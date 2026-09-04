import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { env } from '../../config/env.js';
import { prisma } from '../../core/prisma.js';
import type { AuthUser } from '../auth/auth.service.js';
import { BACKUP_PATHS, backupDirectory, createBackup, deleteBackup } from './backup.service.js';
import { disconnectLockClient } from './distributed-lock.js';
import { parseDatabaseUrl, runSql } from './mariadb-cli.js';
import { readManifest, sha256File } from './manifest.js';
import { resetOperationLock } from './operation-lock.js';
import {
  assertScratchDatabase,
  listRehearsals,
  rehearsalDatabaseName,
  rehearsalStatus,
  runRehearsal,
  selectBackupForRehearsal,
} from './rehearsal.service.js';
import { decideRehearsalRun, nextRehearsalAt, zonedDayOfWeek, isRehearsalStale } from './schedule-policy.js';

/**
 * การซ้อมกู้คืน
 *
 * พิสูจน์ว่าชุดสำรอง "กู้คืนได้จริง" ไม่ใช่แค่ "ไฟล์ยังไม่เน่า"
 * ทุกอย่างเกิดในพื้นที่พัก - ระบบที่ใช้งานจริงต้องไม่ถูกแตะแม้แต่ไบต์เดียว
 */
describe('การซ้อมกู้คืน', () => {
  const prefix = `rehearsal-test-${process.pid}`;
  let userId = '';
  let user: AuthUser;
  let backupId = '';
  let backupName = '';
  const createdResourceIds: string[] = [];
  const rehearsalIds: string[] = [];

  const makeFile = async (
    name: string,
    bodies: string[],
    options: { driveScope?: 'MY_DRIVE' | 'SYSTEM_DRIVE'; trashed?: boolean } = {},
  ): Promise<string> => {
    const resourceId = crypto.randomUUID();
    await prisma.resource.create({
      data: {
        id: resourceId, type: 'FILE', name: `${prefix}-${name}`, normalizedName: `${prefix}-${name}`.toLowerCase(),
        siblingKey: `${prefix}:${name}:${resourceId}`, ownerId: userId, createdById: userId,
        driveScope: options.driveScope ?? 'MY_DRIVE',
        ...(options.trashed ? { deletedAt: new Date(), deletedById: userId } : {}),
      },
    });
    createdResourceIds.push(resourceId);

    for (const [index, body] of bodies.entries()) {
      const storageKey = `resources/${resourceId}/${crypto.randomUUID()}`;
      const absolute = path.join(env.STORAGE_ROOT, storageKey);
      await fsp.mkdir(path.dirname(absolute), { recursive: true });
      await fsp.writeFile(absolute, body);
      await prisma.resourceVersion.create({
        data: {
          resourceId, versionNumber: index + 1, storageKey,
          size: BigInt(Buffer.byteLength(body)),
          checksum: crypto.createHash('sha256').update(body).digest('hex'),
          createdById: userId,
        },
      });
    }
    return resourceId;
  };

  before(async () => {
    resetOperationLock();
    const row = await prisma.user.create({
      data: { email: `${prefix}@example.invalid`, displayName: 'Rehearsal QA', status: 'ACTIVE' },
    });
    userId = row.id;
    user = {
      id: userId, email: row.email, displayName: row.displayName, status: 'ACTIVE',
      mustChangePassword: false, roles: ['SUPER_ADMIN'], permissions: ['system:backup:manage'],
    };

    // ข้อมูลที่ต้องพิสูจน์ว่ากู้คืนกลับมาครบ: หลายเวอร์ชัน, ไดร์ฟของระบบ, ถังขยะ
    await makeFile('versions.txt', ['v1 body', 'v2 body', 'v3 body']);
    await makeFile('system.txt', ['system drive content'], { driveScope: 'SYSTEM_DRIVE' });
    await makeFile('trashed.txt', ['trashed content'], { trashed: true });

    const { backup } = await createBackup(user);
    backupId = backup.id;
    backupName = (await prisma.backupLog.findUniqueOrThrow({ where: { id: backupId } })).backupName;
  });

  after(async () => {
    await prisma.restoreRehearsalLog.deleteMany({ where: { id: { in: rehearsalIds } } });
    await prisma.restoreRehearsalLog.deleteMany({ where: { backupId } });
    await deleteBackup(backupId, user).catch(() => undefined);
    await prisma.backupLog.deleteMany({ where: { id: backupId } });
    await prisma.resourceVersion.deleteMany({ where: { resourceId: { in: createdResourceIds } } });
    await prisma.resource.deleteMany({ where: { id: { in: createdResourceIds } } });
    for (const id of createdResourceIds) {
      await fsp.rm(path.join(env.STORAGE_ROOT, 'resources', id), { recursive: true, force: true }).catch(() => undefined);
    }
    await prisma.activityLog.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { email: { startsWith: prefix } } });
    await disconnectLockClient();
    resetOperationLock();
  });

  /* ---------------- ด่านความปลอดภัยของฐานข้อมูลปลายทาง ---------------- */

  test('ชื่อฐานข้อมูลของการซ้อมสร้างจาก id ของระบบและอยู่ใน namespace ที่อนุญาต', () => {
    const name = rehearsalDatabaseName('abc123');
    assert.ok(name.startsWith(env.S2_NAS_RESTORE_DB_PREFIX));
    assert.ok(/^[a-zA-Z0-9_]+$/.test(name));
  });

  test('ปฏิเสธฐานข้อมูลที่ใช้งานจริงและชื่อนอก namespace เด็ดขาด', () => {
    const live = parseDatabaseUrl().database;
    assert.throws(
      () => assertScratchDatabase(live),
      (error: { code?: string }) => error.code === 'REHEARSAL_TARGET_IS_LIVE',
    );
    for (const bad of ['s2_nas', 'mysql', 'information_schema', 'anything_else', 'test_other_prefix']) {
      assert.throws(() => assertScratchDatabase(bad), `${bad} ต้องถูกปฏิเสธ`);
    }
  });

  test('อินพุตที่ไม่ปลอดภัยไม่มีทางกลายเป็นชื่อฐานข้อมูล', () => {
    for (const bad of ['', '../../etc', 'a;DROP DATABASE x', '`backtick`']) {
      const name = (() => {
        try { return rehearsalDatabaseName(bad); } catch { return null; }
      })();
      if (name !== null) {
        assert.ok(/^[a-zA-Z0-9_]+$/.test(name), `${bad} ต้องถูกกรองจนปลอดภัย`);
        assert.ok(name.startsWith(env.S2_NAS_RESTORE_DB_PREFIX));
      }
    }
  });

  /* ---------------- การเลือกชุดสำรอง ---------------- */

  test('เลือกชุดสำรองที่ใหม่ที่สุดที่ทำสำเร็จและตรวจสอบตัวเองแล้ว', async () => {
    const candidate = await selectBackupForRehearsal();
    assert.ok(candidate, 'ต้องมีชุดสำรองให้ซ้อม');
    assert.equal(candidate!.id, backupId);
  });

  test('ชุดที่ล้มเหลวและชุดที่ยังไม่ตรวจสอบต้องไม่ถูกเลือก', async () => {
    const failed = await prisma.backupLog.create({
      data: { status: 'FAILED', backupName: `${prefix}-failed`, triggeredByUserId: userId, startedAt: new Date() },
    });
    const unverified = await prisma.backupLog.create({
      data: { status: 'COMPLETED', backupName: `${prefix}-unverified`, triggeredByUserId: userId, startedAt: new Date() },
    });
    try {
      const candidate = await selectBackupForRehearsal();
      assert.notEqual(candidate?.id, failed.id, 'ชุดที่ล้มเหลวต้องไม่ถูกเลือก');
      assert.notEqual(candidate?.id, unverified.id, 'ชุดที่ไม่มี manifest checksum ต้องไม่ถูกเลือก');
    } finally {
      await prisma.backupLog.deleteMany({ where: { id: { in: [failed.id, unverified.id] } } });
    }
  });

  /* ---------------- ซ้อมจริง ---------------- */

  test('ซ้อมกู้คืนผ่าน และข้อมูลกับไฟล์สอดคล้องกัน', async () => {
    const result = await runRehearsal(user, 'MANUAL');
    assert.ok(result);
    rehearsalIds.push(result!.id);

    assert.equal(result!.status, 'PASSED', result!.errorMessage ?? '');
    assert.equal(result!.databaseRestored, true);
    assert.equal(result!.storageRestored, true);
    assert.equal(result!.missingCount, 0);
    assert.equal(result!.checksumFailures, 0);
    assert.equal(result!.cleanupFailed, false, 'ต้องล้างพื้นที่พักสำเร็จ');
    assert.ok((result!.versionCount ?? 0) >= 5);
  });

  test('เก็บกวาดพื้นที่พักหมดจริง ไม่เหลือฐานข้อมูลหรือโฟลเดอร์ค้าง', async () => {
    const target = parseDatabaseUrl();
    const leftovers = await runSql(
      target,
      `SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME LIKE '${env.S2_NAS_RESTORE_DB_PREFIX}rh_%'`,
    );
    assert.equal(leftovers.trim(), '', 'ต้องไม่เหลือฐานข้อมูลของการซ้อมค้างไว้');

    for (const id of rehearsalIds) {
      const stage = path.join(env.REHEARSAL_STAGE_ROOT, `rehearsal-${id}`);
      await assert.rejects(() => fsp.stat(stage), 'โฟลเดอร์พักต้องถูกลบ');
    }
  });

  test('ชุดที่เพิ่งซ้อมผ่านไม่ถูกเลือกซ้ำในรอบถัดไป', async () => {
    assert.equal(await selectBackupForRehearsal(), null, 'ไม่ควรซ้อมชุดเดิมซ้ำทันที');
    // การเรียกซ้ำจึงไม่สร้างระเบียนใหม่
    assert.equal(await runRehearsal(user, 'SCHEDULED'), null);
  });

  test('ระบบที่ใช้งานจริงไม่ถูกแตะเลยระหว่างการซ้อม', async () => {
    // แถวของชุดทดสอบต้องอยู่ครบ และไฟล์จริงต้องยังอยู่ที่เดิม
    const mine = await prisma.resource.count({ where: { id: { in: createdResourceIds } } });
    assert.equal(mine, createdResourceIds.length);

    const versions = await prisma.resourceVersion.findMany({
      where: { resourceId: { in: createdResourceIds } },
      select: { storageKey: true, checksum: true },
    });
    for (const version of versions) {
      const actual = await sha256File(path.join(env.STORAGE_ROOT, version.storageKey));
      assert.equal(actual, version.checksum, 'ไฟล์จริงต้องไม่ถูกเขียนทับระหว่างการซ้อม');
    }

    const backup = await prisma.backupLog.findUnique({ where: { id: backupId } });
    assert.equal(backup?.status, 'COMPLETED', 'การซ้อมต้องไม่เปลี่ยนสถานะชุดสำรอง');
  });

  test('การซ้อมพิสูจน์ว่าเวอร์ชัน ไดร์ฟ และถังขยะกู้คืนกลับมาครบ', async () => {
    /**
     * ซ้อมอีกครั้งโดยข้ามกติกา "เพิ่งซ้อมไป" ด้วยการลบผลเดิมทิ้งก่อน
     * แล้วตรวจเนื้อหาในฐานข้อมูลพักโดยตรงระหว่างที่ยังไม่ถูกล้าง - ทำไม่ได้เพราะล้างใน finally
     * จึงตรวจผ่านค่าที่บันทึกไว้ในผลการซ้อมแทน ซึ่งคำนวณจากฐานข้อมูลพักจริง
     */
    await prisma.restoreRehearsalLog.deleteMany({ where: { backupId } });
    const result = await runRehearsal(user, 'MANUAL');
    assert.ok(result);
    rehearsalIds.push(result!.id);

    assert.equal(result!.status, 'PASSED');
    // 3 เวอร์ชันของไฟล์แรก + อีกสองไฟล์ = อย่างน้อย 5 เวอร์ชันของชุดทดสอบนี้
    assert.ok((result!.versionCount ?? 0) >= 5, 'ประวัติเวอร์ชันต้องกู้คืนมาครบ');
    assert.ok((result!.resourceCount ?? 0) >= 3);
    assert.equal(result!.missingCount, 0, 'ไฟล์ของไดร์ฟของระบบและถังขยะต้องอยู่ครบ');
    assert.equal(result!.orphanCount, 0);
  });

  test('บันทึกผลการซ้อมไว้ให้ตรวจสอบย้อนหลังได้ และไม่มีความลับปนมา', async () => {
    const rows = await listRehearsals(10);
    assert.ok(rows.length >= 1);

    const dump = JSON.stringify(rows);
    for (const secret of ['DATABASE_URL', 'mysql://', 'password', 'MYSQL_PWD', env.STORAGE_ROOT.replace(/\\/g, '\\\\')]) {
      assert.ok(!dump.includes(secret), `ผลการซ้อมต้องไม่มี ${secret}`);
    }
  });

  test('สถานะการซ้อมรายงานค่าจริง', async () => {
    const status = await rehearsalStatus();
    assert.equal(typeof status.enabled, 'boolean');
    assert.ok(status.lastRehearsalAt instanceof Date);
    assert.equal(status.lastRehearsalStatus, 'PASSED');
    assert.equal(status.lastRehearsedBackupId, backupId);
    assert.equal(status.stale, false, 'เพิ่งซ้อมผ่านไป จึงต้องไม่ถือว่าเก่า');
  });

  test('ชุดสำรองต้องไม่ถูกลบเพราะการซ้อม ไม่ว่าผลจะเป็นอย่างไร', async () => {
    const backup = await prisma.backupLog.findUnique({ where: { id: backupId } });
    assert.ok(backup, 'ชุดสำรองต้องยังอยู่');
    const dir = await fsp.stat(backupDirectory(backupName));
    assert.ok(dir.isDirectory(), 'ไฟล์ของชุดสำรองต้องยังอยู่');
  });

  test('ชุดสำรองที่ไฟล์เสียหาย ทำให้การซ้อมไม่ผ่านโดยไม่แตะระบบจริง', async () => {
    const manifest = await readManifest(path.join(backupDirectory(backupName), BACKUP_PATHS.MANIFEST_FILE));
    const victim = manifest.storage.objects[0]!;
    const victimPath = path.join(backupDirectory(backupName), BACKUP_PATHS.STORAGE_DIR, victim.storageKey);
    const original = await fsp.readFile(victimPath);

    await fsp.writeFile(victimPath, 'corrupted backup content');
    await prisma.restoreRehearsalLog.deleteMany({ where: { backupId } });
    try {
      const result = await runRehearsal(user, 'MANUAL');
      assert.ok(result);
      rehearsalIds.push(result!.id);
      assert.equal(result!.status, 'FAILED');
      assert.ok(result!.errorMessage, 'ต้องมีข้อความบอกสาเหตุ');
      // ล้มเหลวแล้วต้องยังเก็บกวาดพื้นที่พัก
      assert.equal(result!.cleanupFailed, false);
    } finally {
      await fsp.writeFile(victimPath, original);
    }

    // ชุดสำรองยังอยู่ ไม่ถูกลบเพราะซ้อมไม่ผ่าน
    assert.ok(await prisma.backupLog.findUnique({ where: { id: backupId } }));
  });
});

describe('ตารางการซ้อมกู้คืน', () => {
  const config = { enabled: true, time: '03:30', timezone: 'Asia/Bangkok', dayOfWeek: 0 };
  const GRACE = 6;

  test('วันในสัปดาห์อ่านตามโซนเวลา ไม่ใช่ UTC', () => {
    // 20:00 UTC วันเสาร์ = ตีสามวันอาทิตย์ที่กรุงเทพ
    const instant = new Date('2026-09-05T20:00:00.000Z');
    assert.equal(zonedDayOfWeek(instant, 'UTC'), 6);
    assert.equal(zonedDayOfWeek(instant, 'Asia/Bangkok'), 0);
  });

  test('ซ้อมเฉพาะวันที่กำหนด วันอื่นต้องไม่ทำงาน', () => {
    const monday = new Date('2026-09-07T03:30:00+07:00');
    const decision = decideRehearsalRun(monday, config, { lastRehearsalDate: null }, GRACE);
    assert.equal(decision.action, 'SKIP');
    assert.equal(decision.reason, 'NOT_DUE');
  });

  test('ถึงเวลาในวันที่กำหนดแล้วต้องทำงาน', () => {
    const sunday = new Date('2026-09-06T03:30:00+07:00');
    const decision = decideRehearsalRun(sunday, config, { lastRehearsalDate: null }, GRACE);
    assert.equal(decision.action, 'RUN');
  });

  test('ซ้อมไปแล้ววันนี้ต้องไม่ซ้อมซ้ำ แม้เซิร์ฟเวอร์จะรีสตาร์ท', () => {
    const sunday = new Date('2026-09-06T05:00:00+07:00');
    const decision = decideRehearsalRun(sunday, config, { lastRehearsalDate: '2026-09-06' }, GRACE);
    assert.equal(decision.action, 'SKIP');
    assert.equal(decision.reason, 'ALREADY_RAN_TODAY');
  });

  test('พลาดไม่นานตามเก็บได้ พลาดนานเกินไปให้รอสัปดาห์หน้า', () => {
    const soon = new Date('2026-09-06T06:00:00+07:00');
    assert.equal(decideRehearsalRun(soon, config, { lastRehearsalDate: null }, GRACE).reason, 'CATCH_UP');

    const late = new Date('2026-09-06T20:00:00+07:00');
    assert.equal(decideRehearsalRun(late, config, { lastRehearsalDate: null }, GRACE).reason, 'MISSED_TOO_LONG');
  });

  test('ปิดตารางแล้วต้องไม่ทำงาน', () => {
    const sunday = new Date('2026-09-06T03:30:00+07:00');
    assert.equal(decideRehearsalRun(sunday, { ...config, enabled: false }, { lastRehearsalDate: null }, GRACE).reason, 'DISABLED');
  });

  test('รอบถัดไปตกวันที่กำหนดเสมอ และอยู่ในอนาคต', () => {
    const monday = new Date('2026-09-07T10:00:00+07:00');
    const next = nextRehearsalAt(monday, config);
    assert.ok(next.getTime() > monday.getTime());
    assert.equal(zonedDayOfWeek(next, config.timezone), 0);
  });

  test('คำเตือนเมื่อไม่ได้ซ้อมมานาน', () => {
    const now = new Date('2026-09-20T00:00:00Z');
    assert.equal(isRehearsalStale(null, now, 14), true);
    assert.equal(isRehearsalStale(new Date('2026-09-18T00:00:00Z'), now, 14), false);
    assert.equal(isRehearsalStale(new Date('2026-09-01T00:00:00Z'), now, 14), true);
  });
});

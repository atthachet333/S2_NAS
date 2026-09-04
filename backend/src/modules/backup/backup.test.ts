import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { env } from '../../config/env.js';
import { prisma } from '../../core/prisma.js';
import type { AuthUser } from '../auth/auth.service.js';
import {
  BACKUP_PATHS,
  backupDirectory,
  backupFolderName,
  collectManifestObjects,
  createBackup,
  deleteBackup,
  toBackupDto,
  verifyBackup,
  verifyBackupFiles,
} from './backup.service.js';
import { assertDumpHasNoDatabaseSwitch, importDump, parseDatabaseUrl, runSql, safeDatabaseError } from './mariadb-cli.js';
import { isSafeStorageKey, readManifest, sha256File } from './manifest.js';
import { acquireOperationLock, resetOperationLock } from './operation-lock.js';
import { discardStage, restorePrecheck, stageRestore } from './restore.service.js';

/**
 * การสำรองและกู้คืน
 *
 * ชุดสำรองที่ยังไม่เคยกู้คืนสำเร็จ ไม่ถือว่าเป็นชุดสำรอง ชุดทดสอบนี้จึงกู้คืนจริง
 * ลงฐานข้อมูลชั่วคราวและโฟลเดอร์ชั่วคราว แล้วเทียบไบต์ต่อไบต์กับต้นฉบับ
 *
 * ข้อมูลทดสอบทั้งหมดเป็นของใช้แล้วทิ้งและถูกเก็บกวาดเสมอ ระบบจริงไม่ถูกแตะต้อง
 */
describe('การสำรองและกู้คืนข้อมูล', () => {
  const prefix = `backup-test-${process.pid}`;
  let userId = '';
  let user: AuthUser;
  const createdResourceIds: string[] = [];
  const createdBackupIds: string[] = [];
  let systemDriveFileKey = '';
  let trashedFileKey = '';

  /** เขียนไฟล์ทดสอบลง storage จริงพร้อมสร้าง metadata ที่สอดคล้องกัน */
  const makeFile = async (
    name: string,
    content: string,
    options: { driveScope?: 'MY_DRIVE' | 'SYSTEM_DRIVE'; trashed?: boolean; versions?: string[] } = {},
  ): Promise<{ resourceId: string; keys: string[] }> => {
    const resourceId = crypto.randomUUID();
    const bodies = [content, ...(options.versions ?? [])];
    const keys: string[] = [];

    const resource = await prisma.resource.create({
      data: {
        id: resourceId, type: 'FILE', name: `${prefix}-${name}`, normalizedName: `${prefix}-${name}`.toLowerCase(),
        siblingKey: `${prefix}:${name}:${resourceId}`, ownerId: userId, createdById: userId,
        driveScope: options.driveScope ?? 'MY_DRIVE',
        ...(options.trashed ? { deletedAt: new Date(), deletedById: userId } : {}),
      },
    });
    createdResourceIds.push(resource.id);

    for (const [index, body] of bodies.entries()) {
      const storageKey = `resources/${resourceId}/${crypto.randomUUID()}`;
      const absolute = path.join(env.STORAGE_ROOT, storageKey);
      await fsp.mkdir(path.dirname(absolute), { recursive: true });
      await fsp.writeFile(absolute, body);
      keys.push(storageKey);

      await prisma.resourceVersion.create({
        data: {
          resourceId, versionNumber: index + 1, storageKey,
          size: BigInt(Buffer.byteLength(body)),
          checksum: crypto.createHash('sha256').update(body).digest('hex'),
          createdById: userId,
        },
      });
    }

    await prisma.resource.update({
      where: { id: resourceId },
      data: { storageKey: keys.at(-1), currentVersion: bodies.length, size: BigInt(Buffer.byteLength(bodies.at(-1)!)) },
    });
    return { resourceId, keys };
  };

  before(async () => {
    resetOperationLock();
    const row = await prisma.user.create({
      data: { email: `${prefix}@example.invalid`, displayName: 'Backup QA', status: 'ACTIVE' },
    });
    userId = row.id;
    user = {
      id: userId, email: row.email, displayName: row.displayName, status: 'ACTIVE',
      mustChangePassword: false, roles: ['SUPER_ADMIN'], permissions: ['system:backup:manage'],
    };

    // ข้อมูลใช้แล้วทิ้งที่ครอบคลุมกรณีที่ต้องพิสูจน์: หลายเวอร์ชัน, ถังขยะ, ไดร์ฟของระบบ
    const multi = await makeFile('multi.txt', 'version one body', { versions: ['version two body', 'v3'] });
    const trashed = await makeFile('trashed.txt', 'trashed content', { trashed: true });
    const system = await makeFile('system.txt', 'system drive content', { driveScope: 'SYSTEM_DRIVE' });
    assert.equal(multi.keys.length, 3);
    trashedFileKey = trashed.keys[0]!;
    systemDriveFileKey = system.keys[0]!;
  });

  after(async () => {
    for (const id of createdBackupIds) {
      await discardStage(id).catch(() => undefined);
      const row = await prisma.backupLog.findUnique({ where: { id } });
      if (row) {
        await fsp.rm(backupDirectory(row.backupName), { recursive: true, force: true }).catch(() => undefined);
        await prisma.backupLog.deleteMany({ where: { id } });
      }
    }
    await prisma.resourceVersion.deleteMany({ where: { resourceId: { in: createdResourceIds } } });
    await prisma.resource.deleteMany({ where: { id: { in: createdResourceIds } } });
    for (const id of createdResourceIds) {
      await fsp.rm(path.join(env.STORAGE_ROOT, 'resources', id), { recursive: true, force: true }).catch(() => undefined);
    }
    await prisma.activityLog.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { email: { startsWith: prefix } } });
    resetOperationLock();
  });

  /* ---------------- หน่วยย่อยที่ต้องถูกต้องก่อน ---------------- */

  test('storageKey ที่ไม่ปลอดภัยถูกปฏิเสธ - กันการเขียนนอกพื้นที่ที่ตั้งใจ', () => {
    assert.equal(isSafeStorageKey('resources/abc/def'), true);
    for (const bad of ['../escape', 'resources/../../etc', '/absolute/path', 'C:/windows', 'a//b', '']) {
      assert.equal(isSafeStorageKey(bad), false, `${bad} ต้องถูกปฏิเสธ`);
    }
  });

  test('ชื่อโฟลเดอร์ชุดสำรองสร้างจากเวลาและ id เท่านั้น ไม่มีอินพุตจากผู้ใช้', () => {
    const name = backupFolderName(new Date('2026-09-03T13:00:00.000Z'), 'abc123');
    assert.equal(name, '2026-09-03T13-00-00Z_abc123');
    assert.ok(/^[0-9A-Za-z:_.-]+$/.test(name.replace(/T|Z/g, '')));
  });

  test('ข้อความ error ของฐานข้อมูลไม่รั่วรายละเอียดภายใน', () => {
    const message = safeDatabaseError("mariadb-dump: Got error: 1045: Access denied for user 'root'@'10.0.0.5'");
    assert.ok(!message.includes('root'));
    assert.ok(!message.includes('10.0.0.5'));
    assert.ok(message.includes('สิทธิ์'));
  });

  test('รายการไฟล์ที่ต้องสำรองครอบคลุมทุกเวอร์ชัน รายการในถังขยะ และไดร์ฟของระบบ', async () => {
    const { objects } = await collectManifestObjects();
    const keys = new Set(objects.map((object) => object.storageKey));

    assert.ok(keys.has(trashedFileKey), 'ไฟล์ในถังขยะต้องอยู่ในชุดสำรอง');
    assert.ok(keys.has(systemDriveFileKey), 'ไฟล์ของไดร์ฟของระบบต้องอยู่ในชุดสำรอง');

    const multiVersions = objects.filter((object) => object.resourceId === createdResourceIds[0]);
    assert.equal(multiVersions.length, 3, 'ต้องได้ทุกเวอร์ชัน ไม่ใช่เฉพาะเวอร์ชันปัจจุบัน');
    // ไฟล์ชั่วคราวไม่มีแถวใน metadata จึงไม่มีทางหลุดเข้ามา
    assert.ok(![...keys].some((key) => key.startsWith('temp/')));
  });

  test('มีงานสำรองได้ครั้งละหนึ่งงานเท่านั้น', () => {
    const release = acquireOperationLock('BACKUP');
    try {
      assert.throws(() => acquireOperationLock('BACKUP'), (error: { code?: string }) => error.code === 'BACKUP_ALREADY_RUNNING');
      assert.throws(() => acquireOperationLock('RESTORE'), (error: { code?: string }) => error.code === 'BACKUP_ALREADY_RUNNING');
    } finally {
      release();
    }
    // ปล่อยแล้วต้องจองใหม่ได้ มิฉะนั้นงานที่ล้มจะล็อกระบบไว้ถาวร
    acquireOperationLock('BACKUP')();
  });

  test('DTO ไม่มี path จริงและไม่มีชื่อโฟลเดอร์ของชุดสำรอง', async () => {
    const row = await prisma.backupLog.create({
      data: { status: 'COMPLETED', backupName: `${prefix}-dto-probe`, triggeredByUserId: userId, totalBytes: BigInt(10) },
    });
    createdBackupIds.push(row.id);
    const dto = JSON.stringify(toBackupDto(row));

    assert.ok(!dto.includes(env.BACKUP_ROOT.replace(/\\/g, '\\\\')));
    assert.ok(!dto.includes('backupName'));
    assert.ok(!dto.includes(`${prefix}-dto-probe`));
    await prisma.backupLog.delete({ where: { id: row.id } });
    createdBackupIds.pop();
  });

  /* ---------------- สำรองจริง ---------------- */

  let backupId = '';

  test('สร้างชุดสำรองจริงและตรวจสอบตัวเองผ่าน', async () => {
    const { backup, manifest } = await createBackup(user);
    backupId = backup.id;
    createdBackupIds.push(backupId);

    assert.equal(backup.status, 'COMPLETED', 'ต้องสำเร็จหลังผ่านการตรวจสอบตัวเอง');
    assert.ok((backup.fileCount ?? 0) >= 5);
    assert.ok((backup.databaseBytes ?? 0) > 0);
    assert.ok(manifest);
    assert.equal(manifest!.storage.objectCount, backup.fileCount);
  });

  test('ดัมป์ฐานข้อมูลต้องไม่มีคำสั่งเปลี่ยนฐานข้อมูลอยู่ภายใน', async () => {
    const row = await prisma.backupLog.findUniqueOrThrow({ where: { id: backupId } });
    const dump = path.join(backupDirectory(row.backupName), BACKUP_PATHS.DATABASE_DIR, BACKUP_PATHS.DUMP_FILE);
    // ถ้ามี USE อยู่ในไฟล์ การกู้คืนจะถูกเปลี่ยนเส้นทางไปเขียนทับฐานข้อมูลจริง
    await assert.doesNotReject(() => assertDumpHasNoDatabaseSwitch(dump));

    const body = await fsp.readFile(dump, 'utf8');
    assert.ok(!/^\s*USE\s/im.test(body));
    assert.ok(!/^\s*CREATE\s+DATABASE/im.test(body));
  });

  test('ชุดสำรองไม่มีความลับหรือไฟล์ของระบบปะปนมา', async () => {
    const row = await prisma.backupLog.findUniqueOrThrow({ where: { id: backupId } });
    const root = backupDirectory(row.backupName);
    const manifestBody = await fsp.readFile(path.join(root, BACKUP_PATHS.MANIFEST_FILE), 'utf8');

    for (const secret of ['DATABASE_URL', 'mysql://', 'JWT_ACCESS_SECRET', 'MYSQL_PWD', 'password']) {
      assert.ok(!manifestBody.includes(secret), `manifest ต้องไม่มี ${secret}`);
    }
    assert.ok(!manifestBody.includes(env.STORAGE_ROOT.replace(/\\/g, '\\\\')), 'manifest ต้องไม่มี path จริง');

    const entries = await fsp.readdir(root);
    assert.deepEqual(entries.sort(), ['backup.json', 'database', 'manifest.json', 'storage']);
    // ห้ามมี .env, source code หรือ node_modules อยู่ในชุดสำรองข้อมูล
    for (const forbidden of ['.env', 'node_modules', 'src', 'package.json']) {
      assert.ok(!entries.includes(forbidden));
    }
  });

  test('ตรวจสอบชุดสำรองผ่านทุกไฟล์', async () => {
    const result = await verifyBackup(backupId);
    assert.equal(result.valid, true, result.summary);
    assert.equal(result.missingObjects.length, 0);
    assert.equal(result.checksumMismatches.length, 0);
    assert.equal(result.databaseChecksumValid, true);
  });

  /* ---------------- ตรวจจับความเสียหาย ---------------- */

  test('ไฟล์หายและ checksum ไม่ตรง ต้องถูกจับได้ ไม่ใช่ผ่านไปเงียบ ๆ', async () => {
    const row = await prisma.backupLog.findUniqueOrThrow({ where: { id: backupId } });
    const root = backupDirectory(row.backupName);
    const manifest = await readManifest(path.join(root, BACKUP_PATHS.MANIFEST_FILE));
    const victim = manifest.storage.objects[0]!;
    const victimPath = path.join(root, BACKUP_PATHS.STORAGE_DIR, victim.storageKey);
    const original = await fsp.readFile(victimPath);

    // 1. เนื้อหาเปลี่ยน
    await fsp.writeFile(victimPath, 'tampered content');
    let result = await verifyBackupFiles(row.backupName);
    assert.equal(result.valid, false);
    assert.deepEqual(result.checksumMismatches, [victim.storageKey]);

    // 2. ไฟล์หาย
    await fsp.rm(victimPath);
    result = await verifyBackupFiles(row.backupName);
    assert.equal(result.valid, false);
    assert.deepEqual(result.missingObjects, [victim.storageKey]);

    // คืนสภาพเดิมเพื่อให้เทสถัดไปใช้ชุดสำรองนี้ต่อได้
    await fsp.writeFile(victimPath, original);
    assert.equal((await sha256File(victimPath)), victim.checksum);
    assert.equal((await verifyBackupFiles(row.backupName)).valid, true);
  });

  test('manifest ที่เสียหายถูกจับได้', async () => {
    const row = await prisma.backupLog.findUniqueOrThrow({ where: { id: backupId } });
    const manifestPath = path.join(backupDirectory(row.backupName), BACKUP_PATHS.MANIFEST_FILE);
    const original = await fsp.readFile(manifestPath, 'utf8');

    await fsp.writeFile(manifestPath, '{ not valid json');
    const broken = await verifyBackupFiles(row.backupName);
    assert.equal(broken.valid, false);
    assert.ok(broken.summary.includes('manifest'));

    // manifest ที่ถูกแก้แบบยังอ่านได้ ต้องถูกจับด้วย checksum ที่บันทึกไว้
    const edited = JSON.parse(original) as { appVersion: string };
    edited.appVersion = 'tampered';
    await fsp.writeFile(manifestPath, `${JSON.stringify(edited, null, 2)}\n`);
    const tampered = await verifyBackupFiles(row.backupName);
    assert.equal(tampered.manifestChecksumValid, false);

    await fsp.writeFile(manifestPath, original);
    assert.equal((await verifyBackupFiles(row.backupName)).valid, true);
  });

  /* ---------------- กู้คืนจริงลงพื้นที่พัก ---------------- */

  test('ตรวจก่อนกู้คืนผ่าน และไม่แตะระบบจริง', async () => {
    const precheck = await restorePrecheck(backupId, user);
    assert.equal(precheck.ok, true, precheck.problems.join(', '));

    /**
     * ยืนยันว่าการตรวจไม่เปลี่ยนอะไร โดยดูข้อมูลของชุดทดสอบนี้เอง
     * ไม่ใช่จำนวนแถวทั้งระบบ เพราะชุดทดสอบอื่นทำงานขนานกันและสร้าง/ลบข้อมูลตลอดเวลา
     */
    const mine = await prisma.resource.count({ where: { id: { in: createdResourceIds } } });
    assert.equal(mine, createdResourceIds.length, 'ข้อมูลของชุดทดสอบต้องอยู่ครบหลังการตรวจ');

    // การตรวจต้องไม่สร้างฐานข้อมูลพักขึ้นมา - ขั้นนั้นเป็นของ stageRestore เท่านั้น
    const target = parseDatabaseUrl();
    const staged = await runSql(
      target,
      `SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = '${env.S2_NAS_RESTORE_DB_PREFIX}${backupId}'`,
    );
    assert.equal(staged.trim(), '', 'การตรวจก่อนกู้คืนต้องไม่สร้างฐานข้อมูลพัก');
  });

  test('กู้คืนลงพื้นที่พักสำเร็จ และข้อมูลกับไฟล์สอดคล้องกัน', async () => {
    const result = await stageRestore(backupId, user);

    assert.equal(result.ok, true, result.problems.join(', '));
    assert.equal(result.verifiedObjects, result.restoredObjects);
    assert.ok(result.stagedDatabase.startsWith(env.S2_NAS_RESTORE_DB_PREFIX));
    assert.notEqual(result.stagedDatabase, parseDatabaseUrl().database, 'ต้องไม่กู้คืนทับฐานข้อมูลจริง');

    const { reconciliation } = result;
    assert.equal(reconciliation.ok, true);
    assert.equal(reconciliation.missingFiles.length, 0, 'ต้องไม่มีไฟล์ที่ metadata อ้างแล้วหาย');
    assert.equal(reconciliation.orphanFiles.length, 0, 'ต้องไม่มีไฟล์ส่วนเกินที่ไม่มีใครอ้างถึง');
    assert.equal(reconciliation.checksumMismatches.length, 0);
  });

  test('ข้อมูลที่กู้คืนมาเหมือนต้นฉบับทุกไบต์ และคงไดร์ฟ เวอร์ชัน ถังขยะไว้ครบ', async () => {
    const target = parseDatabaseUrl();
    const staged = `${env.S2_NAS_RESTORE_DB_PREFIX}${backupId}`;
    const scalar = async (sql: string) => (await runSql(target, sql, staged)).trim();

    /**
     * เทียบกับ manifest ของชุดสำรอง ไม่ใช่กับฐานข้อมูลจริง ณ ตอนนี้
     * ชุดสำรองคือภาพนิ่ง ณ เวลาหนึ่ง ส่วนฐานข้อมูลจริงเดินหน้าต่อไปเรื่อย ๆ
     * การเทียบกับของที่ยังเปลี่ยนอยู่จะให้ผลไม่คงที่และไม่ได้พิสูจน์อะไรเลย
     */
    const row = await prisma.backupLog.findUniqueOrThrow({ where: { id: backupId } });
    const manifest = await readManifest(path.join(backupDirectory(row.backupName), BACKUP_PATHS.MANIFEST_FILE));

    /**
     * ตัวเลขในฐานข้อมูลที่กู้มาต้องสมเหตุสมผลเมื่อเทียบกับ manifest แต่ไม่บังคับให้เท่ากันเป๊ะ
     * manifest อ่านตัวเลขหลังดัมป์ ระบบที่ยังรับงานอยู่จึงอาจมีข้อมูลเพิ่มระหว่างนั้น
     * สิ่งที่ต้องเท่ากันเป๊ะคือข้อมูลของชุดทดสอบนี้เอง ซึ่งตรวจอยู่ด้านล่าง
     */
    const restoredResources = Number(await scalar('SELECT COUNT(*) FROM resources'));
    assert.ok(restoredResources > 0, 'ฐานข้อมูลที่กู้มาต้องมีข้อมูลจริง');
    assert.ok(manifest.counts.resources > 0, 'manifest ต้องบันทึกภาพรวมไว้');
    /**
     * ไม่เทียบจำนวนรวมให้เท่ากันเป๊ะ และไม่ตั้งค่าความคลาดเคลื่อนแบบเดาเอาด้วย
     * ตัวเลขรวมขยับได้ตลอดจากงานอื่นที่ทำงานขนานกัน การยืนยันที่มีความหมายจริง
     * คือข้อมูลของชุดทดสอบนี้ ซึ่งเราควบคุมได้ทั้งหมดและตรวจแบบเป๊ะ ๆ ด้านล่าง
     */

    /* ---- ข้อมูลของชุดทดสอบต้องกลับมาครบ พร้อมคุณสมบัติที่ต้องคงไว้ ---- */
    const [multiId, trashedId, systemId] = createdResourceIds as [string, string, string];

    assert.equal(
      await scalar(`SELECT COUNT(*) FROM resource_versions WHERE resourceId = '${multiId}'`),
      '3',
      'ประวัติเวอร์ชันต้องกู้คืนมาครบทุกเวอร์ชัน',
    );
    assert.equal(
      await scalar(`SELECT driveScope FROM resources WHERE id = '${systemId}'`),
      'SYSTEM_DRIVE',
      'ไดร์ฟของทรัพยากรต้องคงเดิม',
    );
    assert.equal(
      await scalar(`SELECT COUNT(*) FROM resources WHERE id = '${trashedId}' AND deletedAt IS NOT NULL`),
      '1',
      'สถานะถังขยะต้องคงเดิม',
    );

    /* ---- เทียบไบต์ต่อไบต์เฉพาะไฟล์ที่ชุดทดสอบนี้เป็นเจ้าของ ---- */
    const stageDir = path.join(env.RESTORE_STAGE_ROOT, `stage-${backupId}`);
    const mine = await prisma.resourceVersion.findMany({
      where: { resourceId: { in: createdResourceIds } },
      select: { storageKey: true },
    });
    let compared = 0;
    for (const version of mine) {
      const live = await sha256File(path.join(env.STORAGE_ROOT, version.storageKey));
      const restored = await sha256File(path.join(stageDir, version.storageKey));
      assert.equal(restored, live, `ไฟล์ที่กู้คืนไม่ตรงกับต้นฉบับ: ${version.storageKey}`);
      compared += 1;
    }
    assert.equal(compared, 5, 'ต้องเทียบไฟล์ของชุดทดสอบครบทั้ง 5 ไฟล์');

    // ทุกไฟล์ใน manifest ต้องถูกกู้คืนและตรวจผ่าน ไม่ใช่แค่ของชุดทดสอบ
    assert.equal(manifest.storage.objectCount >= 5, true);
  });

  test('การกู้คืนไม่แตะฐานข้อมูลจริงแม้แต่แถวเดียว', async () => {
    // แถวที่ถูกเขียนหลังดัมป์ต้องยังอยู่ - ถ้าถูกเขียนทับ แถวเหล่านี้จะหายไป
    const audit = await prisma.activityLog.count({ where: { userId, action: 'BACKUP_CREATED' } });
    assert.ok(audit >= 1, 'audit ที่เขียนหลังดัมป์ต้องยังอยู่ในฐานข้อมูลจริง');
    const row = await prisma.backupLog.findUniqueOrThrow({ where: { id: backupId } });
    assert.equal(row.status, 'COMPLETED', 'สถานะที่อัปเดตหลังดัมป์ต้องยังอยู่');
  });

  test('ปฏิเสธการนำเข้าดัมป์ทับฐานข้อมูลที่ใช้งานจริง', async () => {
    const target = parseDatabaseUrl();
    const row = await prisma.backupLog.findUniqueOrThrow({ where: { id: backupId } });
    const dump = path.join(backupDirectory(row.backupName), BACKUP_PATHS.DATABASE_DIR, BACKUP_PATHS.DUMP_FILE);
    await assert.rejects(
      () => importDump(target, target.database, dump),
      (error: { code?: string }) => error.code === 'RESTORE_TARGET_IS_LIVE',
    );
  });

  /* ---------------- ลบชุดสำรอง ---------------- */

  test('ลบชุดสำรองที่กำลังทำงานอยู่ไม่ได้', async () => {
    const running = await prisma.backupLog.create({
      data: { status: 'RUNNING', backupName: `${prefix}-running`, triggeredByUserId: userId },
    });
    createdBackupIds.push(running.id);
    await assert.rejects(
      () => deleteBackup(running.id, user),
      (error: { code?: string }) => error.code === 'BACKUP_IN_PROGRESS',
    );
    await prisma.backupLog.delete({ where: { id: running.id } });
    createdBackupIds.pop();
  });

  test('ลบชุดสำรองแล้วทั้งไฟล์และระเบียนต้องหายไปพร้อมกัน', async () => {
    await discardStage(backupId);
    const row = await prisma.backupLog.findUniqueOrThrow({ where: { id: backupId } });
    const root = backupDirectory(row.backupName);

    await deleteBackup(backupId, user);
    assert.equal(await prisma.backupLog.findUnique({ where: { id: backupId } }), null);
    await assert.rejects(() => fsp.stat(root), 'ไฟล์ของชุดสำรองต้องถูกลบด้วย');

    createdBackupIds.splice(createdBackupIds.indexOf(backupId), 1);
  });

  test('ชุดสำรองที่ไม่มีอยู่ ต้องตอบว่าไม่พบ', async () => {
    await assert.rejects(
      () => verifyBackup('does-not-exist'),
      (error: { code?: string }) => error.code === 'BACKUP_NOT_FOUND',
    );
  });
});

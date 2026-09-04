import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { env } from '../../config/env.js';
import { prisma } from '../../core/prisma.js';
import type { AuthUser } from '../auth/auth.service.js';
import { BACKUP_PATHS, backupDirectory, createBackup, deleteBackup } from './backup.service.js';
import { assertDumpHasNoDatabaseSwitch, importDump, parseDatabaseUrl } from './mariadb-cli.js';
import { readManifest, sha256File } from './manifest.js';
import { FilesystemOffsiteProvider } from './offsite.js';
import { resetOperationLock } from './operation-lock.js';

/**
 * สำเนานอกเครื่อง
 *
 * ใช้ปลายทางจริงบนดิสก์ในโฟลเดอร์ชั่วคราวของระบบ ไม่ใช่ของปลอมในหน่วยความจำ
 * เพราะสิ่งที่ต้องพิสูจน์คือไฟล์ที่ปลายทางอ่านกลับมาแล้วตรงกับต้นฉบับจริง ๆ
 */
describe('สำเนานอกเครื่อง', () => {
  const prefix = `offsite-test-${process.pid}`;
  let userId = '';
  let user: AuthUser;
  let offsiteRoot = '';
  let backupId = '';
  let backupName = '';

  before(async () => {
    resetOperationLock();
    offsiteRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 's2nas-offsite-'));
    const row = await prisma.user.create({
      data: { email: `${prefix}@example.invalid`, displayName: 'Offsite QA', status: 'ACTIVE' },
    });
    userId = row.id;
    user = {
      id: userId, email: row.email, displayName: row.displayName, status: 'ACTIVE',
      mustChangePassword: false, roles: ['SUPER_ADMIN'], permissions: ['system:backup:manage'],
    };

    const { backup } = await createBackup(user);
    backupId = backup.id;
    backupName = (await prisma.backupLog.findUniqueOrThrow({ where: { id: backupId } })).backupName;
  });

  after(async () => {
    await deleteBackup(backupId, user).catch(() => undefined);
    await prisma.backupLog.deleteMany({ where: { id: backupId } });
    await prisma.activityLog.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { email: { startsWith: prefix } } });
    await fsp.rm(offsiteRoot, { recursive: true, force: true });
    resetOperationLock();
  });

  const provider = () => new FilesystemOffsiteProvider(offsiteRoot);
  const remoteDir = () => path.join(offsiteRoot, backupId);

  test('ปลายทางที่ยังไม่ได้ตั้งค่า ต้องบอกตรง ๆ ไม่ใช่แกล้งว่าสำเร็จ', async () => {
    const health = await new FilesystemOffsiteProvider(null).healthCheck();
    assert.equal(health.configured, false);
    assert.equal(health.reachable, false);
  });

  test('ปลายทางที่เข้าถึงไม่ได้ ต้องรายงานโดยไม่เปิดเผยเส้นทางจริง', async () => {
    const unreachable = new FilesystemOffsiteProvider(path.join(offsiteRoot, 'nope', '\0invalid'));
    const health = await unreachable.healthCheck();
    assert.equal(health.reachable, false);
    assert.ok(!health.reason?.includes(offsiteRoot), 'ข้อความต้องไม่มี path จริง');
  });

  test('คัดลอกสำเร็จและตรวจสอบที่ปลายทางผ่าน', async () => {
    const result = await provider().uploadBackup(backupName, backupId);
    assert.equal(result.ok, true, result.problems.join(', '));
    assert.ok(result.verifiedObjects > 0);
    assert.equal(result.verifiedObjects, result.copiedObjects);
  });

  test('โครงสร้างแพ็กเกจที่ปลายทางคงรูปเดิม ไม่ถูกยุบ', async () => {
    const entries = (await fsp.readdir(remoteDir())).sort();
    assert.deepEqual(entries, ['backup.json', 'database', 'manifest.json', 'storage']);
  });

  test('ไฟล์ที่ปลายทางเหมือนต้นฉบับทุกไบต์', async () => {
    const source = backupDirectory(backupName);
    const manifest = await readManifest(path.join(source, BACKUP_PATHS.MANIFEST_FILE));

    for (const object of manifest.storage.objects) {
      const local = await sha256File(path.join(source, BACKUP_PATHS.STORAGE_DIR, object.storageKey));
      const remote = await sha256File(path.join(remoteDir(), BACKUP_PATHS.STORAGE_DIR, object.storageKey));
      assert.equal(remote, local, `ไฟล์ที่ปลายทางไม่ตรง: ${object.storageKey}`);
    }

    const localDump = await sha256File(path.join(source, ...manifest.database.fileName.split('/')));
    const remoteDump = await sha256File(path.join(remoteDir(), ...manifest.database.fileName.split('/')));
    assert.equal(remoteDump, localDump);
  });

  test('ไฟล์หายที่ปลายทางถูกจับได้ ไม่เชื่อผลการคัดลอกอย่างเดียว', async () => {
    const manifest = await readManifest(path.join(remoteDir(), BACKUP_PATHS.MANIFEST_FILE));
    const victim = manifest.storage.objects[0]!;
    const victimPath = path.join(remoteDir(), BACKUP_PATHS.STORAGE_DIR, victim.storageKey);
    const original = await fsp.readFile(victimPath);

    await fsp.rm(victimPath);
    const missing = await provider().verifyRemote(backupName, backupId);
    assert.equal(missing.ok, false);
    assert.ok(missing.problems.some((problem) => problem.includes(victim.storageKey)));

    await fsp.writeFile(victimPath, original);
    assert.equal((await provider().verifyRemote(backupName, backupId)).ok, true);
  });

  test('เนื้อหาที่ปลายทางถูกแก้ ต้องถูกจับได้ด้วย checksum', async () => {
    const manifest = await readManifest(path.join(remoteDir(), BACKUP_PATHS.MANIFEST_FILE));
    const victim = manifest.storage.objects[0]!;
    const victimPath = path.join(remoteDir(), BACKUP_PATHS.STORAGE_DIR, victim.storageKey);
    const original = await fsp.readFile(victimPath);

    await fsp.writeFile(victimPath, 'tampered at the remote end');
    const tampered = await provider().verifyRemote(backupName, backupId);
    assert.equal(tampered.ok, false);
    assert.ok(tampered.problems.some((problem) => problem.includes('checksum')));

    await fsp.writeFile(victimPath, original);
  });

  test('สำเนาที่ค้างครึ่งทางถูกเขียนทับ ไม่ถูกนับว่าใช้ได้', async () => {
    // จำลองสำเนาที่ขาด แล้วสั่งคัดลอกใหม่ - ต้องกลับมาสมบูรณ์
    await fsp.rm(path.join(remoteDir(), BACKUP_PATHS.STORAGE_DIR), { recursive: true, force: true });
    assert.equal((await provider().verifyRemote(backupName, backupId)).ok, false);

    const retry = await provider().uploadBackup(backupName, backupId);
    assert.equal(retry.ok, true, 'คัดลอกใหม่ต้องซ่อมสำเนาที่ค้างได้');
  });

  test('manifest ที่ปลายทางถูกแก้ ต้องถูกจับได้', async () => {
    const manifestPath = path.join(remoteDir(), BACKUP_PATHS.MANIFEST_FILE);
    const original = await fsp.readFile(manifestPath, 'utf8');
    const edited = JSON.parse(original) as { appVersion: string };
    edited.appVersion = 'tampered';
    await fsp.writeFile(manifestPath, `${JSON.stringify(edited, null, 2)}\n`);

    const result = await provider().verifyRemote(backupName, backupId);
    assert.equal(result.ok, false);
    assert.ok(result.problems.some((problem) => problem.includes('manifest')));

    await fsp.writeFile(manifestPath, original);
  });

  test('ชุดสำรองในเครื่องยังใช้ได้ แม้สำเนานอกเครื่องจะล้มเหลว', async () => {
    const failing = new FilesystemOffsiteProvider(path.join(offsiteRoot, 'x', '\0bad'));
    await assert.rejects(() => failing.uploadBackup(backupName, backupId));

    const row = await prisma.backupLog.findUniqueOrThrow({ where: { id: backupId } });
    assert.equal(row.status, 'COMPLETED', 'สถานะของชุดสำรองในเครื่องต้องไม่ถูกกระทบ');
  });

  test('ลบสำเนาที่ปลายทางได้ และไม่แตะชุดสำรองในเครื่อง', async () => {
    await provider().deleteRemote(backupId);
    await assert.rejects(() => fsp.stat(remoteDir()));

    const local = await fsp.stat(backupDirectory(backupName));
    assert.ok(local.isDirectory(), 'ชุดสำรองในเครื่องต้องยังอยู่');
  });

  /* ---------------- ด่านความปลอดภัยจากเหตุการณ์ใน F5 ---------------- */

  describe('ด่านกันการเขียนทับฐานข้อมูลจริง (ห้ามอ่อนลง)', () => {
    test('ดัมป์ต้องไม่มี CREATE DATABASE หรือ USE', async () => {
      const manifest = await readManifest(path.join(backupDirectory(backupName), BACKUP_PATHS.MANIFEST_FILE));
      const dump = path.join(backupDirectory(backupName), ...manifest.database.fileName.split('/'));

      await assert.doesNotReject(() => assertDumpHasNoDatabaseSwitch(dump));
      const body = await fsp.readFile(dump, 'utf8');
      assert.ok(!/^\s*USE\s/im.test(body), 'ดัมป์ต้องไม่มี USE');
      assert.ok(!/^\s*CREATE\s+DATABASE/im.test(body), 'ดัมป์ต้องไม่มี CREATE DATABASE');
    });

    test('ดัมป์ที่มีคำสั่งเปลี่ยนฐานข้อมูลต้องถูกปฏิเสธก่อนนำเข้า', async () => {
      const poisoned = path.join(offsiteRoot, 'poisoned.sql');
      await fsp.writeFile(poisoned, 'USE `s2_nas`;\nSELECT 1;\n');
      await assert.rejects(
        () => assertDumpHasNoDatabaseSwitch(poisoned),
        (error: { code?: string }) => error.code === 'BACKUP_DUMP_UNSAFE',
      );
    });

    test('ปฏิเสธการนำเข้าไปยังฐานข้อมูลที่ใช้งานจริงเสมอ', async () => {
      const target = parseDatabaseUrl();
      const manifest = await readManifest(path.join(backupDirectory(backupName), BACKUP_PATHS.MANIFEST_FILE));
      const dump = path.join(backupDirectory(backupName), ...manifest.database.fileName.split('/'));

      await assert.rejects(
        () => importDump(target, target.database, dump),
        (error: { code?: string }) => error.code === 'RESTORE_TARGET_IS_LIVE',
      );
    });

    test('การคัดลอกออกนอกเครื่องไม่แตะฐานข้อมูลเลย', async () => {
      /**
       * ถ้าการคัดลอกไปเรียกการกู้คืน ฐานข้อมูลจริงจะถูกเขียนทับเหมือนเหตุการณ์เดิม
       * และแถวที่ถูกเขียนหลังดัมป์ (เช่นระเบียนชุดสำรองนี้เอง) จะหายไป
       *
       * ตรวจจากแถวที่ชุดทดสอบนี้เป็นเจ้าของ ไม่ใช่จำนวนรวมทั้งระบบ
       * เพราะชุดทดสอบอื่นทำงานขนานกันและสร้างข้อมูลตลอดเวลา
       */
      await provider().uploadBackup(backupName, backupId);

      const row = await prisma.backupLog.findUnique({ where: { id: backupId } });
      assert.equal(row?.status, 'COMPLETED', 'ระเบียนที่เขียนหลังดัมป์ต้องยังอยู่');
      const owner = await prisma.user.findUnique({ where: { id: userId } });
      assert.ok(owner, 'ผู้ใช้ของชุดทดสอบต้องยังอยู่');

      const source = await fsp.readFile(
        new URL('./offsite.ts', import.meta.url),
        'utf8',
      );
      assert.ok(!source.includes('importDump'), 'โมดูลสำเนานอกเครื่องต้องไม่นำเข้าดัมป์เข้าฐานข้อมูล');
      assert.ok(!source.includes('runSql'), 'โมดูลสำเนานอกเครื่องต้องไม่รันคำสั่ง SQL');
    });

    test('เส้นทางปลายทางไม่รับอินพุตที่ไม่ปลอดภัย', async () => {
      for (const bad of ['../escape', 'a/b', '..']) {
        await assert.rejects(
          () => provider().verifyRemote(backupName, bad),
          (error: { code?: string }) => error.code === 'OFFSITE_INVALID_ID',
          `${bad} ต้องถูกปฏิเสธ`,
        );
      }
    });
  });
});

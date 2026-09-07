import assert from 'node:assert/strict';
import path from 'node:path';
import { Readable } from 'node:stream';
import { after, before, describe, test } from 'node:test';
import { env } from '../../config/env.js';
import { prisma } from '../../core/prisma.js';
import type { AuthUser } from '../auth/auth.service.js';
import { createFolder } from '../resources/resource.service.js';
import { uploadFile } from '../files/file.service.js';
import { BACKUP_PATHS, backupDirectory, createBackup, deleteBackup } from './backup.service.js';
import { disconnectLockClient } from './distributed-lock.js';
import { importDump, parseDatabaseUrl, runSql } from './mariadb-cli.js';
import { readManifest } from './manifest.js';
import { resetOperationLock } from './operation-lock.js';
import { assertScratchDatabase } from './rehearsal.service.js';

/**
 * F17 - บันทึกกิจกรรมต้องรอดจากการกู้คืน
 *
 * บันทึกการตรวจสอบเป็นข้อมูลหลักของธุรกิจ ไม่ใช่ข้อมูลที่คำนวณใหม่ได้
 *
 * ถ้ามันหายไปตอนกู้คืน องค์กรจะตอบผู้ตรวจสอบไม่ได้เลยว่าเกิดอะไรขึ้นก่อนหน้านั้น
 * และไม่มีทางสร้างกลับมาได้ เพราะเหตุการณ์ที่ผ่านไปแล้วเกิดขึ้นครั้งเดียว
 */
describe('F17 บันทึกกิจกรรมต้องรอดจากการกู้คืน', () => {
  const prefix = `f17-restore-${Date.now().toString(36)}`;
  const audit = { ipAddress: '10.1.2.3', userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/120' };
  const stream = (text: string) => Readable.from([Buffer.from(text, 'utf8')]);

  let user: AuthUser;
  let userId = '';
  let folderId = '';
  let fileId = '';
  let markerEventId = '';
  let backupId = '';
  let scratchDatabase = '';

  before(async () => {
    const row = await prisma.user.create({
      data: {
        email: `${prefix}@example.invalid`,
        displayName: 'F17 Restore',
        type: 'INTERNAL',
        status: 'ACTIVE',
      },
    });
    userId = row.id;
    user = {
      id: userId,
      email: row.email,
      displayName: row.displayName,
      type: 'INTERNAL',
      status: 'ACTIVE',
      mustChangePassword: false,
      roles: ['ADMIN'],
      permissions: ['resources:read', 'resources:write', 'resources:delete', 'admin:access'],
    };

    const folder = await createFolder(user, { name: `${prefix} งาน`, parentId: null }, audit);
    folderId = folder.id;

    const uploaded = await uploadFile(
      user,
      stream('เอกสารสำหรับทดสอบการกู้คืนบันทึก'),
      { parentId: folderId, fileName: `${prefix}.txt`, allowDuplicateContent: true },
      audit,
    );
    fileId = uploaded.resource.id;

    /**
     * เหตุการณ์หลักที่ใช้เทียบทีละไบต์หลังกู้คืน
     * ใส่ทั้ง IP และ user agent เพราะทั้งสองอย่างเป็นหลักฐานที่ผู้ตรวจสอบใช้จริง
     */
    const marker = await prisma.activityLog.create({
      data: {
        userId,
        action: 'RESOURCE_DOWNLOADED',
        resourceId: fileId,
        ipAddress: '203.0.113.45',
        userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/120.0 Safari/537.36',
        metadata: { note: 'เหตุการณ์ทดสอบภาษาไทย' },
      },
    });
    markerEventId = marker.id;
  });

  after(async () => {
    if (scratchDatabase) {
      assertScratchDatabase(scratchDatabase);
      await runSql(parseDatabaseUrl(), `DROP DATABASE IF EXISTS \`${scratchDatabase}\``);
    }
    if (backupId) {
      try {
        await deleteBackup(backupId, user, audit);
      } catch {
        /* อาจถูกลบไปแล้ว */
      }
    }

    const all = [fileId, folderId].filter(Boolean);
    await prisma.activityLog.deleteMany({ where: { userId } });
    await prisma.activityLog.deleteMany({ where: { resourceId: { in: all } } });
    await prisma.resourceSearchIndex.deleteMany({ where: { resourceId: { in: all } } });
    await prisma.resourceVersion.deleteMany({ where: { resourceId: { in: all } } });
    await prisma.resource.deleteMany({ where: { id: fileId } });
    await prisma.resource.deleteMany({ where: { id: folderId } });
    await prisma.user.deleteMany({ where: { id: userId } });

    resetOperationLock();
    await disconnectLockClient();
  });

  test('บันทึกกิจกรรมกลับมาครบ พร้อม IP และ user agent', async () => {
    const liveCount = await prisma.activityLog.count();

    const { backup } = await createBackup(user, audit, 'MANUAL');
    assert.equal(backup.status, 'COMPLETED', backup.errorMessage ?? 'สร้างชุดสำรองไม่สำเร็จ');
    backupId = backup.id;

    const row = await prisma.backupLog.findUnique({
      where: { id: backupId },
      select: { backupName: true },
    });

    const target = parseDatabaseUrl();
    scratchDatabase = `${env.S2_NAS_RESTORE_DB_PREFIX}f17_${process.pid}`;
    assertScratchDatabase(scratchDatabase);

    await runSql(target, `DROP DATABASE IF EXISTS \`${scratchDatabase}\``);
    await runSql(
      target,
      `CREATE DATABASE \`${scratchDatabase}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    );

    const root = backupDirectory(row!.backupName);
    const manifest = await readManifest(path.join(root, BACKUP_PATHS.MANIFEST_FILE));
    await importDump(target, scratchDatabase, path.join(root, ...manifest.database.fileName.split('/')));

    /* ---- จำนวนเหตุการณ์ต้องไม่หายไป ---- */
    const restoredCount = Number(
      (await runSql(target, 'SELECT COUNT(*) FROM activity_logs', scratchDatabase)).trim(),
    );
    assert.ok(
      restoredCount >= liveCount,
      `จำนวนเหตุการณ์ที่กู้คืนได้ (${restoredCount}) ต้องไม่น้อยกว่าตอนสำรอง (${liveCount})`,
    );

    /* ---- เหตุการณ์หลักต้องกลับมาครบทุกฟิลด์ ---- */
    const marker = await runSql(
      target,
      `SELECT action, userId, resourceId, ipAddress, HEX(userAgent), HEX(metadata) FROM activity_logs WHERE id = '${markerEventId}'`,
      scratchDatabase,
    );
    const [action, actor, resource, ip, agentHex, metaHex] = marker.trim().split('\t');

    assert.equal(action, 'RESOURCE_DOWNLOADED');
    assert.equal(actor, userId, 'ผู้ดำเนินการต้องกลับมา');
    assert.equal(resource, fileId, 'ทรัพยากรที่เกี่ยวข้องต้องกลับมา');
    assert.equal(ip, '203.0.113.45', 'IP เป็นหลักฐานที่ผู้ตรวจสอบใช้ จึงต้องกลับมาครบ');
    assert.match(
      Buffer.from(agentHex ?? '', 'hex').toString('utf8'),
      /Chrome\/120/,
      'user agent ต้องกลับมาครบ',
    );
    assert.match(
      Buffer.from(metaHex ?? '', 'hex').toString('utf8'),
      /เหตุการณ์ทดสอบภาษาไทย/,
      'ข้อความภาษาไทยใน metadata ต้องกลับมาครบทุกตัวอักษร',
    );

    /* ---- การซ้อมต้องไม่แตะระบบจริง ---- */
    const stillLive = await prisma.activityLog.count({ where: { id: markerEventId } });
    assert.equal(stillLive, 1, 'การซ้อมกู้คืนต้องไม่แตะบันทึกในระบบจริง');
  });
});

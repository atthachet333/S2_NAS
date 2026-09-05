import assert from 'node:assert/strict';
import path from 'node:path';
import { Readable } from 'node:stream';
import { after, before, describe, test } from 'node:test';
import { env } from '../../config/env.js';
import { prisma } from '../../core/prisma.js';
import type { AuthUser } from '../auth/auth.service.js';
import { createFolder } from '../resources/resource.service.js';
import { uploadFile } from '../files/file.service.js';
import { drainOnce } from '../search/index.worker.js';
import { saveCorrection } from '../search/ocr/correction.service.js';
import { BACKUP_PATHS, backupDirectory, createBackup, deleteBackup } from './backup.service.js';
import { disconnectLockClient } from './distributed-lock.js';
import { importDump, parseDatabaseUrl, runSql } from './mariadb-cli.js';
import { readManifest } from './manifest.js';
import { resetOperationLock } from './operation-lock.js';
import { assertScratchDatabase } from './rehearsal.service.js';

/**
 * F14 - ข้อความที่คนตรวจแก้ต้องรอดจากการกู้คืน
 *
 * ข้อความที่ผ่านการตรวจแก้ไม่ใช่ "ข้อมูลที่สร้างใหม่ได้จากไฟล์ต้นฉบับ" อย่างผลของ OCR
 * มันคือแรงงานของคนที่นั่งอ่านเอกสารทีละบรรทัด ถ้ามันหายไปตอนกู้คืน
 * ไม่มีอะไรในระบบสร้างมันกลับมาได้อีก - ต่างจากผลของ OCR ที่สั่งอ่านใหม่ได้เสมอ
 *
 * ชุดทดสอบนี้จึงกู้ดัมป์จริงลงฐานข้อมูลพัก แล้วอ่านข้อความออกมาเทียบทีละตัวอักษร
 * ไม่ใช่แค่ยืนยันว่า "มีตารางอยู่ในดัมป์"
 */
describe('F14 การตรวจแก้ต้องรอดจากการกู้คืน', () => {
  const prefix = `f14-restore-${Date.now().toString(36)}`;
  const audit = { ipAddress: '127.0.0.1', userAgent: 'f14-restore-test' };
  const stream = (text: string) => Readable.from([Buffer.from(text, 'utf8')]);

  /** ข้อความที่ต้องกลับมาครบทุกตัวอักษร รวมทั้งวรรณยุกต์และการขึ้นบรรทัด */
  const corrected = `ใบกำกับภาษี เลขที่ ${prefix}\nบริษัท เอส ทู เอ็นเอเอส จำกัด\nยอดรวม 1,234.56 บาท`;

  let user: AuthUser;
  let userId = '';
  let folderId = '';
  let resourceId = '';
  let backupId = '';
  let backupName = '';
  let scratchDatabase = '';

  before(async () => {
    const row = await prisma.user.create({
      data: {
        email: `${prefix}@example.invalid`,
        displayName: 'F14 Restore',
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

    const folder = await createFolder(user, { name: `${prefix} สำรอง`, parentId: null }, audit);
    folderId = folder.id;

    const uploaded = await uploadFile(
      user,
      stream('ใบกํากับภาษี เลขที่ อ่านผิด'),
      { parentId: folderId, fileName: `${prefix}.txt`, allowDuplicateContent: true },
      audit,
    );
    resourceId = uploaded.resource.id;
    for (let pass = 0; pass < 10 && (await drainOnce(2)) > 0; pass += 1) {
      /* ทำดัชนีให้เสร็จก่อน จึงจะมีข้อความให้ตรวจแก้ */
    }

    await saveCorrection(resourceId, user, { text: corrected, expectedRevision: 0 });
  });

  after(async () => {
    if (scratchDatabase) {
      const target = parseDatabaseUrl();
      assertScratchDatabase(scratchDatabase);
      await runSql(target, `DROP DATABASE IF EXISTS \`${scratchDatabase}\``);
    }
    if (backupId) {
      try {
        await deleteBackup(backupId, user, audit);
      } catch {
        /* ชุดสำรองอาจถูกลบไปแล้ว - ไม่ใช่ความล้มเหลวของการทดสอบ */
      }
    }

    const index = await prisma.resourceSearchIndex.findFirst({
      where: { resourceId },
      select: { id: true },
    });
    if (index) {
      await prisma.resourceTextCorrection.deleteMany({ where: { resourceSearchIndexId: index.id } });
    }
    await prisma.activityLog.deleteMany({ where: { userId } });
    await prisma.resourceSearchIndex.deleteMany({ where: { resourceId } });
    await prisma.resourceVersion.deleteMany({ where: { resourceId } });
    await prisma.resource.deleteMany({ where: { id: resourceId } });
    await prisma.resource.deleteMany({ where: { id: folderId } });
    await prisma.user.deleteMany({ where: { id: userId } });

    resetOperationLock();
    await disconnectLockClient();
  });

  test('ข้อความที่ตรวจแก้กลับมาครบทุกตัวอักษรหลังกู้ดัมป์จริง', async () => {
    const { backup } = await createBackup(user, audit, 'MANUAL');
    /**
     * ไม่ข้ามการทดสอบเมื่อสำรองไม่ผ่าน - ถ้าสำรองไม่ได้ ข้อความที่คนแก้ก็ไม่ได้รับการปกป้อง
     * ซึ่งเป็นความล้มเหลวของสิ่งที่ข้อกำหนดนี้ต้องการพิสูจน์พอดี
     */
    assert.equal(backup.status, 'COMPLETED', backup.errorMessage ?? 'สร้างชุดสำรองไม่สำเร็จ');
    backupId = backup.id;
    // DTO ไม่มีชื่อโฟลเดอร์ของชุดสำรองโดยตั้งใจ - ตำแหน่งบนดิสก์ไม่ใช่ข้อมูลของ browser
    const row = await prisma.backupLog.findUnique({
      where: { id: backupId },
      select: { backupName: true },
    });
    backupName = row!.backupName;

    const target = parseDatabaseUrl();
    scratchDatabase = `${env.S2_NAS_RESTORE_DB_PREFIX}f14_${process.pid}`;
    assertScratchDatabase(scratchDatabase);

    await runSql(target, `DROP DATABASE IF EXISTS \`${scratchDatabase}\``);
    await runSql(
      target,
      `CREATE DATABASE \`${scratchDatabase}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    );

    const root = backupDirectory(backupName);
    const manifest = await readManifest(path.join(root, BACKUP_PATHS.MANIFEST_FILE));
    await importDump(target, scratchDatabase, path.join(root, ...manifest.database.fileName.split('/')));

    /* ---- ตารางประวัติต้องอยู่ในชุดสำรอง ---- */
    const tables = await runSql(
      target,
      "SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'resource_text_corrections'",
      scratchDatabase,
    );
    assert.equal(Number(tables.trim()), 1, 'ตารางประวัติการตรวจแก้ต้องอยู่ในชุดสำรอง');

    /* ---- ข้อความที่มีผลใช้งานต้องเป็นฉบับที่คนแก้ ---- */
    const restored = await runSql(
      target,
      `SELECT textSource, correctionRevision, HEX(extractedText), HEX(rawOcrText) FROM resource_search_index WHERE resourceId = '${resourceId}'`,
      scratchDatabase,
    );
    const [textSource, revision, effectiveHex, rawHex] = restored.trim().split('\t');

    assert.equal(textSource, 'HUMAN_CORRECTED', 'ที่มาของข้อความต้องกู้กลับมาเป็นฉบับที่ตรวจแก้แล้ว');
    assert.equal(Number(revision), 1, 'เลขรุ่นของการตรวจแก้ต้องกู้กลับมาด้วย');
    assert.equal(
      Buffer.from(effectiveHex ?? '', 'hex').toString('utf8'),
      corrected,
      'ข้อความภาษาไทยต้องกลับมาครบทุกตัวอักษร ไม่ใช่แค่ความยาวเท่ากัน',
    );
    // ผลดิบต้องรอดมาด้วย มิฉะนั้นปุ่ม "ใช้ผล OCR เดิม" จะพังหลังการกู้คืน
    assert.match(Buffer.from(rawHex ?? '', 'hex').toString('utf8'), /อ่านผิด/);

    /* ---- ประวัติการแก้ต้องรอดมาด้วย ---- */
    const historyHex = await runSql(
      target,
      `SELECT revision, HEX(text) FROM resource_text_corrections c JOIN resource_search_index i ON i.id = c.resourceSearchIndexId WHERE i.resourceId = '${resourceId}'`,
      scratchDatabase,
    );
    const [historyRevision, historyText] = historyHex.trim().split('\t');
    assert.equal(Number(historyRevision), 1);
    assert.equal(Buffer.from(historyText ?? '', 'hex').toString('utf8'), corrected);
  });
});

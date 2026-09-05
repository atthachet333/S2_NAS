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
import { verifyOcrResult } from '../search/ocr/review.service.js';
import { createSavedSearch } from '../search/saved-search.service.js';
import { createCategory } from '../categories/category.service.js';
import { BACKUP_PATHS, backupDirectory, createBackup, deleteBackup } from './backup.service.js';
import { disconnectLockClient } from './distributed-lock.js';
import { importDump, parseDatabaseUrl, runSql } from './mariadb-cli.js';
import { readManifest } from './manifest.js';
import { resetOperationLock } from './operation-lock.js';
import { assertScratchDatabase } from './rehearsal.service.js';

/**
 * F15 - ข้อมูลที่คนสร้างขึ้นต้องรอดจากการกู้คืน
 *
 * สามอย่างในเฟสนี้เป็นแรงงานของคน ไม่ใช่ข้อมูลที่เครื่องสร้างใหม่ได้:
 *
 *   1. ชุดค้นหาที่บันทึกไว้ - คนคิดเงื่อนไขและตั้งชื่อเอง
 *   2. การจัดประเภทเอกสาร  - คนเปิดอ่านแล้วตัดสินใจว่าเป็นเอกสารชนิดไหน
 *   3. สถานะการตรวจ OCR    - คนนั่งอ่านผลของเครื่องแล้วยืนยันหรือแก้
 *
 * ถ้าสิ่งเหล่านี้หายไปตอนกู้คืน ไม่มีอะไรในระบบสร้างมันกลับมาได้
 * ชุดทดสอบนี้จึงกู้ดัมป์จริงลงฐานข้อมูลพัก แล้วอ่านค่ากลับมาเทียบทีละรายการ
 */
describe('F15 ข้อมูลที่คนสร้างต้องรอดจากการกู้คืน', () => {
  const prefix = `f15-restore-${Date.now().toString(36)}`;
  const audit = { ipAddress: '127.0.0.1', userAgent: 'f15-restore-test' };
  const stream = (text: string) => Readable.from([Buffer.from(text, 'utf8')]);

  const savedName = `${prefix} ภาษีเดือนนี้`;
  const categoryName = `${prefix} ใบกำกับภาษี`;
  const correctedText = `ใบกำกับภาษี ${prefix}\nยอดรวม 9,876.54 บาท`;

  let user: AuthUser;
  let userId = '';
  let folderId = '';
  let verifiedId = '';
  let correctedId = '';
  let categorizedId = '';
  let categoryId = '';
  let savedSearchId = '';
  let backupId = '';
  let backupName = '';
  let scratchDatabase = '';

  before(async () => {
    const row = await prisma.user.create({
      data: {
        email: `${prefix}@example.invalid`,
        displayName: 'F15 Restore',
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

    const make = async (name: string, body: string) => {
      const uploaded = await uploadFile(
        user,
        stream(body),
        { parentId: folderId, fileName: name, allowDuplicateContent: true },
        audit,
      );
      for (let pass = 0; pass < 10 && (await drainOnce(3)) > 0; pass += 1) {
        /* รอทำดัชนี */
      }
      return uploaded.resource.id;
    };

    verifiedId = await make(`${prefix}-ยืนยัน.txt`, 'ข้อความที่เครื่องอ่านมาถูกต้องแล้ว');
    correctedId = await make(`${prefix}-แก้ไข.txt`, 'ข้อความที่เครื่องอ่านผิด');
    categorizedId = await make(`${prefix}-จัดประเภท.txt`, 'เอกสารที่ถูกจัดประเภทไว้');

    /* ---- สถานะการตรวจ: VERIFIED (ไม่แก้ข้อความ) ---- */
    const target = await prisma.resource.findUnique({
      where: { id: verifiedId },
      select: { currentVersion: true },
    });
    await prisma.resourceSearchIndex.updateMany({
      where: { resourceId: verifiedId, versionNumber: target!.currentVersion! },
      data: { status: 'READY', jobKind: 'OCR', textSource: 'OCR', ocrRequested: true, ocrConfidence: 91 },
    });
    await verifyOcrResult(verifiedId, user);

    /* ---- สถานะการตรวจ: CORRECTED (แก้ข้อความ) ---- */
    await saveCorrection(correctedId, user, { text: correctedText, expectedRevision: 0 });

    /* ---- ประเภทเอกสาร ---- */
    const category = await createCategory(user, { name: categoryName });
    categoryId = category.id;
    await prisma.resource.update({
      where: { id: categorizedId },
      data: { documentCategoryId: categoryId },
    });

    /* ---- ชุดค้นหาที่บันทึกไว้ ---- */
    const saved = await createSavedSearch(user, {
      name: savedName,
      query: 'ภาษี',
      filters: { fileKind: 'pdf', ocrState: 'OCR_DONE', uploadedPreset: 'thisMonth', sort: 'newest' },
    });
    savedSearchId = saved.id;
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
        /* ชุดสำรองอาจถูกลบไปแล้ว */
      }
    }

    const all = [verifiedId, correctedId, categorizedId, folderId].filter(Boolean);
    const indexes = await prisma.resourceSearchIndex.findMany({
      where: { resourceId: { in: all } },
      select: { id: true },
    });
    await prisma.resourceTextCorrection.deleteMany({
      where: { resourceSearchIndexId: { in: indexes.map((row) => row.id) } },
    });
    await prisma.savedSearch.deleteMany({ where: { userId } });
    await prisma.activityLog.deleteMany({ where: { userId } });
    await prisma.resourceSearchIndex.deleteMany({ where: { resourceId: { in: all } } });
    await prisma.resourceVersion.deleteMany({ where: { resourceId: { in: all } } });
    await prisma.resource.deleteMany({ where: { id: { in: all.filter((id) => id !== folderId) } } });
    await prisma.resource.deleteMany({ where: { id: folderId } });
    await prisma.documentCategory.deleteMany({ where: { createdById: userId } });
    await prisma.user.deleteMany({ where: { id: userId } });

    resetOperationLock();
    await disconnectLockClient();
  });

  test('ชุดค้นหา ประเภทเอกสาร และสถานะการตรวจ กลับมาครบหลังกู้ดัมป์จริง', async () => {
    const { backup } = await createBackup(user, audit, 'MANUAL');
    /**
     * ไม่ข้ามการทดสอบเมื่อสำรองไม่ผ่าน - ถ้าสำรองไม่ได้ ข้อมูลที่คนสร้างก็ไม่ได้
     * รับการปกป้อง ซึ่งเป็นความล้มเหลวของสิ่งที่ข้อกำหนดนี้ต้องพิสูจน์พอดี
     */
    assert.equal(backup.status, 'COMPLETED', backup.errorMessage ?? 'สร้างชุดสำรองไม่สำเร็จ');
    backupId = backup.id;

    const row = await prisma.backupLog.findUnique({
      where: { id: backupId },
      select: { backupName: true },
    });
    backupName = row!.backupName;

    const target = parseDatabaseUrl();
    scratchDatabase = `${env.S2_NAS_RESTORE_DB_PREFIX}f15_${process.pid}`;
    assertScratchDatabase(scratchDatabase);

    await runSql(target, `DROP DATABASE IF EXISTS \`${scratchDatabase}\``);
    await runSql(
      target,
      `CREATE DATABASE \`${scratchDatabase}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    );

    const root = backupDirectory(backupName);
    const manifest = await readManifest(path.join(root, BACKUP_PATHS.MANIFEST_FILE));
    await importDump(target, scratchDatabase, path.join(root, ...manifest.database.fileName.split('/')));

    /* ---- ตารางใหม่ของ F15 ต้องอยู่ในชุดสำรอง ---- */
    const tables = await runSql(
      target,
      "SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('saved_searches','document_categories')",
      scratchDatabase,
    );
    assert.equal(Number(tables.trim()), 2, 'ตารางชุดค้นหาและประเภทเอกสารต้องอยู่ในชุดสำรอง');

    /* ---- ชุดค้นหา: ทั้งชื่อและเงื่อนไข ---- */
    const savedRow = await runSql(
      target,
      `SELECT HEX(name), HEX(query), HEX(filters) FROM saved_searches WHERE id = '${savedSearchId}'`,
      scratchDatabase,
    );
    const [nameHex, queryHex, filtersHex] = savedRow.trim().split('\t');
    assert.equal(
      Buffer.from(nameHex ?? '', 'hex').toString('utf8'),
      savedName,
      'ชื่อชุดค้นหาภาษาไทยต้องกลับมาครบทุกตัวอักษร',
    );
    assert.equal(Buffer.from(queryHex ?? '', 'hex').toString('utf8'), 'ภาษี');

    const filters = JSON.parse(Buffer.from(filtersHex ?? '', 'hex').toString('utf8'));
    assert.equal(filters.fileKind, 'pdf', 'เงื่อนไขที่บันทึกไว้ต้องกลับมาครบ');
    assert.equal(filters.ocrState, 'OCR_DONE');
    assert.equal(filters.uploadedPreset, 'thisMonth');

    /* ---- ประเภทเอกสาร และการผูกกับทรัพยากร ---- */
    const categoryRow = await runSql(
      target,
      `SELECT HEX(name), isActive FROM document_categories WHERE id = '${categoryId}'`,
      scratchDatabase,
    );
    const [categoryHex] = categoryRow.trim().split('\t');
    assert.equal(Buffer.from(categoryHex ?? '', 'hex').toString('utf8'), categoryName);

    const assigned = await runSql(
      target,
      `SELECT documentCategoryId FROM resources WHERE id = '${categorizedId}'`,
      scratchDatabase,
    );
    assert.equal(
      assigned.trim(),
      categoryId,
      'การจัดประเภทที่คนทำไว้ต้องกลับมา ไม่ใช่แค่ตัวประเภทเปล่า ๆ',
    );

    /* ---- สถานะการตรวจ: VERIFIED ต้องยังเป็น OCR ไม่ใช่ HUMAN_CORRECTED ---- */
    const verified = await runSql(
      target,
      `SELECT i.reviewStatus, i.textSource, i.reviewedById FROM resource_search_index i
        JOIN resources r ON r.id = i.resourceId AND r.currentVersion = i.versionNumber
       WHERE i.resourceId = '${verifiedId}'`,
      scratchDatabase,
    );
    const [reviewStatus, textSource, reviewedById] = verified.trim().split('\t');
    assert.equal(reviewStatus, 'VERIFIED');
    assert.equal(
      textSource,
      'OCR',
      'การยืนยันไม่ได้แก้ข้อความ ที่มาจึงต้องยังเป็น OCR หลังกู้คืนด้วย',
    );
    assert.equal(reviewedById, userId, 'ผู้ที่ตรวจต้องกลับมาด้วย');

    /* ---- สถานะการตรวจ: CORRECTED พร้อมข้อความที่แก้ ---- */
    const corrected = await runSql(
      target,
      `SELECT i.reviewStatus, i.textSource, HEX(i.extractedText) FROM resource_search_index i
        JOIN resources r ON r.id = i.resourceId AND r.currentVersion = i.versionNumber
       WHERE i.resourceId = '${correctedId}'`,
      scratchDatabase,
    );
    const [correctedStatus, correctedSource, textHex] = corrected.trim().split('\t');
    assert.equal(correctedStatus, 'CORRECTED');
    assert.equal(correctedSource, 'HUMAN_CORRECTED');
    assert.equal(
      Buffer.from(textHex ?? '', 'hex').toString('utf8'),
      correctedText,
      'ข้อความที่คนแก้ต้องกลับมาครบทุกตัวอักษร',
    );
  });
});

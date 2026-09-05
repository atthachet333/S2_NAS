import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { after, before, describe, test } from 'node:test';
import { prisma } from '../../core/prisma.js';
import { AppError } from '../../core/errors.js';
import { createFolder } from '../resources/resource.service.js';
import { uploadFile } from '../files/file.service.js';
import { drainOnce } from './index.worker.js';
import { searchResources } from '../workspace/search.service.js';
import { saveCorrection } from './ocr/correction.service.js';
import {
  createSavedSearch,
  deleteSavedSearch,
  getSavedSearch,
  listSavedSearches,
  renameSavedSearch,
} from './saved-search.service.js';
import { SMART_VIEWS, findSmartView, smartViewFilters } from './smart-views.js';
import { reviewQueue, reviewSummary, verifyOcrResult } from './ocr/review.service.js';
import {
  createCategory,
  deleteCategory,
  listCategories,
  slugify,
  updateCategory,
} from '../categories/category.service.js';
import { bulkAddTag, bulkSetCategory, bulkSetOwner } from '../resources/bulk.service.js';
import { fileKindWhere, resolveDateRange, orderByFor } from './search-filters.js';
import type { AuthUser } from '../auth/auth.service.js';

/**
 * F15 - ตัวกรองขั้นสูง ชุดค้นหา มุมมองอัจฉริยะ คิวตรวจ ประเภทเอกสาร และงานหลายรายการ
 *
 * ทำงานกับฐานข้อมูลจริงทั้งหมด ไม่มีการจำลองผลลัพธ์
 */

const prefix = `f15-${Date.now().toString(36)}`;
const audit = { ipAddress: '127.0.0.1', userAgent: 'f15-test' };
const stream = (text: string) => Readable.from([Buffer.from(text, 'utf8')]);

const makeUser = (
  id: string,
  email: string,
  displayName: string,
  roles: string[] = ['MEMBER'],
): AuthUser => ({
  id,
  email,
  displayName,
  type: 'INTERNAL',
  status: 'ACTIVE',
  mustChangePassword: false,
  roles,
  permissions: [
    'resources:read',
    'resources:write',
    'resources:delete',
    'resources:tag:create',
    ...(roles.includes('ADMIN') ? ['admin:access'] : []),
  ],
});

describe('F15 พื้นที่ทำงานเอกสาร', () => {
  let admin: AuthUser;
  let member: AuthUser;
  let outsider: AuthUser;
  let adminId = '';
  let memberId = '';
  let outsiderId = '';
  let folderId = '';
  let privateFolderId = '';
  let categoryId = '';
  const created: string[] = [];
  const savedSearchIds: string[] = [];

  const drainAll = async () => {
    for (let pass = 0; pass < 10 && (await drainOnce(3)) > 0; pass += 1) {
      /* รอให้ทำดัชนีเสร็จ */
    }
  };

  const upload = async (name: string, body: string, parent = folderId) => {
    const uploaded = await uploadFile(
      admin,
      stream(body),
      { parentId: parent, fileName: name, allowDuplicateContent: true },
      audit,
    );
    created.push(uploaded.resource.id);
    await drainAll();
    return uploaded.resource.id;
  };

  before(async () => {
    const rows = await Promise.all(
      ['admin', 'member', 'outsider'].map((role) =>
        prisma.user.create({
          data: {
            email: `${prefix}-${role}@example.invalid`,
            displayName: `F15 ${role}`,
            type: 'INTERNAL',
            status: 'ACTIVE',
          },
        }),
      ),
    );
    [adminId, memberId, outsiderId] = rows.map((row) => row.id);
    admin = makeUser(adminId, rows[0].email, rows[0].displayName, ['ADMIN']);
    member = makeUser(memberId, rows[1].email, rows[1].displayName);
    outsider = makeUser(outsiderId, rows[2].email, rows[2].displayName);

    const folder = await createFolder(admin, { name: `${prefix} งาน`, parentId: null }, audit);
    folderId = folder.id;
    created.push(folderId);

    const shut = await createFolder(admin, { name: `${prefix} ปิด`, parentId: null }, audit);
    privateFolderId = shut.id;
    created.push(privateFolderId);
    await prisma.resource.update({
      where: { id: privateFolderId },
      data: { visibility: 'RESTRICTED' },
    });

    const category = await createCategory(admin, { name: `${prefix} ใบกำกับภาษี` });
    categoryId = category.id;
  });

  after(async () => {
    const ids = new Set(created.filter(Boolean));
    for (let depth = 0; depth < 6; depth += 1) {
      const children = await prisma.resource.findMany({
        where: { parentId: { in: [...ids] } },
        select: { id: true },
      });
      const size = ids.size;
      for (const child of children) ids.add(child.id);
      if (ids.size === size) break;
    }
    const all = [...ids];

    await prisma.savedSearch.deleteMany({ where: { userId: { in: [adminId, memberId, outsiderId] } } });
    const indexes = await prisma.resourceSearchIndex.findMany({
      where: { resourceId: { in: all } },
      select: { id: true },
    });
    await prisma.resourceTextCorrection.deleteMany({
      where: { resourceSearchIndexId: { in: indexes.map((row) => row.id) } },
    });
    await prisma.activityLog.deleteMany({ where: { userId: { in: [adminId, memberId, outsiderId] } } });
    await prisma.activityLog.deleteMany({ where: { resourceId: { in: all } } });
    await prisma.resourceTag.deleteMany({ where: { resourceId: { in: all } } });
    await prisma.resourceSearchIndex.deleteMany({ where: { resourceId: { in: all } } });
    await prisma.resourceVersion.deleteMany({ where: { resourceId: { in: all } } });
    for (let pass = 0; pass < 6; pass += 1) {
      const left = await prisma.resource.findMany({ where: { id: { in: all } }, select: { id: true } });
      if (left.length === 0) break;
      await prisma.resource.deleteMany({ where: { parentId: { not: null }, id: { in: all } } });
      await prisma.resource.deleteMany({ where: { parentId: null, id: { in: all } } });
    }
    await prisma.tag.deleteMany({ where: { createdById: { in: [adminId, memberId] } } });
    await prisma.documentCategory.deleteMany({ where: { createdById: adminId } });
    await prisma.user.deleteMany({ where: { id: { in: [adminId, memberId, outsiderId] } } });
  });

  /* ---------------- ตัวกรอง ---------------- */

  describe('ตัวกรองขั้นสูง', () => {
    test('กลุ่มชนิดไฟล์แปลงเป็นเงื่อนไขที่ถูกต้อง ไม่บังคับให้ผู้ใช้รู้จัก MIME', () => {
      assert.deepEqual(fileKindWhere('folder'), { type: 'FOLDER' });
      const pdf = fileKindWhere('pdf') as { extension: { in: string[] } };
      assert.deepEqual(pdf.extension.in, ['pdf']);
      const excel = fileKindWhere('excel') as { extension: { in: string[] } };
      assert.ok(excel.extension.in.includes('xlsx'));
      // "อื่น ๆ" นิยามด้วยการยกเว้น จึงต้องไม่ใช่รายชื่อนามสกุลตายตัว
      const other = fileKindWhere('other') as { OR: unknown[] };
      assert.equal(other.OR.length, 2);
    });

    test('ช่วงวันที่คำนวณจากเวลาปัจจุบันของเซิร์ฟเวอร์', () => {
      const now = new Date('2026-09-15T10:00:00Z');
      const today = resolveDateRange('today', undefined, undefined, now)!;
      assert.ok(today.gte! <= now);
      const month = resolveDateRange('thisMonth', undefined, undefined, now)!;
      assert.equal(month.gte!.getMonth(), now.getMonth());
      assert.equal(month.gte!.getDate(), 1);
      // ไม่ระบุอะไรเลยต้องไม่กรอง ไม่ใช่กรองจนไม่เหลืออะไร
      assert.equal(resolveDateRange(undefined, undefined, undefined, now), null);
    });

    test('การเรียงที่ฐานข้อมูลทำได้จริงเท่านั้น - "เกี่ยวข้องมากที่สุด" ไม่ถูกส่งลงไป', () => {
      assert.deepEqual(orderByFor('name'), [{ normalizedName: 'asc' }, { id: 'asc' }]);
      assert.deepEqual(orderByFor('largest'), [{ size: 'desc' }, { id: 'asc' }]);
      // relevance ตกไปใช้ค่าเริ่มต้น เพราะฐานข้อมูลไม่รู้จักคำค้น
      assert.deepEqual(orderByFor('relevance'), orderByFor(undefined));
    });

    test('กรองตามชนิดไฟล์ได้ผลจริงจากฐานข้อมูล', async () => {
      await upload(`${prefix}-เอกสาร.txt`, 'เนื้อหาข้อความ');
      const result = await searchResources(
        { q: prefix, limit: 50, filters: { fileKind: 'text' } },
        admin,
      );
      assert.ok(result.items.length > 0);
      assert.ok(result.items.every((item) => item.name.endsWith('.txt')));
    });

    test('กรองประเภทเอกสารและ "ยังไม่จัดประเภท" ให้ผลตรงข้ามกัน', async () => {
      const id = await upload(`${prefix}-จัดประเภท.txt`, 'เอกสารที่จะถูกจัดประเภท');
      await prisma.resource.update({ where: { id }, data: { documentCategoryId: categoryId } });

      const inCategory = await searchResources(
        { q: prefix, limit: 50, filters: { documentCategoryId: categoryId } },
        admin,
      );
      assert.ok(inCategory.items.some((item) => item.id === id));

      const uncategorized = await searchResources(
        { q: prefix, limit: 50, filters: { uncategorizedOnly: true } },
        admin,
      );
      assert.equal(uncategorized.items.some((item) => item.id === id), false);
    });

    test('ตัวกรองไม่มีทางทำให้เห็นเอกสารที่เดิมมองไม่เห็น', async () => {
      const secret = await uploadFile(
        admin,
        stream('ความลับที่คนอื่นต้องไม่เห็น'),
        { parentId: privateFolderId, fileName: `${prefix}-ลับ.txt`, allowDuplicateContent: true },
        audit,
      );
      created.push(secret.resource.id);
      await prisma.resource.update({
        where: { id: secret.resource.id },
        data: { visibility: 'RESTRICTED' },
      });
      await drainAll();

      // ลองใช้ตัวกรองทุกแบบที่อาจถูกคิดว่าเป็นทางลัด
      for (const filters of [
        {},
        { hasText: true },
        { ocrState: 'READY' as const },
        { fileKind: 'text' as const },
        { sort: 'newest' as const },
      ]) {
        const result = await searchResources({ q: prefix, limit: 50, filters }, outsider);
        assert.equal(
          result.items.some((item) => item.id === secret.resource.id),
          false,
          `ตัวกรอง ${JSON.stringify(filters)} ต้องไม่เปิดทางให้เห็นเอกสารที่ไม่มีสิทธิ์`,
        );
      }
    });
  });

  /* ---------------- ชุดค้นหา ---------------- */

  describe('ชุดค้นหาที่บันทึกไว้', () => {
    test('สร้าง อ่าน และเปลี่ยนชื่อของตัวเองได้', async () => {
      const saved = await createSavedSearch(admin, {
        name: `${prefix} ภาษีเดือนนี้`,
        query: 'ภาษี',
        filters: { fileKind: 'pdf', uploadedPreset: 'thisMonth', sort: 'newest' },
      });
      savedSearchIds.push(saved.id);

      assert.equal(saved.query, 'ภาษี');
      assert.equal(saved.filters.fileKind, 'pdf');

      const fetched = await getSavedSearch(saved.id, admin);
      assert.deepEqual(fetched.filters, saved.filters, 'ตัวกรองต้องกลับมาเหมือนเดิมทุกฟิลด์');

      const renamed = await renameSavedSearch(saved.id, admin, `${prefix} ชื่อใหม่`);
      assert.equal(renamed.name, `${prefix} ชื่อใหม่`);
      assert.deepEqual(renamed.filters, saved.filters, 'การเปลี่ยนชื่อต้องไม่แตะเงื่อนไข');
    });

    test('ผู้ใช้อื่นอ่าน แก้ หรือลบชุดค้นหาของเราไม่ได้', async () => {
      const saved = await createSavedSearch(admin, {
        name: `${prefix} ส่วนตัว`,
        query: 'ลับ',
        filters: {},
      });
      savedSearchIds.push(saved.id);

      // ตอบ 404 ไม่ใช่ 403 - 403 จะเป็นการยืนยันว่ารหัสนี้มีอยู่จริง
      await assert.rejects(
        () => getSavedSearch(saved.id, member),
        (error: unknown) => error instanceof AppError && error.statusCode === 404,
      );
      await assert.rejects(
        () => renameSavedSearch(saved.id, member, 'แก้ของคนอื่น'),
        (error: unknown) => error instanceof AppError && error.statusCode === 404,
      );
      await assert.rejects(
        () => deleteSavedSearch(saved.id, member),
        (error: unknown) => error instanceof AppError && error.statusCode === 404,
      );

      // ของเดิมต้องยังอยู่ครบ
      const still = await getSavedSearch(saved.id, admin);
      assert.equal(still.name, `${prefix} ส่วนตัว`);
      assert.equal((await listSavedSearches(member)).length, 0);
    });

    test('ชื่อซ้ำในชุดของคนเดียวกันถูกปฏิเสธ', async () => {
      const name = `${prefix} ซ้ำ`;
      const first = await createSavedSearch(admin, { name, filters: {} });
      savedSearchIds.push(first.id);
      await assert.rejects(
        () => createSavedSearch(admin, { name, filters: {} }),
        (error: unknown) => error instanceof AppError && error.code === 'SAVED_SEARCH_NAME_EXISTS',
      );
    });

    test('ตัวกรองที่เก็บไว้ถูกตรวจซ้ำตอนอ่าน ไม่เชื่อ JSON ที่อยู่ในฐานข้อมูลดื้อ ๆ', async () => {
      const saved = await createSavedSearch(admin, { name: `${prefix} เพี้ยน`, filters: {} });
      savedSearchIds.push(saved.id);
      // จำลองข้อมูลที่ถูกบันทึกไว้ด้วยกติกาคนละรุ่น
      await prisma.savedSearch.update({
        where: { id: saved.id },
        data: { filters: { fileKind: 'ไม่มีชนิดนี้', อะไรก็ไม่รู้: true } },
      });
      const loaded = await getSavedSearch(saved.id, admin);
      assert.deepEqual(loaded.filters, {}, 'ตัวกรองที่ไม่ผ่านการตรวจต้องถูกตัดทิ้งทั้งชุด');
    });
  });

  /* ---------------- มุมมองอัจฉริยะ ---------------- */

  describe('มุมมองอัจฉริยะ', () => {
    test('ทุกมุมมองมี slug ไม่ซ้ำ และมีคำอธิบาย', () => {
      const slugs = SMART_VIEWS.map((view) => view.slug);
      assert.equal(new Set(slugs).size, slugs.length);
      for (const view of SMART_VIEWS) {
        assert.ok(view.name.length > 0);
        assert.ok(view.description.length > 0, `${view.slug} ต้องอธิบายว่าคัดอะไรมา`);
      }
    });

    test('"เอกสารที่ฉันดูแล" ใช้ผู้ดูแล ไม่ใช่ผู้สร้าง', () => {
      const view = findSmartView('my-responsibility')!;
      const filters = smartViewFilters(view, memberId);
      assert.equal(filters.ownerId, memberId);
      assert.equal(filters.createdById, undefined, 'ต้องไม่ผูกกับผู้สร้าง');
    });

    test('"ต้องตรวจ OCR" ไม่รวมเอกสารที่มีข้อความในไฟล์จริง', () => {
      const view = findSmartView('needs-review')!;
      assert.equal(view.filters.textSource, 'OCR');
      assert.notEqual(view.filters.textSource, 'NATIVE_TEXT');
    });

    test('มุมมองยังกรองสิทธิ์ตามปกติ ไม่ใช่ทางลัดของผู้ดูแล', async () => {
      const view = findSmartView('recent')!;
      const filters = smartViewFilters(view, outsiderId);
      const result = await searchResources({ limit: 50, filters }, outsider);
      for (const item of result.items) {
        assert.ok(item.capabilities.canView, 'ทุกรายการที่คืนต้องเปิดดูได้จริง');
      }
    });
  });

  /* ---------------- คิวตรวจ OCR ---------------- */

  describe('คิวตรวจ OCR', () => {
    /** สร้างแถวดัชนีที่ดูเหมือนผ่าน OCR มาแล้ว เพื่อทดสอบคิวโดยไม่ต้องรัน OCR จริง */
    const fakeOcrIndex = async (resourceId: string, confidence = 95) => {
      const resource = await prisma.resource.findUnique({
        where: { id: resourceId },
        select: { currentVersion: true },
      });
      await prisma.resourceSearchIndex.updateMany({
        where: { resourceId, versionNumber: resource!.currentVersion! },
        data: {
          status: 'READY',
          jobKind: 'OCR',
          textSource: 'OCR',
          ocrRequested: true,
          ocrConfidence: confidence,
          reviewStatus: 'UNREVIEWED',
        },
      });
    };

    test('ยืนยันว่าถูกต้องแล้ว โดยที่ที่มาของข้อความยังเป็น OCR', async () => {
      const id = await upload(`${prefix}-ยืนยัน.txt`, 'ข้อความที่เครื่องอ่านมาถูกแล้ว');
      await fakeOcrIndex(id);

      const result = await verifyOcrResult(id, admin);
      assert.equal(result.reviewStatus, 'VERIFIED');

      const index = await prisma.resourceSearchIndex.findFirst({
        where: { resourceId: id },
        select: { textSource: true, reviewStatus: true, reviewedById: true, correctionRevision: true },
      });
      assert.equal(
        index!.textSource,
        'OCR',
        'ไม่มีใครพิมพ์อะไรลงไป ที่มาจึงต้องยังเป็น OCR ไม่ใช่ HUMAN_CORRECTED',
      );
      assert.equal(index!.reviewStatus, 'VERIFIED');
      assert.equal(index!.reviewedById, adminId);
      assert.equal(index!.correctionRevision, 0, 'การยืนยันไม่ใช่การแก้ จึงต้องไม่มีรุ่นการแก้เกิดขึ้น');
    });

    test('การแก้ข้อความใช้บริการของ F14 และปิดงานในคิวให้เอง', async () => {
      const id = await upload(`${prefix}-แก้ไข.txt`, 'ข้อความที่เครื่องอ่านผิด');
      await fakeOcrIndex(id);

      await saveCorrection(id, admin, { text: 'ข้อความที่ถูกต้อง', expectedRevision: 0 });

      const index = await prisma.resourceSearchIndex.findFirst({
        where: { resourceId: id },
        select: { textSource: true, reviewStatus: true, correctionRevision: true },
      });
      assert.equal(index!.textSource, 'HUMAN_CORRECTED');
      assert.equal(index!.reviewStatus, 'CORRECTED');
      assert.equal(index!.correctionRevision, 1);
    });

    test('รายการที่ตรวจแล้วหลุดออกจากคิว', async () => {
      const id = await upload(`${prefix}-หลุดคิว.txt`, 'รอตรวจ');
      await fakeOcrIndex(id);

      const before = await reviewQueue(admin, {}, 50);
      assert.ok(before.items.some((item) => item.resourceId === id));

      await verifyOcrResult(id, admin);

      const after = await reviewQueue(admin, {}, 50);
      assert.equal(after.items.some((item) => item.resourceId === id), false);
      assert.ok(after.remaining < before.remaining || before.remaining === 0);
    });

    test('คิวไม่แสดงรายการที่ผู้เรียกไม่มีสิทธิ์แก้ไข', async () => {
      const secret = await uploadFile(
        admin,
        stream('เอกสารลับที่รอตรวจ'),
        { parentId: privateFolderId, fileName: `${prefix}-ลับรอตรวจ.txt`, allowDuplicateContent: true },
        audit,
      );
      created.push(secret.resource.id);
      await prisma.resource.update({
        where: { id: secret.resource.id },
        data: { visibility: 'RESTRICTED' },
      });
      await drainAll();
      await fakeOcrIndex(secret.resource.id);

      const queue = await reviewQueue(outsider, {}, 50);
      assert.equal(queue.items.some((item) => item.resourceId === secret.resource.id), false);
    });

    test('ยืนยันไม่ได้ถ้าไม่มีสิทธิ์แก้ไข', async () => {
      const secret = await uploadFile(
        admin,
        stream('เอกสารลับ'),
        { parentId: privateFolderId, fileName: `${prefix}-ห้ามยืนยัน.txt`, allowDuplicateContent: true },
        audit,
      );
      created.push(secret.resource.id);
      await prisma.resource.update({
        where: { id: secret.resource.id },
        data: { visibility: 'RESTRICTED' },
      });
      await drainAll();
      await fakeOcrIndex(secret.resource.id);

      await assert.rejects(
        () => verifyOcrResult(secret.resource.id, outsider),
        (error: unknown) => error instanceof AppError && error.statusCode >= 400,
      );
    });

    test('ไฟล์ที่ถูกล็อกยืนยันไม่ได้ - ใช้กติกาเดียวกับการแก้ไขอื่น ๆ', async () => {
      const id = await upload(`${prefix}-ล็อก.txt`, 'เอกสารที่ถูกล็อก');
      await fakeOcrIndex(id);
      await prisma.resource.update({
        where: { id },
        data: { isLocked: true, lockReason: 'ทดสอบ F15' },
      });

      await assert.rejects(
        () => verifyOcrResult(id, admin),
        (error: unknown) => error instanceof AppError && error.code === 'OCR_REVIEW_DENIED',
      );

      await prisma.resource.update({ where: { id }, data: { isLocked: false, lockReason: null } });
    });

    test('ยืนยันได้เฉพาะผลที่มาจาก OCR จริง', async () => {
      const id = await upload(`${prefix}-ข้อความปกติ.txt`, 'ข้อความที่อยู่ในไฟล์จริง');
      // ไม่แตะดัชนี - ยังเป็น NATIVE_TEXT
      await assert.rejects(
        () => verifyOcrResult(id, admin),
        (error: unknown) => error instanceof AppError && error.code === 'OCR_REVIEW_NOT_APPLICABLE',
      );
    });

    test('ตัวเลขสรุปนับจากสถานะจริง', async () => {
      const summary = await reviewSummary();
      for (const value of Object.values(summary)) {
        assert.equal(typeof value, 'number');
        assert.ok(value >= 0);
      }
    });
  });

  /* ---------------- ประเภทเอกสาร ---------------- */

  describe('ประเภทเอกสาร', () => {
    test('slug คงอักษรไทยไว้และตัดอักขระที่ใช้ใน URL ไม่ได้', () => {
      assert.equal(slugify('ใบกำกับภาษี'), 'ใบกำกับภาษี');
      assert.equal(slugify('งบ/การเงิน'), 'งบ-การเงิน');
      assert.ok(slugify('  ').length > 0, 'ชื่อว่างต้องยังได้ slug ที่ใช้ได้');
    });

    test('สร้าง เปลี่ยนชื่อ และปิดการใช้งานได้', async () => {
      const category = await createCategory(admin, { name: `${prefix} สัญญา` });
      assert.equal(category.isActive, true);

      const renamed = await updateCategory(category.id, admin, { name: `${prefix} สัญญาจ้าง` });
      assert.equal(renamed.name, `${prefix} สัญญาจ้าง`);
      assert.equal(renamed.slug, category.slug, 'slug ต้องไม่เปลี่ยนตามชื่อ ไม่อย่างนั้นลิงก์เก่าจะพัง');

      const disabled = await updateCategory(category.id, admin, { isActive: false });
      assert.equal(disabled.isActive, false);

      // ผู้ใช้ทั่วไปต้องไม่เห็นประเภทที่ปิดไว้
      const visible = await listCategories(member);
      assert.equal(visible.some((row) => row.id === category.id), false);

      await deleteCategory(category.id, admin);
    });

    test('ผู้ใช้ทั่วไปสร้างหรือแก้ประเภทไม่ได้', async () => {
      await assert.rejects(
        () => createCategory(member, { name: `${prefix} ห้ามสร้าง` }),
        (error: unknown) => error instanceof AppError && error.code === 'CATEGORY_DENIED',
      );
      await assert.rejects(
        () => updateCategory(categoryId, member, { name: 'แก้ไม่ได้' }),
        (error: unknown) => error instanceof AppError && error.code === 'CATEGORY_DENIED',
      );
    });

    test('ลบประเภทที่ยังมีเอกสารใช้อยู่ไม่ได้ - ต้องปิดการใช้งานแทน', async () => {
      const category = await createCategory(admin, { name: `${prefix} ใช้อยู่` });
      const id = await upload(`${prefix}-ผูกประเภท.txt`, 'เอกสาร');
      await prisma.resource.update({ where: { id }, data: { documentCategoryId: category.id } });

      await assert.rejects(
        () => deleteCategory(category.id, admin),
        (error: unknown) => error instanceof AppError && error.code === 'CATEGORY_IN_USE',
      );

      await prisma.resource.update({ where: { id }, data: { documentCategoryId: null } });
      await deleteCategory(category.id, admin);
    });
  });

  /* ---------------- งานหลายรายการ ---------------- */

  describe('แก้ข้อมูลหลายรายการ', () => {
    test('ติดแท็กให้หลายรายการโดยไม่ลบแท็กเดิม', async () => {
      const a = await upload(`${prefix}-แท็ก-ก.txt`, 'ก');
      const b = await upload(`${prefix}-แท็ก-ข.txt`, 'ข');

      await bulkAddTag([a], `${prefix}-เดิม`, admin, audit);
      const result = await bulkAddTag([a, b], `${prefix}-ใหม่`, admin, audit);

      assert.equal(result.succeeded, 2);
      assert.equal(result.failed, 0);
      assert.ok(result.batchId.length > 0);

      const tagsOfA = await prisma.resourceTag.findMany({
        where: { resourceId: a },
        select: { tag: { select: { name: true } } },
      });
      assert.equal(tagsOfA.length, 2, 'แท็กเดิมต้องยังอยู่');
    });

    test('ชุดที่ผสมรายการที่ไม่มีสิทธิ์ ต้องแก้เฉพาะรายการที่มีสิทธิ์', async () => {
      const allowed = await upload(`${prefix}-อนุญาต.txt`, 'แก้ได้');
      const denied = await uploadFile(
        admin,
        stream('แก้ไม่ได้'),
        { parentId: privateFolderId, fileName: `${prefix}-ห้าม.txt`, allowDuplicateContent: true },
        audit,
      );
      created.push(denied.resource.id);
      await prisma.resource.update({
        where: { id: denied.resource.id },
        data: { visibility: 'RESTRICTED' },
      });
      await drainAll();

      const before = await prisma.resource.findUnique({
        where: { id: denied.resource.id },
        select: { documentCategoryId: true },
      });

      const result = await bulkSetCategory(
        [allowed, denied.resource.id],
        categoryId,
        outsider,
        audit,
      );

      /**
       * นี่คือชุดที่ผสมของที่มีสิทธิ์กับของที่ไม่มีสิทธิ์
       * รายการที่อยู่ในโฟลเดอร์เปิดขององค์กรแก้ได้ ส่วนรายการที่ถูกจำกัดไว้แก้ไม่ได้
       * การมีรายการหนึ่งที่ผ่าน ต้องไม่ทำให้ทั้งชุดผ่าน
       */
      assert.equal(result.succeeded, 1, 'ต้องแก้ได้เฉพาะรายการที่มีสิทธิ์');
      assert.equal(result.failed, 1, 'รายการที่ไม่มีสิทธิ์ต้องถูกนับว่าล้มเหลว');
      assert.ok(result.errors.some((e) => e.resourceId === denied.resource.id));

      const after = await prisma.resource.findUnique({
        where: { id: denied.resource.id },
        select: { documentCategoryId: true },
      });
      assert.deepEqual(after, before, 'รายการที่ไม่มีสิทธิ์ต้องไม่ถูกแตะเลย');
    });

    test('โฟลเดอร์ถูกข้ามเมื่อกำหนดประเภทเอกสาร และรายงานตามจริง', async () => {
      const file = await upload(`${prefix}-ไฟล์จัดประเภท.txt`, 'ไฟล์');
      const result = await bulkSetCategory([file, folderId], categoryId, admin, audit);

      assert.equal(result.succeeded, 1);
      assert.equal(result.skipped, 1, 'โฟลเดอร์ต้องถูกนับเป็น "ข้าม" ไม่ใช่ "ล้มเหลว"');
      assert.equal(result.failed, 0);
    });

    test('เปลี่ยนผู้ดูแลหลายรายการ และปฏิเสธผู้รับโอนที่ไม่ใช่บัญชีภายในที่เปิดใช้งาน', async () => {
      const id = await upload(`${prefix}-โอน.txt`, 'เอกสาร');
      const result = await bulkSetOwner([id], memberId, admin, audit);
      assert.equal(result.succeeded, 1);

      const row = await prisma.resource.findUnique({ where: { id }, select: { ownerId: true } });
      assert.equal(row!.ownerId, memberId);

      await assert.rejects(
        () => bulkSetOwner([id], 'ไม่มีผู้ใช้นี้', admin, audit),
        (error: unknown) => error instanceof AppError && error.code === 'OWNER_NOT_FOUND',
      );
    });

    test('audit ของงานหลายรายการเก็บจำนวน ไม่ใช่รายชื่อทรัพยากรทั้งหมด', async () => {
      const id = await upload(`${prefix}-audit.txt`, 'เอกสาร');
      const result = await bulkAddTag([id], `${prefix}-audit`, admin, audit);

      const log = await prisma.activityLog.findFirst({
        where: { userId: adminId, action: 'BULK_TAG_ADDED' },
        orderBy: { createdAt: 'desc' },
      });
      assert.ok(log);
      const metadata = log!.metadata as Record<string, unknown>;
      assert.equal(metadata.batchId, result.batchId);
      assert.equal(typeof metadata.succeeded, 'number');
      // ต้องไม่มีรายชื่อทรัพยากรยาว ๆ อยู่ใน metadata
      assert.ok(JSON.stringify(metadata).length < 500);
    });

    test('ชุดที่ใหญ่เกินเพดานถูกปฏิเสธตั้งแต่ต้น', async () => {
      const many = Array.from({ length: 201 }, (_, index) => `id-${index}`);
      await assert.rejects(
        () => bulkAddTag(many, 'ไม่ควรถึงตรงนี้', admin, audit),
        (error: unknown) => error instanceof AppError && error.code === 'BULK_TOO_MANY',
      );
    });
  });
});

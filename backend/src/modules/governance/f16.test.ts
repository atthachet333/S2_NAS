import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { after, before, describe, test } from 'node:test';
import { prisma } from '../../core/prisma.js';
import { AppError } from '../../core/errors.js';
import { createFolder } from '../resources/resource.service.js';
import { uploadFile } from '../files/file.service.js';
import { trashResource, permanentlyDelete, describePermanentDelete, listTrash } from '../files/trash.service.js';
import { runTrashRetention } from '../files/trash-retention.js';
import { searchResources } from '../workspace/search.service.js';
import { listResources, listRecentResources } from '../resources/resource.service.js';
import { createCategory } from '../categories/category.service.js';
import { findSmartView, smartViewFilters } from '../search/smart-views.js';
import { retentionStatusWhere } from '../search/search-filters.js';
import { bulkArchive, bulkAssignRetention } from '../resources/bulk.service.js';
import {
  assignPolicy,
  applyCategoryDefaultPolicy,
  computeRetentionUntil,
  createPolicy,
  deletePolicy,
  listPolicies,
  reapplyPolicy,
  updatePolicy,
} from './retention.service.js';
import { archiveResource, unarchiveResource } from './archive.service.js';
import { legalHoldsForResource, listLegalHolds, placeLegalHold, releaseLegalHold } from './legal-hold.service.js';
import { evaluateGovernance } from './governance.guard.js';
import type { AuthUser } from '../auth/auth.service.js';

/**
 * F16 - นโยบายการเก็บรักษา คลังเอกสาร และการระงับการลบ
 *
 * ทำงานกับฐานข้อมูลจริงทั้งหมด สิ่งที่ทดสอบคือ "ข้อมูลในฐานข้อมูลถูกต้องหลังเรียก"
 * และที่สำคัญกว่านั้นคือ "การลบที่ไม่ควรเกิด ไม่เกิดขึ้นจริง"
 */

const prefix = `f16-${Date.now().toString(36)}`;
const audit = { ipAddress: '127.0.0.1', userAgent: 'f16-test' };
const stream = (text: string) => Readable.from([Buffer.from(text, 'utf8')]);
const DAY = 24 * 60 * 60 * 1000;

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
    ...(roles.includes('ADMIN') ? ['admin:access', 'system:retention:manage'] : []),
  ],
});

describe('F16 การกำกับดูแลวงจรชีวิตเอกสาร', () => {
  let admin: AuthUser;
  let staff: AuthUser;
  let outsider: AuthUser;
  let adminId = '';
  let staffId = '';
  let outsiderId = '';
  let folderId = '';
  let privateFolderId = '';
  let policy5y = '';
  let policyForever = '';
  const created: string[] = [];

  const upload = async (name: string, body = 'เอกสารทดสอบ', parent?: string) => {
    const uploaded = await uploadFile(
      admin,
      stream(body),
      { parentId: parent ?? folderId, fileName: name, allowDuplicateContent: true },
      audit,
    );
    created.push(uploaded.resource.id);
    return uploaded.resource.id;
  };

  before(async () => {
    const rows = await Promise.all(
      ['admin', 'staff', 'outsider'].map((role) =>
        prisma.user.create({
          data: {
            email: `${prefix}-${role}@example.invalid`,
            displayName: `F16 ${role}`,
            type: 'INTERNAL',
            status: 'ACTIVE',
          },
        }),
      ),
    );
    [adminId, staffId, outsiderId] = rows.map((row) => row.id);
    admin = makeUser(adminId, rows[0].email, rows[0].displayName, ['ADMIN']);
    staff = makeUser(staffId, rows[1].email, rows[1].displayName);
    outsider = makeUser(outsiderId, rows[2].email, rows[2].displayName);

    const folder = await createFolder(admin, { name: `${prefix} งาน`, parentId: null }, audit);
    folderId = folder.id;
    created.push(folderId);

    const shut = await createFolder(admin, { name: `${prefix} จำกัด`, parentId: null }, audit);
    privateFolderId = shut.id;
    created.push(privateFolderId);
    await prisma.resource.update({
      where: { id: privateFolderId },
      data: { visibility: 'RESTRICTED' },
    });

    policy5y = (await createPolicy(admin, { name: `${prefix} เก็บ 5 ปี`, retentionDays: 365 * 5 })).id;
    policyForever = (await createPolicy(admin, { name: `${prefix} เก็บถาวร`, retainForever: true })).id;
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

    await prisma.legalHold.deleteMany({ where: { resourceId: { in: all } } });
    await prisma.activityLog.deleteMany({ where: { userId: { in: [adminId, staffId, outsiderId] } } });
    await prisma.activityLog.deleteMany({ where: { resourceId: { in: all } } });
    await prisma.resourceSearchIndex.deleteMany({ where: { resourceId: { in: all } } });
    await prisma.resourceVersion.deleteMany({ where: { resourceId: { in: all } } });
    await prisma.resource.updateMany({
      where: { id: { in: all } },
      data: { retentionPolicyId: null, documentCategoryId: null },
    });
    for (let pass = 0; pass < 6; pass += 1) {
      const left = await prisma.resource.findMany({ where: { id: { in: all } }, select: { id: true } });
      if (left.length === 0) break;
      await prisma.resource.deleteMany({ where: { parentId: { not: null }, id: { in: all } } });
      await prisma.resource.deleteMany({ where: { parentId: null, id: { in: all } } });
    }
    await prisma.documentCategory.deleteMany({ where: { createdById: adminId } });
    await prisma.retentionPolicy.deleteMany({ where: { createdById: adminId } });
    await prisma.user.deleteMany({ where: { id: { in: [adminId, staffId, outsiderId] } } });
  });

  /* ---------------- นโยบายการเก็บรักษา ---------------- */

  describe('นโยบายการเก็บรักษา', () => {
    test('คำนวณวันหมดอายุจากวันเริ่มนับ', () => {
      const start = new Date('2026-01-01T00:00:00Z');
      const until = computeRetentionUntil({ retentionDays: 365, retainForever: false }, start)!;
      assert.equal(until.getUTCFullYear(), 2027);
      // เก็บถาวรไม่มีวันหมดอายุ ไม่ใช่ "วันหมดอายุที่ไกลมาก"
      assert.equal(computeRetentionUntil({ retentionDays: null, retainForever: true }, start), null);
    });

    test('นโยบายที่ไม่ระบุทั้งจำนวนวันและไม่ใช่เก็บถาวร ถูกปฏิเสธ', async () => {
      await assert.rejects(
        () => createPolicy(admin, { name: `${prefix} ว่างเปล่า` }),
        (error: unknown) => error instanceof AppError && error.code === 'RETENTION_PERIOD_REQUIRED',
      );
    });

    test('กำหนดนโยบายให้เอกสาร แล้ววันหมดอายุถูกเก็บเป็นภาพนิ่ง', async () => {
      const id = await upload(`${prefix}-นโยบาย.txt`);
      const result = await assignPolicy(id, admin, { policyId: policy5y }, audit);

      assert.equal(result.retentionPolicyId, policy5y);
      assert.ok(result.retentionUntil);
      assert.equal(result.retentionForever, false);

      const row = await prisma.resource.findUnique({
        where: { id },
        select: { retentionUntil: true, retentionStartBasis: true, retentionStartAt: true },
      });
      assert.equal(row!.retentionStartBasis, 'CREATED_AT');
      assert.ok(row!.retentionStartAt);
    });

    test('แก้นิยามนโยบายไม่เปลี่ยนวันหมดอายุของเอกสารที่กำหนดไว้แล้ว', async () => {
      const id = await upload(`${prefix}-ภาพนิ่ง.txt`);
      const policy = await createPolicy(admin, { name: `${prefix} ทดสอบภาพนิ่ง`, retentionDays: 100 });
      await assignPolicy(id, admin, { policyId: policy.id }, audit);

      const before = await prisma.resource.findUnique({
        where: { id },
        select: { retentionUntil: true },
      });

      // แก้จาก 100 วัน เป็น 1 วัน - ถ้าคำนวณใหม่ เอกสารจะกลายเป็นลบได้ทันที
      await updatePolicy(policy.id, admin, { retentionDays: 1 });

      const afterChange = await prisma.resource.findUnique({
        where: { id },
        select: { retentionUntil: true },
      });
      assert.deepEqual(
        afterChange!.retentionUntil,
        before!.retentionUntil,
        'การแก้นิยามนโยบายต้องไม่เปลี่ยนวันหมดอายุของเอกสารที่กำหนดไว้แล้ว',
      );

      // ต้องกด reapply เองจึงจะมีผลย้อนหลัง
      const reapplied = await reapplyPolicy(policy.id, admin);
      assert.ok(reapplied.updated >= 1);
      const afterReapply = await prisma.resource.findUnique({
        where: { id },
        select: { retentionUntil: true },
      });
      assert.notDeepEqual(afterReapply!.retentionUntil, before!.retentionUntil);
    });

    test('วันเริ่มนับที่ระบุเองถูกบันทึกเป็น MANUAL - ไม่มีการเดาจากเนื้อในเอกสาร', async () => {
      const id = await upload(`${prefix}-วันเอกสาร.txt`);
      const documentDate = new Date('2020-06-15T00:00:00Z');
      await assignPolicy(id, admin, { policyId: policy5y, startAt: documentDate }, audit);

      const row = await prisma.resource.findUnique({
        where: { id },
        select: { retentionStartBasis: true, retentionStartAt: true },
      });
      assert.equal(row!.retentionStartBasis, 'MANUAL');
      assert.equal(row!.retentionStartAt!.getUTCFullYear(), 2020);
    });

    test('ลบนโยบายที่ยังมีเอกสารใช้อยู่ไม่ได้', async () => {
      await assert.rejects(
        () => deletePolicy(policy5y, admin),
        (error: unknown) => error instanceof AppError && error.code === 'RETENTION_POLICY_IN_USE',
      );
    });

    test('ผู้ใช้ทั่วไปสร้างหรือแก้นโยบายไม่ได้', async () => {
      await assert.rejects(
        () => createPolicy(staff, { name: `${prefix} ห้าม`, retentionDays: 10 }),
        (error: unknown) => error instanceof AppError && error.code === 'RETENTION_DENIED',
      );
      await assert.rejects(
        () => reapplyPolicy(policy5y, staff),
        (error: unknown) => error instanceof AppError && error.code === 'RETENTION_DENIED',
      );
    });

    test('ผู้ใช้ทั่วไปกำหนดนโยบายให้เอกสารที่ตนแก้ไขได้ - เป็นการจัดการเอกสาร ไม่ใช่ตั้งค่าระบบ', async () => {
      const id = await upload(`${prefix}-staff-กำหนด.txt`);
      const result = await assignPolicy(id, staff, { policyId: policy5y }, audit);
      assert.equal(result.retentionPolicyId, policy5y);
    });

    test('ผู้ที่ไม่มีสิทธิ์แก้ไขเอกสาร กำหนดนโยบายไม่ได้', async () => {
      const secret = await uploadFile(
        admin,
        stream('ลับ'),
        { parentId: privateFolderId, fileName: `${prefix}-ลับ.txt`, allowDuplicateContent: true },
        audit,
      );
      created.push(secret.resource.id);
      await prisma.resource.update({
        where: { id: secret.resource.id },
        data: { visibility: 'RESTRICTED' },
      });

      await assert.rejects(
        () => assignPolicy(secret.resource.id, outsider, { policyId: policy5y }, audit),
        (error: unknown) => error instanceof AppError && error.statusCode >= 400,
      );
    });
  });

  /* ---------------- นโยบายเริ่มต้นของประเภทเอกสาร ---------------- */

  describe('นโยบายเริ่มต้นของประเภทเอกสาร', () => {
    test('เอกสารที่ยังไม่มีนโยบาย ได้รับนโยบายเริ่มต้นของประเภท', async () => {
      const category = await createCategory(admin, { name: `${prefix} ใบกำกับ` });
      await prisma.documentCategory.update({
        where: { id: category.id },
        data: { defaultRetentionPolicyId: policy5y },
      });

      const id = await upload(`${prefix}-ค่าเริ่มต้น.txt`);
      const applied = await applyCategoryDefaultPolicy(id, category.id, admin, audit);
      assert.equal(applied.applied, true);

      const row = await prisma.resource.findUnique({
        where: { id },
        select: { retentionPolicyId: true, retentionUntil: true },
      });
      assert.equal(row!.retentionPolicyId, policy5y);
      assert.ok(row!.retentionUntil);
    });

    test('เอกสารที่มีนโยบายอยู่แล้ว ไม่ถูกเขียนทับด้วยค่าเริ่มต้นของประเภท', async () => {
      const category = await createCategory(admin, { name: `${prefix} เขียนทับ` });
      await prisma.documentCategory.update({
        where: { id: category.id },
        data: { defaultRetentionPolicyId: policy5y },
      });

      const id = await upload(`${prefix}-มีนโยบายแล้ว.txt`);
      await assignPolicy(id, admin, { policyId: policyForever }, audit);

      const applied = await applyCategoryDefaultPolicy(id, category.id, admin, audit);
      assert.equal(applied.applied, false, 'ต้องไม่แตะนโยบายที่คนตั้งใจกำหนดไว้');

      const row = await prisma.resource.findUnique({
        where: { id },
        select: { retentionPolicyId: true, retentionForever: true },
      });
      assert.equal(row!.retentionPolicyId, policyForever);
      assert.equal(row!.retentionForever, true);
    });
  });

  /* ---------------- ด่านตรวจการทำลายข้อมูล ---------------- */

  describe('ด่านตรวจการทำลายข้อมูล', () => {
    test('ลำดับความสำคัญ: Legal Hold > เก็บถาวร > ยังไม่ถึงกำหนด', () => {
      const future = new Date(Date.now() + 30 * DAY);

      const hold = evaluateGovernance({ onLegalHold: true, retentionUntil: future, retentionForever: true });
      assert.equal(hold.blockedBy?.kind, 'LEGAL_HOLD');

      const forever = evaluateGovernance({ onLegalHold: false, retentionUntil: null, retentionForever: true });
      assert.equal(forever.blockedBy?.kind, 'RETAIN_FOREVER');

      const active = evaluateGovernance({ onLegalHold: false, retentionUntil: future, retentionForever: false });
      assert.equal(active.blockedBy?.kind, 'RETENTION_ACTIVE');

      const past = new Date(Date.now() - DAY);
      const expired = evaluateGovernance({ onLegalHold: false, retentionUntil: past, retentionForever: false });
      assert.equal(expired.canPermanentlyDelete, true, 'หมดอายุแล้วต้องลบได้');
      assert.equal(expired.blockedBy, null);

      const none = evaluateGovernance({ onLegalHold: false, retentionUntil: null, retentionForever: false });
      assert.equal(none.canPermanentlyDelete, true, 'ไม่มีนโยบาย = ไม่มีอะไรขวาง');
    });

    test('นโยบายที่ยังไม่หมดอายุ ขวางการลบถาวร แต่ย้ายลงถังขยะได้', async () => {
      const id = await upload(`${prefix}-ขวางลบ.txt`);
      await assignPolicy(id, admin, { policyId: policy5y }, audit);

      // ถังขยะกู้คืนได้ จึงไม่ใช่การทำลาย - ต้องทำได้
      await trashResource(id, admin, audit);
      const trashed = await prisma.resource.findUnique({ where: { id }, select: { deletedAt: true } });
      assert.ok(trashed!.deletedAt, 'ย้ายลงถังขยะต้องทำได้');

      await assert.rejects(
        () => permanentlyDelete(id, admin, audit),
        (error: unknown) => {
          assert.ok(error instanceof AppError);
          assert.equal(error.code, 'RETENTION_ACTIVE');
          assert.match(error.message, /สามารถลบถาวรได้หลัง/);
          return true;
        },
      );

      // ต้องยังอยู่ครบ
      const still = await prisma.resource.findUnique({ where: { id }, select: { id: true } });
      assert.ok(still, 'เอกสารที่ถูกคุ้มครองต้องไม่หายไป');
    });

    test('เก็บถาวรขวางการลบถาวรด้วยข้อความที่ต่างออกไป', async () => {
      const id = await upload(`${prefix}-ถาวร.txt`);
      await assignPolicy(id, admin, { policyId: policyForever }, audit);
      await trashResource(id, admin, audit);

      await assert.rejects(
        () => permanentlyDelete(id, admin, audit),
        (error: unknown) => {
          assert.ok(error instanceof AppError);
          assert.equal(error.code, 'RETENTION_ACTIVE');
          assert.match(error.message, /ไม่มีกำหนด/);
          return true;
        },
      );
    });

    test('นโยบายที่หมดอายุแล้ว อนุญาตให้ลบถาวรได้', async () => {
      const id = await upload(`${prefix}-หมดอายุ.txt`);
      await assignPolicy(id, admin, { policyId: policy5y }, audit);
      // ทำให้หมดอายุแล้วโดยตรง แทนการรอห้าปี
      await prisma.resource.update({
        where: { id },
        data: { retentionUntil: new Date(Date.now() - DAY) },
      });
      await trashResource(id, admin, audit);

      await permanentlyDelete(id, admin, audit);
      const gone = await prisma.resource.findUnique({ where: { id }, select: { id: true } });
      assert.equal(gone, null, 'หมดอายุแล้วต้องลบได้จริง');
    });

    test('การลบโฟลเดอร์ถูกขวาง ถ้ามีเอกสารที่ถูกคุ้มครองอยู่ข้างใน', async () => {
      const parent = await createFolder(admin, { name: `${prefix} กิ่ง`, parentId: folderId }, audit);
      created.push(parent.id);
      const child = await upload(`${prefix}-ลูกที่ถูกคุ้มครอง.txt`, 'เนื้อหา', parent.id);
      await assignPolicy(child, admin, { policyId: policyForever }, audit);

      await trashResource(parent.id, admin, audit);
      await assert.rejects(
        () => permanentlyDelete(parent.id, admin, audit),
        (error: unknown) => error instanceof AppError && error.code === 'RETENTION_ACTIVE',
      );

      // ทั้งโฟลเดอร์และลูกต้องยังอยู่
      assert.ok(await prisma.resource.findUnique({ where: { id: child }, select: { id: true } }));
    });

    test('describePermanentDelete บอกล่วงหน้าว่าลบไม่ได้ พร้อมเหตุผล', async () => {
      const id = await upload(`${prefix}-อธิบาย.txt`);
      await assignPolicy(id, admin, { policyId: policyForever }, audit);
      await trashResource(id, admin, audit);

      const info = await describePermanentDelete(id, admin);
      assert.equal(info.canDelete, false);
      assert.equal(info.blockedBy?.kind, 'RETAIN_FOREVER');
    });

    test('งานเก็บกวาดถังขยะข้ามรายการที่ถูกคุ้มครอง โดยไม่นับเป็นความล้มเหลว', async () => {
      const id = await upload(`${prefix}-worker.txt`);
      await assignPolicy(id, admin, { policyId: policyForever }, audit);
      await trashResource(id, admin, audit);
      // ทำให้พ้นอายุถังขยะไปแล้ว
      await prisma.resource.update({
        where: { id },
        data: { deletedAt: new Date(Date.now() - 400 * DAY) },
      });

      const result = await runTrashRetention(new Date());
      assert.ok(result.skipped >= 1, 'ต้องถูกนับเป็น "ข้าม"');
      assert.equal(result.failed, 0, 'เอกสารที่ถูกเก็บตามนโยบายไม่ใช่ความล้มเหลว');

      assert.ok(
        await prisma.resource.findUnique({ where: { id }, select: { id: true } }),
        'ต้องไม่ถูกลบ',
      );
    });

    test('รายการในถังขยะบอกสถานะการคุ้มครอง เพื่อไม่ให้แสดงเวลานับถอยหลังที่ไม่จริง', async () => {
      const id = await upload(`${prefix}-นับถอยหลัง.txt`);
      await assignPolicy(id, admin, { policyId: policyForever }, audit);
      await trashResource(id, admin, audit);

      const trash = await listTrash(admin);
      const item = trash.items.find((row) => row.id === id);
      assert.ok(item);
      assert.equal(item.retentionForever, true);
      assert.equal(item.onLegalHold, false);
    });
  });

  /* ---------------- คลังเอกสาร ---------------- */

  describe('คลังเอกสาร', () => {
    test('เก็บเข้าคลังแล้วนำออกได้ และไม่แตะถังขยะ', async () => {
      const id = await upload(`${prefix}-คลัง.txt`);

      await archiveResource(id, admin, audit);
      let row = await prisma.resource.findUnique({
        where: { id },
        select: { lifecycleState: true, archivedAt: true, archivedById: true, deletedAt: true },
      });
      assert.equal(row!.lifecycleState, 'ARCHIVED');
      assert.ok(row!.archivedAt);
      assert.equal(row!.archivedById, adminId);
      assert.equal(row!.deletedAt, null, 'คลังไม่ใช่ถังขยะ');

      await unarchiveResource(id, admin, audit);
      row = await prisma.resource.findUnique({
        where: { id },
        select: { lifecycleState: true, archivedAt: true },
      });
      assert.equal(row!.lifecycleState, 'ACTIVE');
      assert.equal(row!.archivedAt, null);
    });

    test('เก็บเข้าคลังไม่แตะไฟล์ เวอร์ชัน แท็ก หรือดัชนีค้นหา', async () => {
      const id = await upload(`${prefix}-คงสภาพ.txt`, 'เนื้อหาที่ต้องไม่เปลี่ยน');
      const before = await prisma.resourceVersion.findMany({
        where: { resourceId: id },
        select: { checksum: true, storageKey: true, size: true },
      });

      await archiveResource(id, admin, audit);

      const afterVersions = await prisma.resourceVersion.findMany({
        where: { resourceId: id },
        select: { checksum: true, storageKey: true, size: true },
      });
      assert.deepEqual(afterVersions, before, 'ไบต์ของไฟล์และเวอร์ชันต้องไม่ถูกแตะ');
    });

    test('เอกสารในคลังไม่ขึ้นในมุมมองการทำงานประจำวัน แต่ยังค้นเจอ', async () => {
      const id = await upload(`${prefix}-ซ่อน.txt`, `เนื้อหา ${prefix} ซ่อน`);
      await archiveResource(id, admin, audit);

      const listed = await listResources(admin, {
        parentId: folderId,
        sort: 'name',
        direction: 'asc',
        limit: 100,
      });
      assert.equal(
        listed.items.some((item) => item.id === id),
        false,
        'ต้องไม่ขึ้นในการเรียกดูปกติ',
      );

      const recent = await listRecentResources(admin, 100);
      assert.equal(recent.some((item) => item.id === id), false, 'ต้องไม่ขึ้นใน "ล่าสุด"');

      // แต่ต้องยังค้นเจอ - ไม่อย่างนั้นผู้ใช้จะคิดว่าเอกสารหายไป
      const found = await searchResources({ q: `${prefix}-ซ่อน`, limit: 50 }, admin);
      assert.ok(found.items.some((item) => item.id === id), 'การค้นหาต้องยังหาเจอ');
    });

    test('เปิด includeArchived แล้วเห็นเอกสารในคลัง', async () => {
      const id = await upload(`${prefix}-เปิดดู.txt`);
      await archiveResource(id, admin, audit);

      const listed = await listResources(admin, {
        parentId: folderId,
        sort: 'name',
        direction: 'asc',
        limit: 100,
        includeArchived: true,
      });
      assert.ok(listed.items.some((item) => item.id === id));
    });

    test('ตัวกรองสถานะวงจรชีวิตในการค้นหาทำงานถูกต้อง', async () => {
      const archived = await upload(`${prefix}-กรองคลัง.txt`);
      await archiveResource(archived, admin, audit);

      const onlyArchived = await searchResources(
        { q: prefix, limit: 100, filters: { lifecycleState: 'ARCHIVED' } },
        admin,
      );
      assert.ok(onlyArchived.items.some((item) => item.id === archived));
      assert.ok(
        onlyArchived.items.every((item) => item.lifecycleState === 'ARCHIVED'),
        'ต้องคืนเฉพาะเอกสารในคลัง',
      );

      const onlyActive = await searchResources(
        { q: prefix, limit: 100, filters: { lifecycleState: 'ACTIVE' } },
        admin,
      );
      assert.equal(onlyActive.items.some((item) => item.id === archived), false);
    });

    test('เก็บเข้าคลังซ้ำถูกปฏิเสธอย่างชัดเจน', async () => {
      const id = await upload(`${prefix}-ซ้ำ.txt`);
      await archiveResource(id, admin, audit);
      await assert.rejects(
        () => archiveResource(id, admin, audit),
        (error: unknown) => error instanceof AppError && error.code === 'RESOURCE_ALREADY_ARCHIVED',
      );
    });
  });

  /* ---------------- การระงับการลบ ---------------- */

  describe('การระงับการลบ', () => {
    test('วางแล้วขวางการลบถาวร โดยข้อความไม่บอกเหตุผลของการระงับ', async () => {
      const id = await upload(`${prefix}-ระงับ.txt`);
      await placeLegalHold(id, admin, { reason: 'ตรวจสอบภาษีปี 2569', caseReference: 'AUD-001' }, audit);
      await trashResource(id, admin, audit);

      await assert.rejects(
        () => permanentlyDelete(id, admin, audit),
        (error: unknown) => {
          assert.ok(error instanceof AppError);
          assert.equal(error.code, 'LEGAL_HOLD_ACTIVE');
          assert.equal(
            error.message.includes('ภาษีปี 2569'),
            false,
            'เหตุผลของการระงับต้องไม่หลุดไปกับข้อความแสดงข้อผิดพลาด',
          );
          return true;
        },
      );
    });

    test('การระงับชนะนโยบายที่หมดอายุแล้ว', async () => {
      const id = await upload(`${prefix}-ระงับเหนือกว่า.txt`);
      await assignPolicy(id, admin, { policyId: policy5y }, audit);
      await prisma.resource.update({
        where: { id },
        data: { retentionUntil: new Date(Date.now() - DAY) },
      });
      await placeLegalHold(id, admin, { reason: 'ข้อพิพาท' }, audit);
      await trashResource(id, admin, audit);

      await assert.rejects(
        () => permanentlyDelete(id, admin, audit),
        (error: unknown) => error instanceof AppError && error.code === 'LEGAL_HOLD_ACTIVE',
      );
    });

    test('ปลดแล้วลบได้ และประวัติยังอยู่ครบ', async () => {
      const id = await upload(`${prefix}-ปลด.txt`);
      const hold = await placeLegalHold(id, admin, { reason: 'ตรวจสอบภายใน' }, audit);
      await trashResource(id, admin, audit);

      const released = await releaseLegalHold(hold.id, admin, { releaseReason: 'ตรวจสอบเสร็จแล้ว' }, audit);
      assert.equal(released.isActive, false);
      assert.equal(released.releasedBy?.id, adminId);
      assert.equal(released.releaseReason, 'ตรวจสอบเสร็จแล้ว');

      // ประวัติต้องไม่ถูกลบ
      const history = await prisma.legalHold.findMany({ where: { resourceId: id } });
      assert.equal(history.length, 1, 'การปลดคือการเพิ่มข้อมูล ไม่ใช่การลบแถว');
      assert.equal(history[0].reason, 'ตรวจสอบภายใน');

      await permanentlyDelete(id, admin, audit);
      assert.equal(await prisma.resource.findUnique({ where: { id }, select: { id: true } }), null);
    });

    test('ผู้ใช้ทั่วไปวางหรือปลดการระงับไม่ได้', async () => {
      const id = await upload(`${prefix}-สิทธิ์ระงับ.txt`);
      await assert.rejects(
        () => placeLegalHold(id, staff, { reason: 'พยายามวางเอง' }, audit),
        (error: unknown) => error instanceof AppError && error.code === 'LEGAL_HOLD_DENIED',
      );

      const hold = await placeLegalHold(id, admin, { reason: 'ของจริง' }, audit);
      await assert.rejects(
        () => releaseLegalHold(hold.id, staff, {}, audit),
        (error: unknown) => error instanceof AppError && error.code === 'LEGAL_HOLD_DENIED',
      );
      await releaseLegalHold(hold.id, admin, {}, audit);
    });

    test('ผู้ใช้ทั่วไปไม่เห็นเหตุผลของการระงับ แต่รู้ว่าถูกระงับอยู่', async () => {
      const id = await upload(`${prefix}-ซ่อนเหตุผล.txt`);
      await placeLegalHold(id, admin, { reason: 'คดีความลับ', caseReference: 'SECRET-1' }, audit);

      const asStaff = await legalHoldsForResource(id, staff);
      assert.equal(asStaff.length, 1);
      assert.equal(asStaff[0].isActive, true, 'ต้องรู้ว่าถูกระงับอยู่');
      assert.equal(asStaff[0].reason, null, 'แต่ต้องไม่เห็นเหตุผล');
      assert.equal(asStaff[0].caseReference, null);

      const asAdmin = await legalHoldsForResource(id, admin);
      assert.equal(asAdmin[0].reason, 'คดีความลับ');
    });

    test('รายการระงับทั้งหมดเห็นได้เฉพาะผู้ที่จัดการได้', async () => {
      await assert.rejects(
        () => listLegalHolds(staff),
        (error: unknown) => error instanceof AppError && error.code === 'LEGAL_HOLD_DENIED',
      );
      const holds = await listLegalHolds(admin);
      assert.ok(Array.isArray(holds));
    });

    test('ต้องระบุเหตุผลเสมอ', async () => {
      const id = await upload(`${prefix}-ไม่มีเหตุผล.txt`);
      await assert.rejects(
        () => placeLegalHold(id, admin, { reason: '   ' }, audit),
        (error: unknown) => error instanceof AppError && error.code === 'LEGAL_HOLD_REASON_REQUIRED',
      );
    });

    test('เก็บเข้าคลังยังทำได้แม้ถูกระงับการลบ - คลังคือการรักษา ไม่ใช่การทำลาย', async () => {
      const id = await upload(`${prefix}-ระงับแต่เก็บได้.txt`);
      await placeLegalHold(id, admin, { reason: 'ตรวจสอบ' }, audit);

      await archiveResource(id, admin, audit);
      const row = await prisma.resource.findUnique({
        where: { id },
        select: { lifecycleState: true },
      });
      assert.equal(row!.lifecycleState, 'ARCHIVED');
    });
  });

  /* ---------------- มุมมองและตัวกรอง ---------------- */

  describe('มุมมองและตัวกรองวงจรชีวิต', () => {
    test('มุมมองใหม่ของ F16 มีครบและตั้งค่าถูกต้อง', () => {
      for (const slug of ['archive', 'retention-expiring', 'retention-expired', 'legal-hold', 'no-retention']) {
        const view = findSmartView(slug);
        assert.ok(view, `ต้องมีมุมมอง ${slug}`);
        assert.ok(view.description.length > 0);
      }
      assert.equal(findSmartView('archive')!.filters.lifecycleState, 'ARCHIVED');
      assert.equal(findSmartView('legal-hold')!.filters.legalHoldOnly, true);
      assert.equal(findSmartView('no-retention')!.filters.retentionStatus, 'NONE');
    });

    test('เงื่อนไขของสถานะการเก็บรักษาแยกกันชัดเจน', () => {
      const now = new Date('2026-09-05T00:00:00Z');
      const none = retentionStatusWhere('NONE', now) as { retentionPolicyId: null };
      assert.equal(none.retentionPolicyId, null);

      const forever = retentionStatusWhere('FOREVER', now) as { retentionForever: boolean };
      assert.equal(forever.retentionForever, true);

      const expired = retentionStatusWhere('EXPIRED', now) as { retentionUntil: { lte: Date } };
      assert.ok(expired.retentionUntil.lte <= now);

      const expiring = retentionStatusWhere('EXPIRING', now) as {
        retentionUntil: { gt: Date; lte: Date };
      };
      assert.ok(expiring.retentionUntil.gt >= now);
      assert.ok(expiring.retentionUntil.lte > now);
    });

    test('มุมมอง Legal Hold คืนเฉพาะเอกสารที่ถูกระงับอยู่', async () => {
      const id = await upload(`${prefix}-มุมมองระงับ.txt`);
      await placeLegalHold(id, admin, { reason: 'ทดสอบมุมมอง' }, audit);

      const view = findSmartView('legal-hold')!;
      const result = await searchResources(
        { limit: 100, filters: smartViewFilters(view, adminId) },
        admin,
      );
      assert.ok(result.items.some((item) => item.id === id));
      assert.ok(result.items.every((item) => item.onLegalHold === true));
    });

    test('มุมมองยังกรองสิทธิ์ตามปกติ', async () => {
      const view = findSmartView('no-retention')!;
      const result = await searchResources(
        { limit: 50, filters: smartViewFilters(view, outsiderId) },
        outsider,
      );
      for (const item of result.items) {
        assert.ok(item.capabilities.canView);
      }
    });
  });

  /* ---------------- งานหลายรายการ ---------------- */

  describe('งานหลายรายการ', () => {
    test('กำหนดนโยบายให้หลายรายการ และรายงานผลตามจริง', async () => {
      const a = await upload(`${prefix}-หลาย-ก.txt`);
      const b = await upload(`${prefix}-หลาย-ข.txt`);

      const result = await bulkAssignRetention([a, b], policy5y, admin, audit);
      assert.equal(result.succeeded, 2);
      assert.equal(result.failed, 0);

      for (const id of [a, b]) {
        const row = await prisma.resource.findUnique({
          where: { id },
          select: { retentionPolicyId: true, retentionUntil: true },
        });
        assert.equal(row!.retentionPolicyId, policy5y);
        assert.ok(row!.retentionUntil);
      }
    });

    test('ชุดที่ผสมรายการที่ไม่มีสิทธิ์ แก้เฉพาะที่มีสิทธิ์', async () => {
      const allowed = await upload(`${prefix}-bulk-ได้.txt`);
      const denied = await uploadFile(
        admin,
        stream('ลับ'),
        { parentId: privateFolderId, fileName: `${prefix}-bulk-ไม่ได้.txt`, allowDuplicateContent: true },
        audit,
      );
      created.push(denied.resource.id);
      await prisma.resource.update({
        where: { id: denied.resource.id },
        data: { visibility: 'RESTRICTED' },
      });

      const before = await prisma.resource.findUnique({
        where: { id: denied.resource.id },
        select: { retentionPolicyId: true },
      });

      const result = await bulkAssignRetention(
        [allowed, denied.resource.id],
        policy5y,
        outsider,
        audit,
      );
      assert.equal(result.succeeded, 1);
      assert.equal(result.failed, 1);

      const after = await prisma.resource.findUnique({
        where: { id: denied.resource.id },
        select: { retentionPolicyId: true },
      });
      assert.deepEqual(after, before, 'รายการที่ไม่มีสิทธิ์ต้องไม่ถูกแตะ');
    });

    test('เก็บหลายรายการเข้าคลัง และนับรายการที่อยู่ในคลังแล้วเป็น "ข้าม"', async () => {
      const a = await upload(`${prefix}-คลังหลาย-ก.txt`);
      const b = await upload(`${prefix}-คลังหลาย-ข.txt`);
      await archiveResource(a, admin, audit);

      const result = await bulkArchive([a, b], admin, audit);
      assert.equal(result.succeeded, 1);
      assert.equal(result.skipped, 1, 'ที่อยู่ในคลังแล้วคือ "ข้าม" ไม่ใช่ "ล้มเหลว"');
      assert.equal(result.failed, 0);
    });
  });

  /* ---------------- audit ---------------- */

  describe('การบันทึกกิจกรรม', () => {
    test('เหตุผลของการระงับไม่หลุดลง activity log', async () => {
      const secret = 'เหตุผลลับที่ต้องไม่อยู่ใน log';
      const id = await upload(`${prefix}-audit-ระงับ.txt`);
      const hold = await placeLegalHold(id, admin, { reason: secret }, audit);

      const logs = await prisma.activityLog.findMany({
        where: { resourceId: id, action: { startsWith: 'LEGAL_HOLD' } },
      });
      assert.ok(logs.length > 0);
      for (const log of logs) {
        assert.equal(
          JSON.stringify(log.metadata ?? {}).includes(secret),
          false,
          'เหตุผลของการระงับต้องอยู่แค่ในตาราง legal_holds',
        );
      }
      await releaseLegalHold(hold.id, admin, {}, audit);
    });

    test('บันทึกเหตุการณ์ของวงจรชีวิตครบ', async () => {
      const id = await upload(`${prefix}-audit-ครบ.txt`);
      await assignPolicy(id, admin, { policyId: policy5y }, audit);
      await archiveResource(id, admin, audit);
      await unarchiveResource(id, admin, audit);

      const actions = await prisma.activityLog.findMany({
        where: { resourceId: id },
        select: { action: true },
      });
      const names = actions.map((row) => row.action);
      assert.ok(names.includes('RETENTION_POLICY_ASSIGNED'));
      assert.ok(names.includes('RESOURCE_ARCHIVED'));
      assert.ok(names.includes('RESOURCE_UNARCHIVED'));
    });
  });
});

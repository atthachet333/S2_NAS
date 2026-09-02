import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { after, before, describe, test } from 'node:test';
import { prisma } from '../../core/prisma.js';
import { createFolder } from '../resources/resource.service.js';
import { uploadFile } from '../files/file.service.js';
import { searchFacets, searchResources } from './search.service.js';
import { listActivityActions, listAdminActivity, listResourceActivity } from './activity.service.js';
import {
  bulkTransferOwnership,
  offboardingCheck,
  ownershipOverview,
  previewHandover,
} from './handover.service.js';
import { addFavorite, addTagToResource } from './workspace.service.js';
import { grantAccess } from './sharing.service.js';
import type { AuthUser } from '../auth/auth.service.js';

const stream = (text: string) => Readable.from([Buffer.from(text)]);

describe('Phase E search, activity, handover', () => {
  const prefix = `sh-test-${process.pid}`;
  const audit = {};

  let ownerId = '';
  let successorId = '';
  let outsiderId = '';

  let owner: AuthUser;
  let successor: AuthUser;
  let outsider: AuthUser;
  let admin: AuthUser;

  let orgFolderId = '';
  let secretFolderId = '';
  let secretFileId = '';
  let publicFileId = '';
  let tagId = '';

  const auth = (id: string, permissions: string[], roles: string[] = ['MEMBER']): AuthUser => ({
    id,
    email: `${id}@test.invalid`,
    displayName: id,
    status: 'ACTIVE',
    mustChangePassword: false,
    permissions,
    roles,
  });

  const member = ['resources:read', 'resources:write', 'resources:delete'];

  before(async () => {
    const users = await Promise.all([
      prisma.user.create({ data: { email: `${prefix}-owner@example.invalid`, displayName: 'Handover Owner', status: 'ACTIVE' } }),
      prisma.user.create({ data: { email: `${prefix}-successor@example.invalid`, displayName: 'Handover Successor', status: 'ACTIVE' } }),
      prisma.user.create({ data: { email: `${prefix}-outsider@example.invalid`, displayName: 'Search Outsider', status: 'ACTIVE' } }),
    ]);
    [ownerId, successorId, outsiderId] = users.map((u) => u.id) as [string, string, string];

    owner = auth(ownerId, [...member, 'resources:tag:create']);
    successor = auth(successorId, member);
    outsider = auth(outsiderId, ['resources:read']);
    admin = auth(ownerId, [...member, 'admin:access', 'resources:owner:manage'], ['SUPER_ADMIN']);

    const org = await createFolder(owner, { name: `${prefix} เอกสารเปิด` }, audit);
    orgFolderId = org.id;

    const secret = await createFolder(owner, { name: `${prefix} เงินเดือนลับ` }, audit);
    secretFolderId = secret.id;
    await prisma.resource.update({ where: { id: secretFolderId }, data: { visibility: 'RESTRICTED' } });

    const open = await uploadFile(owner, stream('open body'), { parentId: orgFolderId, fileName: `${prefix}-สัญญาเช่า.pdf` }, audit);
    publicFileId = open.resource.id;

    const secretFile = await uploadFile(owner, stream('secret body'), { parentId: secretFolderId, fileName: `${prefix}-เงินเดือน.pdf` }, audit);
    secretFileId = secretFile.resource.id;
    await prisma.resource.update({ where: { id: secretFileId }, data: { visibility: 'RESTRICTED' } });

    const tagged = await addTagToResource(publicFileId, 'สัญญา', owner, audit);
    tagId = tagged.tags[0]!.id;
  });

  after(async () => {
    const userIds = [ownerId, successorId, outsiderId];
    const { deleteStoredFile, removeResourceDirectory } = await import('../../core/file-storage.js');
    const versions = await prisma.resourceVersion.findMany({
      where: { createdById: { in: userIds } },
      select: { storageKey: true, resourceId: true },
    });
    for (const version of versions) await deleteStoredFile(version.storageKey);
    for (const id of new Set(versions.map((v) => v.resourceId))) await removeResourceDirectory(id);

    await prisma.resourceTag.deleteMany({ where: { createdById: { in: userIds } } });
    await prisma.tag.deleteMany({ where: { createdById: { in: userIds } } });
    await prisma.userFavorite.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.resourceAccess.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.resourceVersion.deleteMany({ where: { createdById: { in: userIds } } });
    await prisma.activityLog.deleteMany({ where: { userId: { in: userIds } } });
    const rows = await prisma.resource.findMany({ where: { createdById: { in: userIds } }, orderBy: { createdAt: 'desc' } });
    for (const row of rows) await prisma.resource.deleteMany({ where: { id: row.id } });
    await prisma.user.deleteMany({ where: { email: { startsWith: prefix } } });
  });

  /* ---------------- ค้นหา ---------------- */

  describe('ค้นหาทั่วพื้นที่ทำงาน', () => {
    test('ค้นหาด้วยคำภาษาไทยเจอไฟล์ที่มีสิทธิ์', async () => {
      const result = await searchResources({ q: `${prefix}-สัญญาเช่า`, limit: 25 }, owner);
      assert.ok(result.items.some((item) => item.id === publicFileId));
    });

    test('ค้นหาไม่สนใจตัวพิมพ์ใหญ่เล็ก', async () => {
      const result = await searchResources({ q: prefix.toUpperCase(), limit: 25 }, owner);
      assert.ok(result.items.length > 0, 'ต้องเจอแม้พิมพ์เป็นตัวใหญ่');
    });

    test('ผลค้นหาไม่รวมทรัพยากรที่ผู้ค้นไม่มีสิทธิ์เห็น', async () => {
      const result = await searchResources({ q: prefix, limit: 100 }, outsider);
      const ids = result.items.map((item) => item.id);
      assert.ok(!ids.includes(secretFileId), 'ไฟล์ RESTRICTED ต้องไม่ปรากฏ');
      assert.ok(!ids.includes(secretFolderId), 'โฟลเดอร์ RESTRICTED ต้องไม่ปรากฏ');
      assert.ok(ids.includes(publicFileId), 'ไฟล์ ORGANIZATION ต้องปรากฏ');
    });

    test('จำนวนรวมนับเฉพาะสิ่งที่ผู้ค้นเห็นได้ ไม่รั่วผ่านตัวเลข', async () => {
      const asOutsider = await searchResources({ q: prefix, limit: 100 }, outsider);
      const asOwner = await searchResources({ q: prefix, limit: 100 }, owner);
      assert.ok(asOutsider.total < asOwner.total, 'ตัวเลขรวมต้องต่างกันตามสิทธิ์');
      assert.equal(asOutsider.total, asOutsider.items.length);
    });

    test('ผู้ที่ได้รับสิทธิ์โดยตรงค้นเจอทรัพยากร RESTRICTED', async () => {
      await grantAccess(secretFileId, { userId: outsiderId, accessLevel: 'VIEWER', allowDownload: false }, owner, audit);
      const result = await searchResources({ q: prefix, limit: 100 }, outsider);
      assert.ok(result.items.some((item) => item.id === secretFileId));
      await prisma.resourceAccess.deleteMany({ where: { resourceId: secretFileId, userId: outsiderId } });
    });

    test('ผู้ดูแลระบบค้นเห็นได้ทั้งหมด', async () => {
      const result = await searchResources({ q: prefix, limit: 100 }, admin);
      assert.ok(result.items.some((item) => item.id === secretFileId));
    });

    test('กรองตามประเภทและเจ้าของได้', async () => {
      const folders = await searchResources({ q: prefix, type: 'FOLDER', ownerId, limit: 25 }, owner);
      assert.ok(folders.items.length > 0);
      assert.ok(folders.items.every((item) => item.type === 'FOLDER' && item.owner.id === ownerId));
    });

    test('กรองตามแท็กได้', async () => {
      const result = await searchResources({ tagId, limit: 25 }, owner);
      assert.deepEqual(result.items.map((item) => item.id), [publicFileId]);
    });

    test('กรองเฉพาะรายการโปรดของฉัน', async () => {
      await addFavorite(publicFileId, owner);
      const mine = await searchResources({ q: prefix, favoriteOnly: true, limit: 25 }, owner);
      assert.deepEqual(mine.items.map((item) => item.id), [publicFileId]);

      const theirs = await searchResources({ q: prefix, favoriteOnly: true, limit: 25 }, successor);
      assert.equal(theirs.items.length, 0, 'รายการโปรดเป็นของแต่ละคน');
    });

    test('กรองตามช่วงเวลาที่แก้ไขได้', async () => {
      const future = new Date(Date.now() + 86_400_000);
      const none = await searchResources({ q: prefix, updatedFrom: future, limit: 25 }, owner);
      assert.equal(none.items.length, 0);
    });

    test('แบ่งหน้าด้วย cursor ไม่ซ้ำรายการ', async () => {
      const first = await searchResources({ q: prefix, limit: 1 }, owner);
      assert.equal(first.items.length, 1);
      assert.ok(first.nextCursor);
      const second = await searchResources({ q: prefix, limit: 1, cursor: first.nextCursor! }, owner);
      assert.notEqual(second.items[0]?.id, first.items[0]?.id);
    });

    test('ตัวเลือกในแผงกรองไม่เปิดเผยแท็กของทรัพยากรที่มองไม่เห็น', async () => {
      await addTagToResource(secretFileId, 'ลับเฉพาะ', owner, audit);
      const facets = await searchFacets(outsider);
      assert.ok(!facets.tags.some((tag) => tag.name === 'ลับเฉพาะ'), 'แท็กของไฟล์ลับต้องไม่หลุด');
    });

    test('ยกเลิกสิทธิ์แล้วทรัพยากรต้องหายจากผลค้นหาและจาก /shared ทันที', async () => {
      const { listSharedWithMe, revokeAccess } = await import('./sharing.service.js');
      await grantAccess(secretFileId, { userId: outsiderId, accessLevel: 'VIEWER', allowDownload: false }, owner, audit);
      assert.ok(
        (await searchResources({ q: prefix, limit: 100 }, outsider)).items.some((item) => item.id === secretFileId),
        'ระหว่างมีสิทธิ์ต้องค้นเจอ',
      );
      assert.ok((await listSharedWithMe(outsider)).some((item) => item.id === secretFileId));

      await revokeAccess(secretFileId, outsiderId, owner, audit);

      const after = await searchResources({ q: prefix, limit: 100 }, outsider);
      assert.ok(!after.items.some((item) => item.id === secretFileId), 'ต้องหายจากผลค้นหา');
      assert.ok(!(await listSharedWithMe(outsider)).some((item) => item.id === secretFileId), 'ต้องหายจาก /shared');
    });

    test('ทรัพยากรที่ไม่มีสิทธิ์ต้องไม่รั่วผ่านตัวกรองใด ๆ', async () => {
      // ค้นด้วยชื่อเต็มของไฟล์ลับโดยตรง
      const byName = await searchResources({ q: 'เงินเดือน', limit: 100 }, outsider);
      assert.ok(!byName.items.some((item) => item.id === secretFileId), 'ชื่อต้องไม่รั่ว');
      assert.equal(byName.total, byName.items.length, 'ตัวเลขรวมต้องไม่นับของที่มองไม่เห็น');

      // ค้นด้วยแท็กของไฟล์ลับโดยตรง
      const secretTag = await prisma.tag.findFirst({ where: { name: 'ลับเฉพาะ' }, select: { id: true } });
      if (secretTag) {
        const byTag = await searchResources({ tagId: secretTag.id, limit: 100 }, outsider);
        assert.equal(byTag.items.length, 0, 'แท็กต้องไม่เป็นทางลัดข้ามสิทธิ์');
        assert.equal(byTag.total, 0);
      }

      // กรองตามเจ้าของ ต้องไม่เผยของลับของเจ้าของคนนั้น
      const byOwner = await searchResources({ ownerId, limit: 100 }, outsider);
      assert.ok(!byOwner.items.some((item) => item.id === secretFileId), 'ตัวกรองเจ้าของต้องไม่ข้ามสิทธิ์');

      // กรองตามการมองเห็น RESTRICTED ต้องไม่กลายเป็นรายการของลับทั้งหมด
      const byVisibility = await searchResources({ visibility: 'RESTRICTED', limit: 100 }, outsider);
      assert.ok(!byVisibility.items.some((item) => item.id === secretFileId));
    });

    test('หมายเหตุของทรัพยากรที่มองไม่เห็นต้องไม่รั่วผ่านการค้นหา', async () => {
      const marker = `${prefix}-ความลับในหมายเหตุ`;
      await prisma.resource.update({ where: { id: secretFileId }, data: { remark: marker } });

      const asOutsider = await searchResources({ q: marker, limit: 100 }, outsider);
      assert.equal(asOutsider.items.length, 0, 'ค้นด้วยข้อความในหมายเหตุต้องไม่เจอ');
      assert.equal(asOutsider.total, 0);

      const asOwner = await searchResources({ q: marker, limit: 100 }, owner);
      assert.ok(asOwner.items.some((item) => item.id === secretFileId), 'เจ้าของยังต้องค้นเจอตามปกติ');
    });

    test('รายการโปรดและปักหมุดข้ามสิทธิ์ไม่ได้', async () => {
      const { addFavorite: fav, pinResource } = await import('./workspace.service.js');
      await assert.rejects(fav(secretFileId, outsider), (error: unknown) =>
        (error as { code?: string }).code === 'RESOURCE_NOT_FOUND',
      );
      await assert.rejects(pinResource(secretFileId, outsider), (error: unknown) =>
        (error as { code?: string }).code === 'RESOURCE_NOT_FOUND',
      );
    });

    test('ผู้ไม่มีสิทธิ์อ่านค้นหาไม่ได้', async () => {
      await assert.rejects(searchResources({ q: prefix, limit: 10 }, auth('nobody', [])), /สิทธิ์/);
    });

    test('DTO ในผลค้นหาไม่เปิดเผยเส้นทางไฟล์จริง', async () => {
      const result = await searchResources({ q: prefix, limit: 25 }, owner);
      for (const item of result.items) {
        assert.ok(!('storageKey' in item), 'ห้ามเปิดเผย storageKey');
      }
    });
  });

  /* ---------------- ประวัติการใช้งาน ---------------- */

  describe('ประวัติการใช้งาน', () => {
    test('ไทม์ไลน์ของทรัพยากรแสดงเหตุการณ์ที่เกิดขึ้นจริง', async () => {
      const result = await listResourceActivity(publicFileId, owner, { limit: 25 });
      assert.ok(result.items.length > 0);
      assert.ok(result.items.every((entry) => entry.resourceId === publicFileId));
    });

    test('ผู้ที่มองไม่เห็นทรัพยากรอ่านประวัติไม่ได้ และได้คำตอบเดียวกับกรณีไม่พบ', async () => {
      await assert.rejects(
        listResourceActivity(secretFileId, outsider, { limit: 25 }),
        (error: unknown) => (error as { code?: string }).code === 'RESOURCE_NOT_FOUND',
      );
    });

    test('ผู้ใช้ทั่วไปไม่เห็น IP และ user agent ในไทม์ไลน์', async () => {
      const result = await listResourceActivity(publicFileId, owner, { limit: 5 });
      for (const entry of result.items) {
        assert.ok(!('ipAddress' in entry), 'ห้ามเปิดเผย ipAddress ให้ผู้ใช้ทั่วไป');
        assert.ok(!('userAgent' in entry), 'ห้ามเปิดเผย userAgent ให้ผู้ใช้ทั่วไป');
      }
    });

    test('ผู้ดูแลระบบเห็นข้อมูลการติดตามได้', async () => {
      const result = await listResourceActivity(publicFileId, admin, { limit: 5 });
      assert.ok(result.items.every((entry) => 'ipAddress' in entry));
    });

    test('ประวัติทั้งระบบเปิดให้เฉพาะผู้ดูแล', async () => {
      await assert.rejects(listAdminActivity({ limit: 10 }, outsider), /สิทธิ์/);
      const result = await listAdminActivity({ limit: 10 }, admin);
      assert.ok(result.items.length > 0);
    });

    test('กรองประวัติทั้งระบบตามผู้ใช้และการกระทำได้', async () => {
      const result = await listAdminActivity({ userId: ownerId, action: 'RESOURCE_FOLDER_CREATED', limit: 10 }, admin);
      assert.ok(result.items.every((entry) => entry.actor?.id === ownerId && entry.action === 'RESOURCE_FOLDER_CREATED'));
    });

    test('รายการ action มาจากข้อมูลจริง ไม่ใช่ค่าตายตัว', async () => {
      const actions = await listActivityActions(admin);
      assert.ok(actions.some((row) => row.action === 'RESOURCE_FOLDER_CREATED'));
      assert.ok(actions.every((row) => row.count > 0));
    });
  });

  /* ---------------- ส่งมอบความรับผิดชอบ ---------------- */

  describe('ส่งมอบความรับผิดชอบ', () => {
    test('ภาพรวมบอกจำนวนที่แต่ละคนดูแลอยู่', async () => {
      const overview = await ownershipOverview(admin);
      const row = overview.find((entry) => entry.user.id === ownerId);
      assert.ok(row, 'ต้องมีผู้ดูแลรายนี้ในภาพรวม');
      assert.equal(row!.ownedTotal, row!.ownedFolders + row!.ownedFiles);
      assert.ok(row!.ownedFolders >= 2);
    });

    test('ผู้ไม่มีสิทธิ์ดูภาพรวมและโอนไม่ได้', async () => {
      await assert.rejects(ownershipOverview(outsider), /สิทธิ์/);
      await assert.rejects(bulkTransferOwnership(ownerId, successorId, outsider, audit), /สิทธิ์/);
    });

    test('ดูตัวอย่างก่อนโอนไม่เปลี่ยนข้อมูลใด ๆ', async () => {
      const preview = await previewHandover(ownerId, successorId, admin);
      assert.ok(preview.total >= 4);
      assert.equal(preview.to.id, successorId);
      const stillOwned = await prisma.resource.count({ where: { ownerId, deletedAt: null } });
      assert.equal(stillOwned, preview.total, 'การดูตัวอย่างต้องไม่โอนจริง');
    });

    test('โอนให้ตัวเองหรือให้บัญชีที่ปิดอยู่ไม่ได้', async () => {
      await assert.rejects(
        previewHandover(ownerId, ownerId, admin),
        (error: unknown) => (error as { code?: string }).code === 'HANDOVER_SAME_USER',
      );
      const disabled = await prisma.user.create({
        data: { email: `${prefix}-disabled@example.invalid`, displayName: 'Disabled', status: 'DISABLED' },
      });
      await assert.rejects(
        bulkTransferOwnership(ownerId, disabled.id, admin, audit),
        (error: unknown) => (error as { code?: string }).code === 'HANDOVER_TARGET_INACTIVE',
      );
      await prisma.user.delete({ where: { id: disabled.id } });
    });

    test('การตรวจก่อนปิดบัญชีเตือนเมื่อยังมีทรัพยากรค้าง', async () => {
      const check = await offboardingCheck(ownerId, admin);
      assert.equal(check.requiresHandover, true);
      assert.ok(check.ownedTotal > 0);
    });

    test('โอนทั้งชุดแล้วผู้รับกลายเป็นผู้ดูแล และผู้สร้างเดิมไม่ถูกแก้', async () => {
      const before = await prisma.resource.findUnique({ where: { id: publicFileId }, select: { createdById: true } });
      const result = await bulkTransferOwnership(ownerId, successorId, admin, audit);
      assert.ok(result.transferred >= 4);

      const moved = await prisma.resource.findUnique({
        where: { id: publicFileId },
        select: { ownerId: true, createdById: true },
      });
      assert.equal(moved?.ownerId, successorId, 'ผู้ดูแลต้องเปลี่ยน');
      assert.equal(moved?.createdById, before?.createdById, 'ผู้สร้างเดิมต้องคงอยู่เป็นประวัติ');

      const remaining = await prisma.resource.count({ where: { ownerId, deletedAt: null } });
      assert.equal(remaining, 0, 'ต้องไม่เหลือของค้างที่ผู้ใช้เดิม');
    });

    test('บันทึกกิจกรรมการโอนทั้งชุดไว้ตรวจสอบได้ โดยไม่เก็บอีเมล', async () => {
      const log = await prisma.activityLog.findFirst({
        where: { action: 'OWNERSHIP_BULK_TRANSFERRED', userId: ownerId },
        orderBy: { createdAt: 'desc' },
      });
      assert.ok(log, 'ต้องมีบันทึกการโอน');
      const metadata = log!.metadata as { fromUserId?: string; toUserId?: string; count?: number };
      assert.equal(metadata.fromUserId, ownerId);
      assert.equal(metadata.toUserId, successorId);
      assert.ok((metadata.count ?? 0) > 0);
      assert.ok(!JSON.stringify(metadata).includes('@'), 'ห้ามเก็บอีเมลลงบันทึกกิจกรรม');
    });

    test('หลังโอนแล้วการตรวจก่อนปิดบัญชีไม่เตือนอีก', async () => {
      const check = await offboardingCheck(ownerId, admin);
      assert.equal(check.requiresHandover, false);
      assert.equal(check.ownedTotal, 0);
    });

    test('ปิดบัญชีที่ยังถือทรัพยากรต้องถูกเตือนก่อน แต่ยืนยันแล้วผ่านได้', async () => {
      // จำลองเส้นทางเดียวกับที่ route ผู้ใช้ใช้ตรวจ ก่อนเปลี่ยนสถานะเป็นไม่ใช้งาน
      const check = await offboardingCheck(successorId, admin);
      assert.equal(check.requiresHandover, true, 'ผู้รับมอบถือของอยู่ ต้องเตือน');

      await bulkTransferOwnership(successorId, ownerId, admin, audit);
      const cleared = await offboardingCheck(successorId, admin);
      assert.equal(cleared.requiresHandover, false, 'ส่งมอบครบแล้วต้องปิดบัญชีได้โดยไม่ต้องเตือน');
    });
  });
});

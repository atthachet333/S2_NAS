import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { after, before, describe, test } from 'node:test';
import { prisma } from '../../core/prisma.js';
import { createFolder, getResource, updateResource, moveResource } from '../resources/resource.service.js';
import { uploadFile, resolveContent, uploadVersion } from '../files/file.service.js';
import { trashResource } from '../files/trash.service.js';
import {
  addFavorite,
  addTagToResource,
  listFavorites,
  listPins,
  listTags,
  lockResource,
  normalizeTagName,
  pinResource,
  removeFavorite,
  removeTagFromResource,
  unlockResource,
  unpinResource,
  updateRemark,
} from './workspace.service.js';
import {
  grantAccess,
  listAccess,
  listSharedWithMe,
  revokeAccess,
  searchShareTargets,
} from './sharing.service.js';
import type { AuthUser } from '../auth/auth.service.js';

const stream = (text: string) => Readable.from([Buffer.from(text)]);

describe('Phase E workspace', () => {
  const prefix = `ws-test-${process.pid}`;
  const audit = {};

  let ownerId = '';
  let editorId = '';
  let viewerId = '';
  let outsiderId = '';
  let inactiveId = '';

  let owner: AuthUser;
  let editor: AuthUser;
  let viewer: AuthUser;
  let outsider: AuthUser;
  let admin: AuthUser;

  let orgFolderId = '';
  let restrictedFolderId = '';
  let fileId = '';

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
      prisma.user.create({ data: { email: `${prefix}-owner@example.invalid`, displayName: 'Owner Pueng', status: 'ACTIVE' } }),
      prisma.user.create({ data: { email: `${prefix}-editor@example.invalid`, displayName: 'Editor Win', status: 'ACTIVE' } }),
      prisma.user.create({ data: { email: `${prefix}-viewer@example.invalid`, displayName: 'Viewer Som', status: 'ACTIVE' } }),
      prisma.user.create({ data: { email: `${prefix}-outsider@example.invalid`, displayName: 'Outsider', status: 'ACTIVE' } }),
      prisma.user.create({ data: { email: `${prefix}-inactive@example.invalid`, displayName: 'Invited User', status: 'INVITED' } }),
    ]);
    [ownerId, editorId, viewerId, outsiderId, inactiveId] = users.map((u) => u.id) as [string, string, string, string, string];

    owner = auth(ownerId, member);
    editor = auth(editorId, member);
    viewer = auth(viewerId, ['resources:read']);
    outsider = auth(outsiderId, ['resources:read']);
    admin = auth(ownerId, [...member, 'admin:access', 'resources:tag:create'], ['SUPER_ADMIN']);

    const org = await createFolder(owner, { name: `${prefix} Accounting` }, audit);
    orgFolderId = org.id;

    const restricted = await createFolder(owner, { name: `${prefix} Payroll` }, audit);
    restrictedFolderId = restricted.id;
    await prisma.resource.update({ where: { id: restrictedFolderId }, data: { visibility: 'RESTRICTED' } });

    const uploaded = await uploadFile(owner, stream('phase-e file body'), { parentId: orgFolderId, fileName: 'report.pdf' }, audit);
    fileId = uploaded.resource.id;
  });

  after(async () => {
    const userIds = [ownerId, editorId, viewerId, outsiderId, inactiveId];
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
    await prisma.userPinnedResource.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.resourceAccess.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.resourceVersion.deleteMany({ where: { createdById: { in: userIds } } });
    await prisma.activityLog.deleteMany({ where: { userId: { in: userIds } } });
    const rows = await prisma.resource.findMany({ where: { createdById: { in: userIds } }, orderBy: { createdAt: 'desc' } });
    for (const row of rows) await prisma.resource.deleteMany({ where: { id: row.id } });
    await prisma.user.deleteMany({ where: { email: { startsWith: prefix } } });
  });

  /* ---------------- การเข้าถึง ---------------- */

  describe('การเข้าถึงและการแชร์ภายใน', () => {
    test('ทรัพยากร ORGANIZATION มองเห็นได้โดยผู้ใช้ที่เปิดใช้งาน', async () => {
      const dto = await getResource(orgFolderId, outsider);
      assert.equal(dto.capabilities.canView, true);
    });

    test('ทรัพยากร RESTRICTED ถูกซ่อนจากผู้ที่ไม่เกี่ยวข้อง', async () => {
      const dto = await getResource(restrictedFolderId, outsider).catch(() => null);
      assert.ok(dto === null || dto.capabilities.canView === false, 'ต้องเข้าถึงไม่ได้');
    });

    test('แชร์ให้ผู้ใช้ที่ยังไม่เปิดใช้งานไม่ได้', async () => {
      await assert.rejects(
        grantAccess(restrictedFolderId, { userId: inactiveId, accessLevel: 'VIEWER', allowDownload: true }, owner, audit),
        (error: unknown) => (error as { code?: string }).code === 'SHARE_TARGET_INACTIVE',
      );
    });

    test('ผู้ดูแลหลักให้สิทธิ์ EDITOR และ VIEWER ได้', async () => {
      await grantAccess(restrictedFolderId, { userId: editorId, accessLevel: 'EDITOR', allowDownload: true }, owner, audit);
      const result = await grantAccess(
        restrictedFolderId,
        { userId: viewerId, accessLevel: 'VIEWER', allowDownload: false },
        owner,
        audit,
      );
      assert.equal(result.grants.length, 2);
      assert.equal(result.owner.id, ownerId);
    });

    test('ผู้ที่ได้รับสิทธิ์เห็นทรัพยากร RESTRICTED ได้', async () => {
      const dto = await getResource(restrictedFolderId, viewer);
      assert.equal(dto.capabilities.canView, true);
    });

    test('EDITOR ที่ได้รับมอบสิทธิ์ ไม่ได้อำนาจจัดการสิทธิ์ต่อ', async () => {
      const dto = await getResource(restrictedFolderId, editor);
      assert.equal(dto.capabilities.canEdit, true, 'แก้ไขได้');
      assert.equal(dto.capabilities.canShare, false, 'แต่จัดการสิทธิ์ไม่ได้');

      await assert.rejects(
        grantAccess(restrictedFolderId, { userId: outsiderId, accessLevel: 'VIEWER', allowDownload: true }, editor, audit),
        (error: unknown) => (error as { code?: string }).code === 'SHARE_DENIED',
      );
    });

    test('VIEWER ที่ห้ามดาวน์โหลด เปิดดูได้แต่ดาวน์โหลดไม่ได้', async () => {
      const restrictedFile = await uploadFile(
        owner,
        stream('payroll secret body'),
        { parentId: restrictedFolderId, fileName: 'payroll.pdf' },
        audit,
      );

      await grantAccess(restrictedFile.resource.id, { userId: viewerId, accessLevel: 'VIEWER', allowDownload: false }, owner, audit);

      const dto = await getResource(restrictedFile.resource.id, viewer);
      assert.equal(dto.capabilities.canView, true, 'ต้องเปิดดูได้');
      assert.equal(dto.capabilities.canDownload, false, 'ต้องดาวน์โหลดไม่ได้');

      // เซิร์ฟเวอร์ต้องบังคับเอง ไม่ใช่แค่ซ่อนปุ่ม
      await assert.rejects(
        resolveContent(restrictedFile.resource.id, viewer, { requireDownload: true }),
        (error: unknown) => (error as { code?: string }).code === 'DOWNLOAD_DENIED',
      );
      // แต่การเปิดดูยังทำได้
      const content = await resolveContent(restrictedFile.resource.id, viewer, {});
      assert.ok(content.storageKey);
    });

    test('allowDownload = false มีน้ำหนักเหนือค่าเริ่มต้นขององค์กร', async () => {
      await grantAccess(fileId, { userId: viewerId, accessLevel: 'VIEWER', allowDownload: false }, owner, audit);
      const dto = await getResource(fileId, viewer);
      assert.equal(dto.visibility, 'ORGANIZATION');
      assert.equal(dto.capabilities.canDownload, false, 'การจำกัดรายคนต้องชนะค่าเริ่มต้น');
      await revokeAccess(fileId, viewerId, owner, audit);
    });

    test('รายการที่แชร์กับฉันมีเฉพาะสิทธิ์ที่มอบให้โดยตรง', async () => {
      const shared = await listSharedWithMe(viewer);
      const ids = shared.map((row) => row.id);
      assert.ok(ids.includes(restrictedFolderId), 'ต้องมีรายการที่ถูกแชร์');
      assert.ok(!ids.includes(orgFolderId), 'ต้องไม่รวมรายการที่เห็นเพราะเป็น ORGANIZATION');

      const entry = shared.find((row) => row.id === restrictedFolderId);
      assert.equal(entry?.myAccessLevel, 'VIEWER');
      assert.equal(entry?.myAllowDownload, false);
    });

    test('ถอนสิทธิ์แล้วรายการหายจากแชร์กับฉัน', async () => {
      await revokeAccess(restrictedFolderId, viewerId, owner, audit);
      const shared = await listSharedWithMe(viewer);
      assert.ok(!shared.some((row) => row.id === restrictedFolderId));
    });

    test('ค้นหาผู้ใช้สำหรับแชร์คืนเฉพาะผู้ที่เปิดใช้งาน', async () => {
      const results = await searchShareTargets(prefix, owner, 25);
      const emails = results.map((u) => u.email);
      assert.ok(emails.some((email) => email.includes('editor')));
      assert.ok(!emails.some((email) => email.includes('inactive')), 'ต้องไม่มีผู้ใช้ INVITED');
      assert.ok(!results.some((u) => u.id === ownerId), 'ต้องไม่มีตัวเอง');
    });

    test('ผู้ที่มองไม่เห็นทรัพยากร อ่านรายชื่อผู้เข้าถึงไม่ได้', async () => {
      await assert.rejects(listAccess(restrictedFolderId, outsider), /RESOURCE_NOT_FOUND|ไม่พบ/);
    });
  });

  /* ---------------- รายการโปรด ---------------- */

  describe('รายการโปรด', () => {
    test('เพิ่ม ซ้ำได้อย่างปลอดภัย และแสดงในรายการ', async () => {
      await addFavorite(orgFolderId, owner);
      await addFavorite(orgFolderId, owner);
      const favorites = await listFavorites(owner);
      assert.equal(favorites.filter((row) => row.id === orgFolderId).length, 1);
    });

    test('นำออกจากรายการโปรดได้', async () => {
      await addFavorite(fileId, owner);
      await removeFavorite(fileId, owner);
      const favorites = await listFavorites(owner);
      assert.ok(!favorites.some((row) => row.id === fileId));
    });

    test('ทรัพยากรที่เข้าถึงไม่ได้ต้องไม่รั่วผ่านรายการโปรด', async () => {
      await addFavorite(restrictedFolderId, owner);
      // ผู้ที่ไม่เกี่ยวข้องบันทึกเป็นรายการโปรดไม่ได้ตั้งแต่แรก
      await assert.rejects(addFavorite(restrictedFolderId, outsider), /RESOURCE_NOT_FOUND|ไม่พบ/);
      const outsiderFavorites = await listFavorites(outsider);
      assert.ok(!outsiderFavorites.some((row) => row.id === restrictedFolderId));
    });

    test('ทรัพยากรที่ถูกลบไม่แสดงในรายการโปรด', async () => {
      const temp = await createFolder(owner, { name: `${prefix} temp-fav` }, audit);
      await addFavorite(temp.id, owner);
      await trashResource(temp.id, owner, audit);
      const favorites = await listFavorites(owner);
      assert.ok(!favorites.some((row) => row.id === temp.id));
    });
  });

  /* ---------------- ปักหมุด ---------------- */

  describe('ปักหมุด', () => {
    test('ปักหมุดและยกเลิกได้ และไม่ซ้ำต่อผู้ใช้', async () => {
      await pinResource(orgFolderId, owner);
      await pinResource(orgFolderId, owner);
      let pins = await listPins(owner);
      assert.equal(pins.filter((row) => row.id === orgFolderId).length, 1);

      await unpinResource(orgFolderId, owner);
      pins = await listPins(owner);
      assert.ok(!pins.some((row) => row.id === orgFolderId));
    });

    test('ปักหมุดของผู้ใช้แต่ละคนแยกจากกัน', async () => {
      await pinResource(orgFolderId, owner);
      const ownerPins = await listPins(owner);
      const editorPins = await listPins(editor);
      assert.ok(ownerPins.some((row) => row.id === orgFolderId));
      assert.ok(!editorPins.some((row) => row.id === orgFolderId));
    });

    test('ปักหมุดทรัพยากรที่เข้าถึงไม่ได้ไม่ได้', async () => {
      await assert.rejects(pinResource(restrictedFolderId, outsider), /RESOURCE_NOT_FOUND|ไม่พบ/);
    });
  });

  /* ---------------- แท็ก ---------------- */

  describe('แท็ก', () => {
    test('ชื่อแท็กภาษาไทยใช้งานได้และตัดช่องว่างส่วนเกิน', () => {
      const result = normalizeTagName('  ภาษี ซื้อ  ');
      assert.equal(result.name, 'ภาษี ซื้อ');
      assert.equal(result.normalizedName, 'ภาษี ซื้อ');
    });

    test('ชื่อแท็กว่างหรือมีอักขระควบคุมถูกปฏิเสธ', () => {
      assert.throws(() => normalizeTagName('   '), /INVALID_TAG_NAME|ว่างเปล่า/);
      assert.throws(() => normalizeTagName('bad tag'), /INVALID_TAG_NAME|ไม่อนุญาต/);
      assert.throws(() => normalizeTagName('x'.repeat(65)), /INVALID_TAG_NAME|ยาวเกิน/);
    });

    test('ติดแท็กภาษาไทยกับทรัพยากรได้', async () => {
      const dto = await addTagToResource(fileId, 'ภาษี', admin, audit);
      assert.ok(dto.tags?.some((tag) => tag.name === 'ภาษี'));
    });

    test('ชื่อแท็กซ้ำแบบไม่สนตัวพิมพ์ใหญ่เล็กใช้แท็กเดิม', async () => {
      await addTagToResource(fileId, 'Urgent', admin, audit);
      await addTagToResource(orgFolderId, 'URGENT', admin, audit);
      const tags = await prisma.tag.findMany({ where: { normalizedName: 'urgent' } });
      assert.equal(tags.length, 1, 'ต้องมีแท็กเดียวเท่านั้น');
    });

    test('ผู้ที่ไม่มีสิทธิ์สร้างแท็กใหม่ ถูกปฏิเสธ', async () => {
      await assert.rejects(
        addTagToResource(fileId, `${prefix}-brand-new-tag`, owner, audit),
        (error: unknown) => (error as { code?: string }).code === 'TAG_CREATE_DENIED',
      );
    });

    test('ผู้ที่แก้ไขไม่ได้ ติดแท็กไม่ได้', async () => {
      await assert.rejects(addTagToResource(fileId, 'ภาษี', viewer, audit), /RESOURCE_ACCESS_DENIED|ไม่มีสิทธิ์/);
    });

    test('ลบแท็กออกจากทรัพยากรได้', async () => {
      const before = await getResource(fileId, admin);
      const tagId = before.tags?.find((tag) => tag.name === 'Urgent')?.id;
      assert.ok(tagId);
      const dto = await removeTagFromResource(fileId, tagId, admin, audit);
      assert.ok(!dto.tags?.some((tag) => tag.name === 'Urgent'));
    });

    test('จำนวนการใช้แท็กนับเฉพาะทรัพยากรที่ผู้ใช้เห็นได้', async () => {
      await addTagToResource(restrictedFolderId, 'ลับ', admin, audit);
      const outsiderTags = await listTags(outsider);
      assert.ok(!outsiderTags.some((tag) => tag.name === 'ลับ'), 'ต้องไม่เห็นแท็กที่ผูกกับของลับเท่านั้น');
    });
  });

  /* ---------------- หมายเหตุ ---------------- */

  describe('หมายเหตุ', () => {
    test('เพิ่มและแก้ไขหมายเหตุได้', async () => {
      let dto = await updateRemark(fileId, 'เอกสารจากลูกค้า รอตรวจสอบ', owner, audit);
      assert.equal(dto.remark, 'เอกสารจากลูกค้า รอตรวจสอบ');

      dto = await updateRemark(fileId, 'ฉบับสำหรับยื่นเดือนกันยายน', owner, audit);
      assert.equal(dto.remark, 'ฉบับสำหรับยื่นเดือนกันยายน');
    });

    test('ล้างหมายเหตุได้', async () => {
      const dto = await updateRemark(fileId, null, owner, audit);
      assert.equal(dto.remark, null);
      await updateRemark(fileId, 'ฉบับสำหรับยื่นเดือนกันยายน', owner, audit);
    });

    test('ผู้ที่ไม่มีสิทธิ์แก้ไข เปลี่ยนหมายเหตุไม่ได้', async () => {
      await assert.rejects(updateRemark(fileId, 'แก้ไม่ได้', viewer, audit), /RESOURCE_ACCESS_DENIED|ไม่มีสิทธิ์/);
    });

    test('บันทึกกิจกรรมโดยไม่เก็บเนื้อหาหมายเหตุ', async () => {
      const log = await prisma.activityLog.findFirst({
        where: { resourceId: fileId, action: 'RESOURCE_REMARK_UPDATED' },
        orderBy: { createdAt: 'desc' },
      });
      assert.ok(log, 'ต้องมีบันทึกกิจกรรม');
      const serialized = JSON.stringify(log.metadata);
      assert.ok(!serialized.includes('กันยายน'), 'ต้องไม่เก็บเนื้อหาหมายเหตุลง log');
    });
  });

  /* ---------------- ล็อก ---------------- */

  describe('ล็อกทรัพยากร', () => {
    let lockedFileId = '';

    test('ผู้ที่ไม่ใช่ผู้ดูแลหลัก ล็อกไม่ได้', async () => {
      const uploaded = await uploadFile(owner, stream('lock target body'), { parentId: orgFolderId, fileName: 'locked.pdf' }, audit);
      lockedFileId = uploaded.resource.id;
      await assert.rejects(
        lockResource(lockedFileId, { reason: 'ไม่ควรได้' }, editor, audit),
        (error: unknown) => (error as { code?: string }).code === 'LOCK_DENIED',
      );
    });

    test('ผู้ดูแลหลักล็อกพร้อมเหตุผลได้', async () => {
      const dto = await lockResource(lockedFileId, { reason: 'ปิดงบเดือนสิงหาคมแล้ว' }, owner, audit);
      assert.equal(dto.isLocked, true);
      assert.equal(dto.lockReason, 'ปิดงบเดือนสิงหาคมแล้ว');
      assert.equal(dto.lockedBy?.id, ownerId);
      assert.ok(dto.lockedAt);
    });

    test('ล็อกแล้วเปลี่ยนชื่อ ย้าย เพิ่มเวอร์ชัน และลบไม่ได้', async () => {
      // ผู้ดูแลหลักมีสิทธิ์เต็ม จึงต้องได้เหตุผล "ถูกล็อก" ไม่ใช่ "ไม่มีสิทธิ์"
      const locked = (error: unknown) => (error as { code?: string }).code === 'RESOURCE_LOCKED';
      await assert.rejects(updateResource(lockedFileId, owner, { name: 'ห้ามเปลี่ยน.pdf' }, audit), locked);
      await assert.rejects(moveResource(lockedFileId, owner, null, audit), locked);
      await assert.rejects(uploadVersion(owner, lockedFileId, stream('new version'), {}, audit), locked);
      await assert.rejects(trashResource(lockedFileId, owner, audit), locked);
    });

    test('ล็อกแล้วยังเปิดดูและดาวน์โหลดได้ตามสิทธิ์', async () => {
      const content = await resolveContent(lockedFileId, owner, { requireDownload: true });
      assert.ok(content.storageKey, 'การล็อกไม่ปิดกั้นการอ่าน');
    });

    test('ล็อกซ้ำถูกปฏิเสธ', async () => {
      await assert.rejects(
        lockResource(lockedFileId, {}, owner, audit),
        (error: unknown) => (error as { code?: string }).code === 'RESOURCE_ALREADY_LOCKED',
      );
    });

    test('ปลดล็อกแล้วกลับมาแก้ไขได้', async () => {
      const dto = await unlockResource(lockedFileId, owner, audit);
      assert.equal(dto.isLocked, false);
      assert.equal(dto.lockReason, null);
      assert.equal(dto.lockedBy, null);

      const renamed = await updateResource(lockedFileId, owner, { name: 'unlocked.pdf' }, audit);
      assert.equal(renamed.name, 'unlocked.pdf');
    });

    test('บันทึกกิจกรรมการล็อกและปลดล็อก', async () => {
      const actions = await prisma.activityLog.findMany({
        where: { resourceId: lockedFileId, action: { in: ['RESOURCE_LOCKED', 'RESOURCE_UNLOCKED'] } },
        select: { action: true },
      });
      const seen = new Set(actions.map((row) => row.action));
      assert.ok(seen.has('RESOURCE_LOCKED'));
      assert.ok(seen.has('RESOURCE_UNLOCKED'));
    });
  });
});

/**
 * F26-A1 - พื้นที่ลูกค้าต้องบังคับใช้เพดานการเปิดเผยของ F25-D จริง ไม่ใช่แค่รายงานว่าบังคับใช้
 *
 * ข้อบกพร่องที่ชุดนี้ล็อกไว้: รายงานการตรวจสอบสิทธิ์ตอบว่าสิทธิ์บนเอกสารชั้น "ลับ" และ
 * "จำกัดการเข้าถึง" ใช้ไม่ได้ แต่ด่านจริงของพื้นที่ลูกค้ายังเปิดให้และยังแสดงบนหน้าแรก
 * รายงานที่ไม่ตรงกับสิ่งที่ระบบทำ อันตรายกว่าการไม่มีรายงาน เพราะผู้ตรวจสอบเชื่อมัน
 *
 * ข้อพิสูจน์หลักคือเทสต์ "agree on every classification" - มันเทียบสองด้านตรง ๆ
 * ไม่ได้ตรวจแต่ละด้านแยกกันแล้วหวังว่าจะตรงกัน
 *
 * การเก็บกวาด: ชุดนี้สร้างไฟล์จริงหนึ่งไฟล์ผ่าน uploadFile จึงลบทั้งแถวฐานข้อมูลและ
 * ไบต์ในที่เก็บด้วย deleteStoredFile ตามกติกาที่ยกมาจาก F25 - ไม่ทิ้งไฟล์กำพร้าไว้
 */
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { after, before, describe, test } from 'node:test';
import type { ResourceClassification } from '@prisma/client';
import { prisma } from '../../core/prisma.js';
import { deleteStoredFile } from '../../core/file-storage.js';
import { createFolder } from '../resources/resource.service.js';
import { uploadFile } from '../files/file.service.js';
import { effectiveAccessReview } from '../sharing/access-review.service.js';
import type { AuthUser } from '../auth/auth.service.js';
import {
  listPortalRoots,
  resolvePortalAccess,
  resourceExposableToPortal,
} from './portal-access.js';
import {
  listPortalVersions,
  openPortalFolder,
  portalHome,
  resolvePortalContent,
  searchPortal,
  uploadToPortalFolder,
} from './portal.service.js';
import { listUploadHistory } from './portal-uploads.js';

const prefix = `f26a1-${Date.now().toString(36)}`;
const audit = { ipAddress: '127.0.0.1', userAgent: 'f26a1-test' };
const stream = (text: string) => Readable.from([Buffer.from(text, 'utf8')]);

/** จับว่าถูกปฏิเสธหรือไม่ โดยไม่สนว่าปฏิเสธด้วยข้อความใด - ด่านนี้ตอบเหมือนกันหมดโดยตั้งใจ */
async function denied(run: () => Promise<unknown>): Promise<boolean> {
  try {
    await run();
    return false;
  } catch {
    return true;
  }
}

describe('F26-A1 portal enforces the F25-D external-exposure ceiling', () => {
  let ownerId = '';
  let externalId = '';
  let otherExternalId = '';
  let rootId = '';
  let childFolderId = '';
  let fileId = '';
  let owner: AuthUser;
  let external: AuthUser;

  before(async () => {
    const [ownerRow, extRow, otherRow] = await Promise.all([
      prisma.user.create({ data: { email: `${prefix}-owner@example.invalid`, displayName: 'F26A1 Owner', status: 'ACTIVE' } }),
      prisma.user.create({ data: { email: `${prefix}-ext@example.invalid`, displayName: 'F26A1 External', type: 'EXTERNAL', status: 'ACTIVE', organizationName: 'F26A1 Corp' } }),
      prisma.user.create({ data: { email: `${prefix}-other@example.invalid`, displayName: 'F26A1 Other', type: 'EXTERNAL', status: 'ACTIVE', organizationName: 'F26A1 Other Corp' } }),
    ]);
    ownerId = ownerRow.id;
    externalId = extRow.id;
    otherExternalId = otherRow.id;

    const adminRole = await prisma.role.findUniqueOrThrow({ where: { code: 'ADMIN' } });
    await prisma.userRole.create({ data: { userId: ownerId, roleId: adminRole.id } });

    owner = {
      id: ownerId, email: ownerRow.email, displayName: ownerRow.displayName,
      type: 'INTERNAL', status: 'ACTIVE', mustChangePassword: false,
      roles: ['ADMIN'], permissions: ['resources:read', 'resources:write', 'resources:delete', 'resources:share'],
    };
    external = {
      id: externalId, email: extRow.email, displayName: extRow.displayName,
      type: 'EXTERNAL', status: 'ACTIVE', mustChangePassword: false,
      roles: [], permissions: [],
    };

    const root = await createFolder(owner, { name: `${prefix}-root`, parentId: null }, audit);
    const child = await createFolder(owner, { name: `${prefix}-child`, parentId: root.id }, audit);
    rootId = root.id;
    childFolderId = child.id;

    const uploaded = await uploadFile(
      owner,
      stream('เนื้อหาสำหรับทดสอบเพดานการเปิดเผย F26-A1'),
      { parentId: rootId, fileName: `${prefix}-เอกสาร.txt`, allowDuplicateContent: true },
      audit,
    );
    fileId = uploaded.resource.id;

    // สิทธิ์ให้แก้ไขได้ เพื่อให้ทดสอบการอัปโหลดผ่านด่านเดียวกันได้ด้วย
    await prisma.resourceAccess.create({
      data: { resourceId: rootId, userId: externalId, accessLevel: 'EDITOR', allowDownload: true, createdById: ownerId },
    });
  });

  after(async () => {
    /*
     * ลบไบต์ก่อนลบแถว - ถ้าลบแถวก่อน จะไม่มีทางรู้ว่า storageKey คืออะไรอีกเลย
     * และไฟล์นั้นจะกลายเป็นขยะถาวรที่ไม่มีใครตามไปเก็บได้
     */
    const versions = await prisma.resourceVersion.findMany({
      where: { resource: { OR: [{ id: rootId }, { parentId: rootId }] } },
      select: { storageKey: true, storageProvider: true },
    });
    for (const version of versions) {
      await deleteStoredFile(version.storageKey, version.storageProvider);
    }

    await prisma.activityLog.deleteMany({ where: { userId: { in: [ownerId, externalId, otherExternalId] } } });
    await prisma.resourceAccess.deleteMany({ where: { resourceId: { in: [rootId, childFolderId, fileId] } } });
    await prisma.resource.deleteMany({ where: { id: { in: [fileId, childFolderId] } } });
    await prisma.resource.deleteMany({ where: { id: rootId } });
    await prisma.user.deleteMany({ where: { id: { in: [ownerId, externalId, otherExternalId] } } });
  });

  const setLevel = async (id: string, level: ResourceClassification) => {
    if (level === 'RESTRICTED') {
      await prisma.resource.update({ where: { id }, data: { visibility: 'RESTRICTED' } });
    }
    await prisma.resource.update({ where: { id }, data: { classification: level } });
  };

  /* ---------------- §11 ข้อพิสูจน์หลักของ A1 ---------------- */

  test('access review and portal runtime agree on every classification', async () => {
    const expected: Record<ResourceClassification, boolean> = {
      PUBLIC: true,
      INTERNAL: true,
      CONFIDENTIAL: false,
      RESTRICTED: false,
    };

    for (const level of ['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED'] as const) {
      await setLevel(rootId, level);

      const review = await effectiveAccessReview(rootId);
      const entry = review.entries.find((item) => item.subject.id === externalId)!;
      const servedByPortal = !(await denied(() => resolvePortalAccess(externalId, rootId)));
      const listedOnHome = (await listPortalRoots(externalId)).some((root) => root.resource.id === rootId);

      assert.equal(
        entry.usable, servedByPortal,
        `${level}: review says usable=${entry.usable} but portal serves=${servedByPortal}`,
      );
      assert.equal(
        servedByPortal, listedOnHome,
        `${level}: portal serves=${servedByPortal} but home lists=${listedOnHome}`,
      );
      assert.equal(servedByPortal, expected[level], `${level}: unexpected portal decision`);

      if (!expected[level]) {
        assert.equal(entry.status, 'CLASSIFICATION_RESTRICTED');
      }
    }

    await setLevel(rootId, 'INTERNAL');
    await prisma.resource.update({ where: { id: rootId }, data: { visibility: 'ORGANIZATION' } });
  });

  test('archived resources are refused by the gate, not merely hidden from listings', async () => {
    await prisma.resource.update({ where: { id: rootId }, data: { lifecycleState: 'ARCHIVED' } });
    try {
      assert.equal(await denied(() => resolvePortalAccess(externalId, rootId)), true);
      assert.equal((await listPortalRoots(externalId)).length, 0);
      assert.equal((await portalHome(external)).shared.length, 0);
    } finally {
      await prisma.resource.update({ where: { id: rootId }, data: { lifecycleState: 'ACTIVE' } });
    }
    // กลับมาใช้ได้เองเมื่อนำออกจากคลัง ไม่ต้องแชร์ใหม่
    assert.equal(await denied(() => resolvePortalAccess(externalId, rootId)), false);
  });

  /* ---------------- §15 เมทริกซ์บังคับ ---------------- */

  test('a blocked resource is refused on every portal route, not just on open', async () => {
    await setLevel(rootId, 'CONFIDENTIAL');
    try {
      assert.equal(await denied(() => resolvePortalAccess(externalId, rootId)), true, 'direct open');
      assert.equal(await denied(() => openPortalFolder(external, rootId, audit)), true, 'folder open');
      assert.equal(await denied(() => resolvePortalContent(external, fileId, { requireDownload: false })), true, 'content');
      assert.equal(await denied(() => resolvePortalContent(external, fileId, { requireDownload: true })), true, 'download');
      assert.equal(await denied(() => listPortalVersions(external, fileId, audit)), true, 'versions');
      assert.equal(
        await denied(() => uploadToPortalFolder(external, rootId, stream('x'), { fileName: 'blocked.txt' }, audit)),
        true,
        'upload',
      );

      assert.equal((await portalHome(external)).shared.length, 0, 'home');
      assert.equal((await searchPortal(external, prefix)).length, 0, 'search');

      // ประวัติการส่งไฟล์ของตัวเองยังอยู่ แต่ต้องไม่เสนอปุ่มที่กดแล้วถูกปฏิเสธ
      const history = await listUploadHistory(external, { limit: 20 });
      for (const item of history.items) {
        assert.notEqual(item.state, 'AVAILABLE');
        assert.equal(item.capabilities?.canDownload ?? false, false);
      }
    } finally {
      await setLevel(rootId, 'INTERNAL');
    }
  });

  test('a permitted parent never leaks a blocked or archived child', async () => {
    await setLevel(childFolderId, 'CONFIDENTIAL');
    await prisma.resource.update({ where: { id: fileId }, data: { lifecycleState: 'ARCHIVED' } });
    try {
      const view = await openPortalFolder(external, rootId, audit);
      const listed = view.items.map((item) => item.id);
      assert.equal(listed.includes(childFolderId), false, 'confidential child listed');
      assert.equal(listed.includes(fileId), false, 'archived child listed');

      // และเข้าถึงตรงก็ไม่ได้ด้วย - การไม่แสดงอย่างเดียวไม่ใช่การบังคับใช้
      assert.equal(await denied(() => resolvePortalAccess(externalId, childFolderId)), true);
      assert.equal(await denied(() => resolvePortalAccess(externalId, fileId)), true);

      // ค้นหาต้องไม่เปิดเผยแม้แต่การมีอยู่
      const hits = await searchPortal(external, prefix);
      const hitIds = hits.map((hit) => hit.id);
      assert.equal(hitIds.includes(childFolderId), false);
      assert.equal(hitIds.includes(fileId), false);
      assert.equal(JSON.stringify(hits).includes(`${prefix}-child`), false);
    } finally {
      await setLevel(childFolderId, 'INTERNAL');
      await prisma.resource.update({ where: { id: fileId }, data: { lifecycleState: 'ACTIVE' } });
    }
  });

  test('blocking hides the document but never deletes the evidence of who was granted access', async () => {
    await setLevel(rootId, 'RESTRICTED');
    try {
      const grants = await prisma.resourceAccess.count({ where: { resourceId: rootId, userId: externalId } });
      assert.equal(grants, 1, 'grant row must survive');

      const review = await effectiveAccessReview(rootId);
      const entry = review.entries.find((item) => item.subject.id === externalId)!;
      assert.equal(entry.usable, false);
      assert.equal(entry.status, 'CLASSIFICATION_RESTRICTED');
      assert.ok(entry.evidence.length > 0, 'evidence must remain visible to auditors');
      assert.equal(review.classificationPolicy.externalAccessBlocked, true);
    } finally {
      await setLevel(rootId, 'INTERNAL');
      await prisma.resource.update({ where: { id: rootId }, data: { visibility: 'ORGANIZATION' } });
    }
  });

  test('expiry, revocation and cross-customer isolation behave exactly as before', async () => {
    // หมดอายุ
    await prisma.resourceAccess.update({
      where: { resourceId_userId: { resourceId: rootId, userId: externalId } },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });
    assert.equal(await denied(() => resolvePortalAccess(externalId, rootId)), true, 'expired grant');

    await prisma.resourceAccess.update({
      where: { resourceId_userId: { resourceId: rootId, userId: externalId } },
      data: { expiresAt: null },
    });
    assert.equal(await denied(() => resolvePortalAccess(externalId, rootId)), false, 'restored grant');

    // ลูกค้ารายอื่นไม่เคยได้รับสิทธิ์ - ต้องไม่เห็นอะไรเลย
    assert.equal(await denied(() => resolvePortalAccess(otherExternalId, rootId)), true, 'cross-customer');
    assert.equal((await listPortalRoots(otherExternalId)).length, 0, 'cross-customer home');

    // เพิกถอน
    await prisma.resourceAccess.deleteMany({ where: { resourceId: rootId, userId: externalId } });
    assert.equal(await denied(() => resolvePortalAccess(externalId, rootId)), true, 'revoked grant');
    await prisma.resourceAccess.create({
      data: { resourceId: rootId, userId: externalId, accessLevel: 'EDITOR', allowDownload: true, createdById: ownerId },
    });
  });

  test('the exposure helper asks the F25-D policy rather than restating it', () => {
    const base = { deletedAt: null, lifecycleState: 'ACTIVE' as const };
    assert.equal(resourceExposableToPortal({ ...base, classification: 'PUBLIC' }), true);
    assert.equal(resourceExposableToPortal({ ...base, classification: 'INTERNAL' }), true);
    assert.equal(resourceExposableToPortal({ ...base, classification: 'CONFIDENTIAL' }), false);
    assert.equal(resourceExposableToPortal({ ...base, classification: 'RESTRICTED' }), false);
    assert.equal(resourceExposableToPortal({ ...base, lifecycleState: 'ARCHIVED', classification: 'PUBLIC' }), false);
    assert.equal(resourceExposableToPortal({ ...base, deletedAt: new Date(), classification: 'PUBLIC' }), false);
  });
});

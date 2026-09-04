import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { after, before, describe, test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app.js';
import { prisma } from '../../core/prisma.js';
import { issueSessionForUser } from '../auth/auth.service.js';
import { createFolder } from '../resources/resource.service.js';
import { uploadFile } from '../files/file.service.js';
import { trashResource } from '../files/trash.service.js';
import { grantAccess, revokeAccess } from '../workspace/sharing.service.js';
import type { AuthUser } from '../auth/auth.service.js';

/**
 * F10 - ความปลอดภัยของพื้นที่เอกสารสำหรับลูกค้า
 *
 * ทดสอบผ่าน HTTP จริงทั้งหมด ไม่เรียกเซอร์วิสลัด
 * เพราะสิ่งที่ต้องพิสูจน์คือ "คำขอที่ส่งมาจริง ๆ ถูกปฏิเสธ" ไม่ใช่ "ฟังก์ชันคืนค่า false"
 * ด่านที่รั่วมักรั่วตรงชั้นเส้นทาง ไม่ใช่ตรงตรรกะที่เขียนไว้ดีแล้ว
 *
 * ข้อมูลทดสอบทั้งหมดเป็นของใช้แล้วทิ้งที่ชุดทดสอบนี้สร้างเอง และถูกเก็บกวาดเมื่อจบ
 */

const stream = (text: string) => Readable.from([Buffer.from(text)]);

describe('F10 พื้นที่เอกสารสำหรับลูกค้า', () => {
  const prefix = `f10-${process.pid}`;
  const audit = {};

  let app: FastifyInstance;

  let staffId = '';
  let viewerId = '';
  let contributorId = '';
  let strangerId = '';

  let staff: AuthUser;

  let sharedFolderId = '';
  let subFolderId = '';
  let sharedFileId = '';
  let uploadFolderId = '';
  let secretFolderId = '';
  let secretFileId = '';

  let viewerToken = '';
  let contributorToken = '';
  let strangerToken = '';
  let staffToken = '';

  const created: string[] = [];

  const internal = (id: string): AuthUser => ({
    id,
    email: `${id}@test.invalid`,
    displayName: id,
    type: 'INTERNAL',
    status: 'ACTIVE',
    mustChangePassword: false,
    roles: ['MEMBER'],
    permissions: ['resources:read', 'resources:write', 'resources:delete', 'resources:share', 'resources:lock'],
  });

  /** token จริงที่ออกจากเส้นทางเดียวกับการเข้าสู่ระบบ ไม่ใช่ token ที่ปั้นขึ้นเองในเทส */
  const tokenFor = async (userId: string) => (await issueSessionForUser(userId)).accessToken;

  const asUser = (token: string) => ({ authorization: `Bearer ${token}` });

  before(async () => {
    app = await buildApp();
    await app.ready();

    const users = await Promise.all([
      prisma.user.create({
        data: { email: `${prefix}-staff@example.invalid`, displayName: 'F10 Staff QA', type: 'INTERNAL', status: 'ACTIVE' },
      }),
      prisma.user.create({
        data: {
          email: `${prefix}-viewer@example.invalid`,
          displayName: 'F10 Client Viewer QA',
          type: 'EXTERNAL',
          organizationName: 'บริษัท ทดสอบ จำกัด',
          status: 'ACTIVE',
        },
      }),
      prisma.user.create({
        data: {
          email: `${prefix}-contributor@example.invalid`,
          displayName: 'F10 Client Contributor QA',
          type: 'EXTERNAL',
          organizationName: 'บริษัท ทดสอบ จำกัด',
          status: 'ACTIVE',
        },
      }),
      prisma.user.create({
        data: { email: `${prefix}-stranger@example.invalid`, displayName: 'F10 Client Stranger QA', type: 'EXTERNAL', status: 'ACTIVE' },
      }),
    ]);
    [staffId, viewerId, contributorId, strangerId] = users.map((row) => row.id) as [string, string, string, string];

    staff = internal(staffId);

    /**
     * โครงสร้างทดสอบ
     *
     *   F10 Client Portal QA        <- แชร์ให้ผู้ดูอย่างเดียว
     *     ภาษี                       <- ลูกที่สืบทอดสิทธิ์
     *       สรุปภาษี.txt
     *   F10 Client Upload QA        <- แชร์ให้ผู้อัปโหลด
     *   F10 Internal Only QA        <- ไม่แชร์ให้ใครเลย
     *     ความลับภายใน.txt
     */
    const shared = await createFolder(staff, { name: `F10 Client Portal QA ${prefix}`, parentId: null }, audit);
    sharedFolderId = shared.id;
    const sub = await createFolder(staff, { name: 'ภาษี', parentId: sharedFolderId }, audit);
    subFolderId = sub.id;
    const upload = await createFolder(staff, { name: `F10 Client Upload QA ${prefix}`, parentId: null }, audit);
    uploadFolderId = upload.id;
    const secret = await createFolder(staff, { name: `F10 Internal Only QA ${prefix}`, parentId: null }, audit);
    secretFolderId = secret.id;
    created.push(sharedFolderId, subFolderId, uploadFolderId, secretFolderId);

    const sharedFile = await uploadFile(
      staff,
      stream('สรุปภาษีเดือนสิงหาคม'),
      { parentId: subFolderId, fileName: `สรุปภาษี-${prefix}.txt`, allowDuplicateContent: true },
      audit,
    );
    sharedFileId = sharedFile.resource.id;

    const secretFile = await uploadFile(
      staff,
      stream('ข้อมูลภายในห้ามเผยแพร่'),
      { parentId: secretFolderId, fileName: `ความลับ-${prefix}.txt`, allowDuplicateContent: true },
      audit,
    );
    secretFileId = secretFile.resource.id;
    created.push(sharedFileId, secretFileId);

    await grantAccess(sharedFolderId, { userId: viewerId, accessLevel: 'VIEWER', allowDownload: false }, staff, audit);
    await grantAccess(uploadFolderId, { userId: contributorId, accessLevel: 'EDITOR', allowDownload: true }, staff, audit);

    viewerToken = await tokenFor(viewerId);
    contributorToken = await tokenFor(contributorId);
    strangerToken = await tokenFor(strangerId);
    staffToken = await tokenFor(staffId);
  });

  /**
   * เก็บกวาดของใช้แล้วทิ้งทั้งหมด
   *
   * ลบจากใบไปหาราก เพราะ Resource อ้างถึงโฟลเดอร์แม่แบบ Restrict
   * และผู้ใช้ลบได้ก็ต่อเมื่อไม่มีทรัพยากรใดอ้างถึงเขาเหลืออยู่แล้ว
   * รวมของที่ลูกค้าอัปโหลดเข้ามาระหว่างเทสด้วย ซึ่งไม่ได้อยู่ในรายการที่เราสร้างเอง
   */
  after(async () => {
    await app.close();

    const userIds = [staffId, viewerId, contributorId, strangerId].filter(Boolean);

    // ไล่หาลูกหลานทุกชั้นของสิ่งที่ชุดทดสอบนี้สร้างขึ้น
    const ids = new Set(created.filter(Boolean));
    for (let depth = 0; depth < 10; depth += 1) {
      const children = await prisma.resource.findMany({
        where: { parentId: { in: [...ids] } },
        select: { id: true },
      });
      const before = ids.size;
      for (const child of children) ids.add(child.id);
      if (ids.size === before) break;
    }
    const all = [...ids];

    await prisma.activityLog.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.activityLog.deleteMany({ where: { resourceId: { in: all } } });
    await prisma.resourceVersion.deleteMany({ where: { resourceId: { in: all } } });
    await prisma.resourceAccess.deleteMany({ where: { resourceId: { in: all } } });
    await prisma.userFavorite.deleteMany({ where: { resourceId: { in: all } } });
    await prisma.userPinnedResource.deleteMany({ where: { resourceId: { in: all } } });

    // ลบใบก่อนเสมอ - วนจนไม่เหลืออะไรให้ลบ
    for (let pass = 0; pass < 10; pass += 1) {
      const remaining = await prisma.resource.findMany({
        where: { id: { in: all } },
        select: { id: true },
      });
      if (remaining.length === 0) break;
      const remainingIds = remaining.map((row) => row.id);
      const parents = await prisma.resource.findMany({
        where: { parentId: { in: remainingIds } },
        select: { parentId: true },
      });
      const hasChildren = new Set(parents.map((row) => row.parentId));
      const leaves = remainingIds.filter((id) => !hasChildren.has(id));
      if (leaves.length === 0) break;
      await prisma.resource.deleteMany({ where: { id: { in: leaves } } });
    }

    await prisma.refreshToken.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  });

  /* ---------------------------------------------------------------- */
  /* การแยกเส้นทาง                                                     */
  /* ---------------------------------------------------------------- */

  describe('ผู้ใช้ภายนอกเข้าเส้นทางภายในไม่ได้', () => {
    const internalRoutes: Array<[string, string]> = [
      ['GET', '/api/dashboard/summary'],
      ['GET', '/api/resources'],
      ['GET', '/api/resources?driveScope=SYSTEM_DRIVE'],
      ['GET', '/api/resources-recent'],
      ['GET', '/api/trash'],
      ['GET', '/api/search?q=%E0%B8%A0%E0%B8%B2%E0%B8%A9%E0%B8%B5'],
      ['GET', '/api/shared'],
      ['GET', '/api/favorites'],
      ['GET', '/api/activity'],
      ['GET', '/api/share-targets?q=a'],
      ['GET', '/api/users'],
      ['GET', '/api/roles'],
      ['GET', '/api/admin/settings'],
      ['GET', '/api/admin/ownership'],
      ['GET', '/api/admin/integrations'],
      ['GET', '/api/system/managed-storage'],
    ];

    for (const [method, url] of internalRoutes) {
      test(`${method} ${url} ถูกปฏิเสธ`, async () => {
        const response = await app.inject({ method: method as 'GET', url, headers: asUser(viewerToken) });
        assert.equal(response.statusCode, 403, `${url} ต้องตอบ 403 แต่ได้ ${response.statusCode}`);
        // ต้องไม่มีข้อมูลใด ๆ ติดออกไปกับคำตอบที่ถูกปฏิเสธ
        assert.equal(response.json().success, false);
        assert.equal(response.json().data, undefined);
      });
    }

    test('บัญชีภายในเข้าพื้นที่ลูกค้าไม่ได้เช่นกัน', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/portal/resources', headers: asUser(staffToken) });
      assert.equal(response.statusCode, 403, 'พนักงานภายในต้องไม่หลงเข้าไปในพื้นที่ลูกค้า');
    });

    test('ไม่มี token ก็เข้าพื้นที่ลูกค้าไม่ได้ - ไม่มีลิงก์สาธารณะในเฟสนี้', async () => {
      const anonymous = await app.inject({ method: 'GET', url: '/api/portal/resources' });
      assert.equal(anonymous.statusCode, 401);
    });
  });

  /* ---------------------------------------------------------------- */
  /* ขอบเขตที่มองเห็น                                                  */
  /* ---------------------------------------------------------------- */

  describe('เห็นเฉพาะสิ่งที่ถูกแชร์ให้', () => {
    test('หน้าแรกแสดงเฉพาะโฟลเดอร์ที่แชร์ให้จริง', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/portal/resources', headers: asUser(viewerToken) });
      assert.equal(response.statusCode, 200);
      const ids = response.json().data.shared.map((item: { id: string }) => item.id);
      assert.deepEqual(ids, [sharedFolderId]);
      assert.ok(!ids.includes(secretFolderId), 'โฟลเดอร์ที่ไม่ได้แชร์ต้องไม่ปรากฏ');
      assert.ok(!ids.includes(uploadFolderId), 'โฟลเดอร์ของลูกค้ารายอื่นต้องไม่ปรากฏ');
    });

    test('ลูกค้าที่ยังไม่ได้รับสิทธิ์ใดเลยเห็นรายการว่าง', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/portal/resources', headers: asUser(strangerToken) });
      assert.equal(response.statusCode, 200);
      assert.deepEqual(response.json().data.shared, []);
      assert.deepEqual(response.json().data.uploadFolders, []);
    });

    test('สิทธิ์สืบทอดลงไปถึงโฟลเดอร์ลูกและไฟล์ข้างใน', async () => {
      const folder = await app.inject({ method: 'GET', url: `/api/portal/folders/${subFolderId}`, headers: asUser(viewerToken) });
      assert.equal(folder.statusCode, 200);
      const names = folder.json().data.items.map((item: { name: string }) => item.name);
      assert.ok(names.some((name: string) => name.includes('สรุปภาษี')), 'ไฟล์ในโฟลเดอร์ลูกต้องมองเห็นได้');
    });

    test('เส้นทางนำทางหยุดที่รากที่ได้รับสิทธิ์ ไม่เผยชั้นเหนือขึ้นไป', async () => {
      const response = await app.inject({ method: 'GET', url: `/api/portal/folders/${subFolderId}`, headers: asUser(viewerToken) });
      const crumbs = response.json().data.breadcrumb as Array<{ id: string; name: string }>;
      assert.equal(crumbs[0]!.id, sharedFolderId, 'ชั้นแรกต้องเป็นโฟลเดอร์ที่ถูกแชร์ให้');
      assert.equal(crumbs[crumbs.length - 1]!.id, subFolderId);
      for (const crumb of crumbs) {
        assert.ok(!crumb.name.includes('ไดร์ฟของฉัน'), 'ต้องไม่มีชื่อไดร์ฟภายในอยู่ในเส้นทางนำทาง');
        assert.ok(!crumb.name.includes('ไดร์ฟของระบบ'));
      }
    });
  });

  /* ---------------------------------------------------------------- */
  /* การเดารหัสทรัพยากร                                                */
  /* ---------------------------------------------------------------- */

  describe('เดารหัสทรัพยากรภายในไม่ได้', () => {
    test('รหัสจริงที่ไม่ได้แชร์ให้ ตอบเหมือนไม่มีอยู่จริง', async () => {
      const response = await app.inject({ method: 'GET', url: `/api/portal/resources/${secretFileId}`, headers: asUser(viewerToken) });
      assert.equal(response.statusCode, 404);
      const body = JSON.stringify(response.json());
      assert.ok(!body.includes('ความลับ'), 'ชื่อไฟล์ภายในต้องไม่รั่วออกไปกับข้อความ error');
      assert.ok(!body.includes('storageKey'));
    });

    test('รหัสที่ไม่มีอยู่จริงตอบเหมือนกันทุกประการ', async () => {
      const real = await app.inject({ method: 'GET', url: `/api/portal/resources/${secretFolderId}`, headers: asUser(viewerToken) });
      const fake = await app.inject({ method: 'GET', url: '/api/portal/resources/ckzzzzzznotarealid0001', headers: asUser(viewerToken) });
      assert.equal(real.statusCode, fake.statusCode, 'สถานะต้องเหมือนกัน มิฉะนั้นเดาได้ว่ารหัสใดมีอยู่จริง');
      assert.deepEqual(real.json().error, fake.json().error, 'ข้อความต้องเหมือนกันทุกตัวอักษร');
    });

    test('ขอเนื้อหาไฟล์ภายในตรง ๆ ก็ไม่ได้', async () => {
      for (const path of ['content', 'download']) {
        const response = await app.inject({
          method: 'GET',
          url: `/api/portal/resources/${secretFileId}/${path}`,
          headers: asUser(viewerToken),
        });
        assert.equal(response.statusCode, 404, `/${path} ต้องไม่ยอมให้เข้าถึง`);
      }
    });

    test('ค้นหาไม่คืนสิ่งที่อยู่นอกขอบเขต', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/portal/search?q=${encodeURIComponent('ความลับ')}`,
        headers: asUser(viewerToken),
      });
      assert.equal(response.statusCode, 200);
      assert.deepEqual(response.json().data, [], 'คำค้นที่ตรงกับเอกสารภายในต้องไม่คืนผลใด ๆ');
    });

    test('ค้นหาคืนเฉพาะสิ่งที่อยู่ในขอบเขตของตัวเอง', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/portal/search?q=${encodeURIComponent('ภาษี')}`,
        headers: asUser(viewerToken),
      });
      const ids = response.json().data.map((item: { id: string }) => item.id);
      assert.ok(ids.includes(subFolderId), 'ของที่อยู่ในขอบเขตต้องค้นเจอ');
      assert.ok(!ids.includes(secretFileId));
    });
  });

  /* ---------------------------------------------------------------- */
  /* ผู้ดูอย่างเดียว                                                   */
  /* ---------------------------------------------------------------- */

  describe('ผู้ดูอย่างเดียว', () => {
    test('เปิดดูเนื้อหาได้', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/portal/resources/${sharedFileId}/content`,
        headers: asUser(viewerToken),
      });
      assert.equal(response.statusCode, 200);
    });

    test('allowDownload = false ทำให้ดาวน์โหลดไม่ได้ แม้เปิดดูได้', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/portal/resources/${sharedFileId}/download`,
        headers: asUser(viewerToken),
      });
      assert.equal(response.statusCode, 403);
      assert.equal(response.json().error.code, 'DOWNLOAD_DENIED');
    });

    test('อัปโหลดเข้าโฟลเดอร์ที่ตัวเองดูได้ ก็ยังอัปโหลดไม่ได้', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/portal/folders/${sharedFolderId}/upload`,
        headers: { ...asUser(viewerToken), 'content-type': 'multipart/form-data; boundary=x' },
        payload: multipart('viewer.txt', 'ห้ามผ่าน'),
      });
      assert.ok([403, 400].includes(response.statusCode), `ต้องถูกปฏิเสธ แต่ได้ ${response.statusCode}`);
      if (response.statusCode === 403) assert.equal(response.json().error.code, 'PORTAL_UPLOAD_DENIED');
    });

    test('ความสามารถที่ส่งให้หน้าจอสอดคล้องกับที่เซิร์ฟเวอร์บังคับใช้', async () => {
      const response = await app.inject({ method: 'GET', url: `/api/portal/resources/${sharedFileId}`, headers: asUser(viewerToken) });
      const caps = response.json().data.resource.capabilities;
      assert.equal(caps.canDownload, false);
      assert.equal(caps.canUpload, false);
      assert.equal(caps.canRename, false);
      assert.equal(caps.canDelete, false);
      assert.equal(caps.canShare, false);
    });
  });

  /* ---------------------------------------------------------------- */
  /* ผู้อัปโหลด                                                        */
  /* ---------------------------------------------------------------- */

  describe('ผู้อัปโหลด', () => {
    test('อัปโหลดเข้าโฟลเดอร์ที่ได้รับสิทธิ์ได้ และถูกบันทึกว่าเป็นของลูกค้า', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/portal/folders/${uploadFolderId}/upload`,
        headers: { ...asUser(contributorToken), 'content-type': 'multipart/form-data; boundary=x' },
        payload: multipart(`ใบเสร็จ-${prefix}.txt`, 'ใบเสร็จจากลูกค้า'),
      });
      assert.equal(response.statusCode, 201, JSON.stringify(response.json()));
      const uploaded = response.json().data;
      assert.equal(uploaded.sourceLabel, 'ลูกค้าอัปโหลด', 'ต้องแสดงป้ายภาษาไทย ไม่ใช่ค่าดิบของ enum');

      const row = await prisma.resource.findUnique({
        where: { id: uploaded.id },
        select: { createdById: true, ownerId: true, sourceType: true, parentId: true, checksum: true },
      });
      assert.equal(row!.createdById, contributorId, 'ผู้สร้างคือลูกค้าที่อัปโหลด');
      assert.equal(row!.ownerId, staffId, 'ผู้รับผิดชอบยังเป็นเจ้าของโฟลเดอร์ ไม่ใช่ลูกค้า');
      assert.equal(row!.sourceType, 'EXTERNAL_UPLOAD');
      assert.equal(row!.parentId, uploadFolderId);
      assert.ok(row!.checksum, 'ต้องผ่านสายอัปโหลดเดิมที่คำนวณ checksum');
    });

    test('อัปโหลดเข้าโฟลเดอร์ที่ไม่ได้รับสิทธิ์ไม่ได้', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/portal/folders/${secretFolderId}/upload`,
        headers: { ...asUser(contributorToken), 'content-type': 'multipart/form-data; boundary=x' },
        payload: multipart('แทรก.txt', 'ห้ามผ่าน'),
      });
      assert.equal(response.statusCode, 404, 'โฟลเดอร์ที่ไม่ได้แชร์ให้ต้องเหมือนไม่มีอยู่จริง');
    });

    test('อัปโหลดเข้าโฟลเดอร์ของลูกค้ารายอื่นไม่ได้', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/portal/folders/${uploadFolderId}/upload`,
        headers: { ...asUser(viewerToken), 'content-type': 'multipart/form-data; boundary=x' },
        payload: multipart('แทรก.txt', 'ห้ามผ่าน'),
      });
      assert.equal(response.statusCode, 404);
    });
  });

  /* ---------------------------------------------------------------- */
  /* หมดอายุและเพิกถอน                                                 */
  /* ---------------------------------------------------------------- */

  describe('หมดอายุและเพิกถอน', () => {
    test('สิทธิ์ที่หมดอายุแล้วถูกปฏิเสธ โดยไม่ต้องออกจากระบบก่อน', async () => {
      const before = await app.inject({ method: 'GET', url: `/api/portal/folders/${sharedFolderId}`, headers: asUser(viewerToken) });
      assert.equal(before.statusCode, 200);

      // ตั้งวันหมดอายุย้อนหลังโดยตรง เพื่อจำลองเวลาที่เดินผ่านไปแล้ว
      await prisma.resourceAccess.updateMany({
        where: { resourceId: sharedFolderId, userId: viewerId },
        data: { expiresAt: new Date(Date.now() - 60_000) },
      });

      const after = await app.inject({ method: 'GET', url: `/api/portal/folders/${sharedFolderId}`, headers: asUser(viewerToken) });
      assert.equal(after.statusCode, 404, 'สิทธิ์ที่หมดอายุต้องถูกปฏิเสธทันทีด้วย token ใบเดิม');

      const home = await app.inject({ method: 'GET', url: '/api/portal/resources', headers: asUser(viewerToken) });
      assert.deepEqual(home.json().data.shared, [], 'สิทธิ์ที่หมดอายุต้องหายจากหน้าแรกด้วย');

      // คืนสภาพให้เทสถัดไป
      await prisma.resourceAccess.updateMany({
        where: { resourceId: sharedFolderId, userId: viewerId },
        data: { expiresAt: null },
      });
      const restored = await app.inject({ method: 'GET', url: `/api/portal/folders/${sharedFolderId}`, headers: asUser(viewerToken) });
      assert.equal(restored.statusCode, 200);
    });

    test('การเพิกถอนมีผลทันทีกับ token ใบเดิม', async () => {
      await grantAccess(secretFolderId, { userId: strangerId, accessLevel: 'VIEWER', allowDownload: true }, staff, audit);
      const granted = await app.inject({ method: 'GET', url: `/api/portal/folders/${secretFolderId}`, headers: asUser(strangerToken) });
      assert.equal(granted.statusCode, 200);

      await revokeAccess(secretFolderId, strangerId, staff, audit);

      const revoked = await app.inject({ method: 'GET', url: `/api/portal/folders/${secretFolderId}`, headers: asUser(strangerToken) });
      assert.equal(revoked.statusCode, 404, 'ไม่ต้องรอ session หมดอายุ การเพิกถอนต้องมีผลทันที');
    });

    test('วันหมดอายุในอดีตถูกปฏิเสธตั้งแต่ตอนให้สิทธิ์', async () => {
      await assert.rejects(
        () =>
          grantAccess(
            sharedFolderId,
            { userId: strangerId, accessLevel: 'VIEWER', allowDownload: false, expiresAt: new Date(Date.now() - 1000) },
            staff,
            audit,
          ),
        (error: { code?: string }) => error.code === 'SHARE_INVALID_EXPIRY',
      );
    });
  });

  /* ---------------------------------------------------------------- */
  /* ถังขยะ                                                           */
  /* ---------------------------------------------------------------- */

  describe('ถังขยะ', () => {
    test('เอกสารที่ถูกย้ายไปถังขยะหายจากพื้นที่ลูกค้าทันที', async () => {
      const folder = await createFolder(staff, { name: `F10 Trash QA ${prefix}`, parentId: null }, audit);
      created.push(folder.id);
      await grantAccess(folder.id, { userId: strangerId, accessLevel: 'VIEWER', allowDownload: true }, staff, audit);

      const visible = await app.inject({ method: 'GET', url: `/api/portal/folders/${folder.id}`, headers: asUser(strangerToken) });
      assert.equal(visible.statusCode, 200);

      await trashResource(folder.id, staff, audit);

      const gone = await app.inject({ method: 'GET', url: `/api/portal/folders/${folder.id}`, headers: asUser(strangerToken) });
      assert.equal(gone.statusCode, 404);

      const home = await app.inject({ method: 'GET', url: '/api/portal/resources', headers: asUser(strangerToken) });
      const ids = home.json().data.shared.map((item: { id: string }) => item.id);
      assert.ok(!ids.includes(folder.id), 'ของในถังขยะต้องไม่อยู่ในหน้าแรกของลูกค้า');
    });
  });

  /* ---------------------------------------------------------------- */
  /* การบันทึกร่องรอย                                                  */
  /* ---------------------------------------------------------------- */

  describe('การบันทึกร่องรอย', () => {
    test('การเปิดดูและการอัปโหลดของลูกค้าถูกบันทึกด้วยรหัสเฉพาะของภายนอก', async () => {
      await app.inject({ method: 'GET', url: `/api/portal/folders/${sharedFolderId}`, headers: asUser(viewerToken) });

      const actions = await prisma.activityLog.findMany({
        where: { userId: { in: [viewerId, contributorId] } },
        select: { action: true },
      });
      const codes = new Set(actions.map((row) => row.action));
      assert.ok(codes.has('EXTERNAL_RESOURCE_VIEWED'), 'ต้องบันทึกการเปิดดูของลูกค้า');
      assert.ok(codes.has('EXTERNAL_FILE_UPLOADED'), 'ต้องบันทึกการอัปโหลดของลูกค้า');
    });

    test('การให้สิทธิ์แก่ลูกค้าถูกบันทึกแยกจากการแชร์ภายใน', async () => {
      const logs = await prisma.activityLog.findMany({
        where: { userId: staffId, action: 'EXTERNAL_ACCESS_GRANTED' },
        select: { id: true },
      });
      assert.ok(logs.length > 0, 'ต้องแยกให้เห็นว่าเอกสารถูกเปิดให้คนนอก');
    });
  });

  /* ---------------------------------------------------------------- */
  /* ข้อมูลที่ส่งออก                                                   */
  /* ---------------------------------------------------------------- */

  describe('ข้อมูลที่ส่งออกไม่รั่ว', () => {
    test('ไม่มีเส้นทางจริงบนดิสก์หรือข้อมูลภายในติดออกไป', async () => {
      const response = await app.inject({ method: 'GET', url: `/api/portal/folders/${subFolderId}`, headers: asUser(viewerToken) });
      const body = JSON.stringify(response.json());
      for (const forbidden of ['storageKey', 'checksum', 'ownerId', 'visibility', 'driveScope', 'siblingKey', 'normalizedName']) {
        assert.ok(!body.includes(forbidden), `${forbidden} ต้องไม่หลุดออกไปที่ฝั่งลูกค้า`);
      }
    });

    test('ไม่ส่งประวัติเวอร์ชันออกไป', async () => {
      const response = await app.inject({ method: 'GET', url: `/api/portal/resources/${sharedFileId}`, headers: asUser(viewerToken) });
      const body = JSON.stringify(response.json());
      assert.ok(!body.includes('currentVersion'), 'เฟสนี้ลูกค้าเห็นเฉพาะเวอร์ชันล่าสุด ไม่เห็นเลขเวอร์ชัน');
      assert.ok(!body.includes('versions'));
    });
  });
});

/** payload multipart แบบง่ายสำหรับ app.inject - ใช้ boundary คงที่ให้อ่านง่าย */
function multipart(fileName: string, content: string): string {
  return [
    '--x',
    `Content-Disposition: form-data; name="file"; filename="${fileName}"`,
    'Content-Type: text/plain',
    '',
    content,
    '--x--',
    '',
  ].join('\r\n');
}

import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { after, before, describe, test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app.js';
import { prisma } from '../../core/prisma.js';
import { issueSessionForUser } from '../auth/auth.service.js';
import { createFolder } from '../resources/resource.service.js';
import { uploadFile, uploadVersion } from '../files/file.service.js';
import { trashResource } from '../files/trash.service.js';
import { grantAccess, revokeAccess } from '../workspace/sharing.service.js';
import type { AuthUser } from '../auth/auth.service.js';

/**
 * F11 - การทำให้พื้นที่ลูกค้าแข็งแรงขึ้น
 *
 * สามเรื่องที่ชุดทดสอบนี้พิสูจน์:
 *   1. ลูกค้าคนหนึ่งเข้าถึงของลูกค้าอีกคนไม่ได้ แม้จะรู้รหัสทุกอย่าง
 *   2. ประวัติเวอร์ชันเป็นของอ่านอย่างเดียว และเคารพสิทธิ์ดาวน์โหลดเท่ากับเวอร์ชันปัจจุบัน
 *   3. การค้นหาลึกได้ทุกชั้น โดยไม่หลุดออกนอกขอบเขตแม้แต่รายการเดียว
 *
 * การตรวจเส้นทางภายในสร้างรายการจากตารางเส้นทางจริงของเซิร์ฟเวอร์ ไม่ใช่จากรายการที่พิมพ์ไว้เอง
 * เส้นทางใหม่ที่ใครเพิ่มเข้ามาในอนาคตจึงถูกตรวจโดยอัตโนมัติ ไม่ต้องมีใครจำได้
 */

const stream = (text: string) => Readable.from([Buffer.from(text)]);

/**
 * อ่านตารางเส้นทางจริงจาก Fastify
 *
 * printRoutes คืนต้นไม้ที่ย่อ prefix ร่วมกันไว้ จึงต้องประกอบเส้นทางเต็มกลับจากระดับความลึก
 * ทุกสี่อักขระคือหนึ่งระดับ และข้อความหลังเครื่องหมายกิ่งคือส่วนที่ต่อจากเส้นทางของแม่
 */
function registeredRoutes(app: FastifyInstance): Array<{ method: string; path: string }> {
  const tree = app.printRoutes({ commonPrefix: false });
  const prefixes: string[] = [];
  const routes: Array<{ method: string; path: string }> = [];

  for (const line of tree.split('\n')) {
    const marker = line.indexOf('── ');
    if (marker < 0) continue;
    const level = Math.floor(marker / 4);
    const rest = line.slice(marker + 3);

    const match = /^(\S*)\s*(?:\(([^)]*)\))?\s*$/.exec(rest);
    if (!match) continue;
    const segment = match[1] ?? '';
    const methods = match[2];

    const parent = level === 0 ? '' : prefixes[level - 1] ?? '';
    const full = parent + segment;
    prefixes[level] = full;
    prefixes.length = level + 1;

    if (!methods) continue;
    for (const method of methods.split(',').map((value) => value.trim())) {
      if (method === 'HEAD') continue;
      routes.push({ method, path: full });
    }
  }

  return routes;
}

/**
 * เส้นทางที่บัญชีลูกค้าเข้าถึงได้อย่างถูกต้อง
 *
 * นอกเหนือจากนี้ต้องถูกปฏิเสธทั้งหมด รายการนี้จึงสั้นโดยตั้งใจ
 * และการเพิ่มรายการเข้ามาต้องเป็นการตัดสินใจที่ตั้งใจ ไม่ใช่ผลข้างเคียงของการเพิ่มเส้นทางใหม่
 */
const PORTAL_ALLOWED = (path: string) => path.startsWith('/api/portal/');

/** เส้นทางสาธารณะหรือเส้นทางของบัญชีตัวเอง ซึ่งผู้ใช้ทุกชนิดต้องใช้ได้จริง */
const SHARED_ROUTES = new Set([
  '/api/health',
  '/api/system/info',
  '/api/system/storage',
  '/api/auth/login',
  '/api/auth/logout',
  '/api/auth/refresh',
  '/api/auth/session',
  '/api/auth/me',
  '/api/auth/profile',
  '/api/auth/change-password',
  '/api/auth/google/config',
  '/api/auth/google/start',
  '/api/auth/google/callback',
]);

/** เส้นทางของระบบเชื่อมต่อ ใช้การยืนยันตัวตนคนละชุด ไม่เกี่ยวกับ session ของผู้ใช้ */
const INTEGRATION_ROUTES = (path: string) => path.startsWith('/api/integrations/');

/**
 * เส้นทางที่ไม่ใช่ API - CORS preflight ของ @fastify/cors ลงทะเบียนเป็น OPTIONS *
 * ไม่ได้ให้ข้อมูลใด ๆ และไม่มีด่านตรวจสิทธิ์โดยธรรมชาติ
 */
const NON_API_ROUTES = (path: string) => !path.startsWith('/api/');

describe('F11 การทำให้พื้นที่ลูกค้าแข็งแรงขึ้น', () => {
  const prefix = `f11-${process.pid}`;
  const audit = {};

  let app: FastifyInstance;

  let staffId = '';
  let clientAId = '';
  let clientBId = '';
  let serviceId = '';
  let staff: AuthUser;

  let tokenA = '';
  let tokenB = '';
  let staffToken = '';
  let serviceToken = '';

  /** โครงสร้างของลูกค้า A - ลึกห้าชั้นเพื่อพิสูจน์การค้นหาลึก */
  let rootA = '';
  let taxFolder = '';
  let yearFolder = '';
  let monthFolder = '';
  let deepFileId = '';
  let versionedFileId = '';
  let uploadFolderA = '';

  /** โครงสร้างของลูกค้า B - แยกขาดจาก A โดยสิ้นเชิง */
  let rootB = '';
  let fileB = '';

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

  const tokenFor = async (userId: string) => (await issueSessionForUser(userId)).accessToken;
  const asUser = (token: string) => ({ authorization: `Bearer ${token}` });

  before(async () => {
    app = await buildApp();
    await app.ready();

    const users = await Promise.all([
      prisma.user.create({
        data: { email: `${prefix}-staff@example.invalid`, displayName: 'F11 Staff QA', type: 'INTERNAL', status: 'ACTIVE' },
      }),
      prisma.user.create({
        data: {
          email: `${prefix}-client-a@example.invalid`,
          displayName: 'F11 Client A QA',
          type: 'EXTERNAL',
          organizationName: 'บริษัท เอ จำกัด',
          status: 'ACTIVE',
        },
      }),
      prisma.user.create({
        data: {
          email: `${prefix}-client-b@example.invalid`,
          displayName: 'F11 Client B QA',
          type: 'EXTERNAL',
          organizationName: 'บริษัท บี จำกัด',
          status: 'ACTIVE',
        },
      }),
      prisma.user.create({
        data: { email: `${prefix}-service@example.invalid`, displayName: 'F11 Service QA', type: 'SERVICE', status: 'ACTIVE' },
      }),
    ]);
    [staffId, clientAId, clientBId, serviceId] = users.map((row) => row.id) as [string, string, string, string];
    staff = internal(staffId);

    /**
     * เอกสารบริษัท เอ / ภาษี / 2569 / กันยายน / ภงด53.pdf
     * ห้าชั้นพอดี - ของเดิมค้นเจอแค่สองชั้นแรก
     */
    const root = await createFolder(staff, { name: `F11 เอกสารบริษัท เอ ${prefix}`, parentId: null }, audit);
    rootA = root.id;
    taxFolder = (await createFolder(staff, { name: 'ภาษี', parentId: rootA }, audit)).id;
    yearFolder = (await createFolder(staff, { name: '2569', parentId: taxFolder }, audit)).id;
    monthFolder = (await createFolder(staff, { name: 'กันยายน', parentId: yearFolder }, audit)).id;
    uploadFolderA = (await createFolder(staff, { name: `F11 รับเอกสาร ${prefix}`, parentId: null }, audit)).id;
    created.push(rootA, taxFolder, yearFolder, monthFolder, uploadFolderA);

    const deep = await uploadFile(
      staff,
      stream('แบบแสดงรายการภาษีหัก ณ ที่จ่าย'),
      { parentId: monthFolder, fileName: `ภงด53-${prefix}.txt`, allowDuplicateContent: true },
      audit,
    );
    deepFileId = deep.resource.id;

    // ไฟล์ที่มีสามเวอร์ชัน - หนึ่งครั้งตอนสร้าง แล้วอีกสองครั้ง
    const versioned = await uploadFile(
      staff,
      stream('งบทดลอง ฉบับที่ 1'),
      { parentId: taxFolder, fileName: `งบทดลอง-${prefix}.txt`, allowDuplicateContent: true },
      audit,
    );
    versionedFileId = versioned.resource.id;
    await uploadVersion(staff, versionedFileId, stream('งบทดลอง ฉบับที่ 2'), {}, audit);
    await uploadVersion(staff, versionedFileId, stream('งบทดลอง ฉบับที่ 3'), {}, audit);
    created.push(deepFileId, versionedFileId);

    const bRoot = await createFolder(staff, { name: `F11 เอกสารบริษัท บี ${prefix}`, parentId: null }, audit);
    rootB = bRoot.id;
    const bFile = await uploadFile(
      staff,
      stream('เอกสารของบริษัท บี'),
      { parentId: rootB, fileName: `ภงด53-บี-${prefix}.txt`, allowDuplicateContent: true },
      audit,
    );
    fileB = bFile.resource.id;
    created.push(rootB, fileB);

    await grantAccess(rootA, { userId: clientAId, accessLevel: 'VIEWER', allowDownload: true }, staff, audit);
    await grantAccess(uploadFolderA, { userId: clientAId, accessLevel: 'EDITOR', allowDownload: false }, staff, audit);
    await grantAccess(rootB, { userId: clientBId, accessLevel: 'VIEWER', allowDownload: true }, staff, audit);

    tokenA = await tokenFor(clientAId);
    tokenB = await tokenFor(clientBId);
    staffToken = await tokenFor(staffId);
    serviceToken = await tokenFor(serviceId);
  });

  after(async () => {
    await app.close();
    const userIds = [staffId, clientAId, clientBId, serviceId].filter(Boolean);

    const ids = new Set(created.filter(Boolean));
    for (let depth = 0; depth < 12; depth += 1) {
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

    for (let pass = 0; pass < 12; pass += 1) {
      const remaining = await prisma.resource.findMany({ where: { id: { in: all } }, select: { id: true } });
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
  /* การตรวจเส้นทางภายในทั้งหมด                                        */
  /* ---------------------------------------------------------------- */

  describe('บัญชีลูกค้าถูกปฏิเสธจากทุกเส้นทางภายในที่ลงทะเบียนจริง', () => {
    test('อ่านตารางเส้นทางจากเซิร์ฟเวอร์ได้จริง', () => {
      const routes = registeredRoutes(app);
      assert.ok(routes.length > 50, `ควรอ่านเส้นทางได้หลายสิบรายการ แต่ได้ ${routes.length}`);
      // ตัวอย่างที่รู้แน่ว่าต้องมี - ถ้าอ่านผิดรูปแบบ ข้อนี้จะจับได้ก่อน
      assert.ok(routes.some((row) => row.method === 'GET' && row.path === '/api/resources'));
      assert.ok(routes.some((row) => row.method === 'GET' && row.path === '/api/search/facets'));
      assert.ok(routes.some((row) => row.method === 'POST' && row.path === '/api/users/:id/activate'));
      assert.ok(routes.some((row) => row.path === '/api/portal/resources'));
    });

    test('ทุกเส้นทางภายในตอบปฏิเสธ ไม่มีข้อยกเว้นที่ไม่ได้ตั้งใจ', async () => {
      const routes = registeredRoutes(app).filter(
        (row) =>
          !NON_API_ROUTES(row.path) &&
          !PORTAL_ALLOWED(row.path) &&
          !SHARED_ROUTES.has(row.path) &&
          !INTEGRATION_ROUTES(row.path),
      );
      assert.ok(routes.length > 30, `ควรมีเส้นทางภายในให้ตรวจจำนวนมาก แต่ได้ ${routes.length}`);

      const failures: string[] = [];
      for (const route of routes) {
        // รหัสสมมติที่ไม่มีอยู่จริง - ด่านต้องปฏิเสธก่อนจะไปถึงการค้นข้อมูลอยู่แล้ว
        const url = route.path.replace(/:[A-Za-z]+/g, 'f11-nonexistent-id');
        const response = await app.inject({
          method: route.method as 'GET',
          url,
          headers: asUser(tokenA),
        });
        if (![401, 403].includes(response.statusCode)) {
          failures.push(`${route.method} ${route.path} -> ${response.statusCode}`);
        }
      }

      assert.deepEqual(failures, [], `เส้นทางภายในที่ไม่ได้ปฏิเสธบัญชีลูกค้า:\n${failures.join('\n')}`);
    });

    test('บัญชีของระบบเชื่อมต่อเข้าพื้นที่ลูกค้าไม่ได้', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/portal/resources',
        headers: asUser(serviceToken),
      });
      assert.equal(response.statusCode, 403, 'บัญชี SERVICE ต้องไม่หลุดเข้าพื้นที่ลูกค้า');
    });

    test('บุคลากรภายในยังคงเข้าพื้นที่ลูกค้าไม่ได้', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/portal/resources',
        headers: asUser(staffToken),
      });
      assert.equal(response.statusCode, 403);
    });
  });

  /* ---------------------------------------------------------------- */
  /* การแยกขาดระหว่างลูกค้า                                            */
  /* ---------------------------------------------------------------- */

  describe('ลูกค้าคนหนึ่งเข้าถึงของอีกคนไม่ได้ แม้รู้รหัส', () => {
    /**
     * เส้นทางถูกประกอบตอนรันเทส ไม่ใช่ตอนลงทะเบียน
     * รหัสทรัพยากรยังเป็นค่าว่างในจังหวะที่ describe ถูกอ่าน
     */
    const crossChecks: Array<[string, () => string]> = [
      ['เปิดโฟลเดอร์', () => `/api/portal/folders/${rootB}`],
      ['ดูรายละเอียด', () => `/api/portal/resources/${fileB}`],
      ['เปิดดูเนื้อหา', () => `/api/portal/resources/${fileB}/content`],
      ['ดาวน์โหลด', () => `/api/portal/resources/${fileB}/download`],
      ['ประวัติเวอร์ชัน', () => `/api/portal/resources/${fileB}/versions`],
      ['เนื้อหาเวอร์ชันเก่า', () => `/api/portal/resources/${fileB}/versions/1/content`],
      ['ดาวน์โหลดเวอร์ชันเก่า', () => `/api/portal/resources/${fileB}/versions/1/download`],
    ];

    for (const [label, buildUrl] of crossChecks) {
      test(`ลูกค้า A ${label} ของลูกค้า B ไม่ได้`, async () => {
        const url = buildUrl();
        assert.ok(url.includes(rootB) || url.includes(fileB), 'ข้อมูลทดสอบต้องถูกสร้างเรียบร้อยแล้ว');
        const response = await app.inject({ method: 'GET', url, headers: asUser(tokenA) });
        assert.equal(response.statusCode, 404, `${url} ต้องตอบเหมือนไม่มีอยู่จริง`);
      });
    }

    test('ลูกค้า A อัปโหลดเข้าโฟลเดอร์ของลูกค้า B ไม่ได้', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/portal/folders/${rootB}/upload`,
        headers: { ...asUser(tokenA), 'content-type': 'multipart/form-data; boundary=x' },
        payload: multipart('แทรก.txt', 'ห้ามผ่าน'),
      });
      assert.equal(response.statusCode, 404);
    });

    test('ค้นหาของลูกค้า A ไม่คืนเอกสารของลูกค้า B แม้ชื่อจะตรงกัน', async () => {
      // ทั้งสองบริษัทมีไฟล์ชื่อขึ้นต้นด้วย ภงด53 เหมือนกัน
      const response = await app.inject({
        method: 'GET',
        url: `/api/portal/search?q=${encodeURIComponent('ภงด53')}`,
        headers: asUser(tokenA),
      });
      assert.equal(response.statusCode, 200);
      const ids = response.json().data.map((item: { id: string }) => item.id);
      assert.ok(ids.includes(deepFileId), 'ต้องเจอไฟล์ของตัวเอง');
      assert.ok(!ids.includes(fileB), 'ต้องไม่เจอไฟล์ของลูกค้าอีกราย');
    });

    test('ลูกค้า B เห็นเฉพาะของตัวเองเช่นกัน', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/portal/resources', headers: asUser(tokenB) });
      const ids = response.json().data.shared.map((item: { id: string }) => item.id);
      assert.deepEqual(ids, [rootB]);
    });
  });

  /* ---------------------------------------------------------------- */
  /* ประวัติเวอร์ชัน                                                    */
  /* ---------------------------------------------------------------- */

  describe('ประวัติเวอร์ชันสำหรับลูกค้า', () => {
    test('เห็นครบทุกเวอร์ชัน เรียงจากใหม่ไปเก่า และระบุเวอร์ชันปัจจุบันได้', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/portal/resources/${versionedFileId}/versions`,
        headers: asUser(tokenA),
      });
      assert.equal(response.statusCode, 200);
      const versions = response.json().data as Array<{ versionNumber: number; isCurrent: boolean; uploadedBy: string }>;

      assert.equal(versions.length, 3, 'ไฟล์นี้มีสามเวอร์ชัน');
      assert.deepEqual(versions.map((row) => row.versionNumber), [3, 2, 1]);
      assert.deepEqual(versions.map((row) => row.isCurrent), [true, false, false]);
      assert.ok(versions.every((row) => typeof row.uploadedBy === 'string' && row.uploadedBy.length > 0));
    });

    test('ไม่ส่งข้อมูลภายในของเวอร์ชันออกไป', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/portal/resources/${versionedFileId}/versions`,
        headers: asUser(tokenA),
      });
      const body = JSON.stringify(response.json());
      for (const forbidden of ['storageKey', 'checksum', 'createdById', 'integrationApp', 'resourceId']) {
        assert.ok(!body.includes(forbidden), `${forbidden} ต้องไม่หลุดออกไปที่ฝั่งลูกค้า`);
      }
      // อีเมลของบุคลากรภายในต้องไม่ติดออกไปกับชื่อผู้อัปโหลด
      assert.ok(!body.includes('@example.invalid'));
    });

    test('เปิดดูเวอร์ชันเก่าได้ และได้เนื้อหาของเวอร์ชันนั้นจริง', async () => {
      const first = await app.inject({
        method: 'GET',
        url: `/api/portal/resources/${versionedFileId}/versions/1/content`,
        headers: asUser(tokenA),
      });
      assert.equal(first.statusCode, 200);
      assert.match(first.body, /ฉบับที่ 1/, 'ต้องได้เนื้อหาของเวอร์ชันที่ขอ ไม่ใช่เวอร์ชันล่าสุด');

      const current = await app.inject({
        method: 'GET',
        url: `/api/portal/resources/${versionedFileId}/versions/3/content`,
        headers: asUser(tokenA),
      });
      assert.match(current.body, /ฉบับที่ 3/);
    });

    test('ดาวน์โหลดเวอร์ชันเก่าได้เมื่ออนุญาตให้ดาวน์โหลด', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/portal/resources/${versionedFileId}/versions/2/download`,
        headers: asUser(tokenA),
      });
      assert.equal(response.statusCode, 200);
      assert.match(response.headers['content-disposition'] as string, /attachment/);
    });

    test('เวอร์ชันที่ไม่มีอยู่ตอบเหมือนเอกสารที่ไม่มีสิทธิ์', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/portal/resources/${versionedFileId}/versions/99/content`,
        headers: asUser(tokenA),
      });
      assert.equal(response.statusCode, 404);
      assert.equal(response.json().error.code, 'PORTAL_RESOURCE_NOT_FOUND');
    });

    test('โฟลเดอร์ไม่มีประวัติเวอร์ชัน', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/portal/resources/${taxFolder}/versions`,
        headers: asUser(tokenA),
      });
      assert.equal(response.statusCode, 404);
    });

    test('ห้ามดาวน์โหลดแล้ว ห้ามทั้งเวอร์ชันปัจจุบันและเวอร์ชันเก่าเท่ากัน', async () => {
      await prisma.resourceAccess.updateMany({
        where: { resourceId: rootA, userId: clientAId },
        data: { allowDownload: false },
      });
      try {
        const current = await app.inject({
          method: 'GET',
          url: `/api/portal/resources/${versionedFileId}/download`,
          headers: asUser(tokenA),
        });
        const historical = await app.inject({
          method: 'GET',
          url: `/api/portal/resources/${versionedFileId}/versions/1/download`,
          headers: asUser(tokenA),
        });
        assert.equal(current.statusCode, 403);
        assert.equal(historical.statusCode, 403, 'ประวัติเวอร์ชันต้องไม่กลายเป็นทางลัดหลบข้อห้ามดาวน์โหลด');

        // แต่เปิดดูยังทำได้ - "ดูได้ แต่บันทึกลงเครื่องไม่ได้" เป็นสถานะที่ตั้งใจให้มี
        const preview = await app.inject({
          method: 'GET',
          url: `/api/portal/resources/${versionedFileId}/versions/1/content`,
          headers: asUser(tokenA),
        });
        assert.equal(preview.statusCode, 200);

        const list = await app.inject({
          method: 'GET',
          url: `/api/portal/resources/${versionedFileId}/versions`,
          headers: asUser(tokenA),
        });
        const versions = list.json().data as Array<{ canDownload: boolean }>;
        assert.ok(versions.every((row) => row.canDownload === false), 'รายการต้องสะท้อนสิ่งที่เซิร์ฟเวอร์บังคับใช้');
      } finally {
        await prisma.resourceAccess.updateMany({
          where: { resourceId: rootA, userId: clientAId },
          data: { allowDownload: true },
        });
      }
    });

    test('การเปลี่ยนสิทธิ์ดาวน์โหลดมีผลทันทีกับ token ใบเดิม', async () => {
      const before = await app.inject({
        method: 'GET',
        url: `/api/portal/resources/${versionedFileId}/versions/1/download`,
        headers: asUser(tokenA),
      });
      assert.equal(before.statusCode, 200);

      await prisma.resourceAccess.updateMany({
        where: { resourceId: rootA, userId: clientAId },
        data: { allowDownload: false },
      });
      const after = await app.inject({
        method: 'GET',
        url: `/api/portal/resources/${versionedFileId}/versions/1/download`,
        headers: asUser(tokenA),
      });
      assert.equal(after.statusCode, 403, 'ไม่ต้องรอให้ออกจากระบบ');

      await prisma.resourceAccess.updateMany({
        where: { resourceId: rootA, userId: clientAId },
        data: { allowDownload: true },
      });
    });

    test('สิทธิ์หมดอายุแล้ว ประวัติเวอร์ชันหายไปด้วย', async () => {
      await prisma.resourceAccess.updateMany({
        where: { resourceId: rootA, userId: clientAId },
        data: { expiresAt: new Date(Date.now() - 60_000) },
      });
      try {
        for (const url of [
          `/api/portal/resources/${versionedFileId}/versions`,
          `/api/portal/resources/${versionedFileId}/versions/1/content`,
          `/api/portal/resources/${versionedFileId}/versions/1/download`,
        ]) {
          const response = await app.inject({ method: 'GET', url, headers: asUser(tokenA) });
          assert.equal(response.statusCode, 404, `${url} ต้องหายไปเมื่อสิทธิ์หมดอายุ`);
        }
      } finally {
        await prisma.resourceAccess.updateMany({
          where: { resourceId: rootA, userId: clientAId },
          data: { expiresAt: null },
        });
      }
    });
  });

  /* ---------------------------------------------------------------- */
  /* การค้นหาลึก                                                       */
  /* ---------------------------------------------------------------- */

  describe('ค้นหาได้ลึกทุกชั้นใต้โฟลเดอร์ที่ได้รับสิทธิ์', () => {
    const search = async (term: string, token = tokenA) => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/portal/search?q=${encodeURIComponent(term)}`,
        headers: asUser(token),
      });
      assert.equal(response.statusCode, 200);
      return response.json().data as Array<{ id: string; name: string; path: Array<{ id: string; name: string }> }>;
    };

    test('ชั้นที่หนึ่ง - โฟลเดอร์ที่ถูกแชร์ให้โดยตรง', async () => {
      const results = await search('เอกสารบริษัท เอ');
      assert.ok(results.some((row) => row.id === rootA));
    });

    test('ชั้นที่สอง', async () => {
      const results = await search('ภาษี');
      assert.ok(results.some((row) => row.id === taxFolder));
    });

    test('ชั้นที่ห้า - ของเดิมค้นไม่เจอ', async () => {
      const results = await search('ภงด53');
      const hit = results.find((row) => row.id === deepFileId);
      assert.ok(hit, 'ไฟล์ที่อยู่ลึกห้าชั้นต้องค้นเจอ');
    });

    test('เส้นทางที่แสดงเริ่มที่โฟลเดอร์ที่ถูกแชร์ให้ ไม่เผยชั้นเหนือขึ้นไป', async () => {
      const results = await search('ภงด53');
      const hit = results.find((row) => row.id === deepFileId)!;
      const names = hit.path.map((node) => node.name);

      assert.equal(hit.path[0]!.id, rootA, 'ชั้นแรกต้องเป็นรากที่ได้รับสิทธิ์');
      assert.deepEqual(names.slice(1, 4), ['ภาษี', '2569', 'กันยายน']);
      for (const name of names) {
        assert.ok(!name.includes('ไดร์ฟของฉัน'));
        assert.ok(!name.includes('ไดร์ฟของระบบ'));
      }
    });

    test('ชื่อภาษาไทยค้นได้ตามปกติ', async () => {
      assert.ok((await search('กันยายน')).some((row) => row.id === monthFolder));
      assert.ok((await search('2569')).some((row) => row.id === yearFolder));
    });

    test('ค้นข้ามหลายรากที่ได้รับสิทธิ์ และไม่มีรายการซ้ำ', async () => {
      const results = await search('F11');
      const ids = results.map((row) => row.id);
      assert.ok(ids.includes(rootA), 'ต้องเจอรากแรก');
      assert.ok(ids.includes(uploadFolderA), 'ต้องเจอรากที่สองด้วย');
      assert.equal(new Set(ids).size, ids.length, 'ต้องไม่มีรายการซ้ำ');
    });

    test('อักขระพิเศษของการค้นหาไม่กลายเป็นไวลด์การ์ด', async () => {
      const results = await search('%');
      assert.deepEqual(results, [], 'เครื่องหมาย % ต้องถูกค้นแบบตัวอักษรจริง ไม่ใช่ตรงกับทุกอย่าง');
    });

    test('คำค้นสั้นเกินไปไม่คืนอะไรเลย', async () => {
      assert.deepEqual(await search('ก'), []);
    });

    test('ของในถังขยะหายจากผลการค้นหาทันที ทั้งตัวเองและทั้งกิ่ง', async () => {
      const before = await search('ภงด53');
      assert.ok(before.some((row) => row.id === deepFileId));

      // ลบโฟลเดอร์ชั้นกลาง - ไฟล์ที่อยู่ข้างใต้ต้องหายไปด้วย
      await trashResource(yearFolder, staff, audit);
      try {
        const after = await search('ภงด53');
        assert.ok(!after.some((row) => row.id === deepFileId), 'ของใต้โฟลเดอร์ที่ถูกลบต้องไม่โผล่ในผลค้นหา');
        assert.ok(!(await search('กันยายน')).some((row) => row.id === monthFolder));
      } finally {
        const { restoreResource } = await import('../files/trash.service.js');
        await restoreResource(yearFolder, staff, {}, audit);
      }

      assert.ok((await search('ภงด53')).some((row) => row.id === deepFileId), 'กู้คืนแล้วต้องกลับมาค้นเจอ');
    });

    test('สิทธิ์ที่หมดอายุถูกตัดออกจากผลการค้นหาทันที', async () => {
      await prisma.resourceAccess.updateMany({
        where: { resourceId: rootA, userId: clientAId },
        data: { expiresAt: new Date(Date.now() - 60_000) },
      });
      try {
        const results = await search('ภงด53');
        assert.ok(!results.some((row) => row.id === deepFileId));
      } finally {
        await prisma.resourceAccess.updateMany({
          where: { resourceId: rootA, userId: clientAId },
          data: { expiresAt: null },
        });
      }
    });

    test('สิทธิ์ที่ถูกเพิกถอนถูกตัดออกทันทีเช่นกัน', async () => {
      await revokeAccess(uploadFolderA, clientAId, staff, audit);
      try {
        const results = await search('รับเอกสาร');
        assert.ok(!results.some((row) => row.id === uploadFolderA));
      } finally {
        await grantAccess(uploadFolderA, { userId: clientAId, accessLevel: 'EDITOR', allowDownload: false }, staff, audit);
      }
    });

    test('ผลการค้นหาสะท้อนสิทธิ์ที่ใกล้ที่สุด ไม่ใช่สิทธิ์ของราก', async () => {
      // รากให้ดูอย่างเดียว แต่โฟลเดอร์รับเอกสารให้อัปโหลดได้
      const results = await search('F11');
      const uploadRow = results.find((row) => row.id === uploadFolderA) as unknown as {
        capabilities: { canUpload: boolean };
      };
      const rootRow = results.find((row) => row.id === rootA) as unknown as {
        capabilities: { canUpload: boolean };
      };
      assert.equal(uploadRow.capabilities.canUpload, true);
      assert.equal(rootRow.capabilities.canUpload, false);
    });
  });

  /* ---------------------------------------------------------------- */
  /* ถังขยะและการล็อก                                                  */
  /* ---------------------------------------------------------------- */

  describe('ถังขยะและการล็อก', () => {
    test('ไฟล์ที่ถูกลบ ประวัติเวอร์ชันก็เข้าไม่ถึงด้วย', async () => {
      await trashResource(versionedFileId, staff, audit);
      try {
        for (const url of [
          `/api/portal/resources/${versionedFileId}/versions`,
          `/api/portal/resources/${versionedFileId}/versions/1/content`,
        ]) {
          const response = await app.inject({ method: 'GET', url, headers: asUser(tokenA) });
          assert.equal(response.statusCode, 404);
        }
      } finally {
        const { restoreResource } = await import('../files/trash.service.js');
        await restoreResource(versionedFileId, staff, {}, audit);
      }
    });

    test('โฟลเดอร์ที่ถูกล็อก ลูกค้าอัปโหลดไม่ได้', async () => {
      const { lockResource, unlockResource } = await import('../workspace/workspace.service.js');
      await lockResource(uploadFolderA, { reason: 'ปิดรอบรับเอกสาร' }, staff, audit);
      try {
        const response = await app.inject({
          method: 'POST',
          url: `/api/portal/folders/${uploadFolderA}/upload`,
          headers: { ...asUser(tokenA), 'content-type': 'multipart/form-data; boundary=x' },
          payload: multipart('ใบเสร็จ.txt', 'เนื้อหา'),
        });
        assert.ok([403, 409].includes(response.statusCode), `ต้องถูกปฏิเสธ แต่ได้ ${response.statusCode}`);
      } finally {
        await unlockResource(uploadFolderA, staff, audit);
      }
    });
  });
});

/** payload multipart แบบง่ายสำหรับ app.inject */
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

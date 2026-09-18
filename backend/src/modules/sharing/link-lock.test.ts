/**
 * Link Lock - ลิงก์ไม่ใช่กุญแจ
 *
 * **การเปลี่ยนพฤติกรรมโดยตั้งใจ:** ก่อนหน้านี้ลิงก์สาธารณะที่ยังใช้งานได้เปิดเอกสารให้
 * ผู้ที่ไม่ได้เข้าสู่ระบบได้เลย ตั้งแต่เฟสนี้ไม่มีคำขอที่ไม่ระบุตัวตนใดได้ไบต์ของเอกสาร
 * หรือข้อมูลประกอบใด ๆ อีก - ดู docs/LINK_LOCK_AUTH_REQUIRED.md
 *
 * ชุดนี้พิสูจน์สามเรื่องที่ต้องจริงพร้อมกัน:
 *   1. ไม่ระบุตัวตน = ไม่ได้อะไรเลย และไม่รู้ด้วยซ้ำว่าโทเคนมีอยู่จริงไหม
 *   2. เข้าสู่ระบบแล้ว ยังต้องมีสิทธิ์ของตัวเอง - ลิงก์ไม่เพิ่มสิทธิ์ให้ใคร
 *   3. สถานะลิงก์เดิม (หมดอายุ/เพิกถอน/ชั้นความลับ) ไม่ถูกปลุกให้ฟื้นด้วยการล็อกอิน
 *
 * การเก็บกวาด: ชุดนี้สร้างไบต์จริงหนึ่งไฟล์ จึงลบทั้งแถวและไบต์ใน after()
 */
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { after, before, describe, test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app.js';
import { prisma } from '../../core/prisma.js';
import { deleteStoredFile, removeResourceDirectory } from '../../core/file-storage.js';
import { issueSessionForUser, type AuthUser } from '../auth/auth.service.js';
import { createFolder } from '../resources/resource.service.js';
import { uploadFile } from '../files/file.service.js';
import { grantAccess } from '../workspace/sharing.service.js';
import { createPublicShare } from './public-share.service.js';

const prefix = `linklock-${Date.now().toString(36)}`;
const audit = { ipAddress: '127.0.0.1', userAgent: 'link-lock-test' };
const stream = (t = 'เนื้อหาลับที่ไม่ควรหลุดให้คนไม่ระบุตัวตน') => Readable.from([Buffer.from(t, 'utf8')]);

/** ทุกเส้นทางที่เคยเปิดให้แขก - ใช้ยิงซ้ำหลายสถานการณ์ */
const guestPaths = (token: string) => [
  ['view', `/api/public/shares/${token}`],
  ['children', `/api/public/shares/${token}/children`],
  ['content', `/api/public/shares/${token}/content`],
  ['download', `/api/public/shares/${token}/download`],
] as const;

describe('Link Lock: a share link locates a document, it never unlocks one', () => {
  let app: FastifyInstance;
  let ownerId = '';
  let strangerId = '';
  let viewerId = '';
  let externalId = '';
  let folderId = '';
  let fileId = '';
  let owner: AuthUser;
  let fileToken = '';
  let folderToken = '';
  let expiredToken = '';
  let revokedToken = '';
  let ownerAuth = '';
  let strangerAuth = '';
  let viewerAuth = '';
  let externalAuth = '';

  before(async () => {
    app = await buildApp();
    await app.ready();

    const rows = await Promise.all([
      prisma.user.create({ data: { email: `${prefix}-owner@example.invalid`, displayName: 'LL Owner', status: 'ACTIVE' } }),
      prisma.user.create({ data: { email: `${prefix}-stranger@example.invalid`, displayName: 'LL Stranger', status: 'ACTIVE' } }),
      prisma.user.create({ data: { email: `${prefix}-viewer@example.invalid`, displayName: 'LL Viewer', status: 'ACTIVE' } }),
      prisma.user.create({ data: { email: `${prefix}-ext@example.invalid`, displayName: 'LL External', type: 'EXTERNAL', status: 'ACTIVE' } }),
    ]);
    [ownerId, strangerId, viewerId, externalId] = rows.map((r) => r.id);

    const memberRole = await prisma.role.findUniqueOrThrow({ where: { code: 'MEMBER' } });
    await prisma.userRole.createMany({ data: [
      { userId: ownerId, roleId: memberRole.id },
      { userId: strangerId, roleId: memberRole.id },
      { userId: viewerId, roleId: memberRole.id },
    ] });

    owner = {
      id: ownerId, email: rows[0].email, displayName: rows[0].displayName,
      type: 'INTERNAL', status: 'ACTIVE', mustChangePassword: false,
      roles: ['MEMBER'], permissions: ['resources:read', 'resources:write', 'resources:share'],
    };

    const folder = await createFolder(owner, { name: `${prefix}-โฟลเดอร์`, parentId: null }, audit);
    folderId = folder.id;
    /*
     * ลิงก์สาธารณะสร้างได้เฉพาะเอกสารชั้น "สาธารณะ" ตั้งแต่ F25-D
     * ตั้งให้ชัดเพื่อให้ชุดนี้ทดสอบ Link Lock ไม่ใช่ทดสอบชั้นความลับ
     */
    await prisma.resource.update({ where: { id: folderId }, data: { classification: 'PUBLIC' } });

    const uploaded = await uploadFile(
      owner, stream(),
      { parentId: folderId, fileName: `${prefix}-ลับ.txt`, allowDuplicateContent: true },
      audit,
    );
    fileId = uploaded.resource.id;

    /*
     * จำกัดการมองเห็นภายในของไฟล์ทดสอบ
     *
     * ค่าเริ่มต้นคือ ORGANIZATION ซึ่งแปลว่าพนักงานทุกคนที่มีสิทธิ์อ่านเห็นได้อยู่แล้ว
     * ตามกติกาของ visibility ที่มีมาก่อนเฟสนี้ - ถ้าใช้ค่านั้น เทสต์ "เข้าสู่ระบบแล้ว
     * แต่ไม่มีสิทธิ์" จะไม่ได้ทดสอบอะไรเลย เพราะทุกคนมีสิทธิ์จริง ๆ
     *
     * ประเด็นของ Link Lock คือ "ลิงก์ไม่เพิ่มสิทธิ์" ไม่ใช่ "ลิงก์ลดสิทธิ์ที่มีอยู่"
     */
    await prisma.resource.update({ where: { id: fileId }, data: { visibility: 'RESTRICTED' } });

    fileToken = (await createPublicShare(fileId, owner, { allowPreview: true, allowDownload: true }, audit)).url.split('/s/')[1]!;
    folderToken = (await createPublicShare(folderId, owner, { allowPreview: true, allowDownload: true }, audit)).url.split('/s/')[1]!;
    const expiring = await createPublicShare(fileId, owner, { allowPreview: true, allowDownload: true }, audit);
    expiredToken = expiring.url.split('/s/')[1]!;
    await prisma.publicShareLink.update({ where: { id: expiring.link.id }, data: { expiresAt: new Date(Date.now() - 3_600_000) } });
    const revoking = await createPublicShare(fileId, owner, { allowPreview: true, allowDownload: true }, audit);
    revokedToken = revoking.url.split('/s/')[1]!;
    await prisma.publicShareLink.update({ where: { id: revoking.link.id }, data: { revokedAt: new Date(), revokedById: ownerId } });

    // ผู้ใช้ภายในอีกคนที่ได้รับสิทธิ์ดูอย่างเดียว ไม่ให้ดาวน์โหลด
    await grantAccess(fileId, { userId: viewerId, accessLevel: 'VIEWER', allowDownload: false, expiresAt: null }, owner, audit);

    ownerAuth = `Bearer ${(await issueSessionForUser(ownerId)).accessToken}`;
    strangerAuth = `Bearer ${(await issueSessionForUser(strangerId)).accessToken}`;
    viewerAuth = `Bearer ${(await issueSessionForUser(viewerId)).accessToken}`;
    externalAuth = `Bearer ${(await issueSessionForUser(externalId)).accessToken}`;
  });

  after(async () => {
    await app.close();
    const userIds = [ownerId, strangerId, viewerId, externalId];
    const resourceIds = [folderId, fileId];
    const versions = await prisma.resourceVersion.findMany({
      where: { resourceId: { in: resourceIds } },
      select: { resourceId: true, storageKey: true, storageProvider: true },
    });
    for (const v of versions) {
      await deleteStoredFile(v.storageKey, v.storageProvider);
      await removeResourceDirectory(v.resourceId, v.storageProvider);
    }
    await prisma.publicShareLink.deleteMany({ where: { resourceId: { in: resourceIds } } });
    await prisma.activityLog.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.resourceAccess.deleteMany({ where: { resourceId: { in: resourceIds } } });
    await prisma.resource.deleteMany({ where: { id: fileId } });
    await prisma.resource.deleteMany({ where: { id: folderId } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  });

  /* ---------------- §24 A-G: ไม่ระบุตัวตนต้องไม่ได้อะไรเลย ---------------- */

  test('every previously anonymous route now answers LOGIN_REQUIRED with zero bytes', async () => {
    for (const [label, url] of guestPaths(fileToken)) {
      const response = await app.inject({ method: 'GET', url });
      assert.equal(response.statusCode, 401, `${label} ต้องตอบ 401`);
      assert.equal(response.json().error?.code, 'LOGIN_REQUIRED', `${label} ต้องใช้รหัส LOGIN_REQUIRED`);
      // ไม่มีไบต์ของเอกสารหลุดออกไปแม้แต่ส่วนเดียว
      assert.equal(response.body.includes('เนื้อหาลับ'), false, `${label} ส่งเนื้อหาออกไป`);
    }
    // ตรวจรหัสผ่านก็ต้องล็อกอินก่อน - มิฉะนั้นมันจะเป็นเครื่องมือเดารหัสผ่านแบบไม่ระบุตัวตน
    const verify = await app.inject({
      method: 'POST', url: `/api/public/shares/${fileToken}/verify-password`, payload: { password: 'x' },
    });
    assert.equal(verify.statusCode, 401);
    assert.equal(verify.json().error?.code, 'LOGIN_REQUIRED');
  });

  test('an anonymous visitor cannot learn anything about the document or the link', async () => {
    const response = await app.inject({ method: 'GET', url: `/api/public/shares/${fileToken}` });
    const body = response.body;
    for (const leak of [
      `${prefix}-ลับ.txt`, `${prefix}-โฟลเดอร์`, 'storageKey', 'storageProvider',
      'classification', 'checksum', 'ownerId', 'expiresAt', 'allowDownload', 'size',
    ]) {
      assert.equal(body.includes(leak), false, `คำตอบแบบไม่ระบุตัวตนรั่ว ${leak}`);
    }
  });

  test('a valid, an expired, a revoked and a forged token are indistinguishable while anonymous', async () => {
    const codes = new Set<string>();
    for (const token of [fileToken, expiredToken, revokedToken, 'x'.repeat(40)]) {
      const response = await app.inject({ method: 'GET', url: `/api/public/shares/${token}` });
      codes.add(`${response.statusCode}:${response.json().error?.code}`);
    }
    /*
     * ต้องได้คำตอบเดียวกันทุกกรณี มิฉะนั้นเส้นทางนี้จะกลายเป็นเครื่องมือตรวจว่า
     * โทเคนที่สุ่มมาใช้ได้หรือไม่ ซึ่งคือรูรั่วเดิมที่ย้ายที่เท่านั้น
     */
    assert.deepEqual([...codes], ['401:LOGIN_REQUIRED'], 'สถานะลิงก์ต้องไม่รั่วก่อนเข้าสู่ระบบ');
  });

  test('an anonymous folder link enumerates nothing', async () => {
    const response = await app.inject({ method: 'GET', url: `/api/public/shares/${folderToken}/children` });
    assert.equal(response.statusCode, 401);
    assert.equal(response.body.includes(`${prefix}-ลับ.txt`), false, 'ชื่อไฟล์ลูกต้องไม่หลุด');
  });

  /* ---------------- §24 H-K: เข้าสู่ระบบแล้ว ยังต้องมีสิทธิ์ ---------------- */

  test('an authenticated internal user without rights is denied, not served', async () => {
    for (const [label, url] of guestPaths(fileToken)) {
      const response = await app.inject({ method: 'GET', url, headers: { authorization: strangerAuth } });
      assert.equal(response.statusCode, 403, `${label} ต้องตอบ 403`);
      assert.equal(response.json().error?.code, 'ACCESS_DENIED', `${label} ต้องแยกจาก LOGIN_REQUIRED`);
      assert.equal(response.body.includes('เนื้อหาลับ'), false);
    }
  });

  test('the owner reaches the document through the same link', async () => {
    const view = await app.inject({ method: 'GET', url: `/api/public/shares/${fileToken}`, headers: { authorization: ownerAuth } });
    assert.equal(view.statusCode, 200);

    const content = await app.inject({ method: 'GET', url: `/api/public/shares/${fileToken}/content`, headers: { authorization: ownerAuth } });
    assert.equal(content.statusCode, 200);
    assert.match(content.body, /เนื้อหาลับ/, 'ผู้มีสิทธิ์ต้องได้เนื้อหาจริง');

    // ไม่มีข้อมูลภายในของที่เก็บหลุดไปกับคำตอบ
    for (const leak of ['storageKey', 'storageProvider', 'tokenHash']) {
      assert.equal(view.body.includes(leak), false, `รั่ว ${leak}`);
    }
  });

  test('an external account gets nothing from a link outside its portal scope', async () => {
    for (const [label, url] of guestPaths(fileToken)) {
      const response = await app.inject({ method: 'GET', url, headers: { authorization: externalAuth } });
      assert.equal(response.statusCode, 403, `${label} ต้องถูกปฏิเสธ`);
      assert.equal(response.body.includes('เนื้อหาลับ'), false);
    }
  });

  /* ---------------- §20 การเข้าสู่ระบบไม่ใช่ใบอนุญาตดาวน์โหลด ---------------- */

  test('login does not become download: a view-only grant still cannot download', async () => {
    const view = await app.inject({ method: 'GET', url: `/api/public/shares/${fileToken}`, headers: { authorization: viewerAuth } });
    assert.equal(view.statusCode, 200, 'ผู้ที่ดูได้ต้องเปิดลิงก์ได้');

    const preview = await app.inject({ method: 'GET', url: `/api/public/shares/${fileToken}/content`, headers: { authorization: viewerAuth } });
    assert.equal(preview.statusCode, 200, 'ดูตัวอย่างได้ตามสิทธิ์เดิม');

    /*
     * ลิงก์อนุญาตดาวน์โหลด แต่สิทธิ์ของผู้ใช้ไม่อนุญาต - ผลลัพธ์ต้องคือปฏิเสธ
     * ถ้าลิงก์ชนะ Link Lock จะกลายเป็นช่องทางยกระดับสิทธิ์แทนที่จะเป็นด่าน
     */
    const download = await app.inject({ method: 'GET', url: `/api/public/shares/${fileToken}/download`, headers: { authorization: viewerAuth } });
    assert.equal(download.statusCode, 403, 'สิทธิ์เดิมที่ห้ามดาวน์โหลดต้องชนะการอนุญาตของลิงก์');
    assert.equal(download.json().error?.code, 'SHARE_DOWNLOAD_DENIED');
  });

  /* ---------------- §24 L-M: ลิงก์ที่ตายแล้วไม่ฟื้นเพราะล็อกอิน ---------------- */

  test('logging in does not revive an expired or revoked link', async () => {
    for (const [label, token] of [['expired', expiredToken], ['revoked', revokedToken]] as const) {
      const response = await app.inject({
        method: 'GET', url: `/api/public/shares/${token}/content`, headers: { authorization: ownerAuth },
      });
      assert.notEqual(response.statusCode, 200, `${label}: ลิงก์ที่ตายแล้วต้องไม่ฟื้น`);
      assert.equal(response.body.includes('เนื้อหาลับ'), false);
    }
  });

  test('a forged token fails safely for an authenticated user too', async () => {
    const response = await app.inject({
      method: 'GET', url: `/api/public/shares/${'z'.repeat(40)}`, headers: { authorization: ownerAuth },
    });
    assert.equal(response.statusCode, 404);
    assert.equal(response.body.includes('เนื้อหาลับ'), false);
  });

  /* ---------------- §24 N: เพดานชั้นความลับยังอยู่ ---------------- */

  test('the classification ceiling still closes the link even for the owner', async () => {
    await prisma.resource.update({ where: { id: fileId }, data: { classification: 'CONFIDENTIAL' } });
    try {
      const response = await app.inject({
        method: 'GET', url: `/api/public/shares/${fileToken}/content`, headers: { authorization: ownerAuth },
      });
      assert.notEqual(response.statusCode, 200, 'ชั้นความลับต้องปิดลิงก์ไว้เหนือทุกสิทธิ์');
      assert.equal(response.body.includes('เนื้อหาลับ'), false);
    } finally {
      await prisma.resource.update({ where: { id: fileId }, data: { classification: 'PUBLIC' } });
    }
  });

  /* ---------------- §21 บันทึกต้องไม่มีโทเคนดิบ ---------------- */

  test('no raw share token is ever written to the activity log', async () => {
    await app.inject({ method: 'GET', url: `/api/public/shares/${fileToken}`, headers: { authorization: ownerAuth } });
    const logs = await prisma.activityLog.findMany({ where: { userId: { in: [ownerId, strangerId] } } });
    const dump = JSON.stringify(logs);
    for (const token of [fileToken, folderToken, expiredToken, revokedToken]) {
      assert.equal(dump.includes(token), false, 'โทเคนดิบต้องไม่ปรากฏในบันทึกกิจกรรม');
    }
  });
});

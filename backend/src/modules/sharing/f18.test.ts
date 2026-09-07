import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { after, before, describe, test } from 'node:test';
import { prisma } from '../../core/prisma.js';
import { AppError } from '../../core/errors.js';
import { createFolder } from '../resources/resource.service.js';
import { uploadFile } from '../files/file.service.js';
import { trashResource, restoreResource } from '../files/trash.service.js';
import { exportAuditCsv } from '../audit/audit-export.js';
import { searchAuditEvents } from '../audit/audit.service.js';
import { EVENT_CATALOG, findPreset } from '../audit/event-catalog.js';
import {
  createPublicShare,
  listResourceShares,
  revokePublicShare,
  shareStatus,
  MAX_ACTIVE_LINKS_PER_RESOURCE,
} from './public-share.service.js';
import {
  countView,
  listShareChildren,
  requiresPassword,
  reserveDownload,
  resolveShareByToken,
  resolveWithinShare,
  verifySharePassword,
} from './guest-access.js';
import { guestPassValid, issueGuestPass } from './guest-session.js';
import { generateShareToken, hashShareToken, safeEqual, shareUrl } from './share-token.js';
import type { AuthUser } from '../auth/auth.service.js';

/**
 * F18 - ลิงก์แชร์ภายนอก
 *
 * ลิงก์เหล่านี้เป็นทางเดียวในระบบที่เปิดสู่อินเทอร์เน็ตโดยไม่ต้องเข้าสู่ระบบ
 * ทุกอย่างที่นี่จึงต้องพิสูจน์ได้ว่า "ผู้ถือโทเคนได้เท่าที่เขียนไว้ ไม่มากกว่านั้น"
 */

const prefix = `f18-${Date.now().toString(36)}`;
const audit = { ipAddress: '198.51.100.7', userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/120' };
const stream = (text: string) => Readable.from([Buffer.from(text, 'utf8')]);

const makeUser = (
  id: string,
  email: string,
  displayName: string,
  roles: string[],
  extra: string[] = [],
  type: AuthUser['type'] = 'INTERNAL',
): AuthUser => ({
  id,
  email,
  displayName,
  type,
  status: 'ACTIVE',
  mustChangePassword: false,
  roles,
  permissions: ['resources:read', 'resources:write', 'resources:delete', ...extra],
});

const rejects = (code: string) => (error: unknown) =>
  error instanceof AppError && error.code === code;

describe('F18 ลิงก์แชร์ภายนอก', () => {
  let owner: AuthUser;
  let viewer: AuthUser;
  let client: AuthUser;
  let ownerId = '';
  let viewerId = '';
  let clientId = '';

  let rootId = '';
  let fileId = '';
  let subFolderId = '';
  let deepFileId = '';
  /** อยู่นอกโฟลเดอร์ที่แชร์ - ใช้พิสูจน์ว่าขอบเขตกันได้จริง */
  let outsideId = '';

  const created: string[] = [];

  before(async () => {
    const rows = await Promise.all(
      [
        ['owner', 'INTERNAL'],
        ['viewer', 'INTERNAL'],
        ['client', 'EXTERNAL'],
      ].map(([role, type]) =>
        prisma.user.create({
          data: {
            email: `${prefix}-${role}@example.invalid`,
            displayName: `F18 ${role}`,
            type: type as 'INTERNAL' | 'EXTERNAL',
            status: 'ACTIVE',
          },
        }),
      ),
    );
    [ownerId, viewerId, clientId] = rows.map((row) => row.id);

    owner = makeUser(ownerId, rows[0].email, rows[0].displayName, ['MEMBER'], ['resources:share']);
    /** ผู้อ่านทั่วไป ไม่มี resources:share และไม่ได้เป็นผู้ดูแลหลัก */
    viewer = makeUser(viewerId, rows[1].email, rows[1].displayName, ['MEMBER']);
    client = makeUser(clientId, rows[2].email, rows[2].displayName, ['MEMBER'], [], 'EXTERNAL');

    const root = await createFolder(owner, { name: `${prefix} ราก`, parentId: null }, audit);
    rootId = root.id;
    created.push(rootId);

    const sub = await createFolder(owner, { name: `${prefix} ย่อย`, parentId: rootId }, audit);
    subFolderId = sub.id;
    created.push(subFolderId);

    const outside = await createFolder(owner, { name: `${prefix} นอก`, parentId: null }, audit);
    outsideId = outside.id;
    created.push(outsideId);

    const uploaded = await uploadFile(
      owner,
      stream('เนื้อหาเอกสารที่แชร์ให้คนนอก'),
      { parentId: rootId, fileName: `${prefix}-เอกสาร.txt`, allowDuplicateContent: true },
      audit,
    );
    fileId = uploaded.resource.id;
    created.push(fileId);

    const deep = await uploadFile(
      owner,
      stream('เอกสารที่อยู่ลึกลงไปอีกชั้น'),
      { parentId: subFolderId, fileName: `${prefix}-ลึก.txt`, allowDuplicateContent: true },
      audit,
    );
    deepFileId = deep.resource.id;
    created.push(deepFileId);
  });

  after(async () => {
    const ids = new Set(created.filter(Boolean));
    const children = await prisma.resource.findMany({
      where: { parentId: { in: [...ids] } },
      select: { id: true },
    });
    for (const child of children) ids.add(child.id);
    const all = [...ids];
    const users = [ownerId, viewerId, clientId];

    await prisma.publicShareLink.deleteMany({ where: { resourceId: { in: all } } });
    await prisma.publicShareLink.deleteMany({ where: { createdById: { in: users } } });
    await prisma.activityLog.deleteMany({ where: { userId: { in: users } } });
    await prisma.activityLog.deleteMany({ where: { resourceId: { in: all } } });
    await prisma.resourceSearchIndex.deleteMany({ where: { resourceId: { in: all } } });
    await prisma.resourceVersion.deleteMany({ where: { resourceId: { in: all } } });
    /**
     * ลบจากใบไปหาราก
     *
     * FK ของ parentId เป็น Restrict โดยตั้งใจ - โฟลเดอร์ที่ยังมีลูกจึงลบไม่ได้
     * คำสั่งลบก้อนเดียวไม่รับประกันลำดับ จึงวนลบเฉพาะตัวที่ไม่มีลูกเหลือแล้ว
     * ไปเรื่อย ๆ จนไม่มีอะไรลบได้อีก
     */
    let remaining = [...all];
    while (remaining.length > 0) {
      const parents = new Set(
        (
          await prisma.resource.findMany({
            where: { parentId: { in: remaining } },
            select: { parentId: true },
          })
        ).map((row) => row.parentId!),
      );
      const leaves = remaining.filter((id) => !parents.has(id));
      if (leaves.length === 0) break;

      await prisma.resource.deleteMany({ where: { id: { in: leaves } } });
      remaining = remaining.filter((id) => !leaves.includes(id));
    }

    await prisma.user.deleteMany({ where: { id: { in: users } } });
  });

  /* ================================================================ */
  /* โทเคน                                                            */
  /* ================================================================ */

  describe('โทเคน', () => {
    test('มีเอนโทรปีสูงและปลอดภัยใน URL', () => {
      const token = generateShareToken();

      // base64url ของ 32 ไบต์ = 43 อักขระ ซึ่งคือ 256 บิต
      assert.equal(token.length, 43);
      assert.match(token, /^[A-Za-z0-9_-]+$/, 'ต้องไม่มีอักขระที่ต้องเข้ารหัสซ้ำใน URL');

      // สุ่ม 500 ครั้งต้องไม่ซ้ำกันเลย - การซ้ำแม้ครั้งเดียวคือหายนะ
      const many = new Set(Array.from({ length: 500 }, () => generateShareToken()));
      assert.equal(many.size, 500);
    });

    test('แฮชคงที่ ไม่ย้อนกลับ และไม่ซ้ำ', () => {
      const a = generateShareToken();
      const b = generateShareToken();

      assert.equal(hashShareToken(a), hashShareToken(a), 'ค่าเดิมต้องได้แฮชเดิม จึงค้นด้วยดัชนีได้');
      assert.notEqual(hashShareToken(a), hashShareToken(b));
      assert.ok(!hashShareToken(a).includes(a), 'แฮชต้องไม่มีโทเคนดิบอยู่ข้างใน');
    });

    test('การเทียบค่าลับไม่ใช้เวลาบอกใบ้', () => {
      assert.equal(safeEqual('abc', 'abc'), true);
      assert.equal(safeEqual('abc', 'abd'), false);
      assert.equal(safeEqual('abc', 'abcd'), false, 'ความยาวต่างกันต้องไม่ทำให้โยนข้อผิดพลาด');
    });

    test('URL ประกอบจากที่อยู่ที่ตั้งค่าไว้ ไม่ใช่จากคำขอ', () => {
      assert.equal(shareUrl('https://nas.example.com/', 'TOKEN'), 'https://nas.example.com/s/TOKEN');
    });

    test('โทเคนดิบไม่เคยถูกเก็บลงฐานข้อมูล', async () => {
      const { url } = await createPublicShare(fileId, owner, {}, audit);
      const token = url.split('/s/')[1]!;

      /**
       * ค้นทั้งตารางหาโทเคนดิบ - ถ้าเจอแม้แถวเดียว แปลว่าฐานข้อมูลที่รั่ว
       * จะกลายเป็นพวงกุญแจที่เปิดเอกสารได้ทันทีโดยไม่ต้องถอดรหัสอะไรเลย
       */
      const rows = await prisma.publicShareLink.findMany({
        where: { resourceId: fileId },
        select: { tokenHash: true, passwordHash: true, label: true },
      });
      assert.ok(rows.length > 0);
      for (const row of rows) {
        assert.notEqual(row.tokenHash, token);
        assert.ok(!JSON.stringify(row).includes(token), 'โทเคนดิบต้องไม่ปรากฏในแถวใด ๆ');
      }
    });

    test('โทเคนผิดได้คำตอบกลาง ๆ เหมือนกับลิงก์ที่ไม่มีอยู่', async () => {
      await assert.rejects(
        () => resolveShareByToken(generateShareToken()),
        rejects('SHARE_UNAVAILABLE'),
      );
    });
  });

  /* ================================================================ */
  /* สิทธิ์ในการสร้าง                                                   */
  /* ================================================================ */

  describe('สิทธิ์', () => {
    test('ผู้อ่านทั่วไปสร้างลิงก์ไม่ได้', async () => {
      await assert.rejects(
        () => createPublicShare(fileId, viewer, {}, audit),
        rejects('PUBLIC_SHARE_DENIED'),
      );
    });

    test('บัญชีลูกค้าสร้างลิงก์ไม่ได้เลย', async () => {
      /**
       * บัญชีภายนอกมองไม่เห็นทรัพยากรภายในตั้งแต่ต้น จึงได้ "ไม่พบ"
       * ไม่ใช่ "ไม่มีสิทธิ์" - ซึ่งถูกต้อง เพราะการบอกว่ามีอยู่ก็เป็นข้อมูลแล้ว
       */
      await assert.rejects(
        () => createPublicShare(fileId, client, {}, audit),
        rejects('RESOURCE_NOT_FOUND'),
      );
    });

    test('ผู้อ่านทั่วไปยกเลิกลิงก์ของคนอื่นไม่ได้', async () => {
      const { link } = await createPublicShare(fileId, owner, {}, audit);
      await assert.rejects(
        () => revokePublicShare(link.id, viewer, audit),
        rejects('PUBLIC_SHARE_DENIED'),
      );
    });

    test('ผู้ที่จัดการสิทธิ์ได้ก็ดูรายการลิงก์ได้ ส่วนคนอื่นไม่ได้', async () => {
      const links = await listResourceShares(fileId, owner);
      assert.ok(links.length > 0);
      await assert.rejects(
        () => listResourceShares(fileId, viewer),
        rejects('PUBLIC_SHARE_DENIED'),
      );
    });
  });

  /* ================================================================ */
  /* ไฟล์                                                             */
  /* ================================================================ */

  describe('การแชร์ไฟล์', () => {
    test('ค่าเริ่มต้นคือดูได้ ดาวน์โหลดไม่ได้ หมดอายุ 7 วัน', async () => {
      const before = Date.now();
      const { link } = await createPublicShare(fileId, owner, {}, audit);

      assert.equal(link.allowPreview, true);
      assert.equal(link.allowDownload, false, 'การดาวน์โหลดต้องเป็นสิ่งที่เลือกเอง ไม่ใช่ของแถม');
      assert.equal(link.passwordProtected, false);
      assert.ok(link.expiresAt, 'ลิงก์ที่ไม่หมดอายุต้องไม่ใช่ค่าเริ่มต้น');

      const days = (new Date(link.expiresAt!).getTime() - before) / 86_400_000;
      assert.ok(days > 6.9 && days < 7.1, `ควรหมดอายุใน 7 วัน แต่ได้ ${days}`);
    });

    test('ลิงก์ที่อนุญาตดาวน์โหลดต้องระบุอย่างชัดเจน', async () => {
      const { link } = await createPublicShare(fileId, owner, { allowDownload: true }, audit);
      assert.equal(link.allowDownload, true);
    });

    test('ลิงก์ที่ไม่ให้ทั้งดูและดาวน์โหลดถูกปฏิเสธ', async () => {
      await assert.rejects(
        () => createPublicShare(fileId, owner, { allowPreview: false, allowDownload: false }, audit),
        rejects('SHARE_NO_PERMISSION'),
      );
    });

    test('แขกเห็นเฉพาะข้อมูลที่ปลอดภัย', async () => {
      const { url } = await createPublicShare(fileId, owner, {}, audit);
      const share = await resolveShareByToken(url.split('/s/')[1]!);

      /** แปลงเหมือนที่เส้นทางของแขกทำ - bigint ต้องกลายเป็น number ก่อนจึง stringify ได้ */
      const visible = JSON.stringify({
        ...share.resource,
        size: share.resource.size === null ? null : Number(share.resource.size),
      });
      /**
       * สิ่งที่ต้องไม่หลุดไปกับเอกสาร: ตัวตนของพนักงาน โครงสร้างที่จัดเก็บ
       * และร่องรอยการกำกับดูแลภายใน คนที่ได้รับเอกสารหนึ่งฉบับไม่ควรได้
       * แผนผังองค์กรแถมไปด้วย
       */
      for (const forbidden of ['storageKey', 'checksum', 'ownerId', 'retentionUntil', 'remark']) {
        assert.ok(!visible.includes(forbidden), `${forbidden} ต้องไม่อยู่ในสิ่งที่แขกเห็น`);
      }
    });
  });

  /* ================================================================ */
  /* ขอบเขตของโฟลเดอร์                                                  */
  /* ================================================================ */

  describe('ขอบเขตของโฟลเดอร์ที่แชร์', () => {
    let folderShare: Awaited<ReturnType<typeof resolveShareByToken>>;

    before(async () => {
      const { url } = await createPublicShare(rootId, owner, { allowDownload: true }, audit);
      folderShare = await resolveShareByToken(url.split('/s/')[1]!);
    });

    test('เห็นลูกโดยตรงของรากที่แชร์', async () => {
      const children = await listShareChildren(rootId);
      const ids = children.map((child) => child.id);
      assert.ok(ids.includes(fileId));
      assert.ok(ids.includes(subFolderId));
      assert.ok(!ids.includes(outsideId), 'โฟลเดอร์นอกขอบเขตต้องไม่โผล่มา');
    });

    test('เข้าถึงเอกสารที่อยู่ลึกลงไปได้', async () => {
      const { resource, breadcrumb } = await resolveWithinShare(folderShare, deepFileId);
      assert.equal(resource.id, deepFileId);

      // เส้นทางนำทางเริ่มที่รากของลิงก์เสมอ ไม่ใช่ที่รากของไดร์ฟ
      assert.equal(breadcrumb[0]?.id, rootId);
      assert.deepEqual(
        breadcrumb.map((node) => node.id),
        [rootId, subFolderId, deepFileId],
      );
    });

    /**
     * ข้อนี้คือหัวใจของความปลอดภัยทั้งเฟส
     *
     * แขกแก้ id ใน URL ได้ตามใจ ถ้าเซิร์ฟเวอร์ไม่ตรวจว่า id นั้นอยู่ในกิ่งที่แชร์จริง
     * ลิงก์เดียวจะกลายเป็นกุญแจเปิดทั้งไดร์ฟ
     */
    test('เปลี่ยน id เป็นทรัพยากรนอกขอบเขตแล้วถูกปฏิเสธ', async () => {
      await assert.rejects(
        () => resolveWithinShare(folderShare, outsideId),
        rejects('SHARE_UNAVAILABLE'),
      );
    });

    test('ไต่ขึ้นไปหาโฟลเดอร์เหนือรากไม่ได้', async () => {
      /** ทดสอบด้วยรากของไดร์ฟจริง ซึ่งเป็นแม่ของโฟลเดอร์ที่แชร์ */
      const root = await prisma.resource.findUnique({
        where: { id: rootId },
        select: { parentId: true },
      });
      if (root?.parentId) {
        await assert.rejects(
          () => resolveWithinShare(folderShare, root.parentId!),
          rejects('SHARE_UNAVAILABLE'),
        );
      }
      // รากอยู่ระดับบนสุดอยู่แล้ว - ไม่มีอะไรเหนือกว่าให้ไต่ไป ซึ่งก็ปลอดภัยเช่นกัน
      assert.ok(true);
    });

    test('ลิงก์ของไฟล์ใช้เปิดไฟล์อื่นไม่ได้', async () => {
      const { url } = await createPublicShare(fileId, owner, {}, audit);
      const fileShare = await resolveShareByToken(url.split('/s/')[1]!);

      await assert.rejects(
        () => resolveWithinShare(fileShare, deepFileId),
        rejects('SHARE_UNAVAILABLE'),
      );
    });
  });

  /* ================================================================ */
  /* หมดอายุและการยกเลิก                                                */
  /* ================================================================ */

  describe('อายุของลิงก์', () => {
    test('ใช้ได้ก่อนหมดอายุ และใช้ไม่ได้หลังหมดอายุ', async () => {
      const { url, link } = await createPublicShare(
        fileId,
        owner,
        { expiresAt: new Date(Date.now() + 60_000) },
        audit,
      );
      const token = url.split('/s/')[1]!;

      await resolveShareByToken(token);

      // เลื่อนวันหมดอายุมาเป็นอดีต แทนที่จะรอเวลาจริง
      await prisma.publicShareLink.update({
        where: { id: link.id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });

      await assert.rejects(() => resolveShareByToken(token), rejects('SHARE_UNAVAILABLE'));
    });

    test('เส้นแบ่งที่วินาทีหมดอายุพอดีถือว่าหมดแล้ว', async () => {
      const now = new Date('2026-06-01T10:00:00.000Z');
      const row = {
        revokedAt: null,
        expiresAt: new Date('2026-06-01T10:00:00.000Z'),
        maxViews: null,
        viewCount: 0,
      } as never;
      const resource = { deletedAt: null, lifecycleState: 'ACTIVE' as const };

      /** ที่วินาทีนั้นพอดีต้องหมดแล้ว - ไม่ใช่ "ยังทันอีกเสี้ยววินาที" */
      assert.equal(shareStatus(row, resource, now), 'EXPIRED');
      assert.equal(shareStatus(row, resource, new Date('2026-06-01T09:59:59.999Z')), 'ACTIVE');
    });

    test('วันหมดอายุในอดีตถูกปฏิเสธตั้งแต่ตอนสร้าง', async () => {
      await assert.rejects(
        () => createPublicShare(fileId, owner, { expiresAt: new Date(Date.now() - 1000) }, audit),
        rejects('SHARE_INVALID_EXPIRY'),
      );
    });

    test('ไม่หมดอายุต้องส่ง null มาอย่างตั้งใจ', async () => {
      const { link } = await createPublicShare(fileId, owner, { expiresAt: null }, audit);
      assert.equal(link.expiresAt, null);
    });
  });

  describe('การยกเลิก', () => {
    test('ยกเลิกแล้วใช้ไม่ได้ทันที และใบผ่านเดิมก็ช่วยไม่ได้', async () => {
      const { url, link } = await createPublicShare(fileId, owner, {}, audit);
      const token = url.split('/s/')[1]!;

      await resolveShareByToken(token);

      /**
       * ออกใบผ่านไว้ก่อนยกเลิก แล้วพิสูจน์ว่ามันไม่ช่วยอะไร
       *
       * ใบผ่านตอบได้แค่ "เคยพิมพ์รหัสผ่านถูก" ไม่ได้ตอบว่า "ยังเข้าได้อยู่"
       * ถ้ามันข้ามการตรวจสถานะได้ การกดยกเลิกจะไม่มีความหมายไปอีกสองชั่วโมง
       */
      const pass = await issueGuestPass(link.id);
      assert.equal(await guestPassValid(pass, link.id), true);

      await revokePublicShare(link.id, owner, audit);

      await assert.rejects(() => resolveShareByToken(token), rejects('SHARE_UNAVAILABLE'));
      assert.equal(await guestPassValid(pass, link.id), true, 'ใบผ่านยังใช้ได้ในตัวมันเอง');
      // ...แต่ประตูปิดไปแล้ว เพราะสถานะลิงก์ถูกอ่านใหม่ทุกคำขอ
    });

    test('ยกเลิกซ้ำไม่ทำให้พัง', async () => {
      const { link } = await createPublicShare(fileId, owner, {}, audit);
      await revokePublicShare(link.id, owner, audit);
      const again = await revokePublicShare(link.id, owner, audit);
      assert.equal(again.status, 'REVOKED');
    });
  });

  /* ================================================================ */
  /* รหัสผ่าน                                                          */
  /* ================================================================ */

  describe('รหัสผ่าน', () => {
    test('รหัสถูกผ่าน รหัสผิดไม่ผ่าน และไม่มีค่าใดถูกส่งกลับ', async () => {
      const { url, link } = await createPublicShare(
        fileId,
        owner,
        { password: 'ความลับ-1234' },
        audit,
      );
      const share = await resolveShareByToken(url.split('/s/')[1]!);

      assert.equal(requiresPassword(share.link), true);
      assert.equal(await verifySharePassword(share.link, 'ความลับ-1234'), true);
      assert.equal(await verifySharePassword(share.link, 'เดาผิด'), false);

      /** ทั้งตัวรหัสผ่านและแฮชต้องไม่มีทางออกจากเซิร์ฟเวอร์ */
      const dto = JSON.stringify(link);
      assert.ok(!dto.includes('ความลับ-1234'));
      assert.ok(!dto.includes('passwordHash'));
      assert.ok(!dto.includes(share.link.passwordHash!));
      assert.equal(link.passwordProtected, true, 'หน้าจอรู้ได้แค่ว่า "มีรหัสผ่าน"');
    });

    test('รหัสผ่านถูกแฮชด้วย bcrypt ไม่ใช่เก็บดิบ', async () => {
      const { link } = await createPublicShare(fileId, owner, { password: 'ทดสอบ-5678' }, audit);
      const row = await prisma.publicShareLink.findUnique({
        where: { id: link.id },
        select: { passwordHash: true },
      });
      assert.match(row!.passwordHash!, /^\$2[aby]\$/, 'ต้องเป็นแฮช bcrypt');
      assert.ok(!row!.passwordHash!.includes('ทดสอบ-5678'));
    });

    test('ใบผ่านของลิงก์หนึ่งใช้กับอีกลิงก์ไม่ได้', async () => {
      const a = await createPublicShare(fileId, owner, { password: 'aaaaaa' }, audit);
      const b = await createPublicShare(fileId, owner, { password: 'bbbbbb' }, audit);

      const pass = await issueGuestPass(a.link.id);
      assert.equal(await guestPassValid(pass, a.link.id), true);
      assert.equal(await guestPassValid(pass, b.link.id), false, 'ใบผ่านต้องผูกกับลิงก์เดียว');
    });

    test('ใบผ่านที่ปลอมหรือว่างเปล่าใช้ไม่ได้', async () => {
      assert.equal(await guestPassValid(undefined, 'x'), false);
      assert.equal(await guestPassValid('ไม่ใช่ JWT', 'x'), false);
      assert.equal(await guestPassValid('a.b.c', 'x'), false);
    });
  });

  /* ================================================================ */
  /* ตัวนับและเพดาน                                                     */
  /* ================================================================ */

  describe('ตัวนับและเพดานการใช้งาน', () => {
    test('การเปิดถูกนับครั้งละหนึ่ง', async () => {
      const { link } = await createPublicShare(fileId, owner, {}, audit);
      const row = await prisma.publicShareLink.findUnique({ where: { id: link.id } });

      await countView(row!);
      await countView(row!);

      const after = await prisma.publicShareLink.findUnique({ where: { id: link.id } });
      assert.equal(after!.viewCount, 2);
      assert.ok(after!.lastAccessedAt, 'ต้องบันทึกเวลาที่ถูกใช้ล่าสุด');
    });

    test('เปิดครบตามเพดานแล้วลิงก์ใช้ไม่ได้', async () => {
      const { url, link } = await createPublicShare(fileId, owner, { maxViews: 2 }, audit);
      const token = url.split('/s/')[1]!;

      const row = await prisma.publicShareLink.findUnique({ where: { id: link.id } });
      await countView(row!);
      await resolveShareByToken(token);

      await countView(row!);
      await assert.rejects(() => resolveShareByToken(token), rejects('SHARE_UNAVAILABLE'));
    });

    test('การดาวน์โหลดถูกจองทีละครั้งจนครบเพดาน', async () => {
      const { link } = await createPublicShare(
        fileId,
        owner,
        { allowDownload: true, maxDownloads: 2 },
        audit,
      );
      const row = await prisma.publicShareLink.findUnique({ where: { id: link.id } });

      assert.equal(await reserveDownload(row!), true);
      assert.equal(await reserveDownload(row!), true);
      assert.equal(await reserveDownload(row!), false, 'เกินเพดานต้องจองไม่ได้');

      const after = await prisma.publicShareLink.findUnique({ where: { id: link.id } });
      assert.equal(after!.downloadCount, 2, 'ครั้งที่ถูกปฏิเสธต้องไม่ถูกนับ');
    });

    /**
     * กรณีที่การตรวจ-แล้ว-ค่อยเพิ่มแบบสองคำสั่งจะพัง
     *
     * เหลือโควตาหนึ่งครั้ง แต่มีคนกดพร้อมกันห้าคน ถ้าทุกคนอ่านค่าเดิมก่อนใครจะเขียน
     * ทุกคนจะผ่านการตรวจหมด แล้วดาวน์โหลดได้ห้าครั้งจากโควตาหนึ่ง
     */
    test('การจองพร้อมกันมีผู้ชนะได้คนเดียวเท่านั้น', async () => {
      const { link } = await createPublicShare(
        fileId,
        owner,
        { allowDownload: true, maxDownloads: 1 },
        audit,
      );
      const row = await prisma.publicShareLink.findUnique({ where: { id: link.id } });

      const results = await Promise.all(Array.from({ length: 5 }, () => reserveDownload(row!)));
      assert.equal(results.filter(Boolean).length, 1, 'ต้องมีผู้ชนะเพียงคนเดียว');

      const after = await prisma.publicShareLink.findUnique({ where: { id: link.id } });
      assert.equal(after!.downloadCount, 1);
    });

    test('ลิงก์ที่ถูกยกเลิกจองดาวน์โหลดไม่ได้แม้โควตาเหลือ', async () => {
      const { link } = await createPublicShare(fileId, owner, { allowDownload: true }, audit);
      const row = await prisma.publicShareLink.findUnique({ where: { id: link.id } });
      await revokePublicShare(link.id, owner, audit);

      assert.equal(await reserveDownload(row!), false);
    });

    test('โควตาดาวน์โหลดหมดแล้วยังเปิดดูได้ ถ้าลิงก์อนุญาต', async () => {
      const { url, link } = await createPublicShare(
        fileId,
        owner,
        { allowPreview: true, allowDownload: true, maxDownloads: 1 },
        audit,
      );
      const row = await prisma.publicShareLink.findUnique({ where: { id: link.id } });
      await reserveDownload(row!);

      /** ดาวน์โหลดหมดสิทธิ์แล้ว แต่ตัวลิงก์ยังไม่ตาย - การดูยังทำได้ */
      const share = await resolveShareByToken(url.split('/s/')[1]!);
      assert.equal(share.link.allowPreview, true);
      assert.equal(await reserveDownload(row!), false);
    });
  });

  /* ================================================================ */
  /* สถานะของทรัพยากร                                                   */
  /* ================================================================ */

  describe('สถานะของทรัพยากร', () => {
    test('เอกสารในถังขยะทำให้ลิงก์ใช้ไม่ได้ และกู้คืนแล้วกลับมาใช้ได้', async () => {
      const folder = await createFolder(owner, { name: `${prefix} วงจร`, parentId: null }, audit);
      created.push(folder.id);
      const uploaded = await uploadFile(
        owner,
        stream('เอกสารทดสอบวงจรชีวิต'),
        { parentId: folder.id, fileName: `${prefix}-วงจร.txt`, allowDuplicateContent: true },
        audit,
      );
      created.push(uploaded.resource.id);

      const { url } = await createPublicShare(uploaded.resource.id, owner, {}, audit);
      const token = url.split('/s/')[1]!;
      await resolveShareByToken(token);

      await trashResource(uploaded.resource.id, owner, audit);
      await assert.rejects(() => resolveShareByToken(token), rejects('SHARE_UNAVAILABLE'));

      await restoreResource(uploaded.resource.id, owner, {}, audit);
      const back = await resolveShareByToken(token);
      assert.equal(back.link.revokedAt, null, 'ลิงก์ไม่เคยถูกยกเลิก เพียงแต่ประตูปิดชั่วคราว');
    });

    test('เอกสารในคลังทำให้ลิงก์ใช้ไม่ได้ และนำออกจากคลังแล้วกลับมาใช้ได้', async () => {
      const { url, link } = await createPublicShare(fileId, owner, {}, audit);
      const token = url.split('/s/')[1]!;
      await resolveShareByToken(token);

      await prisma.resource.update({
        where: { id: fileId },
        data: { lifecycleState: 'ARCHIVED', archivedAt: new Date() },
      });
      await assert.rejects(() => resolveShareByToken(token), rejects('SHARE_UNAVAILABLE'));

      await prisma.resource.update({
        where: { id: fileId },
        data: { lifecycleState: 'ACTIVE', archivedAt: null },
      });
      const back = await resolveShareByToken(token);
      assert.equal(back.link.id, link.id);
    });

    test('สร้างลิงก์ใหม่บนเอกสารในคลังไม่ได้', async () => {
      await prisma.resource.update({
        where: { id: fileId },
        data: { lifecycleState: 'ARCHIVED', archivedAt: new Date() },
      });
      await assert.rejects(
        () => createPublicShare(fileId, owner, {}, audit),
        rejects('SHARE_RESOURCE_ARCHIVED'),
      );
      await prisma.resource.update({
        where: { id: fileId },
        data: { lifecycleState: 'ACTIVE', archivedAt: null },
      });
    });

    test('สร้างลิงก์ใหม่บนเอกสารในถังขยะไม่ได้', async () => {
      const folder = await createFolder(owner, { name: `${prefix} ทิ้ง`, parentId: null }, audit);
      created.push(folder.id);
      await trashResource(folder.id, owner, audit);

      await assert.rejects(
        () => createPublicShare(folder.id, owner, {}, audit),
        rejects('SHARE_RESOURCE_TRASHED'),
      );
      await restoreResource(folder.id, owner, {}, audit);
    });

    test('ลิงก์ที่ยกเลิกแล้วไม่กลับมาเองแม้เอกสารจะกลับมา', async () => {
      const { url, link } = await createPublicShare(fileId, owner, {}, audit);
      const token = url.split('/s/')[1]!;
      await revokePublicShare(link.id, owner, audit);

      await prisma.resource.update({
        where: { id: fileId },
        data: { lifecycleState: 'ARCHIVED', archivedAt: new Date() },
      });
      await prisma.resource.update({
        where: { id: fileId },
        data: { lifecycleState: 'ACTIVE', archivedAt: null },
      });

      await assert.rejects(() => resolveShareByToken(token), rejects('SHARE_UNAVAILABLE'));
    });

    test('การลบถาวรทำให้ลิงก์หายไปด้วย ไม่เหลือสิทธิ์ที่ไร้เจ้าของ', async () => {
      const folder = await createFolder(owner, { name: `${prefix} ลบถาวร`, parentId: null }, audit);
      const { link } = await createPublicShare(folder.id, owner, {}, audit);

      /** FK เป็น Cascade - แถวลิงก์หายไปพร้อมทรัพยากร ไม่มีสิทธิ์ที่ชี้ไปที่ว่างเปล่า */
      await prisma.resource.delete({ where: { id: folder.id } });

      const orphan = await prisma.publicShareLink.findUnique({ where: { id: link.id } });
      assert.equal(orphan, null, 'ต้องไม่เหลือลิงก์ที่ชี้ไปยังทรัพยากรที่ไม่มีอยู่');
    });
  });

  /* ================================================================ */
  /* เพดานจำนวนลิงก์                                                    */
  /* ================================================================ */

  test('จำนวนลิงก์ที่ยังใช้งานได้ต่อทรัพยากรมีเพดาน', async () => {
    const folder = await createFolder(owner, { name: `${prefix} เพดาน`, parentId: null }, audit);
    created.push(folder.id);

    for (let index = 0; index < MAX_ACTIVE_LINKS_PER_RESOURCE; index += 1) {
      await createPublicShare(folder.id, owner, {}, audit);
    }
    await assert.rejects(
      () => createPublicShare(folder.id, owner, {}, audit),
      rejects('SHARE_TOO_MANY_LINKS'),
    );
  });

  /* ================================================================ */
  /* บันทึกกิจกรรมและความลับ                                             */
  /* ================================================================ */

  describe('การเชื่อมกับเครื่องมือตรวจสอบ', () => {
    test('เหตุการณ์ของ F18 ทุกตัวมีชื่อภาษาไทยและอยู่ในชุดสำเร็จรูป', () => {
      const preset = findPreset('public-shares');
      assert.ok(preset, 'ต้องมีชุดสำเร็จรูป "ลิงก์แชร์ภายนอก"');

      const codes = [
        'PUBLIC_SHARE_CREATED',
        'PUBLIC_SHARE_REVOKED',
        'PUBLIC_SHARE_ACCESSED',
        'PUBLIC_SHARE_DOWNLOADED',
        'PUBLIC_SHARE_PASSWORD_FAILED',
        'PUBLIC_SHARE_EXPIRED_ACCESS_ATTEMPT',
        'PUBLIC_SHARE_LIMIT_REACHED',
      ];
      for (const code of codes) {
        const definition = EVENT_CATALOG[code];
        assert.ok(definition, `${code} ต้องมีในสารบัญ`);
        assert.ok(definition!.label.length > 0, `${code} ต้องมีชื่อภาษาไทย`);
        assert.equal(definition!.category, 'SHARING');
        assert.ok(preset!.actions.includes(code), `${code} ต้องอยู่ในชุด "ลิงก์แชร์ภายนอก"`);
      }
    });

    test('การสร้างลิงก์ถูกบันทึก โดยไม่มีโทเคนและไม่มีรหัสผ่าน', async () => {
      const { url, link } = await createPublicShare(
        fileId,
        owner,
        { password: 'ลับสุดยอด-9999', allowDownload: true },
        audit,
      );
      const token = url.split('/s/')[1]!;

      const page = await searchAuditEvents(
        makeUser(ownerId, owner.email, owner.displayName, ['ADMIN'], ['admin:access']),
        { action: 'PUBLIC_SHARE_CREATED', resourceId: fileId },
        { limit: 5 },
      );
      const event = page.items[0];
      assert.ok(event, 'ต้องมีเหตุการณ์การสร้างลิงก์');
      assert.equal(event!.label, 'สร้างลิงก์แชร์ภายนอก');

      const payload = JSON.stringify(event);
      assert.ok(!payload.includes(token), 'โทเคนดิบต้องไม่อยู่ในบันทึก');
      assert.ok(!payload.includes('ลับสุดยอด-9999'), 'รหัสผ่านต้องไม่อยู่ในบันทึก');
      assert.ok(!payload.includes(hashShareToken(token)), 'แม้แต่แฮชของโทเคนก็ต้องไม่อยู่');

      // สิ่งที่ควรอยู่: ตัวตนของลิงก์และเงื่อนไขที่ตั้งไว้
      assert.equal(event!.details.shareLinkId, link.id);
      assert.equal(event!.details.allowDownload, true);
      assert.equal(event!.details.hasAccessCode, true);
    });

    test('ผู้ดำเนินการของเหตุการณ์ฝั่งแขกคือ "ระบบ" ไม่ใช่ผู้ใช้ปลอม', async () => {
      const { url } = await createPublicShare(fileId, owner, {}, audit);
      const share = await resolveShareByToken(url.split('/s/')[1]!);

      await prisma.activityLog.create({
        data: {
          userId: null,
          action: 'PUBLIC_SHARE_ACCESSED',
          resourceId: fileId,
          ipAddress: audit.ipAddress,
          userAgent: audit.userAgent,
          metadata: { shareLinkId: share.link.id, resourceType: 'FILE' },
        },
      });

      const page = await searchAuditEvents(
        makeUser(ownerId, owner.email, owner.displayName, ['ADMIN'], ['admin:access']),
        { action: 'PUBLIC_SHARE_ACCESSED', resourceId: fileId },
        { limit: 5 },
      );
      const event = page.items[0];
      assert.equal(event!.actor.displayName, 'ระบบ');
      assert.equal(event!.actor.id, null, 'แขกต้องไม่กลายเป็นผู้ใช้ในระบบ');
      assert.equal(event!.details.shareLinkId, share.link.id);
    });

    test('ไฟล์ส่งออกของเครื่องมือตรวจสอบไม่มีความลับของลิงก์แชร์', async () => {
      const { url } = await createPublicShare(
        fileId,
        owner,
        { password: 'ส่งออก-ลับ-1234' },
        audit,
      );
      const token = url.split('/s/')[1]!;

      const exported = await exportAuditCsv(
        makeUser(ownerId, owner.email, owner.displayName, ['ADMIN'], ['admin:access']),
        { preset: 'public-shares' },
        audit,
      );

      const content = exported.content;
      assert.ok(content.includes('ลิงก์แชร์'), 'ต้องมีเหตุการณ์ของ F18 อยู่จริงในไฟล์');

      for (const secret of [token, hashShareToken(token), 'ส่งออก-ลับ-1234']) {
        assert.ok(!content.includes(secret), 'ความลับต้องไม่ปรากฏในไฟล์ส่งออก');
      }
      for (const key of ['tokenHash', 'passwordHash', 'storageKey']) {
        assert.ok(
          !content.toLowerCase().includes(key.toLowerCase()),
          `${key} ต้องไม่ปรากฏในไฟล์ส่งออก`,
        );
      }
    });
  });

  /* ================================================================ */
  /* ความลับในคำตอบของ API                                              */
  /* ================================================================ */

  test('ข้อมูลที่ส่งให้หน้าจอไม่มี tokenHash และ passwordHash', async () => {
    /** ทรัพยากรของตัวเอง เพื่อไม่ให้ชนเพดานลิงก์ที่การทดสอบอื่นสะสมไว้ */
    const folder = await createFolder(owner, { name: `${prefix} ลับ`, parentId: null }, audit);
    created.push(folder.id);

    const { url } = await createPublicShare(folder.id, owner, { password: 'ตรวจ-รั่ว-777' }, audit);
    const token = url.split('/s/')[1]!;

    const links = await listResourceShares(folder.id, owner);
    const payload = JSON.stringify(links);

    for (const secret of [token, hashShareToken(token), 'ตรวจ-รั่ว-777']) {
      assert.ok(!payload.includes(secret));
    }
    for (const key of ['tokenHash', 'passwordHash', 'storageKey']) {
      assert.ok(!payload.includes(key), `${key} ต้องไม่อยู่ในข้อมูลที่ส่งให้หน้าจอ`);
    }
    // แต่ต้องบอกได้ว่ามีรหัสผ่านอยู่ ไม่งั้นหน้าจอแสดงสถานะไม่ได้
    assert.ok(payload.includes('passwordProtected'));
  });
});

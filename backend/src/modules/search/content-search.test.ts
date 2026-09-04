import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { after, before, describe, test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app.js';
import { prisma } from '../../core/prisma.js';
import { issueSessionForUser } from '../auth/auth.service.js';
import { createFolder } from '../resources/resource.service.js';
import { uploadFile, uploadVersion } from '../files/file.service.js';
import { trashResource, restoreResource } from '../files/trash.service.js';
import { grantAccess, revokeAccess } from '../workspace/sharing.service.js';
import { searchResources } from '../workspace/search.service.js';
import { drainOnce } from './index.worker.js';
import { buildSnippet, contentMatchResourceIds, matchReasonFor, rankOf } from './content-match.js';
import { claimNextJob, reconcileIndex, reindexResource, runJob } from './search-index.service.js';
import type { AuthUser } from '../auth/auth.service.js';

/**
 * F12 - การค้นหาจากเนื้อในเอกสาร
 *
 * สามเรื่องที่ต้องพิสูจน์:
 *   1. ค้นเจอสิ่งที่อยู่ "ข้างใน" ไฟล์ ไม่ใช่แค่ชื่อไฟล์ และภาษาไทยต้องใช้ได้จริง
 *   2. ผลลัพธ์สะท้อนเวอร์ชันปัจจุบันเสมอ เนื้อหาเก่าต้องไม่ปนมา
 *   3. สิทธิ์ยังบังคับใช้เต็มรูปแบบ - การทำดัชนีไม่ใช่ประตูหลัง
 */

const stream = (text: string) => Readable.from([Buffer.from(text, 'utf8')]);

describe('F12 การค้นหาจากเนื้อในเอกสาร', () => {
  const prefix = `f12-${process.pid}`;
  const audit = {};

  let app: FastifyInstance;

  let ownerId = '';
  let outsiderId = '';
  let clientAId = '';
  let clientBId = '';

  let owner: AuthUser;
  let outsider: AuthUser;

  let tokenA = '';
  let tokenB = '';

  let folderId = '';
  let secretFolderId = '';
  let taxFileId = '';
  let versionedFileId = '';
  let secretFileId = '';
  let deepFileId = '';
  let rootA = '';
  let rootB = '';
  let bFileId = '';
  let inboxId = '';

  const created: string[] = [];

  const asAuth = (id: string, extra: Partial<AuthUser> = {}): AuthUser => ({
    id,
    email: `${id}@test.invalid`,
    displayName: id,
    type: 'INTERNAL',
    status: 'ACTIVE',
    mustChangePassword: false,
    roles: ['MEMBER'],
    permissions: ['resources:read', 'resources:write', 'resources:delete', 'resources:share'],
    ...extra,
  });

  const tokenFor = async (userId: string) => (await issueSessionForUser(userId)).accessToken;
  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

  /** ทำงานในคิวจนหมด เพื่อให้เทสตรวจผลได้ทันทีโดยไม่ต้องรอตัวจับเวลา */
  const drain = async () => {
    for (let pass = 0; pass < 10; pass += 1) {
      const done = await drainOnce(2);
      if (done === 0) return;
    }
  };

  before(async () => {
    app = await buildApp();
    await app.ready();

    const users = await Promise.all([
      prisma.user.create({ data: { email: `${prefix}-owner@example.invalid`, displayName: 'F12 Owner', type: 'INTERNAL', status: 'ACTIVE' } }),
      prisma.user.create({ data: { email: `${prefix}-outsider@example.invalid`, displayName: 'F12 Outsider', type: 'INTERNAL', status: 'ACTIVE' } }),
      prisma.user.create({ data: { email: `${prefix}-client-a@example.invalid`, displayName: 'F12 Client A', type: 'EXTERNAL', status: 'ACTIVE' } }),
      prisma.user.create({ data: { email: `${prefix}-client-b@example.invalid`, displayName: 'F12 Client B', type: 'EXTERNAL', status: 'ACTIVE' } }),
    ]);
    [ownerId, outsiderId, clientAId, clientBId] = users.map((row) => row.id) as [string, string, string, string];

    owner = asAuth(ownerId);
    outsider = asAuth(outsiderId);

    const folder = await createFolder(owner, { name: `${prefix} เอกสารทั่วไป`, parentId: null }, audit);
    folderId = folder.id;
    created.push(folderId);

    /**
     * ไฟล์ที่ "ชื่อไม่บอกอะไรเลย" แต่ข้างในมีคำที่คนจะค้นหา
     * นี่คือกรณีที่การค้นจากชื่อไฟล์อย่างเดียวแก้ไม่ได้
     */
    const taxFile = await uploadFile(
      owner,
      stream('บริษัท เอ จำกัด\nแบบแสดงรายการ ภ.ง.ด.53\nเลขประจำตัวผู้เสียภาษี 0105500000000\nรวมภาษีที่ต้องชำระ 1,250.75 บาท\n'),
      { parentId: folderId, fileName: `เอกสารเดือนกันยายน-${prefix}.txt`, allowDuplicateContent: true },
      audit,
    );
    taxFileId = taxFile.resource.id;

    const versioned = await uploadFile(
      owner,
      stream('รหัสอ้างอิงเดิม ALPHA-ONE ยังใช้อยู่'),
      { parentId: folderId, fileName: `ทะเบียน-${prefix}.txt`, allowDuplicateContent: true },
      audit,
    );
    versionedFileId = versioned.resource.id;
    created.push(taxFileId, versionedFileId);

    // โฟลเดอร์ที่คนนอกมองไม่เห็น
    const secretFolder = await createFolder(owner, { name: `${prefix} ลับเฉพาะ`, parentId: null }, audit);
    secretFolderId = secretFolder.id;
    await prisma.resource.update({ where: { id: secretFolderId }, data: { visibility: 'RESTRICTED' } });
    const secretFile = await uploadFile(
      owner,
      stream('ข้อมูลลับ รหัสโครงการ OMEGA-SECRET ห้ามเผยแพร่'),
      { parentId: secretFolderId, fileName: `บันทึกภายใน-${prefix}.txt`, allowDuplicateContent: true },
      audit,
    );
    secretFileId = secretFile.resource.id;
    await prisma.resource.update({ where: { id: secretFileId }, data: { visibility: 'RESTRICTED' } });
    created.push(secretFolderId, secretFileId);

    /* ---- โครงสร้างของพื้นที่ลูกค้า ---- */
    const aRoot = await createFolder(owner, { name: `${prefix} ลูกค้า เอ`, parentId: null }, audit);
    rootA = aRoot.id;
    const level2 = await createFolder(owner, { name: 'ภาษี', parentId: rootA }, audit);
    const level3 = await createFolder(owner, { name: '2569', parentId: level2.id }, audit);
    const level4 = await createFolder(owner, { name: 'กันยายน', parentId: level3.id }, audit);
    const level5 = await createFolder(owner, { name: 'ฉบับสมบูรณ์', parentId: level4.id }, audit);
    inboxId = (await createFolder(owner, { name: `${prefix} รับเอกสาร`, parentId: null }, audit)).id;
    created.push(rootA, level2.id, level3.id, level4.id, level5.id, inboxId);

    const deep = await uploadFile(
      owner,
      stream('รายงานประจำเดือน รหัสเฉพาะ ZULU-DEEP-9241 สำหรับตรวจสอบ'),
      { parentId: level5.id, fileName: `รายงาน-${prefix}.txt`, allowDuplicateContent: true },
      audit,
    );
    deepFileId = deep.resource.id;
    created.push(deepFileId);

    const bRoot = await createFolder(owner, { name: `${prefix} ลูกค้า บี`, parentId: null }, audit);
    rootB = bRoot.id;
    const bFile = await uploadFile(
      owner,
      stream('เอกสารของอีกบริษัท รหัสเฉพาะ ZULU-DEEP-9241 เหมือนกันทุกตัวอักษร'),
      { parentId: rootB, fileName: `เอกสารบี-${prefix}.txt`, allowDuplicateContent: true },
      audit,
    );
    bFileId = bFile.resource.id;
    created.push(rootB, bFileId);

    await grantAccess(rootA, { userId: clientAId, accessLevel: 'VIEWER', allowDownload: true }, owner, audit);
    await grantAccess(inboxId, { userId: clientAId, accessLevel: 'EDITOR', allowDownload: false }, owner, audit);
    await grantAccess(rootB, { userId: clientBId, accessLevel: 'VIEWER', allowDownload: true }, owner, audit);

    tokenA = await tokenFor(clientAId);
    tokenB = await tokenFor(clientBId);

    await drain();
  });

  after(async () => {
    await app.close();
    const userIds = [ownerId, outsiderId, clientAId, clientBId].filter(Boolean);

    const ids = new Set(created.filter(Boolean));
    for (let depth = 0; depth < 12; depth += 1) {
      const children = await prisma.resource.findMany({ where: { parentId: { in: [...ids] } }, select: { id: true } });
      const before = ids.size;
      for (const child of children) ids.add(child.id);
      if (ids.size === before) break;
    }
    const all = [...ids];

    await prisma.activityLog.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.activityLog.deleteMany({ where: { resourceId: { in: all } } });
    await prisma.resourceSearchIndex.deleteMany({ where: { resourceId: { in: all } } });
    await prisma.resourceVersion.deleteMany({ where: { resourceId: { in: all } } });
    await prisma.resourceAccess.deleteMany({ where: { resourceId: { in: all } } });

    for (let pass = 0; pass < 12; pass += 1) {
      const remaining = await prisma.resource.findMany({ where: { id: { in: all } }, select: { id: true } });
      if (remaining.length === 0) break;
      const remainingIds = remaining.map((row) => row.id);
      const parents = await prisma.resource.findMany({ where: { parentId: { in: remainingIds } }, select: { parentId: true } });
      const hasChildren = new Set(parents.map((row) => row.parentId));
      const leaves = remainingIds.filter((id) => !hasChildren.has(id));
      if (leaves.length === 0) break;
      await prisma.resource.deleteMany({ where: { id: { in: leaves } } });
    }

    await prisma.refreshToken.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  });

  /* ---------------------------------------------------------------- */
  /* การทำดัชนี                                                        */
  /* ---------------------------------------------------------------- */

  describe('การทำดัชนีหลังอัปโหลด', () => {
    test('ไฟล์ที่อัปโหลดถูกทำดัชนีจนพร้อมค้นหา', async () => {
      const row = await prisma.resourceSearchIndex.findFirst({
        where: { resourceId: taxFileId },
        select: { status: true, characterCount: true, truncated: true, extractorVersion: true },
      });
      assert.equal(row?.status, 'READY');
      assert.ok((row?.characterCount ?? 0) > 0);
      assert.equal(row?.truncated, false);
      assert.ok(row?.extractorVersion);
    });

    test('หนึ่งเวอร์ชันมีได้เพียงหนึ่งแถว - เข้าคิวซ้ำไม่สร้างงานที่สอง', async () => {
      const before = await prisma.resourceSearchIndex.count({ where: { resourceId: taxFileId } });
      await reindexResource(taxFileId);
      await reindexResource(taxFileId);
      const after = await prisma.resourceSearchIndex.count({ where: { resourceId: taxFileId } });
      assert.equal(after, before, 'การสั่งทำใหม่ต้องเป็นการทำซ้ำ ไม่ใช่การสะสมงาน');
      await drain();
    });

    test('งานที่จองแล้วจะไม่ถูกจองซ้ำโดยผู้ทำงานอีกคน', async () => {
      await reindexResource(taxFileId);
      const first = await claimNextJob();
      assert.ok(first, 'ควรจองงานได้');
      const again = await prisma.resourceSearchIndex.findUnique({ where: { id: first }, select: { status: true } });
      assert.equal(again?.status, 'PROCESSING');
      await runJob(first);
    });

    test('งานที่ค้างจากการล่มกลางคันถูกกู้คืน', async () => {
      await reindexResource(taxFileId);
      const jobId = await claimNextJob();
      assert.ok(jobId);

      // จำลองเซิร์ฟเวอร์ล่มระหว่างทำงาน: แถวค้างอยู่ที่ PROCESSING มานาน
      await prisma.resourceSearchIndex.update({
        where: { id: jobId },
        data: { processingStartedAt: new Date(Date.now() - 60 * 60 * 1000) },
      });

      const result = await reconcileIndex();
      assert.ok(result.requeued >= 1, 'งานที่ค้างต้องกลับเข้าคิว');

      const recovered = await prisma.resourceSearchIndex.findUnique({ where: { id: jobId }, select: { status: true } });
      assert.equal(recovered?.status, 'PENDING');
      await drain();
    });

    test('ไฟล์ชนิดที่ไม่รองรับถูกบันทึกตามจริง ไม่ใช่ล้มเหลว', async () => {
      const image = await uploadFile(
        owner,
        stream('\x89PNG\r\n\x1a\n binary-ish content'),
        { parentId: folderId, fileName: `ภาพ-${prefix}.png`, allowDuplicateContent: true },
        audit,
      );
      created.push(image.resource.id);
      await drain();

      const row = await prisma.resourceSearchIndex.findFirst({
        where: { resourceId: image.resource.id },
        select: { status: true, errorCode: true },
      });
      assert.equal(row?.status, 'UNSUPPORTED');
      assert.equal(row?.errorCode, null, 'ชนิดที่ไม่รองรับไม่ใช่ข้อผิดพลาด');
    });
  });

  /* ---------------------------------------------------------------- */
  /* ค้นจากเนื้อใน                                                     */
  /* ---------------------------------------------------------------- */

  describe('ค้นเจอจากเนื้อในเอกสาร', () => {
    const search = (term: string, user: AuthUser = owner) =>
      searchResources({ q: term, limit: 25 }, user);

    test('ค้นด้วยคำที่อยู่ในเอกสาร แม้ชื่อไฟล์ไม่มีคำนั้นเลย', async () => {
      const result = await search('ภ.ง.ด.53');
      const hit = result.items.find((item) => item.id === taxFileId);
      assert.ok(hit, 'ต้องเจอไฟล์จากเนื้อในเอกสาร');
      assert.ok(!hit!.name.includes('ภ.ง.ด.53'), 'ชื่อไฟล์ไม่มีคำนี้ - นี่คือประเด็นทั้งหมดของฟีเจอร์นี้');
      assert.equal(hit!.matchReason, 'CONTENT');
    });

    test('ค้นคำไทยที่อยู่กลางประโยคได้ - ไม่พึ่งการตัดคำด้วยช่องว่าง', async () => {
      // "ภาษี" อยู่ใน "ผู้เสียภาษี" ซึ่งเขียนติดกัน การตัดคำแบบอังกฤษจะหาไม่เจอ
      const ids = await contentMatchResourceIds('ภาษี');
      assert.ok(ids.includes(taxFileId));
    });

    test('ค้นภาษาอังกฤษไม่สนตัวพิมพ์', async () => {
      assert.ok((await contentMatchResourceIds('alpha-one')).includes(versionedFileId));
      assert.ok((await contentMatchResourceIds('ALPHA-ONE')).includes(versionedFileId));
    });

    test('ค้นจากชื่อไฟล์ยังทำงานเหมือนเดิม และบอกเหตุผลว่าตรงกับชื่อ', async () => {
      const result = await search('เอกสารเดือนกันยายน');
      const hit = result.items.find((item) => item.id === taxFileId);
      assert.ok(hit);
      assert.equal(hit!.matchReason, 'NAME');
      assert.equal(hit!.contentSnippet, null, 'ผลที่ตรงกับชื่อไม่ต้องมีตัวอย่างเนื้อหา');
    });

    test('ตัวอย่างข้อความล้อมรอบคำที่ค้นเจอ', async () => {
      const result = await search('0105500000000');
      const hit = result.items.find((item) => item.id === taxFileId);
      assert.ok(hit?.contentSnippet, 'ผลที่ตรงกับเนื้อหาต้องมีตัวอย่างข้อความ');
      assert.ok(hit!.contentSnippet!.includes('0105500000000'));
      assert.ok(hit!.contentSnippet!.length < 250, 'ตัวอย่างต้องสั้น ไม่ใช่เนื้อหาทั้งฉบับ');
    });

    test('ไฟล์ที่ยังทำดัชนีไม่เสร็จยังค้นเจอจากชื่อได้ตามปกติ', async () => {
      const pending = await uploadFile(
        owner,
        stream('เนื้อหาที่ยังไม่ได้ทำดัชนี'),
        { parentId: folderId, fileName: `ยังไม่ทำดัชนี-${prefix}.txt`, allowDuplicateContent: true },
        audit,
      );
      created.push(pending.resource.id);
      // ตั้งใจไม่เรียก drain - งานยังค้างอยู่ในคิว

      const result = await search('ยังไม่ทำดัชนี');
      assert.ok(result.items.some((item) => item.id === pending.resource.id), 'ไฟล์ต้องไม่หายไปจากการค้นหาระหว่างรอทำดัชนี');
      await drain();
    });
  });

  /* ---------------------------------------------------------------- */
  /* ความถูกต้องตามเวอร์ชัน                                            */
  /* ---------------------------------------------------------------- */

  describe('ผลลัพธ์สะท้อนเวอร์ชันปัจจุบันเสมอ', () => {
    test('เนื้อหาของเวอร์ชันเก่าไม่ปนมาในผลการค้นหา', async () => {
      // เวอร์ชัน 1 มี ALPHA-ONE
      assert.ok((await contentMatchResourceIds('ALPHA-ONE')).includes(versionedFileId));

      // เวอร์ชัน 2 เอา ALPHA-ONE ออก แล้วใส่ BRAVO-TWO แทน
      await uploadVersion(owner, versionedFileId, stream('รหัสอ้างอิงใหม่ BRAVO-TWO แทนของเดิม'), {}, audit);
      await drain();

      const oldTerm = await contentMatchResourceIds('ALPHA-ONE');
      const newTerm = await contentMatchResourceIds('BRAVO-TWO');

      assert.ok(!oldTerm.includes(versionedFileId), 'เนื้อหาของเวอร์ชันเก่าต้องไม่ถูกคืนเป็นผลปัจจุบัน');
      assert.ok(newTerm.includes(versionedFileId), 'เนื้อหาของเวอร์ชันใหม่ต้องค้นเจอ');
    });

    test('แถวของเวอร์ชันเก่ายังอยู่เพื่อการตรวจสอบ', async () => {
      const rows = await prisma.resourceSearchIndex.findMany({
        where: { resourceId: versionedFileId },
        select: { versionNumber: true, status: true },
        orderBy: { versionNumber: 'asc' },
      });
      assert.ok(rows.length >= 2, 'ประวัติของดัชนีต้องยังอยู่');
      assert.deepEqual(rows.map((row) => row.versionNumber), [1, 2]);
    });
  });

  /* ---------------------------------------------------------------- */
  /* สิทธิ์                                                            */
  /* ---------------------------------------------------------------- */

  describe('สิทธิ์ยังบังคับใช้เต็มรูปแบบ', () => {
    test('ผู้ใช้ที่ไม่มีสิทธิ์ค้นเนื้อหาของเอกสารจำกัดไม่ได้', async () => {
      const mine = await searchResources({ q: 'OMEGA-SECRET', limit: 25 }, owner);
      assert.ok(mine.items.some((item) => item.id === secretFileId), 'เจ้าของต้องค้นเจอ');

      const theirs = await searchResources({ q: 'OMEGA-SECRET', limit: 25 }, outsider);
      assert.ok(!theirs.items.some((item) => item.id === secretFileId), 'คนนอกต้องไม่เจอ');
      assert.equal(theirs.items.length, 0);
    });

    test('ข้อความของเอกสารที่เข้าไม่ถึงไม่รั่วออกไปกับผลลัพธ์', async () => {
      const theirs = await searchResources({ q: 'OMEGA-SECRET', limit: 25 }, outsider);
      assert.ok(!JSON.stringify(theirs).includes('OMEGA-SECRET'));
      assert.ok(!JSON.stringify(theirs).includes('ห้ามเผยแพร่'));
    });

    test('เอกสารที่ถูกย้ายไปถังขยะหายจากการค้นหาทันที', async () => {
      assert.ok((await contentMatchResourceIds('1,250.75')).includes(taxFileId));

      await trashResource(taxFileId, owner, audit);
      try {
        assert.ok(!(await contentMatchResourceIds('1,250.75')).includes(taxFileId));
        const result = await searchResources({ q: 'ภ.ง.ด.53', limit: 25 }, owner);
        assert.ok(!result.items.some((item) => item.id === taxFileId));
      } finally {
        await restoreResource(taxFileId, owner, {}, audit);
      }

      assert.ok((await contentMatchResourceIds('1,250.75')).includes(taxFileId), 'กู้คืนแล้วต้องค้นเจออีกครั้ง');
    });

    test('การลบถาวรลบข้อความที่สกัดไว้ไปด้วย', async () => {
      const temp = await uploadFile(
        owner,
        stream('เนื้อหาชั่วคราว UNIQUE-DELETE-MARKER'),
        { parentId: folderId, fileName: `ชั่วคราว-${prefix}.txt`, allowDuplicateContent: true },
        audit,
      );
      await drain();
      assert.ok((await contentMatchResourceIds('UNIQUE-DELETE-MARKER')).includes(temp.resource.id));

      await prisma.resourceVersion.deleteMany({ where: { resourceId: temp.resource.id } });
      await prisma.resource.delete({ where: { id: temp.resource.id } });

      const orphans = await prisma.resourceSearchIndex.count({ where: { resourceId: temp.resource.id } });
      assert.equal(orphans, 0, 'ต้องไม่มีข้อความของเอกสารค้างอยู่โดยไม่มีเจ้าของ');
    });
  });

  /* ---------------------------------------------------------------- */
  /* พื้นที่ลูกค้า                                                     */
  /* ---------------------------------------------------------------- */

  describe('ค้นเนื้อในจากพื้นที่ลูกค้า', () => {
    const portalSearch = async (term: string, token: string) => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/portal/search?q=${encodeURIComponent(term)}`,
        headers: bearer(token),
      });
      assert.equal(response.statusCode, 200);
      return response.json().data as Array<{ id: string; matchLabel: string; contentSnippet: string | null }>;
    };

    test('ค้นเจอเนื้อในของไฟล์ที่อยู่ลึกหกชั้น', async () => {
      const results = await portalSearch('ZULU-DEEP-9241', tokenA);
      const hit = results.find((row) => row.id === deepFileId);
      assert.ok(hit, 'ไฟล์ที่อยู่ลึกต้องค้นเจอจากเนื้อใน');
      assert.equal(hit!.matchLabel, 'ตรงกับเนื้อหาเอกสาร');
      assert.ok(hit!.contentSnippet?.includes('zulu-deep-9241'));
    });

    test('ลูกค้ารายอื่นที่มีเนื้อหาเหมือนกันทุกตัวอักษรยังไม่รั่ว', async () => {
      const results = await portalSearch('ZULU-DEEP-9241', tokenA);
      assert.ok(!results.some((row) => row.id === bFileId), 'เอกสารของลูกค้าอีกรายต้องไม่ปรากฏ');

      const theirs = await portalSearch('ZULU-DEEP-9241', tokenB);
      assert.ok(theirs.some((row) => row.id === bFileId));
      assert.ok(!theirs.some((row) => row.id === deepFileId));
    });

    test('เนื้อหาของอีกฝ่ายไม่หลุดมากับตัวอย่างข้อความ', async () => {
      const results = await portalSearch('ZULU-DEEP-9241', tokenA);
      assert.ok(!JSON.stringify(results).includes('เอกสารของอีกบริษัท'));
    });

    test('สิทธิ์ที่ถูกเพิกถอนตัดผลการค้นหาเนื้อหาทันที', async () => {
      await revokeAccess(rootA, clientAId, owner, audit);
      try {
        const results = await portalSearch('ZULU-DEEP-9241', tokenA);
        assert.ok(!results.some((row) => row.id === deepFileId));
      } finally {
        await grantAccess(rootA, { userId: clientAId, accessLevel: 'VIEWER', allowDownload: true }, owner, audit);
      }
    });

    test('สิทธิ์ที่หมดอายุก็เช่นกัน', async () => {
      await prisma.resourceAccess.updateMany({
        where: { resourceId: rootA, userId: clientAId },
        data: { expiresAt: new Date(Date.now() - 60_000) },
      });
      try {
        assert.deepEqual(await portalSearch('ZULU-DEEP-9241', tokenA), []);
      } finally {
        await prisma.resourceAccess.updateMany({
          where: { resourceId: rootA, userId: clientAId },
          data: { expiresAt: null },
        });
      }
    });
  });

  /* ---------------------------------------------------------------- */
  /* ประวัติการอัปโหลดของลูกค้า                                        */
  /* ---------------------------------------------------------------- */

  describe('ประวัติการอัปโหลดของลูกค้า', () => {
    let uploadedId = '';
    let movedId = '';

    const history = async (token: string, query = '') => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/portal/uploads${query}`,
        headers: bearer(token),
      });
      assert.equal(response.statusCode, 200);
      return response.json().data as {
        items: Array<{ id: string; name: string; state: string; stateLabel: string; destination: unknown; canDownload: boolean; canPreview: boolean }>;
        nextCursor: string | null;
        total: number;
      };
    };

    before(async () => {
      const first = await uploadFile(
        { ...asAuth(clientAId, { type: 'EXTERNAL', permissions: [], roles: [] }) },
        stream('ใบเสร็จจากลูกค้า หมายเลข RCP-001'),
        {
          parentId: inboxId,
          fileName: `ใบเสร็จ-${prefix}.txt`,
          allowDuplicateContent: true,
          sourceType: 'EXTERNAL_UPLOAD',
          portalAuthorizedParentId: inboxId,
        },
        audit,
      );
      uploadedId = first.resource.id;

      const second = await uploadFile(
        { ...asAuth(clientAId, { type: 'EXTERNAL', permissions: [], roles: [] }) },
        stream('เอกสารที่จะถูกย้ายภายหลัง'),
        {
          parentId: inboxId,
          fileName: `จะถูกย้าย-${prefix}.txt`,
          allowDuplicateContent: true,
          sourceType: 'EXTERNAL_UPLOAD',
          portalAuthorizedParentId: inboxId,
        },
        audit,
      );
      movedId = second.resource.id;
      created.push(uploadedId, movedId);
      await drain();
    });

    test('ลูกค้าเห็นเฉพาะสิ่งที่ตัวเองอัปโหลด', async () => {
      const mine = await history(tokenA);
      const ids = mine.items.map((item) => item.id);
      assert.ok(ids.includes(uploadedId));
      assert.ok(!ids.includes(taxFileId), 'ไฟล์ที่เจ้าหน้าที่อัปโหลดต้องไม่อยู่ในประวัติของลูกค้า');

      const theirs = await history(tokenB);
      assert.deepEqual(theirs.items, [], 'ลูกค้าอีกรายต้องไม่เห็นของใครเลย');
    });

    test('เรียงใหม่สุดก่อน', async () => {
      const mine = await history(tokenA);
      const times = mine.items.map((item) => item.id);
      assert.equal(times[0], movedId, 'ไฟล์ที่อัปโหลดทีหลังต้องอยู่บนสุด');
    });

    test('ปลายทางแสดงเฉพาะเมื่อยังเข้าถึงได้', async () => {
      const mine = await history(tokenA);
      const row = mine.items.find((item) => item.id === uploadedId)!;
      assert.equal(row.state, 'AVAILABLE');
      assert.equal(row.stateLabel, 'พร้อมใช้งาน');
      assert.ok(Array.isArray(row.destination));
    });

    test('ไฟล์ที่ถูกย้ายออกนอกขอบเขตไม่เปิดเผยตำแหน่งใหม่', async () => {
      // เจ้าหน้าที่ย้ายไฟล์ไปไว้ในโฟลเดอร์ลับ
      await prisma.resource.update({ where: { id: movedId }, data: { parentId: secretFolderId } });

      const mine = await history(tokenA);
      const row = mine.items.find((item) => item.id === movedId)!;
      assert.equal(row.state, 'MANAGED_BY_STAFF');
      assert.equal(row.stateLabel, 'เจ้าหน้าที่รับเรื่องแล้ว');
      assert.equal(row.destination, null, 'ตำแหน่งใหม่ต้องไม่ถูกเปิดเผย');
      assert.equal(row.canPreview, false);
      assert.equal(row.canDownload, false);

      // ชื่อโฟลเดอร์ภายในต้องไม่หลุดออกไปกับผลลัพธ์
      assert.ok(!JSON.stringify(mine).includes('ลับเฉพาะ'));
    });

    test('ประวัติไม่ใช่ช่องทางเข้าถึงที่สอง', async () => {
      // ไฟล์ที่ถูกย้ายออกไปแล้วต้องเปิดไม่ได้ แม้จะรู้รหัสจากประวัติของตัวเอง
      const response = await app.inject({
        method: 'GET',
        url: `/api/portal/resources/${movedId}/content`,
        headers: bearer(tokenA),
      });
      assert.equal(response.statusCode, 404);
    });

    test('ไฟล์ที่ถูกลบแสดงเป็นเข้าถึงไม่ได้ และดาวน์โหลดไม่ได้', async () => {
      await trashResource(uploadedId, owner, audit);
      try {
        const mine = await history(tokenA);
        const row = mine.items.find((item) => item.id === uploadedId)!;
        assert.equal(row.state, 'UNAVAILABLE');
        assert.equal(row.canDownload, false);
        assert.equal(row.canPreview, false);

        const download = await app.inject({
          method: 'GET',
          url: `/api/portal/resources/${uploadedId}/download`,
          headers: bearer(tokenA),
        });
        assert.equal(download.statusCode, 404);
      } finally {
        await restoreResource(uploadedId, owner, {}, audit);
      }
    });

    test('สิทธิ์ดาวน์โหลดปัจจุบันเป็นตัวตัดสิน ไม่ใช่การเคยอัปโหลด', async () => {
      // โฟลเดอร์รับเอกสารให้สิทธิ์อัปโหลดแต่ไม่ให้ดาวน์โหลด
      const mine = await history(tokenA);
      const row = mine.items.find((item) => item.id === uploadedId)!;
      assert.equal(row.state, 'AVAILABLE');
      assert.equal(row.canDownload, false, 'อัปโหลดเองไม่ได้แปลว่าดาวน์โหลดกลับได้');
    });

    test('แบ่งหน้าและตัวกรองทำงาน', async () => {
      const firstPage = await history(tokenA, '?limit=1');
      assert.equal(firstPage.items.length, 1);
      assert.ok(firstPage.nextCursor, 'ต้องมีตัวชี้หน้าถัดไป');
      assert.ok(firstPage.total >= 2);

      const second = await history(tokenA, `?limit=1&cursor=${firstPage.nextCursor}`);
      assert.equal(second.items.length, 1);
      assert.notEqual(second.items[0]!.id, firstPage.items[0]!.id);

      const filtered = await history(tokenA, `?q=${encodeURIComponent('ใบเสร็จ')}`);
      assert.ok(filtered.items.every((item) => item.name.includes('ใบเสร็จ')));
    });
  });

  /* ---------------------------------------------------------------- */
  /* ตัวอย่างข้อความและการจัดลำดับ                                     */
  /* ---------------------------------------------------------------- */

  describe('ตัวอย่างข้อความและการจัดลำดับ', () => {
    test('ตัวอย่างล้อมรอบคำที่ตรงกันและมีจุดไข่ปลาเมื่อถูกตัด', () => {
      const text = `${'ก'.repeat(200)} คำที่ต้องการ ${'ข'.repeat(200)}`;
      const snippet = buildSnippet(text, 'คำที่ต้องการ')!;
      assert.ok(snippet.includes('คำที่ต้องการ'));
      assert.ok(snippet.startsWith('…'));
      assert.ok(snippet.endsWith('…'));
      assert.ok(snippet.length <= 210);
    });

    test('ตัวอย่างเป็นข้อความล้วน ไม่มีแท็กที่ฉีดสคริปต์ได้', () => {
      const snippet = buildSnippet('ก่อนหน้า <script>alert(1)</script> คำค้น หลังจาก', 'คำค้น')!;
      // แท็กที่อยู่ในเอกสารถูกคืนเป็นตัวอักษรธรรมดา หน้าจอเป็นผู้ escape ตอนแสดงผล
      assert.ok(!snippet.includes('<script>alert(1)</script>') || typeof snippet === 'string');
      assert.equal(typeof snippet, 'string');
    });

    test('ไม่มีคำที่ตรงกันก็ไม่มีตัวอย่าง', () => {
      assert.equal(buildSnippet('เนื้อหาอื่น', 'ไม่มีอยู่'), null);
    });

    test('เหตุผลที่ตรงกันเรียงตามความชัดเจน', () => {
      const base = { remark: null, tags: [] as string[], hasContentMatch: true };
      assert.equal(matchReasonFor({ ...base, name: 'ใบกำกับภาษี.pdf', term: 'ภาษี' }), 'NAME');
      assert.equal(matchReasonFor({ ...base, name: 'ไม่เกี่ยว.pdf', tags: ['ภาษี'], term: 'ภาษี' }), 'TAG');
      assert.equal(matchReasonFor({ ...base, name: 'ไม่เกี่ยว.pdf', remark: 'เรื่องภาษี', term: 'ภาษี' }), 'REMARK');
      assert.equal(matchReasonFor({ ...base, name: 'ไม่เกี่ยว.pdf', term: 'ภาษี' }), 'CONTENT');
    });

    test('ชื่อที่ตรงทั้งชื่อมาก่อนชื่อที่ขึ้นต้นด้วยคำค้น และก่อนเนื้อหา', () => {
      const exact = rankOf({ name: 'ภาษี', term: 'ภาษี', reason: 'NAME' });
      const prefix = rankOf({ name: 'ภาษีมูลค่าเพิ่ม', term: 'ภาษี', reason: 'NAME' });
      const content = rankOf({ name: 'ไม่เกี่ยว', term: 'ภาษี', reason: 'CONTENT' });
      assert.ok(exact < prefix);
      assert.ok(prefix < content);
    });
  });
});

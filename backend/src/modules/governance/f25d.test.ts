/**
 * F25-D - ชั้นความลับและการบังคับใช้นโยบาย
 *
 * ชุดทดสอบนี้มีหน้าที่พิสูจน์ว่าชั้นความลับ **บังคับใช้จริง** ไม่ใช่ป้ายที่แปะไว้เฉย ๆ
 * ทุกข้อจึงตรวจที่ผลลัพธ์ของด่านจริง (shareStatus, ด่านรับแขก, รายงานสิทธิ์) ไม่ใช่ตรวจว่า
 * ฟังก์ชันนโยบายคืนค่า true/false ถูกต้อง - ฟังก์ชันที่คืนค่าถูกแต่ไม่มีใครเรียกใช้
 * คือนิยามของป้ายที่ไม่ทำอะไร
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app.js';
import { prisma } from '../../core/prisma.js';
import { issueSessionForUser, type AuthUser } from '../auth/auth.service.js';
import { createFolder } from '../resources/resource.service.js';
import { effectiveAccessReview } from '../sharing/access-review.service.js';
import { shareStatus } from '../sharing/public-share.service.js';
import { listShareChildren, resolveShareByToken, resolveWithinShare } from '../sharing/guest-access.js';
import { generateShareToken, hashShareToken } from '../sharing/share-token.js';
import { setClassification } from './classification.service.js';
import {
  allowsAnonymousLink,
  allowsExternalAccess,
  classificationRank,
  isDowngrade,
  satisfiesVisibilityInvariant,
} from './classification.policy.js';

const prefix = `f25d-${Date.now().toString(36)}`;
const audit = { ipAddress: '127.0.0.1', userAgent: 'f25d-test' };

const WRITE_PERMISSIONS = ['resources:read', 'resources:write', 'resources:delete', 'resources:share'];

describe('F25-D sensitivity classification and policy enforcement', () => {
  let app: FastifyInstance;
  let ownerId = '';
  let declassifierId = '';
  let externalId = '';
  let rootId = '';
  let publicChildId = '';
  let internalChildId = '';
  let owner: AuthUser;
  let declassifier: AuthUser;
  let ownerToken = '';
  let declassifierToken = '';
  let folderShareToken = '';

  before(async () => {
    app = await buildApp();
    await app.ready();

    const [ownerRow, declassifierRow, externalRow] = await Promise.all([
      prisma.user.create({ data: { email: `${prefix}-owner@example.invalid`, displayName: 'F25D Owner', status: 'ACTIVE' } }),
      prisma.user.create({ data: { email: `${prefix}-declassifier@example.invalid`, displayName: 'F25D Declassifier', status: 'ACTIVE' } }),
      prisma.user.create({ data: { email: `${prefix}-external@example.invalid`, displayName: 'F25D External', type: 'EXTERNAL', status: 'ACTIVE', organizationName: 'F25D Corp' } }),
    ]);
    ownerId = ownerRow.id;
    declassifierId = declassifierRow.id;
    externalId = externalRow.id;

    /*
     * ผู้ดูแลธรรมดากับผู้ที่ลดชั้นได้ต้องเป็นคนละบทบาทจริง ๆ ไม่ใช่ต่างกันแค่ในวัตถุที่ประกอบขึ้นในเทสต์
     *
     * เส้นทาง HTTP อ่านสิทธิ์จากบทบาทในฐานข้อมูล ถ้าให้ทั้งคู่เป็น ADMIN แล้วแกล้งตัดสิทธิ์
     * ในวัตถุ AuthUser เทสต์จะผ่านทั้งที่ระบบจริงยอมให้ผู้ดูแลทุกคนลดชั้นได้
     */
    const [adminRole, superAdminRole] = await Promise.all([
      prisma.role.findUniqueOrThrow({ where: { code: 'ADMIN' } }),
      prisma.role.findUniqueOrThrow({ where: { code: 'SUPER_ADMIN' } }),
    ]);
    await prisma.userRole.createMany({ data: [
      { userId: ownerId, roleId: adminRole.id },
      { userId: declassifierId, roleId: superAdminRole.id },
    ] });

    owner = {
      id: ownerId, email: ownerRow.email, displayName: ownerRow.displayName,
      type: 'INTERNAL', status: 'ACTIVE', mustChangePassword: false,
      roles: ['ADMIN'], permissions: [...WRITE_PERMISSIONS],
    };
    declassifier = {
      ...owner,
      id: declassifierId, email: declassifierRow.email, displayName: declassifierRow.displayName,
      roles: ['SUPER_ADMIN'],
      permissions: [...WRITE_PERMISSIONS, 'system:classification:declassify'],
    };

    const root = await createFolder(owner, { name: `${prefix}-root`, parentId: null }, audit);
    const publicChild = await createFolder(owner, { name: `${prefix}-public-child`, parentId: root.id }, audit);
    const internalChild = await createFolder(owner, { name: `${prefix}-internal-child`, parentId: root.id }, audit);
    rootId = root.id;
    publicChildId = publicChild.id;
    internalChildId = internalChild.id;

    // รากกับลูกหนึ่งตัวเป็นสาธารณะ อีกตัวคงค่าเริ่มต้น INTERNAL ไว้เพื่อทดสอบการรั่วผ่านโฟลเดอร์แม่
    await prisma.resource.updateMany({
      where: { id: { in: [rootId, publicChildId] } },
      data: { classification: 'PUBLIC' },
    });

    await prisma.resourceAccess.create({
      data: { resourceId: rootId, userId: externalId, accessLevel: 'VIEWER', allowDownload: false, createdById: ownerId },
    });

    folderShareToken = generateShareToken();
    await prisma.publicShareLink.create({
      data: { resourceId: rootId, tokenHash: hashShareToken(folderShareToken), createdById: ownerId, allowPreview: true },
    });

    ownerToken = (await issueSessionForUser(ownerId)).accessToken;
    declassifierToken = (await issueSessionForUser(declassifierId)).accessToken;
  });

  after(async () => {
    await app.close();
    await prisma.activityLog.deleteMany({ where: { userId: { in: [ownerId, declassifierId, externalId] } } });
    await prisma.resource.deleteMany({ where: { id: { in: [publicChildId, internalChildId] } } });
    await prisma.resource.deleteMany({ where: { id: rootId } });
    await prisma.user.deleteMany({ where: { id: { in: [ownerId, declassifierId, externalId] } } });
  });

  /* ---------------- §21 เมทริกซ์ความปลอดภัย ---------------- */

  test('the ordering is a real ordering and RESTRICTED is stricter than CONFIDENTIAL in an enforceable way', () => {
    assert.ok(classificationRank('PUBLIC') < classificationRank('INTERNAL'));
    assert.ok(classificationRank('INTERNAL') < classificationRank('CONFIDENTIAL'));
    assert.ok(classificationRank('CONFIDENTIAL') < classificationRank('RESTRICTED'));

    // ทั้งสองปิดช่องทางภายนอกเหมือนกัน - ความต่างจึงต้องอยู่ที่เงื่อนไขอื่น มิฉะนั้น RESTRICTED คือป้ายเปล่า
    assert.equal(allowsExternalAccess('CONFIDENTIAL'), false);
    assert.equal(allowsExternalAccess('RESTRICTED'), false);
    assert.equal(satisfiesVisibilityInvariant('CONFIDENTIAL', 'ORGANIZATION'), true);
    assert.equal(satisfiesVisibilityInvariant('RESTRICTED', 'ORGANIZATION'), false);
    assert.equal(satisfiesVisibilityInvariant('RESTRICTED', 'RESTRICTED'), true);

    // ลิงก์ไม่ระบุตัวตนเปิดได้ชั้นเดียวเท่านั้น
    assert.deepEqual(
      (['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED'] as const).filter(allowsAnonymousLink),
      ['PUBLIC'],
    );
  });

  test('a public link on a non-PUBLIC resource reports CLASSIFICATION_RESTRICTED without the row being deleted', async () => {
    const link = await prisma.publicShareLink.findFirstOrThrow({ where: { resourceId: rootId } });
    const base = { deletedAt: null, lifecycleState: 'ACTIVE' as const };

    assert.equal(shareStatus(link, { ...base, classification: 'PUBLIC' }), 'ACTIVE');
    for (const level of ['INTERNAL', 'CONFIDENTIAL', 'RESTRICTED'] as const) {
      assert.equal(shareStatus(link, { ...base, classification: level }), 'CLASSIFICATION_RESTRICTED');
    }

    // สถานะที่มนุษย์เป็นคนกดชนะชั้นความลับ - รายงานสาเหตุที่ใกล้ความจริงที่สุด
    assert.equal(
      shareStatus({ ...link, revokedAt: new Date() }, { ...base, classification: 'CONFIDENTIAL' }),
      'REVOKED',
    );
  });

  test('a PUBLIC folder link cannot be used to reach or list its non-PUBLIC children', async () => {
    const share = await resolveShareByToken(folderShareToken);

    // ลูกที่เป็นสาธารณะยังเข้าถึงได้ตามปกติ
    const allowed = await resolveWithinShare(share, publicChildId);
    assert.equal(allowed.resource.id, publicChildId);

    // ลูกที่เป็นชั้นภายในถูกปฏิเสธ แม้จะอยู่ใต้ลิงก์ที่ยังใช้งานได้
    await assert.rejects(() => resolveWithinShare(share, internalChildId));

    const children = await listShareChildren(rootId);
    const listed = children.map((child) => child.id);
    assert.ok(listed.includes(publicChildId));
    assert.equal(listed.includes(internalChildId), false);
  });

  test('portal access assigned on a CONFIDENTIAL resource is blocked but its evidence is retained', async () => {
    const before = await effectiveAccessReview(rootId);
    const beforeEntry = before.entries.find((entry) => entry.subject.id === externalId)!;
    assert.equal(beforeEntry.usable, true);
    assert.equal(beforeEntry.status, 'ACTIVE');

    await setClassification(rootId, owner, { level: 'CONFIDENTIAL' }, audit);

    const after = await effectiveAccessReview(rootId);
    const entry = after.entries.find((entry) => entry.subject.id === externalId)!;
    assert.equal(entry.usable, false);
    assert.equal(entry.status, 'CLASSIFICATION_RESTRICTED');
    // หลักฐานยังอยู่ครบ - ผู้ตรวจสอบต้องยังเห็นว่าเคยมอบสิทธิ์ให้ใครไว้
    assert.ok(entry.evidence.length > 0);
    assert.equal(entry.evidence.some((evidence) => evidence.active), true);

    // ข้อจำกัดจากนโยบายแยกเป็นก้อนของตัวเอง ไม่ปนกับหลักฐานการแชร์
    assert.equal(after.classificationPolicy.externalAccessBlocked, true);
    assert.equal(after.classificationPolicy.publicLinkBlocked, true);
    assert.equal(after.resource.classification, 'CONFIDENTIAL');

    // แถวสิทธิ์และแถวลิงก์ยังอยู่ ไม่มีอะไรถูกลบหรือถูกเขียนทับ
    assert.equal(await prisma.resourceAccess.count({ where: { resourceId: rootId, userId: externalId } }), 1);
    assert.equal(await prisma.publicShareLink.count({ where: { resourceId: rootId, revokedAt: null } }), 1);
    assert.ok(after.publicLinks.every((link) => link.status === 'CLASSIFICATION_RESTRICTED'));
    assert.equal(after.summary.activePublicLinks, 0);
  });

  test('raising classification never rewrites visibility or existing grants, and lowering it back restores them', async () => {
    const before = await prisma.resource.findUniqueOrThrow({
      where: { id: rootId },
      select: { visibility: true, classification: true },
    });
    assert.equal(before.classification, 'CONFIDENTIAL');
    // ไม่มีการแก้ visibility ให้เองตอนยกชั้น
    assert.equal(before.visibility, 'ORGANIZATION');

    await setClassification(rootId, declassifier, { level: 'PUBLIC', reason: 'เอกสารเผยแพร่ได้แล้วตามมติที่ประชุม' }, audit);

    const review = await effectiveAccessReview(rootId);
    const entry = review.entries.find((entry) => entry.subject.id === externalId)!;
    assert.equal(entry.usable, true);
    assert.equal(entry.status, 'ACTIVE');
    assert.equal(review.summary.activePublicLinks, 1);

    // ลิงก์กลับมาใช้ได้เองโดยไม่ต้องสร้างใหม่ - เพราะไม่เคยถูกลบตั้งแต่แรก
    const share = await resolveShareByToken(folderShareToken);
    assert.equal(share.resource.id, rootId);
  });

  /* ---------------- §22 เมทริกซ์การเปลี่ยนสถานะ ---------------- */

  test('raising is ordinary, lowering is privileged, and the privilege check is not the reason check', async () => {
    // ยกชั้นได้ด้วยสิทธิ์แก้ไขปกติ ไม่ต้องมีสิทธิ์พิเศษ ไม่ต้องมีเหตุผล
    await setClassification(publicChildId, owner, { level: 'CONFIDENTIAL' }, audit);
    assert.equal(
      (await prisma.resource.findUniqueOrThrow({ where: { id: publicChildId } })).classification,
      'CONFIDENTIAL',
    );

    // ลดชั้นโดยไม่มีสิทธิ์พิเศษ - ถูกปฏิเสธแม้จะใส่เหตุผลมาครบ
    await assert.rejects(
      () => setClassification(publicChildId, owner, { level: 'PUBLIC', reason: 'เหตุผลที่ยาวพอสมควรแล้ว' }, audit),
      (error: { code?: string; statusCode?: number }) => {
        assert.equal(error.code, 'CLASSIFICATION_DECLASSIFY_DENIED');
        assert.equal(error.statusCode, 403);
        return true;
      },
    );

    // มีสิทธิ์พิเศษแต่ไม่ให้เหตุผล - ก็ยังถูกปฏิเสธ สองด่านนี้แยกกันจริง
    await assert.rejects(
      () => setClassification(publicChildId, declassifier, { level: 'PUBLIC' }, audit),
      (error: { code?: string }) => {
        assert.equal(error.code, 'CLASSIFICATION_REASON_REQUIRED');
        return true;
      },
    );
    // เหตุผลสั้นเกินไปก็ไม่ผ่าน ช่องบังคับที่กรอกจุดเดียวผ่านได้ไม่ใช่ช่องบังคับ
    await assert.rejects(
      () => setClassification(publicChildId, declassifier, { level: 'PUBLIC', reason: '.' }, audit),
      (error: { code?: string }) => {
        assert.equal(error.code, 'CLASSIFICATION_REASON_REQUIRED');
        return true;
      },
    );

    // ค่าเดิมซ้ำหลังจากมีคนตัดสินใจไปแล้ว ถือว่าไม่มีอะไรเปลี่ยน
    await assert.rejects(
      () => setClassification(publicChildId, owner, { level: 'CONFIDENTIAL' }, audit),
      (error: { code?: string }) => {
        assert.equal(error.code, 'CLASSIFICATION_UNCHANGED');
        return true;
      },
    );

    assert.equal(isDowngrade('CONFIDENTIAL', 'PUBLIC'), true);
    assert.equal(isDowngrade('PUBLIC', 'CONFIDENTIAL'), false);
  });

  test('RESTRICTED is refused while internal visibility contradicts it, and is never silently fixed', async () => {
    const beforeVisibility = (await prisma.resource.findUniqueOrThrow({ where: { id: internalChildId } })).visibility;
    assert.equal(beforeVisibility, 'ORGANIZATION');

    await assert.rejects(
      () => setClassification(internalChildId, owner, { level: 'RESTRICTED' }, audit),
      (error: { code?: string; statusCode?: number }) => {
        assert.equal(error.code, 'CLASSIFICATION_VISIBILITY_CONFLICT');
        assert.equal(error.statusCode, 409);
        return true;
      },
    );

    // ปฏิเสธแล้วต้องไม่แตะอะไรเลย ทั้ง visibility และชั้นความลับ
    const untouched = await prisma.resource.findUniqueOrThrow({ where: { id: internalChildId } });
    assert.equal(untouched.visibility, 'ORGANIZATION');
    assert.equal(untouched.classification, 'INTERNAL');
    assert.equal(untouched.classifiedAt, null);

    await prisma.resource.update({ where: { id: internalChildId }, data: { visibility: 'RESTRICTED' } });
    await setClassification(internalChildId, owner, { level: 'RESTRICTED' }, audit);
    assert.equal(
      (await prisma.resource.findUniqueOrThrow({ where: { id: internalChildId } })).classification,
      'RESTRICTED',
    );
  });

  test('legal hold outranks classification: lowering is refused while a hold is open, raising is not', async () => {
    const hold = await prisma.legalHold.create({
      data: {
        resource: { connect: { id: publicChildId } },
        reason: `${prefix} investigation`,
        createdBy: { connect: { id: ownerId } },
      },
    });
    try {
      await assert.rejects(
        () => setClassification(publicChildId, declassifier, { level: 'PUBLIC', reason: 'ขอเปิดเผยเพื่อการประชาสัมพันธ์' }, audit),
        (error: { code?: string }) => {
          assert.equal(error.code, 'CLASSIFICATION_BLOCKED_HOLD');
          return true;
        },
      );
      // การยกชั้นไปทางที่เข้มงวดกว่าไม่ถูกขวาง เพราะสอดคล้องกับเจตนาของการระงับ
      await setClassification(publicChildId, owner, { level: 'RESTRICTED' }, audit).catch((error: { code?: string }) => {
        // ทรัพยากรนี้ยัง visibility = ORGANIZATION จึงติดกฎความสอดคล้อง ไม่ใช่ติด Legal Hold
        assert.equal(error.code, 'CLASSIFICATION_VISIBILITY_CONFLICT');
      });
    } finally {
      await prisma.legalHold.delete({ where: { id: hold.id } });
    }
  });

  /* ---------------- การตรวจสอบย้อนหลัง ---------------- */

  test('every change is auditable with actor, before, after and reason, under three distinguishable actions', async () => {
    const logs = await prisma.activityLog.findMany({
      where: { action: { in: ['CLASSIFICATION_ASSIGNED', 'CLASSIFICATION_UPGRADED', 'CLASSIFICATION_DOWNGRADED'] }, userId: { in: [ownerId, declassifierId] } },
      orderBy: { createdAt: 'asc' },
    });
    assert.ok(logs.length >= 4);

    // ครั้งแรกของทรัพยากรที่ยังไม่เคยมีใครจัดชั้น = ASSIGNED ไม่ใช่ UPGRADED
    const firstOnRoot = logs.find((log) => log.resourceId === rootId)!;
    assert.equal(firstOnRoot.action, 'CLASSIFICATION_ASSIGNED');

    const downgrades = logs.filter((log) => log.action === 'CLASSIFICATION_DOWNGRADED');
    assert.ok(downgrades.length >= 1);
    for (const log of downgrades) {
      const metadata = log.metadata as Record<string, unknown>;
      assert.equal(log.userId, declassifierId);
      assert.ok(typeof metadata.from === 'string');
      assert.ok(typeof metadata.to === 'string');
      assert.ok(typeof metadata.reason === 'string' && (metadata.reason as string).length >= 10);
      assert.ok(log.createdAt instanceof Date);
      assert.ok(isDowngrade(metadata.from as never, metadata.to as never));
    }

    const upgrades = logs.filter((log) => log.action === 'CLASSIFICATION_UPGRADED');
    for (const log of upgrades) {
      const metadata = log.metadata as Record<string, unknown>;
      assert.equal(isDowngrade(metadata.from as never, metadata.to as never), false);
    }
  });

  /* ---------------- ขอบเขต HTTP ---------------- */

  test('HTTP routes enforce the same rules and leak no storage location', async () => {
    const impact = await app.inject({
      method: 'GET',
      url: `/api/resources/${rootId}/classification/impact?level=CONFIDENTIAL`,
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(impact.statusCode, 200);
    assert.equal(impact.json().data.publicLinksBlocked, 1);
    assert.equal(impact.json().data.externalGrantsBlocked, 1);

    // ดูผลกระทบแล้วต้องไม่มีอะไรเปลี่ยน
    assert.equal(
      (await prisma.resource.findUniqueOrThrow({ where: { id: rootId } })).classification,
      'PUBLIC',
    );

    /*
     * ยกชั้นผ่านเส้นทาง HTTP ได้ด้วยสิทธิ์แก้ไขปกติ - ไม่ต้องมีสิทธิ์พิเศษ
     * ต้องทำก่อน เพื่อให้ขั้นถัดไปเป็นการ "ลดชั้น" จริง ๆ ไม่ใช่การยกชั้นที่ผ่านอยู่แล้ว
     */
    const raised = await app.inject({
      method: 'PATCH',
      url: `/api/resources/${rootId}/classification`,
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { level: 'CONFIDENTIAL' },
    });
    assert.equal(raised.statusCode, 200);

    // ผู้ดูแลทั่วไปลดชั้นไม่ได้ แม้จะมีสิทธิ์แก้ไขเอกสารเต็มที่และใส่เหตุผลมาครบ
    const denied = await app.inject({
      method: 'PATCH',
      url: `/api/resources/${rootId}/classification`,
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { level: 'INTERNAL', reason: 'ลดชั้นโดยผู้ที่ไม่มีสิทธิ์พิเศษ' },
    });
    assert.equal(denied.statusCode, 403);
    assert.equal(
      (await prisma.resource.findUniqueOrThrow({ where: { id: rootId } })).classification,
      'CONFIDENTIAL',
    );

    const accepted = await app.inject({
      method: 'PATCH',
      url: `/api/resources/${rootId}/classification`,
      headers: { authorization: `Bearer ${declassifierToken}` },
      payload: { level: 'INTERNAL', reason: 'ปรับให้ตรงกับนโยบายการเปิดเผยฉบับใหม่' },
    });
    assert.equal(accepted.statusCode, 200);

    // ไม่มีข้อมูลที่ตั้งไฟล์ ผู้ให้บริการพื้นที่เก็บ หรือโทเคนหลุดออกไปในคำตอบใด
    for (const body of [impact.body, raised.body, accepted.body]) {
      for (const leak of ['storageKey', 'storagePath', 'bucket', 'tokenHash', 'provider', folderShareToken]) {
        assert.equal(body.includes(leak), false, `response leaked ${leak}`);
      }
    }
  });
});

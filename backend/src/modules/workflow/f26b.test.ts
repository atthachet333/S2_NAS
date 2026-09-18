/**
 * F26-B - รากฐานของคำขอความร่วมมือจากภายนอก
 *
 * สิ่งที่ชุดนี้ต้องพิสูจน์ ไม่ใช่ว่า "สร้างคำขอได้" แต่คือ **คำขอไม่เปิดช่องทางใหม่ใด ๆ**
 * ทุกข้อจึงยืนยันว่ากติกาที่มีอยู่ก่อนแล้วยังบังคับใช้ผ่านเส้นทางใหม่นี้เหมือนเดิม
 *
 * การเก็บกวาด: ชุดนี้ไม่สร้างไบต์ของเอกสารเลย (คำขอชี้ไปที่โฟลเดอร์ ไม่ได้อัปโหลดอะไร)
 * จำนวนไฟล์กำพร้าที่เกิดจากชุดนี้จึงต้องเป็นศูนย์โดยโครงสร้าง ไม่ใช่โดยการเก็บกวาดที่ดี
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app.js';
import { prisma } from '../../core/prisma.js';
import { issueSessionForUser, type AuthUser } from '../auth/auth.service.js';
import { createFolder } from '../resources/resource.service.js';
import { effectiveAccessReview } from '../sharing/access-review.service.js';
import { resolvePortalAccess } from '../portal/portal-access.js';
import {
  createWorkflowRequest,
  getWorkflowRequest,
  listAssignedWorkflows,
  listWorkflowRequests,
} from './workflow.service.js';
import { effectiveWorkflowStatus, isWorkflowActive } from './workflow.policy.js';

const prefix = `f26b-${Date.now().toString(36)}`;
const audit = { ipAddress: '127.0.0.1', userAgent: 'f26b-test' };
const SHARE_PERMISSIONS = ['resources:read', 'resources:write', 'resources:share'];
const hour = 3_600_000;

async function failure(run: () => Promise<unknown>): Promise<{ code?: string; statusCode?: number }> {
  try {
    await run();
    throw new Error('expected the call to be rejected, but it succeeded');
  } catch (error) {
    return error as { code?: string; statusCode?: number };
  }
}

describe('F26-B external workflow request foundation', () => {
  let app: FastifyInstance;
  let managerId = '';
  let plainId = '';
  let externalId = '';
  let otherExternalId = '';
  let disabledExternalId = '';
  let internalTargetId = '';
  let folderId = '';
  let secondFolderId = '';
  let blockedFolderId = '';
  let fileId = '';
  let manager: AuthUser;
  let plain: AuthUser;
  let external: AuthUser;
  let managerToken = '';
  let plainToken = '';
  let externalToken = '';
  const createdWorkflowIds: string[] = [];

  before(async () => {
    app = await buildApp();
    await app.ready();

    const rows = await Promise.all([
      prisma.user.create({ data: { email: `${prefix}-manager@example.invalid`, displayName: 'F26B Manager', status: 'ACTIVE' } }),
      prisma.user.create({ data: { email: `${prefix}-plain@example.invalid`, displayName: 'F26B Plain', status: 'ACTIVE' } }),
      prisma.user.create({ data: { email: `${prefix}-ext@example.invalid`, displayName: 'F26B External', type: 'EXTERNAL', status: 'ACTIVE', organizationName: 'F26B Corp' } }),
      prisma.user.create({ data: { email: `${prefix}-ext2@example.invalid`, displayName: 'F26B Other External', type: 'EXTERNAL', status: 'ACTIVE', organizationName: 'F26B Other Corp' } }),
      prisma.user.create({ data: { email: `${prefix}-extoff@example.invalid`, displayName: 'F26B Disabled External', type: 'EXTERNAL', status: 'DISABLED' } }),
      prisma.user.create({ data: { email: `${prefix}-internal-target@example.invalid`, displayName: 'F26B Internal Target', status: 'ACTIVE' } }),
    ]);
    [managerId, plainId, externalId, otherExternalId, disabledExternalId, internalTargetId] = rows.map((row) => row.id);

    const [adminRole, memberRole] = await Promise.all([
      prisma.role.findUniqueOrThrow({ where: { code: 'ADMIN' } }),
      prisma.role.findUniqueOrThrow({ where: { code: 'MEMBER' } }),
    ]);
    await prisma.userRole.createMany({ data: [
      { userId: managerId, roleId: adminRole.id },
      { userId: plainId, roleId: memberRole.id },
    ] });

    manager = {
      id: managerId, email: rows[0].email, displayName: rows[0].displayName,
      type: 'INTERNAL', status: 'ACTIVE', mustChangePassword: false,
      roles: ['ADMIN'], permissions: [...SHARE_PERMISSIONS],
    };
    plain = {
      id: plainId, email: rows[1].email, displayName: rows[1].displayName,
      type: 'INTERNAL', status: 'ACTIVE', mustChangePassword: false,
      roles: ['MEMBER'], permissions: ['resources:read'],
    };
    external = {
      id: externalId, email: rows[2].email, displayName: rows[2].displayName,
      type: 'EXTERNAL', status: 'ACTIVE', mustChangePassword: false,
      roles: [], permissions: [],
    };

    const folder = await createFolder(manager, { name: `${prefix}-งาน`, parentId: null }, audit);
    const second = await createFolder(manager, { name: `${prefix}-งาน2`, parentId: null }, audit);
    const blocked = await createFolder(manager, { name: `${prefix}-ลับ`, parentId: null }, audit);
    folderId = folder.id;
    secondFolderId = second.id;
    blockedFolderId = blocked.id;
    await prisma.resource.update({ where: { id: blockedFolderId }, data: { classification: 'CONFIDENTIAL' } });

    /*
     * ทรัพยากรชนิดไฟล์สำหรับทดสอบว่าคำขอรับเฉพาะโฟลเดอร์
     * สร้างเป็นแถวตรง ๆ ไม่ผ่าน uploadFile เพราะไม่ต้องการไบต์จริง และไม่ต้องการ
     * ไฟล์กำพร้าแม้แต่ไฟล์เดียวจากชุดนี้
     */
    const fileRow = await prisma.resource.create({
      data: {
        type: 'WEB_LINK', name: `${prefix}-ลิงก์`, normalizedName: `${prefix}-ลิงก์`,
        siblingKey: `${prefix}-link-${Date.now()}`, ownerId: managerId, createdById: managerId,
        sourceType: 'MANUAL', externalUrl: 'https://example.invalid/doc',
      },
    });
    fileId = fileRow.id;

    managerToken = (await issueSessionForUser(managerId)).accessToken;
    plainToken = (await issueSessionForUser(plainId)).accessToken;
    externalToken = (await issueSessionForUser(externalId)).accessToken;
  });

  after(async () => {
    await app.close();
    const userIds = [managerId, plainId, externalId, otherExternalId, disabledExternalId, internalTargetId];
    const resourceIds = [folderId, secondFolderId, blockedFolderId, fileId];
    // ไม่มีไบต์ให้ลบ - ชุดนี้ไม่เคยเรียก uploadFile
    await prisma.externalWorkflowRequest.deleteMany({ where: { targetResourceId: { in: resourceIds } } });
    await prisma.activityLog.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.resourceAccess.deleteMany({ where: { resourceId: { in: resourceIds } } });
    await prisma.resource.deleteMany({ where: { id: { in: resourceIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  });

  const baseInput = () => ({
    title: `${prefix} ขอเอกสารประกอบ`,
    instructions: 'กรุณาส่งใบกำกับภาษีของไตรมาสล่าสุด',
    targetResourceId: folderId,
    externalUserId: externalId,
    expiresAt: new Date(Date.now() + 24 * hour),
    dueAt: new Date(Date.now() + 12 * hour),
    allowUpload: true,
    allowDownload: false,
  });

  /* ---------------- §14 สถานะที่คำนวณ ---------------- */

  test('EXPIRED is derived from time and never stored; revocation outranks expiry', () => {
    const past = new Date(Date.now() - hour);
    const future = new Date(Date.now() + hour);

    assert.equal(effectiveWorkflowStatus({ state: 'OPEN', expiresAt: null }), 'OPEN');
    assert.equal(effectiveWorkflowStatus({ state: 'OPEN', expiresAt: future }), 'OPEN');
    assert.equal(effectiveWorkflowStatus({ state: 'OPEN', expiresAt: past }), 'EXPIRED');
    assert.equal(effectiveWorkflowStatus({ state: 'SUBMITTED', expiresAt: past }), 'EXPIRED');

    // ถูกยกเลิกแล้วต้องรายงานว่าถูกยกเลิก ไม่ใช่กลบด้วยคำว่าหมดอายุ
    assert.equal(effectiveWorkflowStatus({ state: 'REVOKED', expiresAt: past }), 'REVOKED');
    assert.equal(effectiveWorkflowStatus({ state: 'REVOKED', expiresAt: null }), 'REVOKED');

    assert.equal(isWorkflowActive({ state: 'OPEN', expiresAt: future }), true);
    assert.equal(isWorkflowActive({ state: 'OPEN', expiresAt: past }), false);
    assert.equal(isWorkflowActive({ state: 'APPROVED', expiresAt: future }), false);
    assert.equal(isWorkflowActive({ state: 'REVOKED', expiresAt: future }), false);

    // ค่าที่เป็นไปไม่ได้: EXPIRED ต้องไม่เคยปรากฏในคอลัมน์สถานะ
    const storedStates = ['OPEN', 'SUBMITTED', 'UNDER_REVIEW', 'REVISION_REQUESTED', 'APPROVED', 'REJECTED', 'REVOKED'];
    assert.equal(storedStates.includes('EXPIRED'), false);
  });

  /* ---------------- §4 §20 การผูกกับ ResourceAccess ---------------- */

  test('creating a request grants portal access without writing or touching any ResourceAccess row', async () => {
    const workflow = await createWorkflowRequest(manager, baseInput(), audit);
    createdWorkflowIds.push(workflow.id);

    assert.equal(workflow.status, 'OPEN');
    assert.equal(workflow.storedState, 'OPEN');
    assert.equal(workflow.permissions.portalRole, 'CONTRIBUTOR');

    /*
     * คำขอเป็นชั้นทับ ไม่ใช่ตัวเขียนแถวสิทธิ์ (แก้ใน F26-B1)
     *
     * เดิมข้อนี้ยืนยันว่ามีแถว ResourceAccess เกิดขึ้น ซึ่งเป็นพฤติกรรมที่เขียนทับสิทธิ์
     * ที่ผู้ดูแลเคยมอบด้วยมือทิ้ง ตอนนี้ยืนยันสิ่งตรงกันข้าม: ต้องไม่มีแถวใดถูกแตะเลย
     * รายละเอียดการรวมสองแหล่งอยู่ใน f26b1.test.ts
     */
    assert.equal(
      await prisma.resourceAccess.count({ where: { resourceId: folderId, userId: externalId } }),
      0,
      'คำขอต้องไม่สร้างหรือเขียนทับแถวสิทธิ์',
    );

    // ด่านพื้นที่ลูกค้าต้องยอมรับจริง โดยสิทธิ์มาจากชั้นทับของคำขอ
    const access = await resolvePortalAccess(externalId, folderId);
    assert.equal(access.role, 'CONTRIBUTOR');
    assert.equal(access.allowDownload, false);

    // §20 รายงานของ F25-C ต้องเห็นและอธิบายได้
    const review = await effectiveAccessReview(folderId);
    const entry = review.entries.find((item) => item.subject.id === externalId)!;
    assert.equal(entry.usable, true);
    assert.equal(entry.status, 'ACTIVE');
    assert.ok(entry.evidence.some((item) => item.source === 'WORKFLOW'), 'ต้องมีหลักฐานที่ระบุว่ามาจากคำขอ');

    // ไม่มีข้อมูลภายในของที่เก็บหลุดออกไปในคำตอบใด
    for (const leak of ['storageKey', 'storagePath', 'bucket', 'tokenHash', 'activeSlot']) {
      assert.equal(JSON.stringify(workflow).includes(leak), false, `workflow DTO leaked ${leak}`);
    }
  });

  /* ---------------- §17 คำขอซ้ำ ---------------- */

  test('a second active request for the same folder and assignee is rejected deterministically', async () => {
    const error = await failure(() => createWorkflowRequest(manager, baseInput(), audit));
    assert.equal(error.code, 'WORKFLOW_ALREADY_ACTIVE');
    assert.equal(error.statusCode, 409);

    // ผู้รับงานคนละคนบนโฟลเดอร์เดิมทำได้ - ข้อจำกัดอยู่ที่ "คู่" ไม่ใช่ที่โฟลเดอร์
    const other = await createWorkflowRequest(
      manager,
      { ...baseInput(), externalUserId: otherExternalId },
      audit,
    );
    createdWorkflowIds.push(other.id);
    assert.equal(other.status, 'OPEN');
  });

  test('an expired request releases its slot so a replacement can be created', async () => {
    const workflow = await createWorkflowRequest(
      manager,
      { ...baseInput(), targetResourceId: secondFolderId, dueAt: null },
      audit,
    );
    createdWorkflowIds.push(workflow.id);

    // ทำให้หมดอายุโดยไม่แตะคอลัมน์สถานะเลย - นั่นคือประเด็นทั้งหมดของการคำนวณ
    await prisma.externalWorkflowRequest.update({
      where: { id: workflow.id },
      data: { expiresAt: new Date(Date.now() - hour) },
    });

    const stale = await prisma.externalWorkflowRequest.findUniqueOrThrow({ where: { id: workflow.id } });
    assert.equal(stale.state, 'OPEN', 'คอลัมน์สถานะต้องไม่ถูกเขียนทับเป็น EXPIRED');
    assert.equal(effectiveWorkflowStatus(stale), 'EXPIRED');

    const replacement = await createWorkflowRequest(
      manager,
      { ...baseInput(), targetResourceId: secondFolderId, dueAt: null },
      audit,
    );
    createdWorkflowIds.push(replacement.id);
    assert.equal(replacement.status, 'OPEN');

    // คำขอเดิมยังอยู่ครบเป็นหลักฐาน แค่ปล่อยช่องกันซ้ำคืนเท่านั้น
    const released = await prisma.externalWorkflowRequest.findUniqueOrThrow({ where: { id: workflow.id } });
    assert.equal(released.activeSlot, null);
    assert.equal(released.state, 'OPEN');
  });

  test('concurrent duplicate creation resolves to exactly one winner', async () => {
    const input = { ...baseInput(), targetResourceId: blockedFolderId };
    // ปลดล็อกชั้นความลับชั่วคราวเพื่อทดสอบการแข่งกัน ไม่ใช่ทดสอบชั้นความลับ
    await prisma.resource.update({ where: { id: blockedFolderId }, data: { classification: 'INTERNAL' } });
    try {
      const results = await Promise.allSettled([
        createWorkflowRequest(manager, input, audit),
        createWorkflowRequest(manager, input, audit),
      ]);
      const ok = results.filter((r) => r.status === 'fulfilled');
      assert.equal(ok.length, 1, 'ต้องสำเร็จเพียงหนึ่ง - อีกอันต้องถูกฐานข้อมูลหรือด่านตรวจปฏิเสธ');
      for (const result of ok) {
        createdWorkflowIds.push((result as PromiseFulfilledResult<{ id: string }>).value.id);
      }
      assert.equal(
        await prisma.externalWorkflowRequest.count({ where: { targetResourceId: blockedFolderId } }),
        1,
      );
    } finally {
      await prisma.externalWorkflowRequest.deleteMany({ where: { targetResourceId: blockedFolderId } });
      await prisma.resourceAccess.deleteMany({ where: { resourceId: blockedFolderId } });
      await prisma.resource.update({ where: { id: blockedFolderId }, data: { classification: 'CONFIDENTIAL' } });
    }
  });

  /* ---------------- §19 เมทริกซ์ความปลอดภัย ---------------- */

  test('every invalid creation is refused with its own reason and writes nothing', async () => {
    const before = await prisma.externalWorkflowRequest.count();
    const grantsBefore = await prisma.resourceAccess.count();

    const cases: Array<[string, Record<string, unknown>, string]> = [
      ['forged target id', { targetResourceId: 'not-a-real-resource' }, 'RESOURCE_NOT_FOUND'],
      ['file target', { targetResourceId: fileId }, 'WORKFLOW_TARGET_NOT_FOLDER'],
      ['confidential target', { targetResourceId: blockedFolderId }, 'WORKFLOW_TARGET_CLASSIFICATION_BLOCKED'],
      ['internal assignee', { externalUserId: internalTargetId }, 'WORKFLOW_ASSIGNEE_NOT_EXTERNAL'],
      ['disabled external assignee', { externalUserId: disabledExternalId }, 'WORKFLOW_ASSIGNEE_INACTIVE'],
      ['forged assignee id', { externalUserId: 'not-a-real-user' }, 'WORKFLOW_ASSIGNEE_INACTIVE'],
      ['expiry already past', { expiresAt: new Date(Date.now() - hour) }, 'SHARE_INVALID_EXPIRY'],
      ['due after expiry', { dueAt: new Date(Date.now() + 48 * hour) }, 'WORKFLOW_DUE_AFTER_EXPIRY'],
      ['due already past', { dueAt: new Date(Date.now() - hour) }, 'WORKFLOW_INVALID_DUE_DATE'],
      ['blank title', { title: '   ' }, 'WORKFLOW_TITLE_REQUIRED'],
    ];

    for (const [label, override, expected] of cases) {
      const error = await failure(() =>
        createWorkflowRequest(manager, { ...baseInput(), targetResourceId: secondFolderId, ...override } as never, audit),
      );
      assert.equal(error.code, expected, `${label}: ได้ ${error.code} แทนที่จะเป็น ${expected}`);
    }

    // archived target - แยกออกมาเพราะต้องเปลี่ยนสถานะทรัพยากรชั่วคราว
    await prisma.resource.update({ where: { id: secondFolderId }, data: { lifecycleState: 'ARCHIVED' } });
    try {
      const error = await failure(() =>
        createWorkflowRequest(manager, { ...baseInput(), targetResourceId: secondFolderId, externalUserId: otherExternalId }, audit),
      );
      assert.equal(error.code, 'WORKFLOW_TARGET_UNAVAILABLE');
    } finally {
      await prisma.resource.update({ where: { id: secondFolderId }, data: { lifecycleState: 'ACTIVE' } });
    }

    // §18 ไม่มีอะไรถูกเขียนเลยจากคำขอที่ล้มทั้งหมดข้างบน
    assert.equal(await prisma.externalWorkflowRequest.count(), before, 'ไม่ควรมีคำขอเกิดใหม่');
    assert.equal(await prisma.resourceAccess.count(), grantsBefore, 'ไม่ควรมีสิทธิ์กำพร้าเกิดขึ้น');
  });

  test('an internal user who cannot share the folder cannot route around it with a workflow', async () => {
    const error = await failure(() =>
      createWorkflowRequest(plain, { ...baseInput(), targetResourceId: secondFolderId }, audit),
    );
    assert.ok(
      error.code === 'SHARE_DENIED' || error.code === 'RESOURCE_NOT_FOUND',
      `ต้องถูกปฏิเสธที่ด่านการแชร์ แต่ได้ ${error.code}`,
    );
  });

  /* ---------------- §12 §13 เส้นทาง HTTP ---------------- */

  test('management routes are internal-only and the assignee route is scoped to the caller', async () => {
    const denied = await app.inject({
      method: 'GET', url: '/api/external-workflows',
      headers: { authorization: `Bearer ${externalToken}` },
    });
    assert.equal(denied.statusCode, 403, 'บัญชีภายนอกต้องไม่เห็นรายการของทั้งระบบ');

    const plainDenied = await app.inject({
      method: 'GET', url: '/api/external-workflows',
      headers: { authorization: `Bearer ${plainToken}` },
    });
    assert.equal(plainDenied.statusCode, 403, 'ผู้ใช้ภายในที่ไม่มีสิทธิ์แชร์ต้องไม่เห็น');

    const listed = await app.inject({
      method: 'GET', url: `/api/external-workflows?targetResourceId=${folderId}`,
      headers: { authorization: `Bearer ${managerToken}` },
    });
    assert.equal(listed.statusCode, 200);
    assert.ok(listed.json().data.length >= 1);
    assert.equal(listed.body.includes('activeSlot'), false);
    assert.equal(listed.body.includes('storageKey'), false);

    // ผู้รับงานเห็นเฉพาะของตัวเอง และเส้นทางไม่รับรหัสผู้ใช้จากภายนอกเลย
    const mine = await app.inject({
      method: 'GET', url: '/api/portal/workflows',
      headers: { authorization: `Bearer ${externalToken}` },
    });
    assert.equal(mine.statusCode, 200);
    const items = mine.json().data as Array<{ id: string }>;
    const rows = await prisma.externalWorkflowRequest.findMany({ where: { id: { in: items.map((i) => i.id) } } });
    assert.ok(rows.every((row) => row.externalUserId === externalId), 'ต้องไม่มีคำขอของคนอื่นปน');

    const internalOnPortalRoute = await app.inject({
      method: 'GET', url: '/api/portal/workflows',
      headers: { authorization: `Bearer ${managerToken}` },
    });
    assert.equal(internalOnPortalRoute.statusCode, 403);
  });

  test('the assignee view hides requests whose folder stopped being externally exposable', async () => {
    const beforeCount = (await listAssignedWorkflows(external)).length;
    assert.ok(beforeCount >= 1);

    await prisma.resource.update({ where: { id: folderId }, data: { classification: 'CONFIDENTIAL' } });
    try {
      const hidden = await listAssignedWorkflows(external);
      assert.equal(hidden.some((item) => item.target.id === folderId), false);
    } finally {
      await prisma.resource.update({ where: { id: folderId }, data: { classification: 'INTERNAL' } });
    }
  });

  /* ---------------- §15 การตรวจสอบย้อนหลัง ---------------- */

  test('creation is auditable without leaking the instructions or any secret', async () => {
    const logs = await prisma.activityLog.findMany({
      where: { action: 'EXTERNAL_WORKFLOW_CREATED', userId: managerId },
      orderBy: { createdAt: 'asc' },
    });
    assert.ok(logs.length >= 1);

    const log = logs[0]!;
    const metadata = log.metadata as Record<string, unknown>;
    assert.equal(log.resourceId, folderId);
    assert.ok(typeof metadata.workflowId === 'string');
    assert.equal(metadata.assigneeUserId, externalId);
    assert.equal(metadata.accessLevel, 'EDITOR');
    assert.equal(typeof metadata.allowUpload, 'boolean');
    assert.ok(log.createdAt instanceof Date);

    // คำชี้แจงเป็นข้อความอิสระที่อาจมีรายละเอียดของงาน จึงไม่ถูกทำสำเนาลงบันทึก
    assert.equal(JSON.stringify(metadata).includes('ใบกำกับภาษี'), false);
  });

  test('list and detail reads agree, and detail rejects a forged id', async () => {
    const all = await listWorkflowRequests(manager, { targetResourceId: folderId });
    assert.ok(all.length >= 1);
    const detail = await getWorkflowRequest(manager, all[0]!.id);
    assert.equal(detail.id, all[0]!.id);
    assert.equal(detail.status, all[0]!.status);

    const error = await failure(() => getWorkflowRequest(manager, 'not-a-real-workflow'));
    assert.equal(error.code, 'WORKFLOW_NOT_FOUND');

    // การกรองสถานะต้องคำนวณ ไม่ใช่กรองจากคอลัมน์
    const expired = await listWorkflowRequests(manager, { status: 'EXPIRED' });
    assert.ok(expired.every((item) => item.status === 'EXPIRED'));
  });
});

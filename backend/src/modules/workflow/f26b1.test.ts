/**
 * F26-B1 - คำขอความร่วมมือต้องไม่ทำลายสิทธิ์ที่มีอยู่เดิม
 *
 * ข้อบกพร่องที่ชุดนี้ล็อกไว้: การสร้างคำขอเคย upsert ทับแถว ResourceAccess ทำให้ระดับสิทธิ์
 * สิทธิ์ดาวน์โหลด และวันหมดอายุที่ผู้ดูแลตั้งไว้ด้วยมือหายไปโดยไม่มีใครรู้ และกู้กลับไม่ได้
 *
 * กติกาสองข้อที่ต้องจริงพร้อมกันเสมอ:
 *   1. เริ่ม/จบคำขอ ต้องไม่ลดทอนสิทธิ์ที่มีอยู่โดยอิสระจากคำขอนั้น
 *   2. จบคำขอแล้ว ต้องไม่เหลือสิทธิ์ที่มีอยู่เพราะคำขอนั้นเท่านั้น
 *
 * ชุดนี้ไม่สร้างไบต์ของเอกสารเลย จำนวนไฟล์กำพร้าที่เกิดจากมันจึงเป็นศูนย์โดยโครงสร้าง
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { prisma } from '../../core/prisma.js';
import { createFolder } from '../resources/resource.service.js';
import { effectiveAccessReview } from '../sharing/access-review.service.js';
import { activeGrantMap, resolvePortalAccess } from '../portal/portal-access.js';
import { grantAccess } from '../workspace/sharing.service.js';
import type { AuthUser } from '../auth/auth.service.js';
import { createWorkflowRequest } from './workflow.service.js';
import { mergeGrants } from './workflow-access.js';

const prefix = `f26b1-${Date.now().toString(36)}`;
const audit = { ipAddress: '127.0.0.1', userAgent: 'f26b1-test' };
const hour = 3_600_000;

async function denied(run: () => Promise<unknown>): Promise<boolean> {
  try { await run(); return false; } catch { return true; }
}

describe('F26-B1 workflow grants never destroy manual access', () => {
  let adminId = '';
  let externalId = '';
  let workflowOnlyId = '';
  let folderId = '';
  let altFolderId = '';
  let admin: AuthUser;
  const workflowIds: string[] = [];

  before(async () => {
    const [adminRow, extRow, onlyRow] = await Promise.all([
      prisma.user.create({ data: { email: `${prefix}-admin@example.invalid`, displayName: 'F26B1 Admin', status: 'ACTIVE' } }),
      prisma.user.create({ data: { email: `${prefix}-ext@example.invalid`, displayName: 'F26B1 External', type: 'EXTERNAL', status: 'ACTIVE', organizationName: 'F26B1 Corp' } }),
      prisma.user.create({ data: { email: `${prefix}-only@example.invalid`, displayName: 'F26B1 Workflow Only', type: 'EXTERNAL', status: 'ACTIVE', organizationName: 'F26B1 Corp' } }),
    ]);
    adminId = adminRow.id;
    externalId = extRow.id;
    workflowOnlyId = onlyRow.id;

    const adminRole = await prisma.role.findUniqueOrThrow({ where: { code: 'ADMIN' } });
    await prisma.userRole.create({ data: { userId: adminId, roleId: adminRole.id } });

    admin = {
      id: adminId, email: adminRow.email, displayName: adminRow.displayName,
      type: 'INTERNAL', status: 'ACTIVE', mustChangePassword: false,
      roles: ['ADMIN'], permissions: ['resources:read', 'resources:write', 'resources:share'],
    };

    const folder = await createFolder(admin, { name: `${prefix}-งาน`, parentId: null }, audit);
    const alt = await createFolder(admin, { name: `${prefix}-งาน2`, parentId: null }, audit);
    folderId = folder.id;
    altFolderId = alt.id;
  });

  after(async () => {
    const ids = [adminId, externalId, workflowOnlyId];
    const resourceIds = [folderId, altFolderId];
    await prisma.externalWorkflowRequest.deleteMany({ where: { targetResourceId: { in: resourceIds } } });
    await prisma.activityLog.deleteMany({ where: { userId: { in: ids } } });
    await prisma.resourceAccess.deleteMany({ where: { resourceId: { in: resourceIds } } });
    await prisma.resource.deleteMany({ where: { id: { in: resourceIds } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  });

  const clearWorkflows = () => prisma.externalWorkflowRequest.deleteMany({ where: { targetResourceId: { in: [folderId, altFolderId] } } });
  const clearGrants = () => prisma.resourceAccess.deleteMany({ where: { resourceId: { in: [folderId, altFolderId] } } });

  const startWorkflow = async (overrides: Record<string, unknown> = {}) => {
    const workflow = await createWorkflowRequest(admin, {
      title: `${prefix} ขอเอกสาร`,
      targetResourceId: folderId,
      externalUserId: externalId,
      expiresAt: new Date(Date.now() + 7 * 24 * hour),
      allowUpload: true,
      allowDownload: false,
      ...overrides,
    } as never, audit);
    workflowIds.push(workflow.id);
    return workflow;
  };

  const manualGrant = (level: 'VIEWER' | 'EDITOR', allowDownload: boolean, expiresAt: Date | null = null) =>
    grantAccess(folderId, { userId: externalId, accessLevel: level, allowDownload, expiresAt }, admin, audit);

  /* ---------------- §5 ความหมายของการรวม ---------------- */

  test('merge is permissive by design: a workflow may add capability, never subtract it', () => {
    const manual = { accessLevel: 'VIEWER' as const, allowDownload: true, expiresAt: null };
    const workflow = [{
      workflowId: 'w1', resourceId: 'r', userId: 'u',
      accessLevel: 'EDITOR' as const, allowDownload: false, expiresAt: new Date(Date.now() + hour),
    }];

    const merged = mergeGrants(manual, workflow)!;
    // ระดับสูงขึ้นจากคำขอ แต่สิทธิ์ดาวน์โหลดเดิมต้องไม่ถูกคำขอถอนไป
    assert.equal(merged.accessLevel, 'EDITOR');
    assert.equal(merged.allowDownload, true, 'คำขอที่ไม่ต้องการดาวน์โหลด ต้องไม่ถอนสิทธิ์ดาวน์โหลดเดิม');
    assert.equal(merged.expiresAt, null, '"ไม่หมดอายุ" ของสิทธิ์เดิมชนะวันหมดอายุของคำขอ');
    assert.equal(merged.fromManual, true);
    assert.equal(merged.fromWorkflow, true);

    // แหล่งเดียวก็ต้องตอบตรงตามแหล่งนั้น
    assert.equal(mergeGrants(manual, [])!.accessLevel, 'VIEWER');
    assert.equal(mergeGrants(null, workflow)!.accessLevel, 'EDITOR');
    assert.equal(mergeGrants(null, workflow)!.allowDownload, false);
    assert.equal(mergeGrants(null, []), null, 'ไม่มีแหล่งเลย = ไม่มีสิทธิ์');

    // วันหมดอายุที่ไกลกว่าชนะ เมื่อทุกแหล่งมีวันหมดอายุ
    const soon = new Date(Date.now() + hour);
    const later = new Date(Date.now() + 5 * hour);
    const both = mergeGrants(
      { accessLevel: 'VIEWER', allowDownload: false, expiresAt: soon },
      [{ workflowId: 'w', resourceId: 'r', userId: 'u', accessLevel: 'VIEWER', allowDownload: false, expiresAt: later }],
    )!;
    assert.equal(both.expiresAt?.getTime(), later.getTime());
  });

  /* ---------------- §3 §12.1-5 สถานการณ์หลัก ---------------- */

  test('a workflow with no prior manual grant creates no ResourceAccess row at all', async () => {
    await clearGrants();
    await clearWorkflows();

    await startWorkflow();
    assert.equal(
      await prisma.resourceAccess.count({ where: { resourceId: folderId, userId: externalId } }),
      0,
      'คำขอต้องไม่สร้างแถวสิทธิ์',
    );

    // แต่ต้องเข้าถึงได้จริง - สิทธิ์มาจากชั้นทับ
    const access = await resolvePortalAccess(externalId, folderId);
    assert.equal(access.role, 'CONTRIBUTOR');
    assert.equal(access.allowDownload, false);
  });

  test('the required §3 scenario: manual VIEWER+download+no-expiry survives untouched', async () => {
    await clearGrants();
    await clearWorkflows();

    await manualGrant('VIEWER', true, null);
    const before = await prisma.resourceAccess.findUniqueOrThrow({
      where: { resourceId_userId: { resourceId: folderId, userId: externalId } },
    });

    await startWorkflow(); // EDITOR/CONTRIBUTOR, allowDownload=false, expires 7 days

    // แถวสิทธิ์เดิมต้องไม่เปลี่ยนแม้แต่ฟิลด์เดียว
    const during = await prisma.resourceAccess.findUniqueOrThrow({
      where: { resourceId_userId: { resourceId: folderId, userId: externalId } },
    });
    assert.equal(during.accessLevel, 'VIEWER');
    assert.equal(during.allowDownload, true);
    assert.equal(during.expiresAt, null);
    assert.equal(during.id, before.id, 'ต้องเป็นแถวเดิม ไม่ใช่แถวที่ถูกสร้างใหม่');

    // ผลรวมระหว่างคำขอเปิดอยู่
    const active = await resolvePortalAccess(externalId, folderId);
    assert.equal(active.role, 'CONTRIBUTOR', 'คำขอยกระดับให้อัปโหลดได้');
    assert.equal(active.allowDownload, true, 'สิทธิ์ดาวน์โหลดเดิมต้องยังอยู่');

    // จบคำขอ - ไม่ต้องกู้คืนอะไร เพราะไม่เคยมีอะไรถูกเขียนทับ
    await clearWorkflows();
    const after = await prisma.resourceAccess.findUniqueOrThrow({
      where: { resourceId_userId: { resourceId: folderId, userId: externalId } },
    });
    assert.equal(after.accessLevel, 'VIEWER');
    assert.equal(after.allowDownload, true);
    assert.equal(after.expiresAt, null);

    const restored = await resolvePortalAccess(externalId, folderId);
    assert.equal(restored.role, 'VIEWER', 'สิทธิ์ที่มาจากคำขอต้องหายไป');
    assert.equal(restored.allowDownload, true, 'สิทธิ์เดิมต้องยังอยู่');
  });

  test('an existing EDITOR manual grant is not downgraded by a view-only workflow', async () => {
    await clearGrants();
    await clearWorkflows();

    await manualGrant('EDITOR', true, null);
    await startWorkflow({ allowUpload: false, allowDownload: false });

    const row = await prisma.resourceAccess.findUniqueOrThrow({
      where: { resourceId_userId: { resourceId: folderId, userId: externalId } },
    });
    assert.equal(row.accessLevel, 'EDITOR');
    assert.equal(row.allowDownload, true);

    const access = await resolvePortalAccess(externalId, folderId);
    assert.equal(access.role, 'CONTRIBUTOR', 'EDITOR เดิมยังทำให้อัปโหลดได้');
    assert.equal(access.allowDownload, true);
  });

  test('expiries are independent: an expired manual grant leaves only the workflow, and vice versa', async () => {
    await clearGrants();
    await clearWorkflows();

    // สิทธิ์เดิมหมดอายุแล้ว + คำขอยังเปิดอยู่ => เหลือเฉพาะส่วนของคำขอ
    await prisma.resourceAccess.create({
      data: {
        resourceId: folderId, userId: externalId, accessLevel: 'VIEWER',
        allowDownload: true, expiresAt: new Date(Date.now() - hour), createdById: adminId,
      },
    });
    await startWorkflow({ allowUpload: true, allowDownload: false });

    const onlyWorkflow = await resolvePortalAccess(externalId, folderId);
    assert.equal(onlyWorkflow.role, 'CONTRIBUTOR');
    assert.equal(onlyWorkflow.allowDownload, false, 'สิทธิ์ดาวน์โหลดที่หมดอายุแล้วต้องไม่ถูกนับ');

    // คำขอหมดอายุ + สิทธิ์เดิมยังอยู่ => เหลือเฉพาะสิทธิ์เดิม
    await clearGrants();
    await manualGrant('VIEWER', true, null);
    await prisma.externalWorkflowRequest.updateMany({
      where: { targetResourceId: folderId },
      data: { expiresAt: new Date(Date.now() - hour) },
    });

    const onlyManual = await resolvePortalAccess(externalId, folderId);
    assert.equal(onlyManual.role, 'VIEWER');
    assert.equal(onlyManual.allowDownload, true);
  });

  /* ---------------- §4 การแก้สิทธิ์ระหว่างคำขอยังเปิดอยู่ ---------------- */

  test('an admin change made during an active workflow is never rolled back when it ends', async () => {
    await clearGrants();
    await clearWorkflows();

    await manualGrant('VIEWER', false, null);
    await startWorkflow();

    // ผู้ดูแลตัดสินใจใหม่ระหว่างที่คำขอยังเปิดอยู่
    await manualGrant('EDITOR', true, null);

    const duringWorkflow = await prisma.resourceAccess.findUniqueOrThrow({
      where: { resourceId_userId: { resourceId: folderId, userId: externalId } },
    });
    assert.equal(duringWorkflow.accessLevel, 'EDITOR');
    assert.equal(duringWorkflow.allowDownload, true);

    await clearWorkflows();

    /*
     * นี่คือข้อที่วิธี "ถ่ายรูปค่าเดิมแล้วคืนทีหลัง" จะพัง - มันจะคืนค่ากลับเป็น
     * VIEWER/ไม่ให้ดาวน์โหลด ซึ่งย้อนการตัดสินใจล่าสุดของผู้ดูแลทิ้ง
     */
    const afterWorkflow = await prisma.resourceAccess.findUniqueOrThrow({
      where: { resourceId_userId: { resourceId: folderId, userId: externalId } },
    });
    assert.equal(afterWorkflow.accessLevel, 'EDITOR', 'ต้องเป็นค่าที่ผู้ดูแลตั้งล่าสุด');
    assert.equal(afterWorkflow.allowDownload, true);
  });

  /* ---------------- §12.8 ไม่มีสิทธิ์ตกค้าง ---------------- */

  test('when only the workflow granted access, ending it leaves nothing behind', async () => {
    await clearGrants();
    await clearWorkflows();

    const workflow = await createWorkflowRequest(admin, {
      title: `${prefix} เฉพาะคำขอ`,
      targetResourceId: folderId,
      externalUserId: workflowOnlyId,
      expiresAt: new Date(Date.now() + hour),
      allowUpload: true,
      allowDownload: true,
    } as never, audit);

    assert.equal(await denied(() => resolvePortalAccess(workflowOnlyId, folderId)), false);

    // จบด้วยการยกเลิก - ไม่ลบแถวคำขอ ซึ่งเป็นแบบที่ F26-G จะใช้
    await prisma.externalWorkflowRequest.update({ where: { id: workflow.id }, data: { state: 'REVOKED' } });

    assert.equal(await denied(() => resolvePortalAccess(workflowOnlyId, folderId)), true, 'ต้องไม่เหลือสิทธิ์');
    assert.equal((await activeGrantMap(workflowOnlyId, new Date())).size, 0);
    assert.equal(
      await prisma.resourceAccess.count({ where: { resourceId: folderId, userId: workflowOnlyId } }),
      0,
      'ไม่ควรมีแถวสิทธิ์ให้ต้องตามเก็บกวาด',
    );
    // แถวคำขอยังอยู่เป็นหลักฐาน
    assert.ok(await prisma.externalWorkflowRequest.findUnique({ where: { id: workflow.id } }));
  });

  test('every terminal state and expiry stops workflow-derived access', async () => {
    await clearGrants();
    await clearWorkflows();
    const workflow = await createWorkflowRequest(admin, {
      title: `${prefix} สถานะ`, targetResourceId: altFolderId, externalUserId: workflowOnlyId,
      expiresAt: new Date(Date.now() + hour), allowUpload: true, allowDownload: false,
    } as never, audit);

    for (const state of ['APPROVED', 'REJECTED', 'REVOKED'] as const) {
      await prisma.externalWorkflowRequest.update({ where: { id: workflow.id }, data: { state } });
      assert.equal(
        await denied(() => resolvePortalAccess(workflowOnlyId, altFolderId)), true,
        `${state} ต้องหยุดสิทธิ์`,
      );
    }
    for (const state of ['OPEN', 'SUBMITTED', 'UNDER_REVIEW', 'REVISION_REQUESTED'] as const) {
      await prisma.externalWorkflowRequest.update({ where: { id: workflow.id }, data: { state } });
      assert.equal(
        await denied(() => resolvePortalAccess(workflowOnlyId, altFolderId)), false,
        `${state} ต้องยังให้สิทธิ์`,
      );
    }
    // หมดอายุโดยไม่แตะสถานะ
    await prisma.externalWorkflowRequest.update({
      where: { id: workflow.id }, data: { state: 'OPEN', expiresAt: new Date(Date.now() - hour) },
    });
    assert.equal(await denied(() => resolvePortalAccess(workflowOnlyId, altFolderId)), true, 'หมดอายุต้องหยุดสิทธิ์');
    await prisma.externalWorkflowRequest.deleteMany({ where: { targetResourceId: altFolderId } });
  });

  /* ---------------- §7 หลักฐานในรายงาน ---------------- */

  test('the review shows manual and workflow provenance as separate evidence', async () => {
    await clearGrants();
    await clearWorkflows();

    await manualGrant('VIEWER', true, null);
    await startWorkflow();

    const review = await effectiveAccessReview(folderId);
    const entry = review.entries.find((item) => item.subject.id === externalId)!;
    assert.equal(entry.usable, true);
    assert.equal(entry.effectiveRole, 'CONTRIBUTOR', 'ผลลัพธ์ต้องสะท้อนการรวมสองแหล่ง');
    assert.equal(entry.allowDownload, true);

    const sources = entry.evidence.map((item) => item.source);
    assert.ok(sources.includes('DIRECT'), 'ต้องเห็นสิทธิ์ที่มอบด้วยมือ');
    assert.ok(sources.includes('WORKFLOW'), 'ต้องเห็นสิทธิ์ที่มาจากคำขอ');

    const manual = entry.evidence.find((item) => item.source === 'DIRECT')!;
    const workflow = entry.evidence.find((item) => item.source === 'WORKFLOW')!;
    assert.equal(manual.role, 'VIEWER');
    assert.equal(manual.allowDownload, true);
    assert.equal(manual.expiresAt, null);
    assert.equal(workflow.role, 'CONTRIBUTOR');
    assert.ok(workflow.expiresAt, 'หลักฐานของคำขอต้องบอกวันสิ้นสุดของมันเอง');
  });

  test('a workflow-only assignee is never invisible to the access review', async () => {
    await clearGrants();
    await clearWorkflows();

    await createWorkflowRequest(admin, {
      title: `${prefix} มองเห็น`, targetResourceId: folderId, externalUserId: workflowOnlyId,
      expiresAt: new Date(Date.now() + hour), allowUpload: true, allowDownload: false,
    } as never, audit);

    const review = await effectiveAccessReview(folderId);
    const entry = review.entries.find((item) => item.subject.id === workflowOnlyId);
    assert.ok(entry, 'ผู้ที่ได้สิทธิ์จากคำขออย่างเดียวต้องปรากฏในรายงาน');
    assert.equal(entry.usable, true);
    assert.equal(entry.source, 'WORKFLOW');
    assert.deepEqual(entry.evidence.map((item) => item.source), ['WORKFLOW']);
  });

  /* ---------------- §6 เพดานยังอยู่เหนือทุกอย่าง ---------------- */

  test('classification and lifecycle still outrank every grant source', async () => {
    await clearGrants();
    await clearWorkflows();

    await manualGrant('EDITOR', true, null);
    await startWorkflow();
    assert.equal(await denied(() => resolvePortalAccess(externalId, folderId)), false);

    for (const level of ['CONFIDENTIAL', 'RESTRICTED'] as const) {
      if (level === 'RESTRICTED') {
        await prisma.resource.update({ where: { id: folderId }, data: { visibility: 'RESTRICTED' } });
      }
      await prisma.resource.update({ where: { id: folderId }, data: { classification: level } });
      assert.equal(
        await denied(() => resolvePortalAccess(externalId, folderId)), true,
        `${level} ต้องปิดแม้จะมีสิทธิ์ทั้งสองแหล่ง`,
      );
      const review = await effectiveAccessReview(folderId);
      const entry = review.entries.find((item) => item.subject.id === externalId)!;
      assert.equal(entry.usable, false);
      assert.equal(entry.status, 'CLASSIFICATION_RESTRICTED');
      assert.ok(entry.evidence.length >= 2, 'หลักฐานทั้งสองที่มาต้องยังอยู่ครบ');
    }
    await prisma.resource.update({
      where: { id: folderId },
      data: { classification: 'INTERNAL', visibility: 'ORGANIZATION' },
    });

    await prisma.resource.update({ where: { id: folderId }, data: { lifecycleState: 'ARCHIVED' } });
    assert.equal(await denied(() => resolvePortalAccess(externalId, folderId)), true, 'คลังต้องปิดเช่นกัน');
    await prisma.resource.update({ where: { id: folderId }, data: { lifecycleState: 'ACTIVE' } });
  });

  /* ---------------- §10 การแข่งกัน ---------------- */

  test('a manual grant change racing a workflow creation loses nothing', async () => {
    await clearGrants();
    await clearWorkflows();
    await manualGrant('VIEWER', false, null);

    /*
     * สองฝั่งเขียนคนละตาราง จึงไม่มีการเขียนทับกันได้เลยโดยโครงสร้าง
     * เทสต์นี้ยืนยันคุณสมบัตินั้น ไม่ได้หวังว่าจังหวะจะดีพอ
     */
    const [, workflow] = await Promise.all([
      manualGrant('EDITOR', true, null),
      startWorkflow(),
    ]);

    const row = await prisma.resourceAccess.findUniqueOrThrow({
      where: { resourceId_userId: { resourceId: folderId, userId: externalId } },
    });
    assert.equal(row.accessLevel, 'EDITOR', 'การตัดสินใจของผู้ดูแลต้องไม่หาย');
    assert.equal(row.allowDownload, true);
    assert.ok(workflow.id);
    assert.equal(await prisma.externalWorkflowRequest.count({ where: { targetResourceId: folderId } }), 1);
  });

  test('two concurrent workflow creations still resolve to exactly one, and touch no grant', async () => {
    await clearGrants();
    await clearWorkflows();
    await manualGrant('VIEWER', true, null);

    const results = await Promise.allSettled([startWorkflow(), startWorkflow()]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal(await prisma.externalWorkflowRequest.count({ where: { targetResourceId: folderId } }), 1);

    const row = await prisma.resourceAccess.findUniqueOrThrow({
      where: { resourceId_userId: { resourceId: folderId, userId: externalId } },
    });
    assert.equal(row.accessLevel, 'VIEWER', 'สิทธิ์เดิมต้องไม่ถูกแตะแม้ในเส้นทางที่แข่งกัน');
    assert.equal(row.allowDownload, true);
  });

  test('a manual change racing a workflow termination keeps the newer manual decision', async () => {
    await clearGrants();
    await clearWorkflows();
    await manualGrant('VIEWER', false, null);
    const workflow = await startWorkflow();

    await Promise.all([
      manualGrant('EDITOR', true, null),
      prisma.externalWorkflowRequest.update({ where: { id: workflow.id }, data: { state: 'REVOKED' } }),
    ]);

    const row = await prisma.resourceAccess.findUniqueOrThrow({
      where: { resourceId_userId: { resourceId: folderId, userId: externalId } },
    });
    assert.equal(row.accessLevel, 'EDITOR');
    assert.equal(row.allowDownload, true);

    const access = await resolvePortalAccess(externalId, folderId);
    assert.equal(access.role, 'CONTRIBUTOR', 'มาจากสิทธิ์เดิมที่เพิ่งถูกยกระดับ ไม่ใช่จากคำขอที่ถูกยกเลิก');
  });
});

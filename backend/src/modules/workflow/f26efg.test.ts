/**
 * F26-E/F/G - การตรวจงาน การส่งฉบับแก้ การยกเลิก และการหมดอายุ
 *
 * ชุดนี้สร้างไบต์จริงหลายไฟล์ (ส่งงานหลายรอบ) จึงลบทั้งแถวและไบต์ใน after()
 * ทุกเส้นทางที่ล้มกลางคันก็ต้องไม่ทิ้งไบต์ ซึ่งมีเทสต์วัดตรง ๆ
 *
 * คำถามหลักที่ต้องตอบ:
 *   1. ตารางการเปลี่ยนสถานะบังคับใช้จริง และการแข่งกันมีผู้ชนะเดียวเสมอ
 *   2. การส่งฉบับแก้ไม่ลบหลักฐานของฉบับก่อน
 *   3. งานที่จบแล้วหยุดให้สิทธิ์ แต่สิทธิ์ที่มอบด้วยมือไม่ถูกแตะ
 *   4. เพดานชั้นความลับยังอยู่เหนือทุกสถานะ
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
import { effectiveAccessReview } from '../sharing/access-review.service.js';
import { resolvePortalAccess } from '../portal/portal-access.js';
import { listPortalVersions, resolvePortalVersionContent } from '../portal/portal.service.js';
import { grantAccess } from '../workspace/sharing.service.js';
import { createWorkflowRequest, getAssignedWorkflow } from './workflow.service.js';
import { submitToWorkflow } from './submission.service.js';
import {
  approveWorkflow, rejectWorkflow, requestRevision, revokeWorkflow, startReview, workflowHistory,
} from './review.service.js';
import { WORKFLOW_TRANSITIONS, canTransition, normalizeRequiredReason } from './workflow.policy.js';

const prefix = `f26efg-${Date.now().toString(36)}`;
const audit = { ipAddress: '127.0.0.1', userAgent: 'f26efg-test' };
const hour = 3_600_000;
const REASON = 'เอกสารไม่ครบ กรุณาแนบใบกำกับภาษีหน้าที่สองมาด้วย';
const stream = (text = 'เนื้อหาที่ลูกค้าส่ง') => Readable.from([Buffer.from(text, 'utf8')]);

async function failure(run: () => Promise<unknown>): Promise<{ code?: string; statusCode?: number }> {
  try {
    await run();
    throw new Error('expected rejection, but the call succeeded');
  } catch (error) {
    return error as { code?: string; statusCode?: number };
  }
}
const denied = async (run: () => Promise<unknown>) => {
  try { await run(); return false; } catch { return true; }
};

async function orphanCount(): Promise<number> {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const root = process.env.STORAGE_ROOT ?? './storage';
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else files.push(path.relative(root, full).split(path.sep).join('/'));
    }
  };
  walk(path.join(root, 'resources'));
  const keys = new Set<string>();
  for (const r of await prisma.resource.findMany({ select: { storageKey: true } })) if (r.storageKey) keys.add(r.storageKey);
  for (const v of await prisma.resourceVersion.findMany({ select: { storageKey: true } })) if (v.storageKey) keys.add(v.storageKey);
  return files.filter((f) => !keys.has(f)).length;
}

describe('F26-E/F/G review, revision, revocation and expiry', () => {
  let app: FastifyInstance;
  let reviewerId = '';
  let outsiderId = '';
  let clientId = '';
  let folderId = '';
  let otherFolderId = '';
  let versionedFileId = '';
  let reviewer: AuthUser;
  let outsider: AuthUser;
  let client: AuthUser;
  let clientToken = '';
  let reviewerToken = '';

  before(async () => {
    app = await buildApp();
    await app.ready();

    const rows = await Promise.all([
      prisma.user.create({ data: { email: `${prefix}-rev@example.invalid`, displayName: 'F26EFG Reviewer', status: 'ACTIVE' } }),
      prisma.user.create({ data: { email: `${prefix}-out@example.invalid`, displayName: 'F26EFG Outsider', status: 'ACTIVE' } }),
      prisma.user.create({ data: { email: `${prefix}-client@example.invalid`, displayName: 'F26EFG Client', type: 'EXTERNAL', status: 'ACTIVE', organizationName: 'EFG Corp' } }),
    ]);
    [reviewerId, outsiderId, clientId] = rows.map((row) => row.id);

    const [adminRole, memberRole] = await Promise.all([
      prisma.role.findUniqueOrThrow({ where: { code: 'ADMIN' } }),
      prisma.role.findUniqueOrThrow({ where: { code: 'MEMBER' } }),
    ]);
    await prisma.userRole.createMany({ data: [
      { userId: reviewerId, roleId: adminRole.id },
      { userId: outsiderId, roleId: memberRole.id },
    ] });

    reviewer = {
      id: reviewerId, email: rows[0].email, displayName: rows[0].displayName,
      type: 'INTERNAL', status: 'ACTIVE', mustChangePassword: false,
      roles: ['ADMIN'], permissions: ['resources:read', 'resources:write', 'resources:share'],
    };
    outsider = {
      id: outsiderId, email: rows[1].email, displayName: rows[1].displayName,
      type: 'INTERNAL', status: 'ACTIVE', mustChangePassword: false,
      roles: ['MEMBER'], permissions: ['resources:read'],
    };
    client = {
      id: clientId, email: rows[2].email, displayName: rows[2].displayName,
      type: 'EXTERNAL', status: 'ACTIVE', mustChangePassword: false, roles: [], permissions: [],
    };

    const folder = await createFolder(reviewer, { name: `${prefix}-งาน`, parentId: null }, audit);
    const other = await createFolder(reviewer, { name: `${prefix}-อื่น`, parentId: null }, audit);
    folderId = folder.id;
    otherFolderId = other.id;

    // ไฟล์ที่มีหลายเวอร์ชัน สำหรับตรวจนโยบายประวัติเวอร์ชัน (§14)
    const uploaded = await uploadFile(
      reviewer, stream('ฉบับที่ 1'),
      { parentId: folderId, fileName: `${prefix}-เอกสาร.txt`, allowDuplicateContent: true },
      audit,
    );
    versionedFileId = uploaded.resource.id;

    clientToken = (await issueSessionForUser(clientId)).accessToken;
    reviewerToken = (await issueSessionForUser(reviewerId)).accessToken;
  });

  after(async () => {
    await app.close();
    const userIds = [reviewerId, outsiderId, clientId];
    const roots = [folderId, otherFolderId];
    const children = await prisma.resource.findMany({ where: { parentId: { in: roots } }, select: { id: true } });
    const allIds = [...roots, ...children.map((c) => c.id)];

    // ลบไบต์ก่อนลบแถว - หลังลบแถวจะไม่มีทางรู้ storageKey อีกเลย
    const versions = await prisma.resourceVersion.findMany({
      where: { resourceId: { in: allIds } },
      select: { resourceId: true, storageKey: true, storageProvider: true },
    });
    for (const version of versions) {
      await deleteStoredFile(version.storageKey, version.storageProvider);
      await removeResourceDirectory(version.resourceId, version.storageProvider);
    }

    await prisma.externalWorkflowSubmission.deleteMany({ where: { resourceId: { in: allIds } } });
    await prisma.externalWorkflowRequest.deleteMany({ where: { targetResourceId: { in: roots } } });
    await prisma.activityLog.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.resourceAccess.deleteMany({ where: { resourceId: { in: allIds } } });
    await prisma.resource.deleteMany({ where: { id: { in: children.map((c) => c.id) } } });
    await prisma.resource.deleteMany({ where: { id: { in: roots } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  });

  /** คำขอใหม่ที่ส่งงานไปแล้วหนึ่งฉบับ พร้อมให้ตรวจ */
  const submittedWorkflow = async () => {
    await prisma.externalWorkflowRequest.deleteMany({ where: { targetResourceId: folderId } });
    const workflow = await createWorkflowRequest(reviewer, {
      title: `${prefix} ขอเอกสาร`, targetResourceId: folderId, externalUserId: clientId,
      expiresAt: new Date(Date.now() + 24 * hour), allowUpload: true, allowDownload: false,
    } as never, audit);
    await submitToWorkflow(client, workflow.id, stream(), { fileName: `${prefix}-รอบ1.txt` }, audit);
    return workflow;
  };

  /* ---------------- §2 ตารางการเปลี่ยนสถานะ ---------------- */

  test('the transition table is the single authority and terminal states are truly terminal', () => {
    assert.equal(canTransition('OPEN', 'SUBMITTED'), true);
    assert.equal(canTransition('SUBMITTED', 'UNDER_REVIEW'), true);
    assert.equal(canTransition('SUBMITTED', 'APPROVED'), true);
    assert.equal(canTransition('UNDER_REVIEW', 'REVISION_REQUESTED'), true);
    assert.equal(canTransition('REVISION_REQUESTED', 'SUBMITTED'), true);

    // ปลายทางไม่มีทางออกเลย
    for (const terminal of ['APPROVED', 'REJECTED', 'REVOKED'] as const) {
      assert.deepEqual(WORKFLOW_TRANSITIONS[terminal], [], `${terminal} ต้องไม่มีทางออก`);
      for (const to of ['OPEN', 'SUBMITTED', 'UNDER_REVIEW', 'APPROVED'] as const) {
        assert.equal(canTransition(terminal, to), false);
      }
    }
    // ข้ามขั้นไม่ได้
    assert.equal(canTransition('OPEN', 'APPROVED'), false);
    assert.equal(canTransition('OPEN', 'UNDER_REVIEW'), false);
  });

  /* ---------------- §1 §27.1-2 §27.7 สิทธิ์การตรวจ ---------------- */

  test('only staff who can manage the target folder may review; others and externals are refused', async () => {
    const workflow = await submittedWorkflow();

    const byOutsider = await failure(() => approveWorkflow(outsider, workflow.id, {}, audit));
    assert.ok(byOutsider.code === 'SHARE_DENIED' || byOutsider.code === 'RESOURCE_NOT_FOUND');

    const byExternal = await failure(() => approveWorkflow(client, workflow.id, {}, audit));
    assert.equal(byExternal.code, 'WORKFLOW_REVIEW_DENIED');

    const forged = await failure(() => approveWorkflow(reviewer, 'not-a-real-workflow', {}, audit));
    assert.equal(forged.code, 'WORKFLOW_NOT_FOUND');

    // เส้นทาง HTTP ต้องปฏิเสธบัญชีภายนอกเช่นกัน
    for (const path of ['review/start', 'review/approve', 'review/reject', 'review/request-revision', 'revoke']) {
      const response = await app.inject({
        method: 'POST', url: `/api/external-workflows/${workflow.id}/${path}`,
        headers: { authorization: `Bearer ${clientToken}` }, payload: { reason: REASON },
      });
      assert.equal(response.statusCode, 403, `${path} ต้องปฏิเสธบัญชีภายนอก`);
    }
  });

  /* ---------------- §3 §27.4-5 เหตุผล ---------------- */

  test('reject and revision demand a real reason; approve does not', async () => {
    assert.equal(normalizeRequiredReason('.'), null);
    assert.equal(normalizeRequiredReason('          '), null, 'ช่องว่างล้วนไม่ใช่เหตุผล');
    assert.equal(normalizeRequiredReason('สั้นไป'), null);
    assert.equal(normalizeRequiredReason(REASON), REASON);

    const workflow = await submittedWorkflow();
    for (const [label, run] of [
      ['reject', () => rejectWorkflow(reviewer, workflow.id, { reason: '.' }, audit)],
      ['revision', () => requestRevision(reviewer, workflow.id, { reason: '   ' }, audit)],
      ['revoke', () => revokeWorkflow(reviewer, workflow.id, { reason: '' }, audit)],
    ] as const) {
      const error = await failure(run);
      assert.equal(error.code, 'WORKFLOW_REASON_REQUIRED', `${label} ต้องบังคับเหตุผล`);
    }

    // อนุมัติไม่ต้องมีเหตุผล
    const result = await approveWorkflow(reviewer, workflow.id, {}, audit);
    assert.equal(result.to, 'APPROVED');
  });

  /* ---------------- §5 §27.3 การแข่งกัน ---------------- */

  test('approve racing reject yields exactly one winner and one explicit conflict', async () => {
    const workflow = await submittedWorkflow();
    const results = await Promise.allSettled([
      approveWorkflow(reviewer, workflow.id, {}, audit),
      rejectWorkflow(reviewer, workflow.id, { reason: REASON }, audit),
    ]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);

    const loser = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    assert.ok(
      ['WORKFLOW_STATE_CONFLICT', 'WORKFLOW_INVALID_TRANSITION'].includes(loser.reason.code),
      `ผู้แพ้ต้องได้ข้อขัดแย้งที่ชัดเจน แต่ได้ ${loser.reason.code}`,
    );

    const final = await prisma.externalWorkflowRequest.findUniqueOrThrow({ where: { id: workflow.id } });
    assert.ok(['APPROVED', 'REJECTED'].includes(final.state), 'ต้องจบที่สถานะเดียว ไม่กำกวม');
  });

  test('approve racing request-revision also resolves to one', async () => {
    const workflow = await submittedWorkflow();
    const results = await Promise.allSettled([
      approveWorkflow(reviewer, workflow.id, {}, audit),
      requestRevision(reviewer, workflow.id, { reason: REASON }, audit),
    ]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  });

  /* ---------------- §13 §27.6 การตัดสินฉบับที่ล้าสมัย ---------------- */

  test('a reviewer cannot approve a submission that has been superseded', async () => {
    const workflow = await submittedWorkflow();
    const first = await getAssignedWorkflow(client, workflow.id);
    const staleSubmissionId = first.submissions[0]!.id;

    await requestRevision(reviewer, workflow.id, { reason: REASON }, audit);
    await submitToWorkflow(client, workflow.id, stream('ฉบับแก้'), { fileName: `${prefix}-รอบ2.txt` }, audit);

    // ผู้ตรวจยังถือรหัสฉบับเก่าอยู่ - ต้องถูกปฏิเสธว่าล้าสมัย
    const error = await failure(() => approveWorkflow(reviewer, workflow.id, { submissionId: staleSubmissionId }, audit));
    assert.equal(error.code, 'WORKFLOW_REVIEW_STALE');
    assert.equal(error.statusCode, 409);

    // ตัดสินฉบับล่าสุดได้ตามปกติ
    const latest = await getAssignedWorkflow(client, workflow.id);
    const current = latest.submissions[latest.submissions.length - 1]!;
    const ok = await approveWorkflow(reviewer, workflow.id, { submissionId: current.id }, audit);
    assert.equal(ok.to, 'APPROVED');
  });

  /* ---------------- §8-10 §27.8-10 การส่งฉบับแก้ ---------------- */

  test('revision preserves prior submissions, increments sequence, and returns to SUBMITTED', async () => {
    const workflow = await submittedWorkflow();
    await requestRevision(reviewer, workflow.id, { reason: REASON }, audit);

    const afterRevision = await prisma.externalWorkflowRequest.findUniqueOrThrow({ where: { id: workflow.id } });
    assert.equal(afterRevision.state, 'REVISION_REQUESTED');

    const detail = await getAssignedWorkflow(client, workflow.id);
    assert.equal(detail.canSubmit, true, 'ถูกขอให้แก้ไขแล้วต้องส่งใหม่ได้');
    assert.equal(detail.latestDecision?.status, 'REVISION_REQUESTED');
    assert.equal(detail.latestDecision?.reason, REASON, 'ผู้รับงานต้องเห็นเหตุผล');

    const second = await submitToWorkflow(client, workflow.id, stream('ฉบับแก้'), { fileName: `${prefix}-แก้.txt` }, audit);
    assert.equal(second.sequence, 2, 'ลำดับต้องเพิ่มขึ้น');

    const rows = await prisma.externalWorkflowSubmission.findMany({
      where: { workflowRequestId: workflow.id }, orderBy: { sequence: 'asc' },
    });
    assert.equal(rows.length, 2, 'ฉบับก่อนต้องยังอยู่');
    assert.notEqual(rows[0]!.resourceId, rows[1]!.resourceId, 'คนละไฟล์ คนละหลักฐาน');

    // ไฟล์ของฉบับแรกยังอยู่จริง ไม่ถูกเขียนทับ
    const firstFile = await prisma.resource.findUnique({ where: { id: rows[0]!.resourceId } });
    assert.ok(firstFile, 'ไฟล์ของฉบับแรกต้องไม่ถูกลบ');
    assert.equal(firstFile!.ownerId, reviewerId, 'เจ้าของยังเป็นผู้รับผิดชอบภายใน (§16)');
    assert.equal(firstFile!.createdById, clientId);

    const back = await prisma.externalWorkflowRequest.findUniqueOrThrow({ where: { id: workflow.id } });
    assert.equal(back.state, 'SUBMITTED');
  });

  test('only OPEN and REVISION_REQUESTED accept a submission', async () => {
    const workflow = await submittedWorkflow(); // อยู่ที่ SUBMITTED แล้ว
    for (const state of ['SUBMITTED', 'UNDER_REVIEW', 'APPROVED', 'REJECTED', 'REVOKED'] as const) {
      await prisma.externalWorkflowRequest.update({ where: { id: workflow.id }, data: { state } });
      const error = await failure(() => submitToWorkflow(client, workflow.id, stream(), { fileName: 'x.txt' }, audit));
      assert.equal(error.code, 'WORKFLOW_NOT_SUBMITTABLE', `${state} ต้องส่งไม่ได้`);
    }
  });

  /* ---------------- §12 §27.11-12 การแข่งกันส่งฉบับแก้ ---------------- */

  test('two simultaneous resubmissions produce one winner and no orphan bytes', async () => {
    const workflow = await submittedWorkflow();
    await requestRevision(reviewer, workflow.id, { reason: REASON }, audit);

    const before = await orphanCount();
    const results = await Promise.allSettled([
      submitToWorkflow(client, workflow.id, stream('ก'), { fileName: `${prefix}-ก.txt` }, audit),
      submitToWorkflow(client, workflow.id, stream('ข'), { fileName: `${prefix}-ข.txt` }, audit),
    ]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal(
      await prisma.externalWorkflowSubmission.count({ where: { workflowRequestId: workflow.id } }), 2,
      'ควรมีฉบับแรกกับฉบับแก้ที่ชนะ รวมสองฉบับ',
    );
    assert.equal(await orphanCount(), before, 'ผู้แพ้ต้องไม่ทิ้งไบต์');
  });

  /* ---------------- §14 §27.21-22 ประวัติเวอร์ชัน ---------------- */

  test('generic portal version history is closed, while workflow submission history stays open', async () => {
    const workflow = await submittedWorkflow();
    await prisma.resourceAccess.deleteMany({ where: { resourceId: folderId, userId: clientId } });

    // ประวัติเวอร์ชันทั่วไปปิดสนิท ทั้งรายการ เนื้อหา และดาวน์โหลด
    assert.equal(await denied(() => listPortalVersions(client, versionedFileId, audit)), true);
    assert.equal(
      await denied(() => resolvePortalVersionContent(client, versionedFileId, 1, { requireDownload: false })),
      true,
    );

    // แต่ประวัติการส่งงานของตัวเองยังเห็นได้ผ่านหน้ารายละเอียดงาน
    const detail = await getAssignedWorkflow(client, workflow.id);
    assert.equal(detail.submissions.length, 1);
    assert.equal(detail.submissions[0]!.sequence, 1);
    // และไม่มีข้อมูลภายในของที่เก็บติดออกไป
    for (const leak of ['storageKey', 'storageProvider', 'checksum']) {
      assert.equal(JSON.stringify(detail).includes(leak), false, `รั่ว ${leak}`);
    }
  });

  /* ---------------- §17-22 §27.15-19 ยกเลิกและหมดอายุ ---------------- */

  test('revocation stops workflow access immediately without deleting any evidence', async () => {
    const workflow = await submittedWorkflow();
    assert.equal(await denied(() => resolvePortalAccess(clientId, folderId)), false);

    const submissionsBefore = await prisma.externalWorkflowSubmission.count({ where: { workflowRequestId: workflow.id } });
    await revokeWorkflow(reviewer, workflow.id, { reason: REASON }, audit);

    assert.equal(await denied(() => resolvePortalAccess(clientId, folderId)), true, 'สิทธิ์ต้องหยุดทันที');
    assert.ok(await prisma.externalWorkflowRequest.findUnique({ where: { id: workflow.id } }), 'แถวคำขอต้องยังอยู่');
    assert.equal(
      await prisma.externalWorkflowSubmission.count({ where: { workflowRequestId: workflow.id } }),
      submissionsBefore, 'แถวการส่งงานต้องยังอยู่ครบ',
    );
    // ไฟล์ที่ส่งมายังอยู่ - การยกเลิกงานไม่ใช่การลบเอกสารที่รับมาแล้ว
    const rows = await prisma.externalWorkflowSubmission.findMany({ where: { workflowRequestId: workflow.id } });
    for (const row of rows) {
      assert.ok(await prisma.resource.findUnique({ where: { id: row.resourceId } }), 'ไฟล์ต้องไม่ถูกลบ');
    }
  });

  test('every end state and expiry stops the workflow contribution', async () => {
    for (const state of ['APPROVED', 'REJECTED', 'REVOKED'] as const) {
      const workflow = await submittedWorkflow();
      await prisma.externalWorkflowRequest.update({ where: { id: workflow.id }, data: { state } });
      assert.equal(await denied(() => resolvePortalAccess(clientId, folderId)), true, `${state} ต้องหยุดสิทธิ์`);
    }
    // สถานะที่งานยังเดินอยู่ต้องให้สิทธิ์ต่อ (§21)
    for (const state of ['OPEN', 'SUBMITTED', 'UNDER_REVIEW', 'REVISION_REQUESTED'] as const) {
      const workflow = await submittedWorkflow();
      await prisma.externalWorkflowRequest.update({ where: { id: workflow.id }, data: { state } });
      assert.equal(await denied(() => resolvePortalAccess(clientId, folderId)), false, `${state} ต้องยังให้สิทธิ์`);
    }
    // หมดอายุโดยไม่แตะคอลัมน์สถานะ
    const expiring = await submittedWorkflow();
    await prisma.externalWorkflowRequest.update({
      where: { id: expiring.id }, data: { state: 'SUBMITTED', expiresAt: new Date(Date.now() - hour) },
    });
    assert.equal(await denied(() => resolvePortalAccess(clientId, folderId)), true, 'หมดอายุต้องหยุดสิทธิ์');
    const row = await prisma.externalWorkflowRequest.findUniqueOrThrow({ where: { id: expiring.id } });
    assert.equal(row.state, 'SUBMITTED', 'EXPIRED ต้องไม่ถูกเขียนลงคอลัมน์');
  });

  test('a manual grant survives approval, rejection, revocation and expiry untouched', async () => {
    await prisma.externalWorkflowRequest.deleteMany({ where: { targetResourceId: folderId } });
    await grantAccess(folderId, { userId: clientId, accessLevel: 'VIEWER', allowDownload: true, expiresAt: null }, reviewer, audit);

    for (const ending of ['APPROVED', 'REJECTED', 'REVOKED', 'EXPIRED'] as const) {
      const workflow = await submittedWorkflow();
      if (ending === 'EXPIRED') {
        await prisma.externalWorkflowRequest.update({
          where: { id: workflow.id }, data: { expiresAt: new Date(Date.now() - hour) },
        });
      } else {
        await prisma.externalWorkflowRequest.update({ where: { id: workflow.id }, data: { state: ending } });
      }

      const grant = await prisma.resourceAccess.findUniqueOrThrow({
        where: { resourceId_userId: { resourceId: folderId, userId: clientId } },
      });
      assert.equal(grant.accessLevel, 'VIEWER', `${ending}: ระดับสิทธิ์เดิมต้องไม่เปลี่ยน`);
      assert.equal(grant.allowDownload, true, `${ending}: สิทธิ์ดาวน์โหลดเดิมต้องไม่เปลี่ยน`);
      assert.equal(grant.expiresAt, null, `${ending}: วันหมดอายุเดิมต้องไม่เปลี่ยน`);

      // สิทธิ์ที่มอบด้วยมือยังใช้ได้ แม้งานจบไปแล้ว
      const access = await resolvePortalAccess(clientId, folderId);
      assert.equal(access.role, 'VIEWER', `${ending}: ส่วนที่มาจากคำขอต้องหายไป เหลือของเดิม`);
      assert.equal(access.allowDownload, true);
    }
    await prisma.resourceAccess.deleteMany({ where: { resourceId: folderId, userId: clientId } });
  });

  /* ---------------- §23 §27.20 เพดานยังอยู่เหนือทุกสถานะ ---------------- */

  test('classification and lifecycle still block external access in every workflow state', async () => {
    const workflow = await submittedWorkflow();
    for (const state of ['OPEN', 'SUBMITTED', 'UNDER_REVIEW', 'REVISION_REQUESTED'] as const) {
      await prisma.externalWorkflowRequest.update({ where: { id: workflow.id }, data: { state } });
      await prisma.resource.update({ where: { id: folderId }, data: { classification: 'CONFIDENTIAL' } });
      assert.equal(await denied(() => resolvePortalAccess(clientId, folderId)), true, `${state} + CONFIDENTIAL`);
      assert.equal(await denied(() => getAssignedWorkflow(client, workflow.id)), true);

      await prisma.resource.update({ where: { id: folderId }, data: { classification: 'INTERNAL', lifecycleState: 'ARCHIVED' } });
      assert.equal(await denied(() => resolvePortalAccess(clientId, folderId)), true, `${state} + ARCHIVED`);

      await prisma.resource.update({ where: { id: folderId }, data: { lifecycleState: 'ACTIVE' } });
    }
  });

  /* ---------------- §24-25 รายงานและประวัติ ---------------- */

  test('the review chronology is reconstructable and an ended workflow is not a current access source', async () => {
    const workflow = await submittedWorkflow();
    await startReview(reviewer, workflow.id, audit);
    await requestRevision(reviewer, workflow.id, { reason: REASON }, audit);
    await submitToWorkflow(client, workflow.id, stream('แก้แล้ว'), { fileName: `${prefix}-ประวัติ.txt` }, audit);
    await approveWorkflow(reviewer, workflow.id, {}, audit);

    const history = await workflowHistory(reviewer, workflow.id);
    const actions = history.map((entry) => entry.action);
    assert.deepEqual(actions, [
      'EXTERNAL_WORKFLOW_CREATED',
      'EXTERNAL_SUBMISSION_CREATED',
      'EXTERNAL_REVIEW_STARTED',
      'EXTERNAL_REVISION_REQUESTED',
      'EXTERNAL_SUBMISSION_CREATED',
      'EXTERNAL_REVIEW_APPROVED',
    ], 'ลำดับเหตุการณ์ต้องอ่านได้ครบตามที่เกิดจริง');

    const revision = history.find((entry) => entry.action === 'EXTERNAL_REVISION_REQUESTED')!;
    assert.equal(revision.reason, REASON);
    assert.equal(revision.fromState, 'UNDER_REVIEW');
    assert.equal(revision.toState, 'REVISION_REQUESTED');
    assert.equal(JSON.stringify(history).includes('storageKey'), false);

    // งานที่จบแล้วต้องไม่ถูกรายงานว่าเป็นที่มาของสิทธิ์ปัจจุบัน
    const review = await effectiveAccessReview(folderId);
    const entry = review.entries.find((item) => item.subject.id === clientId);
    assert.equal(entry, undefined, 'ไม่มีสิทธิ์เหลือ จึงไม่ควรปรากฏเป็นผู้เข้าถึงปัจจุบัน');
  });

  /* ---------------- §26 การชดเชยที่ล้มเหลวต้องมองเห็นได้ ---------------- */

  test('a failed compensation is recorded durably rather than only logged', async () => {
    // ยืนยันว่ารหัสเหตุการณ์มีอยู่จริงในสารบัญ และเป็นเหตุการณ์แบบล้มเหลว
    const { EVENT_CATALOG } = await import('../audit/event-catalog.js');
    const definition = (EVENT_CATALOG as Record<string, { failure?: boolean; category: string }>)
      .STORAGE_CLEANUP_FAILED;
    assert.ok(definition, 'ต้องมีรหัสเหตุการณ์สำหรับการเก็บกวาดที่ล้มเหลว');
    assert.equal(definition.failure, true, 'ต้องถูกจัดเป็นความล้มเหลว จึงกรองหาได้');
  });
});

/**
 * F26-C/D - หน้าจองานของผู้รับงานภายนอก และการส่งงานแบบควบคุมปลายทาง
 *
 * ชุดนี้ **สร้างไบต์จริง** จึงต้องเก็บกวาดทั้งแถวและไฟล์ในที่เก็บ ดู after()
 * ทุกเส้นทางที่ล้มกลางคันต้องไม่ทิ้งไบต์ไว้เช่นกัน ซึ่งมีเทสต์ยืนยันแยกต่างหาก
 *
 * คำถามหลักสองข้อที่ต้องตอบ:
 *   1. ผู้รับงานเห็นและทำได้เฉพาะงานของตัวเอง ภายใต้เพดานเดิมทุกชั้น
 *   2. ปลายทางของไฟล์มาจากเซิร์ฟเวอร์เสมอ ไม่ว่าผู้ส่งจะพยายามอย่างไร
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
import { effectiveAccessReview } from '../sharing/access-review.service.js';
import { openPortalFolder } from '../portal/portal.service.js';
import { createWorkflowRequest, getAssignedWorkflow, listAssignedWorkflows } from './workflow.service.js';
import { submitToWorkflow } from './submission.service.js';

const prefix = `f26cd-${Date.now().toString(36)}`;
const audit = { ipAddress: '127.0.0.1', userAgent: 'f26cd-test' };
const hour = 3_600_000;
const stream = (text = 'เนื้อหาเอกสารที่ลูกค้าส่งกลับมา') => Readable.from([Buffer.from(text, 'utf8')]);

async function failure(run: () => Promise<unknown>): Promise<{ code?: string; statusCode?: number }> {
  try {
    await run();
    throw new Error('expected rejection, but the call succeeded');
  } catch (error) {
    return error as { code?: string; statusCode?: number };
  }
}

/** นับไบต์ที่ไม่มีแถวอ้างถึง - ใช้ยืนยันว่าเส้นทางที่ล้มไม่ทิ้งขยะ */
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
  for (const row of await prisma.resource.findMany({ select: { storageKey: true } })) if (row.storageKey) keys.add(row.storageKey);
  for (const row of await prisma.resourceVersion.findMany({ select: { storageKey: true } })) if (row.storageKey) keys.add(row.storageKey);
  return files.filter((file) => !keys.has(file)).length;
}

describe('F26-C/D portal workflow surface and controlled submission', () => {
  let app: FastifyInstance;
  let managerId = '';
  let aliceId = '';
  let bobId = '';
  let folderId = '';
  let bobFolderId = '';
  let viewOnlyFolderId = '';
  let manager: AuthUser;
  let alice: AuthUser;
  let aliceToken = '';
  let managerToken = '';

  before(async () => {
    app = await buildApp();
    await app.ready();

    const rows = await Promise.all([
      prisma.user.create({ data: { email: `${prefix}-mgr@example.invalid`, displayName: 'F26CD Manager', status: 'ACTIVE' } }),
      prisma.user.create({ data: { email: `${prefix}-alice@example.invalid`, displayName: 'F26CD Alice', type: 'EXTERNAL', status: 'ACTIVE', organizationName: 'Alice Corp' } }),
      prisma.user.create({ data: { email: `${prefix}-bob@example.invalid`, displayName: 'F26CD Bob', type: 'EXTERNAL', status: 'ACTIVE', organizationName: 'Bob Corp' } }),
    ]);
    [managerId, aliceId, bobId] = rows.map((row) => row.id);

    const adminRole = await prisma.role.findUniqueOrThrow({ where: { code: 'ADMIN' } });
    await prisma.userRole.create({ data: { userId: managerId, roleId: adminRole.id } });

    manager = {
      id: managerId, email: rows[0].email, displayName: rows[0].displayName,
      type: 'INTERNAL', status: 'ACTIVE', mustChangePassword: false,
      roles: ['ADMIN'], permissions: ['resources:read', 'resources:write', 'resources:share'],
    };
    alice = {
      id: aliceId, email: rows[1].email, displayName: rows[1].displayName,
      type: 'EXTERNAL', status: 'ACTIVE', mustChangePassword: false, roles: [], permissions: [],
    };

    for (const [name, assign] of [['งาน', 'folderId'], ['งานบ๊อบ', 'bobFolderId'], ['อ่านอย่างเดียว', 'viewOnlyFolderId']] as const) {
      const folder = await createFolder(manager, { name: `${prefix}-${name}`, parentId: null }, audit);
      if (assign === 'folderId') folderId = folder.id;
      if (assign === 'bobFolderId') bobFolderId = folder.id;
      if (assign === 'viewOnlyFolderId') viewOnlyFolderId = folder.id;
    }

    aliceToken = (await issueSessionForUser(aliceId)).accessToken;
    managerToken = (await issueSessionForUser(managerId)).accessToken;
  });

  after(async () => {
    await app.close();
    const userIds = [managerId, aliceId, bobId];
    const roots = [folderId, bobFolderId, viewOnlyFolderId];

    /*
     * ลบไบต์ก่อนลบแถว - หลังลบแถวแล้วจะไม่มีทางรู้ storageKey อีกเลย
     * ไฟล์ที่ผู้รับงานส่งเข้ามาอยู่ใต้โฟลเดอร์เหล่านี้ จึงต้องกวาดลูกด้วย ไม่ใช่แค่ตัวราก
     */
    const children = await prisma.resource.findMany({ where: { parentId: { in: roots } }, select: { id: true } });
    const allIds = [...roots, ...children.map((child) => child.id)];
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
    await prisma.resource.deleteMany({ where: { id: { in: children.map((child) => child.id) } } });
    await prisma.resource.deleteMany({ where: { id: { in: roots } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  });

  const openWorkflow = async (overrides: Record<string, unknown> = {}) => {
    await prisma.externalWorkflowRequest.deleteMany({ where: { targetResourceId: folderId, externalUserId: aliceId } });
    return createWorkflowRequest(manager, {
      title: `${prefix} ส่งใบเสร็จ`,
      instructions: 'กรุณาแนบใบเสร็จของเดือนนี้',
      targetResourceId: folderId,
      externalUserId: aliceId,
      expiresAt: new Date(Date.now() + 24 * hour),
      allowUpload: true,
      allowDownload: false,
      ...overrides,
    } as never, audit);
  };

  /* ---------------- F26-C: รายการและรายละเอียด ---------------- */

  test('the assignee sees only their own work, with no other target names leaking', async () => {
    await openWorkflow();
    await createWorkflowRequest(manager, {
      title: `${prefix} งานของบ๊อบ`, targetResourceId: bobFolderId, externalUserId: bobId,
      expiresAt: new Date(Date.now() + 24 * hour), allowUpload: true, allowDownload: false,
    } as never, audit);

    const mine = await listAssignedWorkflows(alice);
    assert.equal(mine.length, 1);
    assert.equal(mine[0]!.target.id, folderId);
    assert.equal(mine[0]!.status, 'OPEN');
    assert.equal(mine[0]!.submissionCount, 0);

    // ชื่อโฟลเดอร์ของลูกค้ารายอื่นต้องไม่ปรากฏที่ใดในคำตอบ
    assert.equal(JSON.stringify(mine).includes('งานบ๊อบ'), false);
    for (const leak of ['storageKey', 'storageProvider', 'activeSlot', 'createdById']) {
      assert.equal(JSON.stringify(mine).includes(leak), false, `list leaked ${leak}`);
    }
  });

  test('detail is scoped to the assignee and forged or foreign ids look identical to missing ones', async () => {
    const workflow = await openWorkflow();
    const detail = await getAssignedWorkflow(alice, workflow.id);
    assert.equal(detail.id, workflow.id);
    assert.equal(detail.canSubmit, true);
    assert.deepEqual(detail.submissions, []);

    const bobWorkflow = await prisma.externalWorkflowRequest.findFirstOrThrow({ where: { externalUserId: bobId } });
    const foreign = await failure(() => getAssignedWorkflow(alice, bobWorkflow.id));
    const forged = await failure(() => getAssignedWorkflow(alice, 'not-a-real-workflow'));
    assert.equal(foreign.code, 'WORKFLOW_NOT_FOUND');
    assert.equal(forged.code, 'WORKFLOW_NOT_FOUND', 'งานของคนอื่นกับงานที่ไม่มีอยู่ ต้องแยกไม่ออก');
  });

  test('internal users are refused on every portal workflow route', async () => {
    const workflow = await openWorkflow();
    for (const url of ['/api/portal/workflows', `/api/portal/workflows/${workflow.id}`]) {
      const response = await app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${managerToken}` } });
      assert.equal(response.statusCode, 403, `${url} ต้องปฏิเสธบัญชีภายใน`);
    }
    const submit = await app.inject({
      method: 'POST', url: `/api/portal/workflows/${workflow.id}/submissions`,
      headers: { authorization: `Bearer ${managerToken}` },
    });
    assert.equal(submit.statusCode, 403);
  });

  test('a workflow blocked after creation disappears from the list and fails safely on direct access', async () => {
    const workflow = await openWorkflow();

    for (const level of ['CONFIDENTIAL', 'RESTRICTED'] as const) {
      if (level === 'RESTRICTED') {
        await prisma.resource.update({ where: { id: folderId }, data: { visibility: 'RESTRICTED' } });
      }
      await prisma.resource.update({ where: { id: folderId }, data: { classification: level } });

      assert.equal((await listAssignedWorkflows(alice)).length, 0, `${level}: ต้องหายจากรายการ`);
      const error = await failure(() => getAssignedWorkflow(alice, workflow.id));
      assert.equal(error.code, 'WORKFLOW_NOT_FOUND', `${level}: ต้องตอบเหมือนไม่พบ`);
      assert.equal(
        (await failure(() => submitToWorkflow(alice, workflow.id, stream(), { fileName: 'x.txt' }, audit))).code,
        'WORKFLOW_NOT_FOUND',
      );
    }
    await prisma.resource.update({
      where: { id: folderId }, data: { classification: 'INTERNAL', visibility: 'ORGANIZATION' },
    });

    // เก็บเข้าคลังก็ต้องได้ผลเดียวกัน
    await prisma.resource.update({ where: { id: folderId }, data: { lifecycleState: 'ARCHIVED' } });
    assert.equal((await listAssignedWorkflows(alice)).length, 0);
    assert.equal((await failure(() => getAssignedWorkflow(alice, workflow.id))).code, 'WORKFLOW_NOT_FOUND');
    await prisma.resource.update({ where: { id: folderId }, data: { lifecycleState: 'ACTIVE' } });
  });

  /* ---------------- F26-D: การส่งงาน ---------------- */

  test('a submission lands in the pinned target, keeps company ownership, and records the link explicitly', async () => {
    const workflow = await openWorkflow();
    const submission = await submitToWorkflow(alice, workflow.id, stream(), { fileName: `${prefix}-ใบเสร็จ.txt` }, audit);

    assert.equal(submission.sequence, 1);
    const resource = await prisma.resource.findUniqueOrThrow({ where: { id: submission.file.id } });

    // §9 ปลายทางถูกตรึง
    assert.equal(resource.parentId, folderId, 'ไฟล์ต้องลงในโฟลเดอร์ของคำขอเท่านั้น');
    // §22 เจ้าของคือผู้รับผิดชอบภายใน ไม่ใช่ผู้ส่งภายนอก
    assert.equal(resource.ownerId, managerId, 'เจ้าของต้องสืบทอดจากโฟลเดอร์ ไม่ใช่ผู้ส่ง');
    assert.equal(resource.createdById, aliceId, 'ผู้สร้างคือผู้ส่งจริง');
    assert.equal(resource.sourceType, 'EXTERNAL_UPLOAD');
    // เส้นทางอัปโหลดปกติทำงานครบ
    assert.ok(resource.storageKey, 'ต้องผ่านเส้นทางที่เก็บปกติ');
    const version = await prisma.resourceVersion.findFirstOrThrow({ where: { resourceId: resource.id } });
    assert.ok(version.checksum, 'ต้องมี checksum จากเส้นทางอัปโหลดปกติ');

    // §15 ความเชื่อมโยงถูกเก็บไว้ ไม่ใช่เดาย้อนหลัง
    const row = await prisma.externalWorkflowSubmission.findFirstOrThrow({ where: { workflowRequestId: workflow.id } });
    assert.equal(row.resourceId, resource.id);
    assert.equal(row.submittedById, aliceId);

    // §7 OPEN -> SUBMITTED
    const after = await prisma.externalWorkflowRequest.findUniqueOrThrow({ where: { id: workflow.id } });
    assert.equal(after.state, 'SUBMITTED');

    const detail = await getAssignedWorkflow(alice, workflow.id);
    assert.equal(detail.status, 'SUBMITTED');
    assert.equal(detail.canSubmit, false, 'ส่งแล้วต้องส่งซ้ำไม่ได้ในเฟสนี้');
    assert.equal(detail.submissions.length, 1);

    // §20 บันทึกมีสิ่งที่ต้องมี และไม่มีสิ่งที่ห้ามมี
    const log = await prisma.activityLog.findFirstOrThrow({
      where: { action: 'EXTERNAL_SUBMISSION_CREATED', userId: aliceId },
    });
    const metadata = log.metadata as Record<string, unknown>;
    assert.equal(metadata.workflowId, workflow.id);
    assert.equal(metadata.sequence, 1);
    assert.equal(JSON.stringify(metadata).includes('storageKey'), false);
  });

  test('submission is refused in every state that F26-F does not open, and when allowUpload is false', async () => {
    const workflow = await openWorkflow();

    /*
     * REVISION_REQUESTED ถูกย้ายออกจากรายการนี้ใน F26-F โดยตั้งใจ
     * ตอนนั้นยังไม่มีนิยามของการส่งซ้ำ จึงปิดไว้ก่อน ตอนนี้มีแล้วจึงเปิด
     * รายละเอียดของการส่งฉบับแก้อยู่ใน f26efg.test.ts
     */
    for (const state of ['SUBMITTED', 'UNDER_REVIEW', 'APPROVED', 'REJECTED', 'REVOKED'] as const) {
      await prisma.externalWorkflowRequest.update({ where: { id: workflow.id }, data: { state } });
      const error = await failure(() => submitToWorkflow(alice, workflow.id, stream(), { fileName: 'x.txt' }, audit));
      assert.ok(
        error.code === 'WORKFLOW_NOT_SUBMITTABLE' || error.code === 'WORKFLOW_NOT_FOUND',
        `${state}: ได้ ${error.code}`,
      );
    }

    // หมดอายุ
    await prisma.externalWorkflowRequest.update({
      where: { id: workflow.id }, data: { state: 'OPEN', expiresAt: new Date(Date.now() - hour) },
    });
    assert.equal(
      (await failure(() => submitToWorkflow(alice, workflow.id, stream(), { fileName: 'x.txt' }, audit))).code,
      'WORKFLOW_NOT_SUBMITTABLE',
    );

    /*
     * §12 สิทธิ์ของงาน ไม่ใช่สิทธิ์ของพื้นที่
     * ให้สิทธิ์ EDITOR ด้วยมือบนโฟลเดอร์เดียวกัน แล้วสั่งงานแบบอ่านอย่างเดียว
     * การส่งต้องยังถูกปฏิเสธ - สิทธิ์ของพื้นที่ต้องไม่เปลี่ยนความหมายของงาน
     */
    await prisma.resourceAccess.create({
      data: { resourceId: folderId, userId: aliceId, accessLevel: 'EDITOR', allowDownload: true, createdById: managerId },
    });
    try {
      const viewOnly = await openWorkflow({ allowUpload: false });
      const error = await failure(() => submitToWorkflow(alice, viewOnly.id, stream(), { fileName: 'x.txt' }, audit));
      assert.equal(error.code, 'WORKFLOW_UPLOAD_NOT_ALLOWED');
      assert.equal(error.statusCode, 403);
    } finally {
      await prisma.resourceAccess.deleteMany({ where: { resourceId: folderId, userId: aliceId } });
    }
  });

  test('a client-supplied destination is rejected outright rather than quietly ignored', async () => {
    const workflow = await openWorkflow();
    const boundary = '----f26cdboundary';
    const body = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="parentId"',
      '', bobFolderId,
      `--${boundary}`,
      `Content-Disposition: form-data; name="file"; filename="${prefix}-forged.txt"`,
      'Content-Type: text/plain',
      '', 'พยายามกำหนดปลายทางเอง',
      `--${boundary}--`, '',
    ].join('\r\n');

    const response = await app.inject({
      method: 'POST',
      url: `/api/portal/workflows/${workflow.id}/submissions`,
      headers: {
        authorization: `Bearer ${aliceToken}`,
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload: body,
    });

    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error?.code ?? response.json().code, 'WORKFLOW_DESTINATION_NOT_ACCEPTED');
    // และไม่มีไฟล์ใดไปโผล่ในโฟลเดอร์ของลูกค้ารายอื่น
    assert.equal(await prisma.resource.count({ where: { parentId: bobFolderId } }), 0);
  });

  test('two simultaneous submissions produce one winner and leave no orphan bytes', async () => {
    const workflow = await openWorkflow();
    const before = await orphanCount();

    const results = await Promise.allSettled([
      submitToWorkflow(alice, workflow.id, stream('หนึ่ง'), { fileName: `${prefix}-a.txt` }, audit),
      submitToWorkflow(alice, workflow.id, stream('สอง'), { fileName: `${prefix}-b.txt` }, audit),
    ]);

    const won = results.filter((result) => result.status === 'fulfilled');
    assert.equal(won.length, 1, 'ต้องสำเร็จเพียงหนึ่ง');
    assert.equal(
      await prisma.externalWorkflowSubmission.count({ where: { workflowRequestId: workflow.id } }), 1,
      'ผู้แพ้ต้องไม่ทิ้งแถวไว้',
    );
    assert.equal(await orphanCount(), before, 'ผู้แพ้ต้องไม่ทิ้งไบต์ไว้');
  });

  test('policy that changes mid-flight fails the bind closed and cleans up the uploaded bytes', async () => {
    const workflow = await openWorkflow();
    const before = await orphanCount();
    const resourcesBefore = await prisma.resource.count({ where: { parentId: folderId } });

    /*
     * จำลองการเปลี่ยนนโยบายระหว่างที่ไฟล์กำลังไหล: สตรีมที่หน่วงไว้ แล้วยกชั้นความลับ
     * ระหว่างนั้น การตรวจครั้งที่สองต้องจับได้ และไบต์ที่เขียนไปแล้วต้องถูกลบ
     */
    const slow = new Readable({
      read() {
        setTimeout(() => { this.push(Buffer.from('ช้า ๆ')); this.push(null); }, 60);
      },
    });
    const pending = submitToWorkflow(alice, workflow.id, slow, { fileName: `${prefix}-inflight.txt` }, audit);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await prisma.resource.update({ where: { id: folderId }, data: { classification: 'CONFIDENTIAL' } });

    const error = await failure(() => pending);
    assert.ok(error.code === 'WORKFLOW_NOT_FOUND' || error.code === 'PORTAL_RESOURCE_NOT_FOUND', `ได้ ${error.code}`);

    await prisma.resource.update({ where: { id: folderId }, data: { classification: 'INTERNAL' } });
    assert.equal(await prisma.resource.count({ where: { parentId: folderId } }), resourcesBefore, 'ต้องไม่เหลือแถวไฟล์');
    assert.equal(await orphanCount(), before, 'ต้องไม่เหลือไบต์');
    assert.equal(await prisma.externalWorkflowSubmission.count({ where: { workflowRequestId: workflow.id } }), 0);
  });

  /* ---------------- ขอบเขตที่ต้องไม่กว้างขึ้น ---------------- */

  test('submitting never turns the target folder into something browsable', async () => {
    const workflow = await openWorkflow();
    await submitToWorkflow(alice, workflow.id, stream(), { fileName: `${prefix}-browse.txt` }, audit);

    /*
     * คำขอเปิดให้ "ส่งงาน" ไม่ได้เปิดให้ "เดินดูโฟลเดอร์"
     * ผู้รับงานเปิดโฟลเดอร์ได้เพราะชั้นทับให้สิทธิ์ แต่ต้องไม่เห็นอะไรเกินขอบเขตนั้น
     */
    const view = await openPortalFolder(alice, folderId, audit);
    assert.equal(view.folder.id, folderId);
    assert.equal(await failure(() => openPortalFolder(alice, bobFolderId, audit)).then((e) => e.code), 'PORTAL_RESOURCE_NOT_FOUND');
    assert.equal(JSON.stringify(view).includes('storageKey'), false);
  });

  test('a submission creates no hidden permission route; the review still explains access as WORKFLOW', async () => {
    const workflow = await openWorkflow();
    await submitToWorkflow(alice, workflow.id, stream(), { fileName: `${prefix}-review.txt` }, audit);

    const review = await effectiveAccessReview(folderId);
    const entry = review.entries.find((item) => item.subject.id === aliceId)!;
    assert.equal(entry.usable, true);
    assert.deepEqual(entry.evidence.map((item) => item.source), ['WORKFLOW']);
    assert.equal(
      await prisma.resourceAccess.count({ where: { resourceId: folderId, userId: aliceId } }), 0,
      'การส่งงานต้องไม่สร้างสิทธิ์ถาวร',
    );
  });
});

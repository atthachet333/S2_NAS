/**
 * เส้นทาง API ของคำขอความร่วมมือจากภายนอก (F26-B)
 *
 * เส้นทางการจัดการทั้งหมดอยู่หลัง requireInternal - ผู้รับงานภายนอกไม่มีทางเห็นรายการ
 * คำขอของทั้งระบบ เส้นทางของผู้รับงานอยู่ภายใต้ /portal ซึ่งมีด่านของตัวเองแยกต่างหาก
 * ตามหลักที่ตั้งไว้ตั้งแต่พื้นที่ลูกค้า: ไม่ใช้ endpoint ร่วมกันแล้วค่อยกรองทีหลัง
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { badRequest } from '../../core/errors.js';
import { requireExternal, requireInternal } from '../auth/auth.guard.js';
import {
  createWorkflowRequest,
  getAssignedWorkflow,
  getWorkflowRequest,
  listAssignedWorkflows,
  listWorkflowRequests,
} from './workflow.service.js';
import { submitToWorkflow } from './submission.service.js';
import {
  approveWorkflow,
  rejectWorkflow,
  requestRevision,
  revokeWorkflow,
  startReview,
  workflowHistory,
} from './review.service.js';

const audit = (request: FastifyRequest) => ({
  ipAddress: request.ip,
  userAgent: request.headers['user-agent'],
});

const idParams = z.object({ id: z.string().min(1).max(191) });

/** วันที่รับเป็นข้อความ ISO แล้วแปลงเป็นเวลาสัมบูรณ์ - ไม่รับ timestamp ดิบจากผู้เรียก */
const isoDate = z.coerce.date();

const workflowStatus = z.enum([
  'OPEN', 'SUBMITTED', 'UNDER_REVIEW', 'REVISION_REQUESTED',
  'APPROVED', 'REJECTED', 'REVOKED', 'EXPIRED',
]);

export async function workflowRoutes(app: FastifyInstance): Promise<void> {
  app.post('/external-workflows', { preHandler: requireInternal }, async (request, reply) => {
    const input = z
      .object({
        title: z.string().min(1).max(191),
        instructions: z.string().max(2000).nullable().optional(),
        targetResourceId: z.string().min(1).max(191),
        externalUserId: z.string().min(1).max(191),
        expiresAt: isoDate.nullable().optional(),
        dueAt: isoDate.nullable().optional(),
        allowUpload: z.boolean().optional(),
        allowDownload: z.boolean().optional(),
      })
      .strict()
      .parse(request.body);

    const data = await createWorkflowRequest(request.authUser!, input, audit(request));
    return reply.code(201).send({ success: true, data });
  });

  app.get('/external-workflows', { preHandler: requireInternal }, async (request) => {
    const query = z
      .object({
        status: workflowStatus.optional(),
        targetResourceId: z.string().min(1).max(191).optional(),
        externalUserId: z.string().min(1).max(191).optional(),
        limit: z.coerce.number().int().min(1).max(200).optional(),
      })
      .parse(request.query);
    return { success: true, data: await listWorkflowRequests(request.authUser!, query) };
  });

  app.get('/external-workflows/:id', { preHandler: requireInternal }, async (request) => ({
    success: true,
    data: await getWorkflowRequest(request.authUser!, idParams.parse(request.params).id),
  }));

  app.get('/external-workflows/:id/history', { preHandler: requireInternal }, async (request) => ({
    success: true,
    data: await workflowHistory(request.authUser!, idParams.parse(request.params).id),
  }));

  /* ---------------- การตรวจงาน (F26-E) ---------------- */

  /**
   * ผู้เรียกไม่เคยส่งสถานะปัจจุบันมา - เซิร์ฟเวอร์อ่านเองและเปลี่ยนแบบ CAS
   *
   * ส่งได้เพียง submissionId ที่ตัวเองกำลังดูอยู่ ซึ่งใช้กันการตัดสินฉบับที่ล้าสมัย
   * ไม่ใช่ใช้เลือกว่าจะเปลี่ยนสถานะอะไร
   */
  const reviewBody = z
    .object({
      reason: z.string().max(500).nullable().optional(),
      submissionId: z.string().min(1).max(191).nullable().optional(),
    })
    .strict();

  app.post('/external-workflows/:id/review/start', { preHandler: requireInternal }, async (request) => ({
    success: true,
    data: await startReview(request.authUser!, idParams.parse(request.params).id, audit(request)),
  }));

  app.post('/external-workflows/:id/review/approve', { preHandler: requireInternal }, async (request) => ({
    success: true,
    data: await approveWorkflow(
      request.authUser!,
      idParams.parse(request.params).id,
      reviewBody.parse(request.body ?? {}),
      audit(request),
    ),
  }));

  app.post('/external-workflows/:id/review/reject', { preHandler: requireInternal }, async (request) => ({
    success: true,
    data: await rejectWorkflow(
      request.authUser!,
      idParams.parse(request.params).id,
      reviewBody.parse(request.body ?? {}),
      audit(request),
    ),
  }));

  app.post('/external-workflows/:id/review/request-revision', { preHandler: requireInternal }, async (request) => ({
    success: true,
    data: await requestRevision(
      request.authUser!,
      idParams.parse(request.params).id,
      reviewBody.parse(request.body ?? {}),
      audit(request),
    ),
  }));

  /* ---------------- การยกเลิก (F26-G) ---------------- */

  app.post('/external-workflows/:id/revoke', { preHandler: requireInternal }, async (request) => ({
    success: true,
    data: await revokeWorkflow(
      request.authUser!,
      idParams.parse(request.params).id,
      z.object({ reason: z.string().max(500).nullable().optional() }).strict().parse(request.body ?? {}),
      audit(request),
    ),
  }));

  /**
   * คำขอของผู้รับงานคนปัจจุบัน - รองรับหน้าจอของ F26-C
   *
   * ไม่รับพารามิเตอร์ระบุผู้ใช้เลย ขอบเขตมาจาก token เท่านั้น
   */
  app.get('/portal/workflows', { preHandler: requireExternal }, async (request) => ({
    success: true,
    data: await listAssignedWorkflows(request.authUser!),
  }));

  app.get('/portal/workflows/:id', { preHandler: requireExternal }, async (request) => ({
    success: true,
    data: await getAssignedWorkflow(request.authUser!, idParams.parse(request.params).id),
  }));

  /**
   * ส่งไฟล์เข้างานที่ได้รับมอบหมาย (F26-D)
   *
   * **ไม่มี field ใดใน multipart ที่เปลี่ยนปลายทางได้** ผู้เรียกส่งมาได้เพียงรหัสงาน
   * ใน path กับตัวไฟล์ โฟลเดอร์ปลายทางอ่านจากแถวคำขอฝั่งเซิร์ฟเวอร์เท่านั้น
   *
   * ถ้ามี field ที่พยายามกำหนดปลายทางติดมา จะถูก **ปฏิเสธทั้งคำขอ** ไม่ใช่เพิกเฉย
   * การเพิกเฉยทำให้ผู้เรียกเชื่อว่าคำสั่งของตัวเองมีผล แล้ววันหนึ่งจะมีคนสร้างระบบ
   * ที่พึ่งพาความเชื่อนั้น - ปฏิเสธเสียงดังตั้งแต่ครั้งแรกจะจบเรื่องได้เร็วกว่า
   */
  const FORBIDDEN_UPLOAD_FIELDS = ['parentId', 'folderId', 'destinationResourceId', 'targetResourceId', 'resourceId'];

  app.post('/portal/workflows/:id/submissions', { preHandler: requireExternal }, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const part = await request.file();
    if (!part) throw badRequest('FILE_MISSING', 'ไม่พบไฟล์ที่ส่ง');

    const supplied = Object.keys(part.fields ?? {});
    const offending = supplied.filter((field) => FORBIDDEN_UPLOAD_FIELDS.includes(field));
    if (offending.length > 0) {
      throw badRequest(
        'WORKFLOW_DESTINATION_NOT_ACCEPTED',
        'ปลายทางของการส่งงานกำหนดโดยระบบ ไม่รับค่าจากผู้ส่ง',
      );
    }

    const submission = await submitToWorkflow(
      request.authUser!,
      id,
      part.file,
      { fileName: part.filename, declaredMime: part.mimetype },
      audit(request),
    );
    return reply.status(201).send({ success: true, data: submission });
  });
}

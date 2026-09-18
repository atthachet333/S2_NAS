/**
 * เส้นทางของการกำกับดูแลวงจรชีวิตเอกสาร (F16)
 *
 * ทุกเส้นทางอยู่หลัง requireInternal - บัญชีลูกค้าภายนอกเข้าไม่ถึงเลย
 * การกำกับดูแลเป็นเรื่องภายในขององค์กร ลูกค้าไม่ควรรู้ด้วยซ้ำว่ามีความสามารถนี้อยู่
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireInternal } from '../auth/auth.guard.js';
import {
  assignPolicy,
  createPolicy,
  deletePolicy,
  executeReapplyPolicy,
  listPolicies,
  previewReapplyPolicy,
  seedDefaultPolicies,
  updatePolicy,
} from './retention.service.js';
import { archiveResource, unarchiveResource } from './archive.service.js';
import {
  legalHoldsForResource,
  listLegalHoldHistory,
  listLegalHolds,
  placeLegalHold,
  releaseLegalHold,
} from './legal-hold.service.js';
import { bulkArchive, bulkAssignRetention } from '../resources/bulk.service.js';
import { classificationImpact, setClassification } from './classification.service.js';

const idParams = z.object({ id: z.string().min(1) });
const audit = (request: FastifyRequest) => ({
  ipAddress: request.ip,
  userAgent: request.headers['user-agent'],
});
const resourceIds = z.array(z.string().min(1).max(191)).min(1).max(200);

export async function governanceRoutes(app: FastifyInstance): Promise<void> {
  /* ---------------- นโยบายการเก็บรักษา ---------------- */

  app.get('/retention-policies', { preHandler: requireInternal }, async (request) => {
    const query = z.object({ includeInactive: z.coerce.boolean().optional() }).parse(request.query);
    return {
      success: true,
      data: await listPolicies(request.authUser!, { includeInactive: query.includeInactive }),
    };
  });

  app.post('/retention-policies', { preHandler: requireInternal }, async (request, reply) => {
    const input = z
      .object({
        name: z.string().min(1).max(100),
        description: z.string().max(500).nullable().optional(),
        retentionDays: z.number().int().min(1).max(36_500).nullable().optional(),
        retainForever: z.boolean().optional(),
        sortOrder: z.number().int().optional(),
      })
      .strict()
      .parse(request.body);
    return reply
      .status(201)
      .send({ success: true, data: await createPolicy(request.authUser!, input) });
  });

  app.patch('/retention-policies/:id', { preHandler: requireInternal }, async (request) => {
    const { id } = idParams.parse(request.params);
    const input = z
      .object({
        name: z.string().min(1).max(100).optional(),
        description: z.string().max(500).nullable().optional(),
        retentionDays: z.number().int().min(1).max(36_500).nullable().optional(),
        retainForever: z.boolean().optional(),
        isActive: z.boolean().optional(),
        sortOrder: z.number().int().optional(),
      })
      .strict()
      .refine((value) => Object.keys(value).length > 0)
      .parse(request.body);
    return { success: true, data: await updatePolicy(id, request.authUser!, input) };
  });

  app.delete('/retention-policies/:id', { preHandler: requireInternal }, async (request) => ({
    success: true,
    data: await deletePolicy(idParams.parse(request.params).id, request.authUser!),
  }));

  /**
   * คำนวณวันหมดอายุใหม่ให้เอกสารที่ใช้นโยบายนี้
   *
   * เป็นการกระทำที่ต้องกดเอง ไม่ใช่ผลข้างเคียงของการแก้นิยามนโยบาย
   * เพราะมันเปลี่ยนวันหมดอายุของเอกสารจำนวนมากพร้อมกัน
   */
  app.get('/retention-policies/:id/reapply-preview', { preHandler: requireInternal }, async (request) => ({
    success: true,
    data: await previewReapplyPolicy(idParams.parse(request.params).id, request.authUser!),
  }));

  app.post('/retention-policies/:id/reapply', { preHandler: requireInternal }, async (request) => {
    const input = z
      .object({ previewToken: z.string().min(20).max(2_000_000), reason: z.string().max(500).nullable().optional() })
      .strict()
      .parse(request.body);
    return {
      success: true,
      data: await executeReapplyPolicy(
        idParams.parse(request.params).id,
        request.authUser!,
        input,
        audit(request),
      ),
    };
  });

  app.post('/retention-policies/seed-defaults', { preHandler: requireInternal }, async (request) => ({
    success: true,
    data: await seedDefaultPolicies(request.authUser!),
  }));

  /* ---------------- กำหนดนโยบายให้เอกสาร ---------------- */

  app.put('/resources/:id/retention', { preHandler: requireInternal }, async (request) => {
    const { id } = idParams.parse(request.params);
    const input = z
      .object({
        policyId: z.string().min(1).max(191).nullable(),
        /** วันเริ่มนับ - ไม่ระบุ = ใช้วันที่นำเข้าระบบ ไม่มีการเดาจากเนื้อในเอกสาร */
        startAt: z.coerce.date().nullable().optional(),
        reason: z.string().max(500).nullable().optional(),
      })
      .strict()
      .parse(request.body);
    return {
      success: true,
      data: await assignPolicy(id, request.authUser!, input, audit(request)),
    };
  });

  /* ---------------- คลังเอกสาร ---------------- */

  app.post('/resources/:id/archive', { preHandler: requireInternal }, async (request) => ({
    success: true,
    data: await archiveResource(idParams.parse(request.params).id, request.authUser!, audit(request)),
  }));

  app.post('/resources/:id/unarchive', { preHandler: requireInternal }, async (request) => ({
    success: true,
    data: await unarchiveResource(
      idParams.parse(request.params).id,
      request.authUser!,
      audit(request),
    ),
  }));

  /* ---------------- ชั้นความลับ (F25-D) ---------------- */

  const classificationLevel = z.enum(['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED']);

  /**
   * ดูผลกระทบก่อนเปลี่ยน - อ่านอย่างเดียว ไม่เปลี่ยนอะไรทั้งสิ้น
   *
   * แยกเป็นเส้นทางของตัวเองเพื่อให้หน้าจอเตือนได้ "ก่อน" ผู้ใช้กดยืนยัน
   * ถ้าให้หน้าจอคำนวณเอง คำเตือนกับสิ่งที่เซิร์ฟเวอร์ทำจริงจะค่อย ๆ ห่างกันตามเวลา
   */
  app.get('/resources/:id/classification/impact', { preHandler: requireInternal }, async (request) => ({
    success: true,
    data: await classificationImpact(
      idParams.parse(request.params).id,
      request.authUser!,
      z.object({ level: classificationLevel }).parse(request.query).level,
    ),
  }));

  app.patch('/resources/:id/classification', { preHandler: requireInternal }, async (request) => {
    const { id } = idParams.parse(request.params);
    const input = z
      .object({
        level: classificationLevel,
        // ตรวจความยาวขั้นต่ำที่ service ไม่ใช่ที่นี่ เพราะบังคับเฉพาะตอนลดชั้น
        reason: z.string().max(500).nullable().optional(),
      })
      .strict()
      .parse(request.body);
    return { success: true, data: await setClassification(id, request.authUser!, input, audit(request)) };
  });

  /* ---------------- การระงับการลบ ---------------- */

  app.get('/legal-holds', { preHandler: requireInternal }, async (request) => {
    const query = z.object({ includeReleased: z.coerce.boolean().optional() }).parse(request.query);
    return {
      success: true,
      data: await listLegalHolds(request.authUser!, { includeReleased: query.includeReleased }),
    };
  });

  app.get('/legal-hold-history', { preHandler: requireInternal }, async (request) => {
    const query = z
      .object({ resourceId: z.string().max(191).optional(), includeActive: z.coerce.boolean().optional() })
      .parse(request.query);
    return { success: true, data: await listLegalHoldHistory(request.authUser!, query) };
  });

  app.post('/resources/:id/legal-hold', { preHandler: requireInternal }, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const input = z
      .object({
        reason: z.string().min(1).max(500),
        caseReference: z.string().max(191).nullable().optional(),
      })
      .strict()
      .parse(request.body);
    return reply
      .status(201)
      .send({ success: true, data: await placeLegalHold(id, request.authUser!, input, audit(request)) });
  });

  /** ประวัติการระงับของเอกสารหนึ่งฉบับ - เหตุผลถูกซ่อนจากผู้ที่ไม่ได้จัดการการระงับ */
  app.get('/resources/:id/legal-holds', { preHandler: requireInternal }, async (request) => ({
    success: true,
    data: await legalHoldsForResource(idParams.parse(request.params).id, request.authUser!),
  }));

  app.post('/legal-holds/:id/release', { preHandler: requireInternal }, async (request) => {
    const { id } = idParams.parse(request.params);
    const input = z
      .object({ releaseReason: z.string().trim().min(1).max(500) })
      .strict()
      .parse(request.body);
    return {
      success: true,
      data: await releaseLegalHold(id, request.authUser!, input, audit(request)),
    };
  });

  /* ---------------- งานหลายรายการ ---------------- */

  app.post('/resources/bulk/retention', { preHandler: requireInternal }, async (request) => {
    const input = z
      .object({
        resourceIds,
        policyId: z.string().min(1).max(191).nullable(),
        reason: z.string().max(500).nullable().optional(),
      })
      .strict()
      .parse(request.body);
    return {
      success: true,
      data: await bulkAssignRetention(
        input.resourceIds,
        input.policyId,
        request.authUser!,
        audit(request),
        input.reason,
      ),
    };
  });

  app.post('/resources/bulk/archive', { preHandler: requireInternal }, async (request) => {
    const input = z.object({ resourceIds }).strict().parse(request.body);
    return {
      success: true,
      data: await bulkArchive(input.resourceIds, request.authUser!, audit(request)),
    };
  });
}

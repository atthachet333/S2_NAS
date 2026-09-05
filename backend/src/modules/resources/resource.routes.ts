import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireInternal, requirePermission } from '../auth/auth.guard.js';
import { prisma } from '../../core/prisma.js';
import { AppError } from '../../core/errors.js';
import { ocrStateFor, requestOcr } from '../search/ocr/ocr.service.js';
import { breadcrumb, createExternalResource, createFolder, getResource, listRecentResources, listResources, moveResource, ownershipOverview, softDeleteResource, transferOwner, updateResource } from './resource.service.js';
import { EXTERNAL_RESOURCE_TYPES } from './external-resource.js';

const idParams = z.object({ id: z.string().min(1) });
/** ไดร์ฟที่ผู้เรียกระบุได้ - ใช้เฉพาะที่ระดับรากเท่านั้น ในโฟลเดอร์จะสืบทอดจากโฟลเดอร์แม่ */
const driveScopeSchema = z.enum(['MY_DRIVE', 'SYSTEM_DRIVE']);
const audit = (request: FastifyRequest) => ({ ipAddress: request.ip, userAgent: request.headers['user-agent'] });

export async function resourceRoutes(app: FastifyInstance): Promise<void> {
  app.get('/resources', { preHandler: requireInternal }, async (request) => {
    const input = z.object({ parentId: z.string().optional(), type: z.enum(['FILE','FOLDER','GOOGLE_SHEET','GOOGLE_DOC','GOOGLE_DRIVE','WEB_LINK','SYSTEM_FILE','SHORTCUT']).optional(), ownerId: z.string().optional(), sort: z.enum(['name','updatedAt','createdAt','size']).default('name'), direction: z.enum(['asc','desc']).default('asc'), limit: z.coerce.number().int().min(1).max(100).default(50), cursor: z.string().optional(), driveScope: driveScopeSchema.optional() }).parse(request.query);
    return { success: true, data: await listResources(request.authUser!, { ...input, parentId: input.parentId ?? null }) };
  });

  /** ทรัพยากรที่เพิ่งอัปโหลด/แก้ไข/เพิ่มเวอร์ชันล่าสุด เรียงใหม่ก่อน */
  app.get('/resources-recent', { preHandler: requireInternal }, async (request) => {
    const input = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50) }).parse(request.query);
    return { success: true, data: await listRecentResources(request.authUser!, input.limit) };
  });

  app.get('/resources/:id', { preHandler: requireInternal }, async (request) => ({ success: true, data: await getResource(idParams.parse(request.params).id, request.authUser!) }));
  app.get('/resources/:id/breadcrumb', { preHandler: requireInternal }, async (request) => ({ success: true, data: await breadcrumb(idParams.parse(request.params).id, request.authUser!) }));

  app.post('/folders', { preHandler: requireInternal }, async (request, reply) => {
    const input = z.object({ name: z.string(), parentId: z.string().nullable().optional(), ownerId: z.string().optional(), remark: z.string().max(1000).nullable().optional(), driveScope: driveScopeSchema.optional() }).parse(request.body);
    return reply.status(201).send({ success: true, data: await createFolder(request.authUser!, input, audit(request)) });
  });

  app.post('/resources/external', { preHandler: requireInternal }, async (request, reply) => {
    const input = z.object({
      type: z.enum(EXTERNAL_RESOURCE_TYPES),
      name: z.string(),
      parentId: z.string().nullable().optional(),
      url: z.string().max(2048),
      remark: z.string().max(1000).nullable().optional(),
      driveScope: driveScopeSchema.optional(),
    }).strict().parse(request.body);
    return reply.status(201).send({ success: true, data: await createExternalResource(request.authUser!, input, audit(request)) });
  });

  app.patch('/resources/:id', { preHandler: requireInternal }, async (request) => {
    const input = z.object({ name: z.string().optional(), remark: z.string().max(1000).nullable().optional(), isLocked: z.boolean().optional(), externalUrl: z.string().max(2048).optional() }).strict().refine((value) => Object.keys(value).length > 0).parse(request.body);
    return { success: true, data: await updateResource(idParams.parse(request.params).id, request.authUser!, input, audit(request)) };
  });

  app.patch('/resources/:id/move', { preHandler: requireInternal }, async (request) => {
    const input = z.object({ parentId: z.string().nullable(), driveScope: driveScopeSchema.optional() }).parse(request.body);
    return { success: true, data: await moveResource(idParams.parse(request.params).id, request.authUser!, input.parentId, audit(request), input.driveScope) };
  });

  app.patch('/resources/:id/owner', { preHandler: requireInternal }, async (request) => {
    const input = z.object({ newOwnerId: z.string().min(1) }).parse(request.body);
    return { success: true, data: await transferOwner(idParams.parse(request.params).id, request.authUser!, input.newOwnerId, audit(request)) };
  });

  app.delete('/resources/:id', { preHandler: requireInternal }, async (request) => ({ success: true, data: await softDeleteResource(idParams.parse(request.params).id, request.authUser!, audit(request)) }));
  /* ---------------- OCR แบบสั่งเอง ---------------- */

  /** สถานะ OCR ของไฟล์ - ใช้ตัดสินว่าจะแสดงปุ่มอะไรบนหน้าจอ */
  app.get('/resources/:id/ocr', { preHandler: requireInternal }, async (request) => {
    const { id } = idParams.parse(request.params);
    // ต้องมองเห็นทรัพยากรก่อนจึงจะรู้สถานะของมันได้
    await getResource(id, request.authUser!);
    return { success: true, data: await ocrStateFor(id) };
  });

  /**
   * สั่งอ่านข้อความจากเอกสาร
   *
   * ใช้ capability เดิมของทรัพยากร - ผู้ที่แก้ไขไฟล์ได้เท่านั้นจึงสั่งได้
   * ผู้ที่เปิดดูได้อย่างเดียวสั่งไม่ได้ เพราะ OCR กิน CPU ของเครื่องทั้งเครื่อง
   * และไม่ควรเป็นสิ่งที่ใครก็ตามที่เห็นไฟล์สั่งได้ตามใจ
   */
  app.post('/resources/:id/ocr', { preHandler: requireInternal }, async (request) => {
    const { id } = idParams.parse(request.params);
    const resource = await getResource(id, request.authUser!);
    if (!resource.capabilities.canEdit) {
      throw new AppError('OCR_DENIED', 'ต้องมีสิทธิ์แก้ไขไฟล์นี้จึงจะสั่งอ่านข้อความได้', 403);
    }

    const result = await requestOcr(id);
    await prisma.activityLog.create({
      data: {
        userId: request.authUser!.id,
        action: 'OCR_REQUESTED',
        resourceId: id,
        ipAddress: request.ip,
        userAgent: request.headers['user-agent']?.slice(0, 500),
        // ห้ามบันทึกข้อความที่อ่านได้ลง audit - มีความลับเท่ากับตัวเอกสาร
        metadata: {},
      },
    });
    return { success: true, data: result };
  });

  app.get('/admin/ownership', { preHandler: requirePermission('admin:access') }, async () => ({ success: true, data: await ownershipOverview() }));
}

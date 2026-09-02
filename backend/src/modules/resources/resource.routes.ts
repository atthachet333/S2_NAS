import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { authenticate, requirePermission } from '../auth/auth.guard.js';
import { breadcrumb, createFolder, getResource, listRecentResources, listResources, moveResource, ownershipOverview, softDeleteResource, transferOwner, updateResource } from './resource.service.js';

const idParams = z.object({ id: z.string().min(1) });
const audit = (request: FastifyRequest) => ({ ipAddress: request.ip, userAgent: request.headers['user-agent'] });

export async function resourceRoutes(app: FastifyInstance): Promise<void> {
  app.get('/resources', { preHandler: authenticate }, async (request) => {
    const input = z.object({ parentId: z.string().optional(), type: z.enum(['FILE','FOLDER','GOOGLE_SHEET','GOOGLE_DOC','GOOGLE_DRIVE','WEB_LINK','SYSTEM_FILE','SHORTCUT']).optional(), ownerId: z.string().optional(), sort: z.enum(['name','updatedAt','createdAt','size']).default('name'), direction: z.enum(['asc','desc']).default('asc'), limit: z.coerce.number().int().min(1).max(100).default(50), cursor: z.string().optional() }).parse(request.query);
    return { success: true, data: await listResources(request.authUser!, { ...input, parentId: input.parentId ?? null }) };
  });

  /** ทรัพยากรที่เพิ่งอัปโหลด/แก้ไข/เพิ่มเวอร์ชันล่าสุด เรียงใหม่ก่อน */
  app.get('/resources-recent', { preHandler: authenticate }, async (request) => {
    const input = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50) }).parse(request.query);
    return { success: true, data: await listRecentResources(request.authUser!, input.limit) };
  });

  app.get('/resources/:id', { preHandler: authenticate }, async (request) => ({ success: true, data: await getResource(idParams.parse(request.params).id, request.authUser!) }));
  app.get('/resources/:id/breadcrumb', { preHandler: authenticate }, async (request) => ({ success: true, data: await breadcrumb(idParams.parse(request.params).id, request.authUser!) }));

  app.post('/folders', { preHandler: authenticate }, async (request, reply) => {
    const input = z.object({ name: z.string(), parentId: z.string().nullable().optional(), ownerId: z.string().optional(), remark: z.string().max(1000).nullable().optional() }).parse(request.body);
    return reply.status(201).send({ success: true, data: await createFolder(request.authUser!, input, audit(request)) });
  });

  app.patch('/resources/:id', { preHandler: authenticate }, async (request) => {
    const input = z.object({ name: z.string().optional(), remark: z.string().max(1000).nullable().optional(), isLocked: z.boolean().optional() }).refine((value) => Object.keys(value).length > 0).parse(request.body);
    return { success: true, data: await updateResource(idParams.parse(request.params).id, request.authUser!, input, audit(request)) };
  });

  app.patch('/resources/:id/move', { preHandler: authenticate }, async (request) => {
    const input = z.object({ parentId: z.string().nullable() }).parse(request.body);
    return { success: true, data: await moveResource(idParams.parse(request.params).id, request.authUser!, input.parentId, audit(request)) };
  });

  app.patch('/resources/:id/owner', { preHandler: authenticate }, async (request) => {
    const input = z.object({ newOwnerId: z.string().min(1) }).parse(request.body);
    return { success: true, data: await transferOwner(idParams.parse(request.params).id, request.authUser!, input.newOwnerId, audit(request)) };
  });

  app.delete('/resources/:id', { preHandler: authenticate }, async (request) => ({ success: true, data: await softDeleteResource(idParams.parse(request.params).id, request.authUser!, audit(request)) }));
  app.get('/admin/ownership', { preHandler: requirePermission('admin:access') }, async () => ({ success: true, data: await ownershipOverview() }));
}

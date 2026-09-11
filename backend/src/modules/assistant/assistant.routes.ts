import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { requireInternal, requirePermission } from '../auth/auth.guard.js';
import { prisma } from '../../core/prisma.js';
import { answerAssistantThread, assistantDiagnostics, createAssistantThread, deleteAssistantThread, getAssistantThread, listAssistantThreads } from './assistant.service.js';

const scope = z.enum(['CURRENT_RESOURCE', 'SELECTED_RESOURCES', 'AUTHORIZED_LIBRARY']);
const createSchema = z.object({ scope, resourceIds: z.array(z.string().min(1).max(191)).max(20).default([]), includeArchived: z.boolean().optional(), title: z.string().max(191).optional() });
const messageSchema = z.object({ question: z.string().min(1).max(4000), clientRequestId: z.string().min(8).max(100), mode: z.enum(['QA','SUMMARY','COMPARE','EXTRACT']).default('QA') });
const audit = (request: FastifyRequest, action: string, metadata?: Record<string, unknown>) => prisma.activityLog.create({ data: {
  userId: request.authUser!.id, action, ipAddress: request.ip, userAgent: request.headers['user-agent']?.slice(0, 500), metadata: metadata as Prisma.InputJsonValue | undefined,
} });

export async function assistantRoutes(app: FastifyInstance): Promise<void> {
  app.get('/assistant/health', { preHandler: requireInternal }, async (_r, reply) => reply.send({ success: true, data: await assistantDiagnostics() }));
  app.get('/admin/assistant', { preHandler: requirePermission('system:settings:manage') }, async (_r, reply) => reply.send({ success: true, data: await assistantDiagnostics() }));
  app.get('/assistant/threads', { preHandler: requireInternal }, async (r, reply) => reply.send({ success: true, data: await listAssistantThreads(r.authUser!) }));
  app.post('/assistant/threads', { preHandler: requireInternal }, async (r, reply) => {
    const input = createSchema.parse(r.body); const data = await createAssistantThread(input, r.authUser!);
    await audit(r, 'ASSISTANT_THREAD_CREATED', { scope: input.scope, resourceCount: input.resourceIds.length }); return reply.status(201).send({ success: true, data });
  });
  app.get('/assistant/threads/:id', { preHandler: requireInternal }, async (r, reply) => reply.send({ success: true, data: await getAssistantThread(z.object({ id: z.string() }).parse(r.params).id, r.authUser!) }));
  app.delete('/assistant/threads/:id', { preHandler: requireInternal }, async (r, reply) => reply.send({ success: true, data: await deleteAssistantThread(z.object({ id: z.string() }).parse(r.params).id, r.authUser!) }));
  app.post('/assistant/threads/:id/messages', { preHandler: requireInternal }, async (r, reply) => {
    const started = Date.now(); const { id } = z.object({ id: z.string() }).parse(r.params); const input = messageSchema.parse(r.body);
    try { const data = await answerAssistantThread({ threadId: id, ...input }, r.authUser!);
      await audit(r, 'ASSISTANT_ANSWER_GENERATED', { durationMs: Date.now() - started, citationCount: data.citations.length }); return reply.send({ success: true, data });
    } catch (error) { await audit(r, 'ASSISTANT_GENERATION_FAILED', { durationMs: Date.now() - started,
      errorCode: error instanceof Error && 'code' in error ? String((error as { code: unknown }).code) : error instanceof Error ? error.name : 'UNKNOWN' }); throw error; }
  });
}

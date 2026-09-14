import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireInternal } from '../auth/auth.guard.js';
import { acceptSuggestion, analyzeResource, currentSuggestion, dismissSuggestion } from './filing.service.js';

/**
 * เส้นทาง API ของการจัดเก็บอัจฉริยะ (F22-C/D)
 *
 * ทุกเส้นทางต้องเป็นผู้ใช้ภายในที่เข้าสู่ระบบแล้ว ไม่มีการเปิดให้พื้นที่ลูกค้าใช้ในเฟสนี้
 *
 * เส้นทางที่เปลี่ยนสถานะมีเพียง accept เส้นทางเดียว การวิเคราะห์ การอ่าน และการปฏิเสธ
 * ไม่เคยทำให้เอกสารเคลื่อนที่ ซึ่งเป็นข้อกำหนดที่มีชุดทดสอบบังคับไว้โดยตรง
 */

const idParams = z.object({ id: z.string().min(1).max(191) });
const dismissSchema = z.object({ suggestionId: z.string().min(1).max(191) });
const acceptSchema = z.object({
  suggestionId: z.string().min(1).max(191),
  /** ปลายทางที่ผู้ใช้เลือกเอง - จำเป็นเมื่อผลกำกวมหรือเมื่อผู้ใช้เลือกโฟลเดอร์อื่น */
  targetFolderId: z.string().min(1).max(191).optional(),
});

export async function smartFilingRoutes(app: FastifyInstance): Promise<void> {
  app.post('/resources/:id/smart-filing/analyze', { preHandler: requireInternal }, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    return reply.send({ success: true, data: await analyzeResource(id, request.authUser!) });
  });

  app.get('/resources/:id/smart-filing/suggestion', { preHandler: requireInternal }, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    return reply.send({ success: true, data: await currentSuggestion(id, request.authUser!) });
  });

  app.post('/resources/:id/smart-filing/dismiss', { preHandler: requireInternal }, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const input = dismissSchema.parse(request.body);
    return reply.send({ success: true, data: await dismissSuggestion(id, input.suggestionId, request.authUser!) });
  });

  app.post('/resources/:id/smart-filing/accept', { preHandler: requireInternal }, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const input = acceptSchema.parse(request.body);
    const data = await acceptSuggestion(id, input, request.authUser!, {
      ipAddress: request.ip, userAgent: request.headers['user-agent']?.slice(0, 500),
    });
    return reply.send({ success: true, data });
  });
}

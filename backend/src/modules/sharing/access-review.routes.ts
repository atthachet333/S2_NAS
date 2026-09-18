import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../core/prisma.js';
import { AppError } from '../../core/errors.js';
import { requireInternal } from '../auth/auth.guard.js';
import { isAdminUser } from '../resources/system-drive.js';
import { accessReviewCsv, effectiveAccessReview } from './access-review.service.js';

const paramsSchema = z.object({ id: z.string().min(1).max(191) });

function assertReviewAdmin(request: FastifyRequest): void {
  if (!isAdminUser(request.authUser!)) {
    throw new AppError('ACCESS_REVIEW_DENIED', 'ไม่มีสิทธิ์ตรวจสอบการเข้าถึงทั้งองค์กร', 403);
  }
}

export async function accessReviewRoutes(app: FastifyInstance): Promise<void> {
  app.get('/resources/:id/access-review', { preHandler: requireInternal }, async (request) => {
    assertReviewAdmin(request);
    const { id } = paramsSchema.parse(request.params);
    return { success: true, data: await effectiveAccessReview(id) };
  });

  app.get('/resources/:id/access-review/export', { preHandler: requireInternal }, async (request, reply) => {
    assertReviewAdmin(request);
    const { id } = paramsSchema.parse(request.params);
    const review = await effectiveAccessReview(id);
    const csv = accessReviewCsv(review);
    await prisma.activityLog.create({
      data: {
        userId: request.authUser!.id,
        action: 'ACCESS_EXPORT_CREATED',
        resourceId: id,
        ipAddress: request.ip,
        userAgent: request.headers['user-agent']?.slice(0, 500),
        metadata: { format: 'CSV', rowCount: review.entries.length },
      },
    });
    return reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="s2-nas-access-review-${id.replace(/[^a-zA-Z0-9_-]/gu, '_')}.csv"`)
      .send(csv);
  });
}

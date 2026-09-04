import type { FastifyInstance } from 'fastify';
import { requireInternal } from '../auth/auth.guard.js';
import { getDashboardSummary } from './dashboard.service.js';

export async function dashboardRoutes(app: FastifyInstance): Promise<void> {
  app.get('/dashboard/summary', { preHandler: requireInternal }, async (request) => ({
    success: true,
    data: await getDashboardSummary(request.authUser!),
  }));
}

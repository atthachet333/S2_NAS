import type { FastifyInstance } from 'fastify';
import { BRAND } from '../../config/branding.js';
import { checkDatabase } from '../../core/database.js';
import { verifyStorage } from '../../core/storage.js';

/**
 * GET /api/health
 * {
 *   "status": "ok",
 *   "service": "S2 NAS",
 *   "database": "connected",
 *   "storage": "ready",
 *   "uptime": 12345
 * }
 */
export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health', async (_request, reply) => {
    const [db, storage] = await Promise.all([checkDatabase(), verifyStorage()]);

    const database =
      db.status === 'CONNECTED'
        ? 'connected'
        : db.status === 'NOT_CONFIGURED'
          ? 'not_configured'
          : 'disconnected';

    const storageState =
      storage.status === 'READY'
        ? 'ready'
        : storage.status === 'READ_ONLY'
          ? 'read_only'
          : 'unavailable';

    const healthy = database === 'connected' && storageState === 'ready';
    const degraded = storageState === 'ready' && database !== 'connected';

    const status = healthy ? 'ok' : degraded ? 'degraded' : 'error';

    reply.status(healthy || degraded ? 200 : 503).send({
      status,
      service: BRAND.service,
      database,
      storage: storageState,
      uptime: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
    });
  });
}

import Fastify, {
  LogController,
  type FastifyBaseLogger,
  type FastifyInstance,
} from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import { env } from './config/env.js';
import { logger } from './core/logger.js';
import { registerErrorHandler } from './plugins/error-handler.js';
import { registerRequestLogging } from './plugins/request-logging.js';
import { healthRoutes } from './modules/health/health.routes.js';
import { systemRoutes } from './modules/system/system.routes.js';
import { backupRoutes } from './modules/backup/backup.routes.js';
import { authRoutes } from './modules/auth/auth.routes.js';
import { usersRoutes } from './modules/users/users.routes.js';
import { resourceRoutes } from './modules/resources/resource.routes.js';
import { dashboardRoutes } from './modules/dashboard/dashboard.routes.js';
import { fileRoutes } from './modules/files/file.routes.js';
import { workspaceRoutes } from './modules/workspace/workspace.routes.js';
import { integrationRoutes } from './modules/integrations/integration.routes.js';
import { portalRoutes } from './modules/portal/portal.routes.js';

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    loggerInstance: logger as FastifyBaseLogger,
    // ปิด request log มาตรฐานของ Fastify แล้วใช้รูปแบบของ S2 NAS แทน
    logController: new LogController({ disableRequestLogging: true }),
    trustProxy: true,
    bodyLimit: env.MAX_UPLOAD_SIZE_BYTES,
  });

  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, {
    origin: env.corsOrigins,
    credentials: true,
  });
  await app.register(cookie);
  await app.register(multipart, {
    limits: {
      fileSize: env.MAX_UPLOAD_SIZE_BYTES,
      files: 1,
      fields: 10,
      fieldSize: 1024 * 100,
    },
  });
  await app.register(rateLimit, { global: false });

  await registerRequestLogging(app);
  await registerErrorHandler(app);

  // ทุก API อยู่ใต้ /api - storage ไม่ถูก serve เป็น static public directory
  await app.register(
    async (api) => {
      await api.register(healthRoutes);
      await api.register(systemRoutes);
      await api.register(authRoutes);
      await api.register(usersRoutes);
      await api.register(resourceRoutes);
      await api.register(dashboardRoutes);
      await api.register(fileRoutes);
      await api.register(workspaceRoutes);
      await api.register(integrationRoutes);
      await api.register(portalRoutes);
      await api.register(backupRoutes);
    },
    { prefix: '/api' },
  );

  return app;
}

import type { FastifyInstance } from 'fastify';
import { BRAND } from '../../config/branding.js';
import { env } from '../../config/env.js';
import { getLastDatabaseCheck, checkDatabase } from '../../core/database.js';
import { getStorageUsage, verifyStorage } from '../../core/storage.js';

/**
 * ข้อมูลระบบสำหรับ Dashboard
 * หมายเหตุความปลอดภัย: ห้ามส่ง physical path จริงของ server กลับไปยัง browser
 */
export async function systemRoutes(app: FastifyInstance): Promise<void> {
  app.get('/system/info', async () => {
    const db = getLastDatabaseCheck() ?? (await checkDatabase());
    return {
      success: true,
      data: {
        service: BRAND.service,
        subtitle: BRAND.subtitle,
        environment: env.NODE_ENV,
        version: '0.1.0',
        phase: 1,
        uptime: Math.round(process.uptime()),
        database: db.status,
        maxUploadSizeMb: env.MAX_UPLOAD_SIZE_MB,
      },
    };
  });

  app.get('/system/storage', async () => {
    const [check, usage] = await Promise.all([verifyStorage(), getStorageUsage()]);
    return {
      success: true,
      data: {
        status: check.status,
        readable: check.readable,
        writable: check.writable,
        // ส่งเฉพาะตัวเลข ไม่ส่ง physical path
        totalBytes: usage?.totalBytes ?? null,
        usedBytes: usage?.usedBytes ?? null,
        freeBytes: usage?.freeBytes ?? null,
      },
    };
  });
}

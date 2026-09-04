import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { BRAND } from '../../config/branding.js';
import { env } from '../../config/env.js';
import { getLastDatabaseCheck, checkDatabase } from '../../core/database.js';
import { getStorageUsage, verifyStorage } from '../../core/storage.js';
import { requirePermission } from '../auth/auth.guard.js';
import { getSetting, listSettings, resetSetting, updateSettings } from './settings.service.js';
import { notFound } from '../../core/errors.js';
import {
  indexDiagnostics,
  reindexAll,
  reindexResource,
  retryFailed,
} from '../search/search-index.service.js';

/** สิทธิ์เฉพาะสำหรับแก้ค่าการทำงานของระบบ - แยกจาก admin:access โดยตั้งใจ */
export const MANAGE_SETTINGS_PERMISSION = 'system:settings:manage';

const settingsAudit = (request: FastifyRequest) => ({
  ipAddress: request.ip,
  userAgent: request.headers['user-agent'],
});

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
        // ค่าที่มีผลจริง ไม่ใช่ค่าที่ตั้งไว้ใน environment เพียงอย่างเดียว
        maxUploadSizeMb: await getSetting('MAX_UPLOAD_SIZE_MB'),
      },
    };
  });

  /* ---------------- ค่าตั้งค่าการทำงาน (ผู้ดูแลระบบเท่านั้น) ---------------- */

  /**
   * สถานะของคิวสกัดข้อความ
   * ไม่มีเส้นทางจริงบนดิสก์ ไม่มีชื่อไฟล์ และไม่มีข้อความของเอกสารใด ๆ ในผลลัพธ์
   */
  app.get('/admin/search-index', { preHandler: requirePermission(MANAGE_SETTINGS_PERMISSION) }, async () => ({
    success: true,
    data: await indexDiagnostics(env.S2_NAS_EXTRACT_ENABLED === 1),
  }));

  /** สั่งทำดัชนีใหม่ของทรัพยากรหนึ่งชิ้น */
  app.post(
    '/admin/search-index/reindex/:id',
    { preHandler: requirePermission(MANAGE_SETTINGS_PERMISSION) },
    async (request) => {
      const { id } = z.object({ id: z.string().min(1).max(191) }).parse(request.params);
      const queued = await reindexResource(id);
      if (!queued) throw notFound('RESOURCE_NOT_FOUND', 'ไม่พบไฟล์ที่ทำดัชนีได้');
      return { success: true, data: { queued: 1 } };
    },
  );

  /**
   * สั่งทำดัชนีใหม่ทั้งระบบ - เข้าคิวเท่านั้น ไม่ทำงานทันที
   * สงวนไว้ให้ผู้ดูแลระบบ เพราะเป็นงานที่กินทรัพยากรทั้งเครื่อง
   */
  app.post(
    '/admin/search-index/reindex-all',
    { preHandler: requirePermission(MANAGE_SETTINGS_PERMISSION) },
    async () => ({ success: true, data: { queued: await reindexAll() } }),
  );

  /** ลองใหม่เฉพาะงานที่ล้มเหลวแบบไม่ถาวร - ชนิดที่ไม่รองรับจะไม่ถูกลองซ้ำไปเรื่อย ๆ */
  app.post(
    '/admin/search-index/retry-failed',
    { preHandler: requirePermission(MANAGE_SETTINGS_PERMISSION) },
    async () => ({ success: true, data: { queued: await retryFailed() } }),
  );

  app.get('/admin/settings', { preHandler: requirePermission(MANAGE_SETTINGS_PERMISSION) }, async () => ({
    success: true,
    data: await listSettings(),
  }));

  app.patch('/admin/settings', { preHandler: requirePermission(MANAGE_SETTINGS_PERMISSION) }, async (request) => {
    // รับเป็น object ดิบแล้วให้ service ตรวจทีละคีย์ เพื่อให้ข้อความบอกได้ว่าคีย์ไหนผิด
    const body = z.record(z.string(), z.unknown()).parse(request.body);
    return { success: true, data: await updateSettings(request.authUser!, body, settingsAudit(request)) };
  });

  app.delete(
    '/admin/settings/:key',
    { preHandler: requirePermission(MANAGE_SETTINGS_PERMISSION) },
    async (request) => {
      const { key } = z.object({ key: z.string().min(1) }).parse(request.params);
      return { success: true, data: await resetSetting(request.authUser!, key, settingsAudit(request)) };
    },
  );

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

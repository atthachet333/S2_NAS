/**
 * เส้นทางของเครื่องมือตรวจสอบ (F17)
 *
 * **อ่านอย่างเดียวทั้งหมด** ไม่มี POST/PATCH/DELETE ที่แก้บันทึกได้เลย
 * มีเพียง POST เดียวคือการส่งออก ซึ่งไม่เปลี่ยนบันทึกเดิม แต่เพิ่มบันทึกใหม่ว่ามีการส่งออก
 *
 * ทุกเส้นทางอยู่หลัง requireInternal และยังตรวจสิทธิ์ audit อีกชั้นในบริการ
 * บัญชีลูกค้าและบัญชีบริการจึงเข้าไม่ถึงไม่ว่าจะมี permission อะไรติดมา
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireInternal } from '../auth/auth.guard.js';
import {
  canExportAudit,
  canViewAudit,
  getAuditEvent,
  resourceTimeline,
  searchAuditEvents,
  type AuditFilters,
} from './audit.service.js';
import { exportAuditCsv } from './audit-export.js';
import { AUDIT_PRESETS, CATEGORY_LABELS, EVENT_CATALOG, EVENT_CATEGORIES } from './event-catalog.js';

const audit = (request: FastifyRequest) => ({
  ipAddress: request.ip,
  userAgent: request.headers['user-agent'],
});

/** ตัวกรองใช้ schema เดียวกันทั้งการค้นหาและการส่งออก - ไม่มีเส้นทางที่กว้างกว่า */
const filterSchema = z.object({
  q: z.string().max(191).optional(),
  action: z.string().max(100).optional(),
  category: z.enum(EVENT_CATEGORIES).optional(),
  preset: z.string().max(64).optional(),
  actorId: z.string().max(191).optional(),
  actorType: z.enum(['INTERNAL', 'EXTERNAL', 'SERVICE', 'SYSTEM', 'INTEGRATION']).optional(),
  resourceId: z.string().max(191).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  failuresOnly: z.coerce.boolean().optional(),
});

export async function auditRoutes(app: FastifyInstance): Promise<void> {
  /**
   * สารบัญเหตุการณ์และชุดสำเร็จรูป
   *
   * หน้าจอใช้สร้างตัวเลือกในตัวกรอง โดยไม่ต้องมีสำเนารายชื่อฝั่ง frontend
   * ที่จะเพี้ยนจากฝั่งเซิร์ฟเวอร์เมื่อมีเหตุการณ์ใหม่
   */
  app.get('/audit/catalog', { preHandler: requireInternal }, async (request) => {
    const user = request.authUser!;
    return {
      success: true,
      data: {
        categories: EVENT_CATEGORIES.map((code) => ({ code, label: CATEGORY_LABELS[code] })),
        events: Object.entries(EVENT_CATALOG).map(([code, definition]) => ({
          code,
          label: definition.label,
          category: definition.category,
        })),
        presets: AUDIT_PRESETS.map((preset) => ({
          slug: preset.slug,
          name: preset.name,
          description: preset.description,
        })),
        /** หน้าจอใช้ตัดสินว่าจะแสดงปุ่มส่งออกหรือไม่ */
        canView: canViewAudit(user),
        canExport: canExportAudit(user),
      },
    };
  });

  app.get('/audit/events', { preHandler: requireInternal }, async (request) => {
    const query = filterSchema
      .extend({
        limit: z.coerce.number().int().min(1).max(100).default(50),
        cursor: z.string().min(1).optional(),
      })
      .parse(request.query);

    const { limit, cursor, ...filters } = query;
    return {
      success: true,
      data: await searchAuditEvents(request.authUser!, filters as AuditFilters, { limit, cursor }),
    };
  });

  app.get('/audit/events/:id', { preHandler: requireInternal }, async (request) => {
    const { id } = z.object({ id: z.string().min(1) }).parse(request.params);
    return { success: true, data: await getAuditEvent(id, request.authUser!) };
  });

  /** ไทม์ไลน์ของทรัพยากรหนึ่งชิ้น - ใช้ตารางและตัวกรองเดิม ไม่มีสำเนาที่สอง */
  app.get('/audit/resources/:id', { preHandler: requireInternal }, async (request) => {
    const { id } = z.object({ id: z.string().min(1) }).parse(request.params);
    const query = z
      .object({
        limit: z.coerce.number().int().min(1).max(100).default(50),
        cursor: z.string().min(1).optional(),
      })
      .parse(request.query);
    return { success: true, data: await resourceTimeline(id, request.authUser!, query) };
  });

  /**
   * ส่งออกเป็น CSV
   *
   * เป็น POST เพราะมีผลข้างเคียงคือเขียนบันทึกว่ามีการส่งออก
   * การใช้ GET จะทำให้ browser หรือ prefetch สร้างบันทึกปลอมขึ้นมาเอง
   */
  app.post('/audit/export', { preHandler: requireInternal }, async (request, reply) => {
    const filters = filterSchema.strict().parse(request.body ?? {});
    const result = await exportAuditCsv(request.authUser!, filters as AuditFilters, audit(request));

    return reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      // ชื่อไฟล์มาจากเซิร์ฟเวอร์เท่านั้น ไม่มีส่วนใดมาจากผู้ใช้
      .header('Content-Disposition', `attachment; filename="${result.filename}"`)
      .header('X-Audit-Row-Count', String(result.rowCount))
      .send(result.content);
  });
}

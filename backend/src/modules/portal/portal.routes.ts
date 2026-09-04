import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireExternal } from '../auth/auth.guard.js';
import { badRequest } from '../../core/errors.js';
import { sendFile } from '../files/file.routes.js';
import {
  getPortalResource,
  listPortalVersions,
  logPortalDownload,
  openPortalFolder,
  portalHome,
  resolvePortalContent,
  resolvePortalVersionContent,
  searchPortal,
  uploadToPortalFolder,
} from './portal.service.js';
import { listUploadHistory, uploadHistoryExtensions } from './portal-uploads.js';

/**
 * เส้นทาง API ของพื้นที่เอกสารสำหรับลูกค้า
 *
 * แยกออกจาก API ภายในทั้งชุดโดยตั้งใจ ไม่มี endpoint ใดใช้ร่วมกัน
 * การใช้ endpoint ภายในร่วมกันแล้วค่อยกรองผลลัพธ์ทีหลัง เป็นรูปแบบที่พลาดครั้งเดียวก็รั่ว
 *
 * ทุกเส้นทางผ่าน requireExternal ซึ่งปฏิเสธบัญชีภายในและบัญชีระบบทั้งหมด
 * ส่วนการตัดสินว่าเห็นอะไรได้บ้าง อยู่ที่ portal-access.ts เพียงที่เดียว
 */

const idParams = z.object({ id: z.string().min(1).max(191) });
const versionParams = z.object({
  id: z.string().min(1).max(191),
  versionNumber: z.coerce.number().int().min(1).max(100000),
});
const audit = (request: FastifyRequest) => ({
  ipAddress: request.ip,
  userAgent: request.headers['user-agent'],
});

const guard = { preHandler: requireExternal };

export async function portalRoutes(app: FastifyInstance): Promise<void> {
  /** หน้าแรก - เอกสารที่แชร์ให้ อัปโหลดล่าสุด และโฟลเดอร์ที่อัปโหลดได้ */
  app.get('/portal/resources', guard, async (request) => ({
    success: true,
    data: await portalHome(request.authUser!),
  }));

  app.get('/portal/search', guard, async (request) => {
    const query = z.object({ q: z.string().max(191).default('') }).parse(request.query);
    return { success: true, data: await searchPortal(request.authUser!, query.q) };
  });

  /** เปิดโฟลเดอร์ - เส้นทางนำทางถูกตัดให้เริ่มที่รากที่ได้รับสิทธิ์เสมอ */
  app.get('/portal/folders/:id', guard, async (request) => ({
    success: true,
    data: await openPortalFolder(request.authUser!, idParams.parse(request.params).id, audit(request)),
  }));

  app.get('/portal/resources/:id', guard, async (request) => ({
    success: true,
    data: await getPortalResource(request.authUser!, idParams.parse(request.params).id, audit(request)),
  }));

  /**
   * เปิดดูเนื้อหา - ไม่บังคับสิทธิ์ดาวน์โหลด
   * "เปิดดูได้ แต่บันทึกลงเครื่องไม่ได้" เป็นสถานะที่ตั้งใจให้มี
   */
  app.get('/portal/resources/:id/content', guard, async (request, reply) => {
    const { content } = await resolvePortalContent(
      request.authUser!,
      idParams.parse(request.params).id,
      { requireDownload: false },
    );
    return sendFile(request, reply, content, 'inline');
  });

  app.get('/portal/resources/:id/download', guard, async (request, reply) => {
    const { content } = await resolvePortalContent(
      request.authUser!,
      idParams.parse(request.params).id,
      { requireDownload: true },
    );
    await logPortalDownload(request.authUser!, content.resourceId, audit(request));
    return sendFile(request, reply, content, 'attachment');
  });

  /* ---------------- ประวัติการอัปโหลดของลูกค้า ---------------- */

  /**
   * รายการถูกตัดสินจาก "ใครอัปโหลด" แต่การเปิดดูและดาวน์โหลดถูกตัดสินจากสิทธิ์ปัจจุบันเสมอ
   * ประวัติจึงไม่ใช่ช่องทางเข้าถึงที่สอง
   */
  app.get('/portal/uploads', guard, async (request) => {
    const query = z
      .object({
        q: z.string().trim().max(191).optional(),
        extension: z.string().trim().max(32).optional(),
        from: z.coerce.date().optional(),
        to: z.coerce.date().optional(),
        limit: z.coerce.number().int().min(1).max(100).default(25),
        cursor: z.string().min(1).max(191).optional(),
      })
      .parse(request.query);
    return { success: true, data: await listUploadHistory(request.authUser!, query) };
  });

  app.get('/portal/uploads/types', guard, async (request) => ({
    success: true,
    data: await uploadHistoryExtensions(request.authUser!),
  }));

  /* ---------------- ประวัติเวอร์ชัน (อ่านอย่างเดียว) ---------------- */

  /**
   * เวอร์ชันถูกอ้างถึงด้วยเลขลำดับภายในไฟล์ ไม่ใช่รหัสของแถวเวอร์ชัน
   * เส้นทางจึงบังคับให้ระบุไฟล์แม่มาด้วยเสมอ และสิทธิ์ถูกตรวจกับไฟล์แม่นั้น
   */
  app.get('/portal/resources/:id/versions', guard, async (request) => ({
    success: true,
    data: await listPortalVersions(request.authUser!, idParams.parse(request.params).id, audit(request)),
  }));

  app.get('/portal/resources/:id/versions/:versionNumber/content', guard, async (request, reply) => {
    const params = versionParams.parse(request.params);
    const { content } = await resolvePortalVersionContent(
      request.authUser!,
      params.id,
      params.versionNumber,
      { requireDownload: false },
    );
    return sendFile(request, reply, content, 'inline');
  });

  app.get('/portal/resources/:id/versions/:versionNumber/download', guard, async (request, reply) => {
    const params = versionParams.parse(request.params);
    const { content } = await resolvePortalVersionContent(
      request.authUser!,
      params.id,
      params.versionNumber,
      { requireDownload: true },
    );
    await logPortalDownload(request.authUser!, content.resourceId, audit(request), params.versionNumber);
    return sendFile(request, reply, content, 'attachment');
  });

  /**
   * อัปโหลดเข้าโฟลเดอร์ที่ได้รับสิทธิ์
   *
   * ปลายทางมาจาก path parameter ที่ถูกตรวจสิทธิ์ฝั่งเซิร์ฟเวอร์เท่านั้น
   * ไม่มี field ใดใน multipart ที่เปลี่ยนปลายทางได้ และไม่รับ parentId จาก client
   */
  app.post('/portal/folders/:id/upload', guard, async (request, reply) => {
    const folderId = idParams.parse(request.params).id;
    const part = await request.file();
    if (!part) throw badRequest('FILE_MISSING', 'ไม่พบไฟล์ที่อัปโหลด');

    const resource = await uploadToPortalFolder(
      request.authUser!,
      folderId,
      part.file,
      { fileName: part.filename, declaredMime: part.mimetype },
      audit(request),
    );
    return reply.status(201).send({ success: true, data: resource });
  });
}

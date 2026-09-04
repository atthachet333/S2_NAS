import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireInternal } from '../auth/auth.guard.js';
import { AppError, badRequest } from '../../core/errors.js';
import { env } from '../../config/env.js';
import { createStoredFileStream, statStoredFile } from '../../core/file-storage.js';
import {
  effectiveUploadBytes,
  getManagedStorageBytes,
  listVersions,
  logDownload,
  resolveContent,
  uploadFile,
  uploadVersion,
  type NameConflictPolicy,
} from './file.service.js';
import {
  describePermanentDelete,
  listTrash,
  permanentlyDelete,
  restoreResource,
  trashResource,
} from './trash.service.js';
import { createZipPlan, createZipStream, logZipDownload } from './zip.service.js';

const idParams = z.object({ id: z.string().min(1) });
const audit = (request: FastifyRequest) => ({
  ipAddress: request.ip,
  userAgent: request.headers['user-agent'],
});

function zipDisposition(fileName: string): string {
  const asciiFallback = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\\r\n]/g, '_');
  const encoded = encodeURIComponent(fileName).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16)}`);
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`;
}

/** ชนิดที่เปิดให้แสดงผลในหน้าเว็บโดยตรงได้อย่างปลอดภัย */
const INLINE_MIME = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'text/plain',
  'text/csv',
  'text/markdown',
  'application/json',
  'application/xml',
  'audio/mpeg',
  'audio/wav',
  'video/mp4',
  'video/webm',
]);

/**
 * ป้องกัน header injection และรองรับชื่อไฟล์ภาษาไทย
 * ใช้ ASCII fallback คู่กับ RFC 5987 filename* เสมอ
 */
function contentDisposition(fileName: string, disposition: 'inline' | 'attachment'): string {
  const asciiFallback = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(fileName).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16)}`);
  return `${disposition}; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`;
}

/** ส่งไฟล์ออกไปแบบสตรีม รองรับ HTTP Range สำหรับสื่อขนาดใหญ่และ PDF */
export async function sendFile(
  request: FastifyRequest,
  reply: FastifyReply,
  content: { storageKey: string; size: number; mimeType: string; fileName: string },
  disposition: 'inline' | 'attachment',
): Promise<void> {
  const stat = await statStoredFile(content.storageKey);
  if (!stat) throw new AppError('FILE_NOT_FOUND', 'ไม่พบไฟล์ในพื้นที่จัดเก็บ', 404);

  const safeMime =
    disposition === 'inline' && INLINE_MIME.has(content.mimeType)
      ? content.mimeType
      : disposition === 'inline'
        ? 'application/octet-stream'
        : content.mimeType;

  reply
    .header('Content-Type', safeMime)
    .header('Content-Disposition', contentDisposition(content.fileName, disposition))
    .header('X-Content-Type-Options', 'nosniff')
    .header('Cache-Control', 'private, no-store')
    .header('Accept-Ranges', 'bytes');

  const range = request.headers.range;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (match) {
      const start = match[1] ? Number(match[1]) : 0;
      const end = match[2] ? Number(match[2]) : stat.size - 1;

      if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= stat.size) {
        return reply.status(416).header('Content-Range', `bytes */${stat.size}`).send();
      }

      const cappedEnd = Math.min(end, stat.size - 1);
      return reply
        .status(206)
        .header('Content-Range', `bytes ${start}-${cappedEnd}/${stat.size}`)
        .header('Content-Length', cappedEnd - start + 1)
        .send(createStoredFileStream(content.storageKey, { start, end: cappedEnd }));
    }
  }

  return reply.header('Content-Length', stat.size).send(createStoredFileStream(content.storageKey));
}

export async function fileRoutes(app: FastifyInstance): Promise<void> {
  /* ---------------- อัปโหลดไฟล์ใหม่ ---------------- */
  app.post('/resources/upload', { preHandler: requireInternal }, async (request, reply) => {
    const part = await request.file();
    if (!part) throw badRequest('FILE_MISSING', 'ไม่พบไฟล์ที่อัปโหลด');

    const fields = part.fields as Record<string, { value?: unknown } | undefined>;
    const readField = (key: string): string | undefined => {
      const value = fields[key]?.value;
      return typeof value === 'string' && value.length > 0 ? value : undefined;
    };

    const parentId = readField('parentId') ?? null;
    /** ไดร์ฟปลายทางมีผลเฉพาะการอัปโหลดที่ระดับราก ในโฟลเดอร์จะสืบทอดจากโฟลเดอร์แม่เสมอ */
    const driveScope = readField('driveScope') === 'SYSTEM_DRIVE' ? ('SYSTEM_DRIVE' as const) : undefined;
    const onNameConflict = readField('onNameConflict') as NameConflictPolicy | undefined;
    const allowDuplicateContent = readField('allowDuplicateContent') === 'true';

    const result = await uploadFile(
      request.authUser!,
      part.file,
      {
        parentId,
        ...(driveScope ? { driveScope } : {}),
        fileName: part.filename,
        declaredMime: part.mimetype,
        remark: readField('remark') ?? null,
        ...(onNameConflict ? { onNameConflict } : {}),
        allowDuplicateContent,
      },
      audit(request),
    );

    return reply.status(201).send({ success: true, data: result });
  });

  /* ---------------- อัปโหลดเวอร์ชันใหม่ ---------------- */
  app.post('/resources/:id/versions', { preHandler: requireInternal }, async (request, reply) => {
    const part = await request.file();
    if (!part) throw badRequest('FILE_MISSING', 'ไม่พบไฟล์ที่อัปโหลด');

    const fields = part.fields as Record<string, { value?: unknown } | undefined>;
    const remarkValue = fields.remark?.value;

    const resource = await uploadVersion(
      request.authUser!,
      idParams.parse(request.params).id,
      part.file,
      {
        remark: typeof remarkValue === 'string' ? remarkValue : null,
        declaredMime: part.mimetype,
      },
      audit(request),
    );

    return reply.status(201).send({ success: true, data: resource });
  });

  /* ---------------- ประวัติเวอร์ชัน ---------------- */
  app.get('/resources/:id/versions', { preHandler: requireInternal }, async (request) => ({
    success: true,
    data: await listVersions(idParams.parse(request.params).id, request.authUser!),
  }));

  /* ---------------- แสดงตัวอย่าง (inline) ---------------- */
  app.get('/resources/:id/content', { preHandler: requireInternal }, async (request, reply) => {
    const query = z.object({ version: z.coerce.number().int().positive().optional() }).parse(request.query);
    const content = await resolveContent(idParams.parse(request.params).id, request.authUser!, {
      ...(query.version === undefined ? {} : { versionNumber: query.version }),
    });
    return sendFile(request, reply, content, 'inline');
  });

  /* ---------------- ดาวน์โหลด ---------------- */
  app.get('/resources/:id/download', { preHandler: requireInternal }, async (request, reply) => {
    const query = z.object({ version: z.coerce.number().int().positive().optional() }).parse(request.query);
    const content = await resolveContent(idParams.parse(request.params).id, request.authUser!, {
      requireDownload: true,
      ...(query.version === undefined ? {} : { versionNumber: query.version }),
    });
    await logDownload(request.authUser!, content.resourceId, content.versionNumber, audit(request));
    return sendFile(request, reply, content, 'attachment');
  });

  /* ---------------- ZIP โฟลเดอร์ / หลายรายการ ---------------- */
  const sendZip = async (request: FastifyRequest, reply: FastifyReply, ids: string[], folderOnly: boolean) => {
    const plan = await createZipPlan(ids, request.authUser!, folderOnly);
    const archive = await createZipStream(plan);
    archive.on('warning', (error: Error) => request.log.warn({ code: (error as NodeJS.ErrnoException).code }, 'ZIP warning'));
    archive.on('error', (error: Error) => request.log.error({ error }, 'ZIP stream failed'));
    await logZipDownload(request.authUser!, plan, audit(request));
    reply
      .header('Content-Type', 'application/zip')
      .header('Content-Disposition', zipDisposition(plan.fileName))
      .header('X-Content-Type-Options', 'nosniff')
      .header('Cache-Control', 'private, no-store');
    reply.send(archive);
    void archive.finalize();
    return reply;
  };

  app.get('/resources/:id/download-zip', { preHandler: requireInternal }, async (request, reply) =>
    sendZip(request, reply, [idParams.parse(request.params).id], true),
  );

  app.post('/resources/download-zip', { preHandler: requireInternal }, async (request, reply) => {
    const body = z.object({ resourceIds: z.array(z.string().min(1)).min(1).max(env.S2_NAS_ZIP_MAX_RESOURCES) }).parse(request.body);
    return sendZip(request, reply, body.resourceIds, false);
  });

  /* ---------------- ถังขยะ ---------------- */
  app.get('/trash', { preHandler: requireInternal }, async (request) => ({
    success: true,
    data: await listTrash(request.authUser!),
  }));

  app.post('/resources/:id/trash', { preHandler: requireInternal }, async (request) => ({
    success: true,
    data: await trashResource(idParams.parse(request.params).id, request.authUser!, audit(request)),
  }));

  app.post('/resources/:id/restore', { preHandler: requireInternal }, async (request) => {
    const body = z
      .object({ targetParentId: z.string().nullable().optional(), newName: z.string().min(1).optional() })
      .parse(request.body ?? {});
    return {
      success: true,
      data: await restoreResource(idParams.parse(request.params).id, request.authUser!, body, audit(request)),
    };
  });

  app.get('/resources/:id/permanent-delete-preview', { preHandler: requireInternal }, async (request) => ({
    success: true,
    data: await describePermanentDelete(idParams.parse(request.params).id, request.authUser!),
  }));

  app.delete('/resources/:id/permanent', { preHandler: requireInternal }, async (request) => ({
    success: true,
    data: await permanentlyDelete(idParams.parse(request.params).id, request.authUser!, audit(request)),
  }));

  /* ---------------- ข้อมูลพื้นที่ที่ S2 NAS ดูแล ---------------- */
  app.get('/system/managed-storage', { preHandler: requireInternal }, async () => ({
    success: true,
    data: {
      managedBytes: await getManagedStorageBytes(),
      // ค่าที่มีผลจริง ไม่ใช่ค่าตอน start server เพียงอย่างเดียว
      maxUploadBytes: await effectiveUploadBytes(),
    },
  }));
}

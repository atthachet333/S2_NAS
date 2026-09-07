import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../core/prisma.js';
import { AppError } from '../../core/errors.js';
import { requireInternal } from '../auth/auth.guard.js';
import { sendFile } from '../files/file.routes.js';
import {
  createPublicShare,
  listResourceShares,
  revokePublicShare,
} from './public-share.service.js';
import {
  countView,
  listShareChildren,
  logExpiredAttempt,
  logGuestEvent,
  requiresPassword,
  reserveDownload,
  resolveShareByToken,
  resolveWithinShare,
  shareUnavailable,
  verifySharePassword,
  type ResolvedShare,
} from './guest-access.js';
import { guestPassValid, issueGuestPass } from './guest-session.js';

/**
 * เส้นทางของลิงก์แชร์ภายนอก (F18)
 *
 * แบ่งเป็นสองกลุ่มที่ไม่ปนกันเลย:
 *
 * /public/shares/*  - ไม่ต้องเข้าสู่ระบบ ผู้เรียกคือแขกที่ถือโทเคน
 * ที่เหลือ           - อยู่หลัง requireInternal ผู้เรียกคือบุคลากรที่จัดการลิงก์
 *
 * การแยกไว้คนละที่ทำให้มองเห็นด้วยตาเปล่าว่าเส้นทางไหนเปิดสู่อินเทอร์เน็ต
 * ถ้าปนกัน วันหนึ่งจะมีคนเพิ่มเส้นทางใหม่ในกลุ่มผิดโดยไม่มีใครทันสังเกต
 */

const audit = (request: FastifyRequest) => ({
  ipAddress: request.ip,
  userAgent: request.headers['user-agent'],
});

const tokenParams = z.object({ token: z.string().min(20).max(200) });
const idParams = z.object({ id: z.string().min(1) });

/**
 * หัวข้อความปลอดภัยของทุกคำตอบฝั่งแขก
 *
 * Referrer-Policy: โทเคนอยู่ใน URL ถ้าหน้าของแขกมีลิงก์ออกไปข้างนอก
 * เบราว์เซอร์จะแนบ URL เต็มไปกับคำขอนั้นเป็น Referer และโทเคนก็จะไปโผล่ใน
 * access log ของเว็บอื่น ซึ่งเท่ากับมอบกุญแจให้คนที่เราไม่รู้จัก
 *
 * Cache-Control: เนื้อหานี้เป็นของส่วนตัวที่บังเอิญไม่ต้องล็อกอิน
 * proxy สาธารณะที่เก็บไว้จะเสิร์ฟให้คนถัดไปโดยไม่ผ่านการตรวจโทเคนเลย
 */
function guestHeaders(reply: FastifyReply): FastifyReply {
  return reply
    .header('Referrer-Policy', 'no-referrer')
    .header('Cache-Control', 'private, no-store')
    .header('X-Robots-Tag', 'noindex, nofollow');
}

/**
 * เปิดลิงก์ให้ผ่านด่านทั้งหมด แล้วคืนบริบทของแขก
 *
 * ทุกเส้นทางของแขกเรียกฟังก์ชันนี้เป็นอย่างแรก - รวมถึงเส้นทางเนื้อหาและดาวน์โหลด
 * ไม่มีเส้นทางไหนที่เชื่อผลการตรวจจากคำขอก่อนหน้า
 */
async function openShare(request: FastifyRequest, token: string): Promise<ResolvedShare> {
  let share: ResolvedShare;
  try {
    share = await resolveShareByToken(token);
  } catch (error) {
    // บันทึกเฉพาะโทเคนที่เคยมีอยู่จริง เพื่อไม่ให้การยิงสุ่มถมบันทึกกิจกรรม
    await logExpiredAttempt(token, audit(request)).catch(() => {});
    throw error;
  }

  if (requiresPassword(share.link)) {
    const pass = request.headers['x-guest-pass'];
    const valid = await guestPassValid(typeof pass === 'string' ? pass : undefined, share.link.id);
    if (!valid) {
      throw new AppError('SHARE_PASSWORD_REQUIRED', 'ลิงก์นี้ต้องใช้รหัสผ่าน', 401);
    }
  }
  return share;
}

export async function publicShareRoutes(app: FastifyInstance): Promise<void> {
  /* ================================================================ */
  /* กลุ่มสาธารณะ - ไม่ต้องเข้าสู่ระบบ                                    */
  /* ================================================================ */

  /**
   * จำกัดอัตราคำขอของเส้นทางแขกทุกเส้น
   *
   * เส้นทางเหล่านี้ไม่มีบัญชีให้ล็อก ไม่มีอะไรให้ผู้โจมตีต้องผ่านก่อน
   * การจำกัดตาม IP จึงเป็นเครื่องมือเดียวที่มี
   */
  const guestRate = { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } };

  /**
   * ตรวจรหัสผ่าน - เข้มกว่าเส้นทางอื่นมาก
   *
   * รหัสผ่านที่มนุษย์ตั้งมักสั้นและเดาได้ ถ้าปล่อยให้ยิงได้ไม่จำกัด
   * การป้องกันด้วยรหัสผ่านก็แทบไม่มีความหมาย
   *
   * นับรวมตาม IP ต่อโทเคน เพื่อไม่ให้คนที่ยิงลิงก์หนึ่งไปกระทบผู้ใช้ลิงก์อื่น
   */
  const passwordRate = {
    config: {
      rateLimit: {
        max: 10,
        timeWindow: '5 minutes',
        keyGenerator: (request: FastifyRequest) => {
          const { token } = request.params as { token?: string };
          return `${request.ip}:${token?.slice(0, 24) ?? ''}`;
        },
      },
    },
  };

  /** ข้อมูลของลิงก์ที่แขกเห็น - น้อยที่สุดเท่าที่จะยังใช้งานได้ */
  app.get('/public/shares/:token', guestRate, async (request, reply) => {
    const { token } = tokenParams.parse(request.params);
    guestHeaders(reply);

    let share: ResolvedShare;
    try {
      share = await resolveShareByToken(token);
    } catch (error) {
      await logExpiredAttempt(token, audit(request)).catch(() => {});
      throw error;
    }

    /**
     * ลิงก์ที่มีรหัสผ่านตอบเพียงว่า "ต้องใช้รหัสผ่าน" ยังไม่บอกอะไรเกี่ยวกับเอกสาร
     * ชื่อไฟล์เองก็เป็นข้อมูล - "สัญญาเลิกจ้าง_สมชาย.pdf" บอกเรื่องราวไปครึ่งหนึ่งแล้ว
     */
    if (requiresPassword(share.link)) {
      const pass = request.headers['x-guest-pass'];
      if (!(await guestPassValid(typeof pass === 'string' ? pass : undefined, share.link.id))) {
        return { success: true, data: { passwordRequired: true } };
      }
    }

    /** นับการเปิดที่นี่ที่เดียว - คำขอเนื้อหาและดาวน์โหลดไม่นับซ้ำ */
    await countView(share.link);
    await logGuestEvent('PUBLIC_SHARE_ACCESSED', share, audit(request), {
      resourceType: share.resource.type,
    });

    return { success: true, data: guestView(share) };
  });

  /** ตรวจรหัสผ่านแล้วออกใบผ่านชั่วคราวที่ผูกกับลิงก์นี้ลิงก์เดียว */
  app.post('/public/shares/:token/verify-password', passwordRate, async (request, reply) => {
    const { token } = tokenParams.parse(request.params);
    const { password } = z.object({ password: z.string().min(1).max(200) }).parse(request.body);
    guestHeaders(reply);

    const share = await resolveShareByToken(token);
    if (!requiresPassword(share.link)) {
      return { success: true, data: { pass: null } };
    }

    if (!(await verifySharePassword(share.link, password))) {
      await logGuestEvent('PUBLIC_SHARE_PASSWORD_FAILED', share, audit(request));
      throw new AppError('SHARE_PASSWORD_INVALID', 'รหัสผ่านไม่ถูกต้อง', 401);
    }

    return { success: true, data: { pass: await issueGuestPass(share.link.id) } };
  });

  /** ลูกของโฟลเดอร์ในขอบเขตของลิงก์ - id ที่อยู่นอกขอบเขตถูกปฏิเสธที่เซิร์ฟเวอร์ */
  app.get('/public/shares/:token/children', guestRate, async (request, reply) => {
    const { token } = tokenParams.parse(request.params);
    const { folderId } = z.object({ folderId: z.string().min(1).optional() }).parse(request.query);
    guestHeaders(reply);

    const share = await openShare(request, token);
    const { resource, breadcrumb } = await resolveWithinShare(
      share,
      folderId ?? share.link.resourceId,
    );
    if (resource.type !== 'FOLDER') throw shareUnavailable();

    const children = await listShareChildren(resource.id);
    return {
      success: true,
      data: {
        folder: { id: resource.id, name: resource.name },
        breadcrumb,
        items: children.map(guestItem),
      },
    };
  });

  /**
   * เปิดดูเนื้อหา
   *
   * ใช้ sendFile ตัวเดียวกับทุกเส้นทางในระบบ - ไม่มีการอ่านไฟล์ดิบที่นี่
   * storageKey ไม่เคยออกจากเซิร์ฟเวอร์ และการจัดการ Range/ชื่อไฟล์ก็ได้มาฟรี
   */
  app.get('/public/shares/:token/content', guestRate, async (request, reply) => {
    const { token } = tokenParams.parse(request.params);
    const { resourceId } = z.object({ resourceId: z.string().min(1).optional() }).parse(request.query);
    guestHeaders(reply);

    const share = await openShare(request, token);
    if (!share.link.allowPreview) {
      throw new AppError('SHARE_PREVIEW_DENIED', 'ลิงก์นี้ไม่อนุญาตให้ดูตัวอย่าง', 403);
    }

    const content = await guestContent(share, resourceId);
    return sendFile(request, reply, content, 'inline');
  });

  app.get('/public/shares/:token/download', guestRate, async (request, reply) => {
    const { token } = tokenParams.parse(request.params);
    const { resourceId } = z.object({ resourceId: z.string().min(1).optional() }).parse(request.query);
    guestHeaders(reply);

    const share = await openShare(request, token);
    if (!share.link.allowDownload) {
      throw new AppError('SHARE_DOWNLOAD_DENIED', 'ลิงก์นี้ไม่อนุญาตให้ดาวน์โหลด', 403);
    }

    const content = await guestContent(share, resourceId);

    /**
     * จองโควตาก่อนส่งไฟล์
     *
     * ถ้าจองไม่ได้แปลว่าโควตาหมดพอดี หรือลิงก์เพิ่งถูกยกเลิกระหว่างทาง
     * ทั้งสองกรณีต้องหยุดก่อนที่ไบต์แรกจะออกไป
     */
    if (!(await reserveDownload(share.link))) {
      await logGuestEvent('PUBLIC_SHARE_LIMIT_REACHED', share, audit(request), {
        limit: 'DOWNLOAD',
        maxDownloads: share.link.maxDownloads,
      });
      throw new AppError('SHARE_DOWNLOAD_LIMIT', 'ลิงก์นี้ใช้สิทธิ์ดาวน์โหลดครบแล้ว', 403);
    }

    await logGuestEvent('PUBLIC_SHARE_DOWNLOADED', share, audit(request), {
      resourceId: content.resourceId,
    });
    return sendFile(request, reply, content, 'attachment');
  });

  /* ================================================================ */
  /* กลุ่มภายใน - ต้องเข้าสู่ระบบ                                        */
  /* ================================================================ */

  app.post('/resources/:id/public-shares', { preHandler: requireInternal }, async (request) => {
    const { id } = idParams.parse(request.params);
    const body = z
      .object({
        allowPreview: z.boolean().optional(),
        allowDownload: z.boolean().optional(),
        // ไม่ส่งมา = ใช้ค่าเริ่มต้น 7 วัน ส่วน null = ไม่หมดอายุ ซึ่งต้องตั้งใจเลือก
        expiresAt: z.coerce.date().nullable().optional(),
        password: z.string().min(6).max(200).nullable().optional(),
        maxViews: z.number().int().min(1).max(100_000).nullable().optional(),
        maxDownloads: z.number().int().min(1).max(100_000).nullable().optional(),
        label: z.string().max(191).nullable().optional(),
      })
      .strict()
      .parse(request.body ?? {});

    return {
      success: true,
      data: await createPublicShare(id, request.authUser!, body, audit(request)),
    };
  });

  app.get('/resources/:id/public-shares', { preHandler: requireInternal }, async (request) => ({
    success: true,
    data: await listResourceShares(idParams.parse(request.params).id, request.authUser!),
  }));

  app.delete('/public-share-links/:id', { preHandler: requireInternal }, async (request) => ({
    success: true,
    data: await revokePublicShare(idParams.parse(request.params).id, request.authUser!, audit(request)),
  }));
}

/* ------------------------------------------------------------------ */
/* การแปลงข้อมูลสำหรับแขก                                                */
/* ------------------------------------------------------------------ */

/**
 * สิ่งที่แขกได้เห็น
 *
 * เทียบกับข้อมูลภายในแล้วแทบไม่เหลืออะไร และนั่นคือเจตนา
 *
 * **ไม่มี**: ผู้ดูแล อีเมล แท็ก หมายเหตุ ประเภทเอกสาร นโยบายการเก็บรักษา
 * โฟลเดอร์แม่ที่อยู่เหนือราก ไดร์ฟ storageKey checksum เวอร์ชัน ผู้สร้าง
 *
 * ชื่อคนและโครงสร้างโฟลเดอร์ขององค์กรเป็นข้อมูลทางธุรกิจ คนที่ได้รับเอกสาร
 * หนึ่งฉบับไม่ควรได้แผนผังองค์กรแถมไปด้วย
 */
function guestView(share: ResolvedShare) {
  return {
    passwordRequired: false,
    resource: guestItem(share.resource),
    allowPreview: share.link.allowPreview,
    allowDownload: share.link.allowDownload,
    expiresAt: share.link.expiresAt?.toISOString() ?? null,
  };
}

function guestItem(resource: ResolvedShare['resource']) {
  return {
    id: resource.id,
    type: resource.type,
    name: resource.name,
    mimeType: resource.mimeType,
    extension: resource.extension,
    size: resource.size === null ? null : Number(resource.size),
  };
}

/**
 * หาเนื้อหาของไฟล์ที่แขกขอ โดยบังคับขอบเขตของลิงก์ก่อนเสมอ
 *
 * เวอร์ชันที่ส่งคือ **เวอร์ชันปัจจุบัน** ของทรัพยากรเสมอ
 *
 * เหตุผล: ลิงก์แชร์คือการบอกว่า "นี่คือเอกสารของเรา" ไม่ใช่ "นี่คือภาพนิ่งของวันนี้"
 * ถ้าแก้เอกสารแล้วผู้รับยังเห็นฉบับเก่า เขาจะทำงานผิดโดยไม่มีทางรู้
 * การตรึงไว้ที่เวอร์ชันหนึ่งเป็นความสามารถคนละอย่างที่ต้องเลือกอย่างตั้งใจ
 * จึงยังไม่มีในเฟสนี้ แทนที่จะมีทั้งสองอย่างแบบกำกวม
 */
async function guestContent(share: ResolvedShare, requestedId?: string) {
  const { resource } = await resolveWithinShare(share, requestedId ?? share.link.resourceId);
  if (resource.type !== 'FILE') {
    throw new AppError('INVALID_RESOURCE_TYPE', 'ทรัพยากรนี้ไม่ใช่ไฟล์', 400);
  }

  const file = await prisma.resource.findUnique({
    where: { id: resource.id },
    select: { storageKey: true, size: true, mimeType: true, name: true, currentVersion: true },
  });
  if (!file?.storageKey) throw shareUnavailable();

  return {
    storageKey: file.storageKey,
    size: file.size === null ? 0 : Number(file.size),
    mimeType: file.mimeType ?? 'application/octet-stream',
    fileName: file.name,
    resourceId: resource.id,
    versionNumber: file.currentVersion,
  };
}

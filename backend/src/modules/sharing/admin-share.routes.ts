import type { FastifyInstance } from 'fastify';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../core/prisma.js';
import { AppError } from '../../core/errors.js';
import { requireInternal } from '../auth/auth.guard.js';
import { isAdminUser } from '../resources/system-drive.js';
import { toShareDto, type ShareStatus } from './public-share.service.js';

/**
 * มุมมองผู้ดูแลระบบสำหรับลิงก์แชร์ภายนอกทั้งระบบ (F18)
 *
 * แผงของผู้สร้างตอบว่า "เอกสารของฉันถูกแชร์ออกไปอย่างไรบ้าง"
 * ส่วนหน้านี้ตอบคำถามที่ใหญ่กว่า: "ตอนนี้มีประตูกี่บานที่เปิดสู่ภายนอก"
 *
 * ไม่มีองค์กรไหนตอบคำถามนั้นได้ถ้าต้องไล่เปิดดูทีละเอกสาร
 */

/** ลิงก์ที่ใกล้หมดอายุถือว่าอยู่ในช่วงนี้ - ผู้ดูแลมีเวลาต่ออายุหรือปล่อยให้จบ */
const EXPIRING_SOON_DAYS = 7;

export async function adminShareRoutes(app: FastifyInstance): Promise<void> {
  app.get('/admin/public-shares', { preHandler: requireInternal }, async (request) => {
    const user = request.authUser!;

    /**
     * เฉพาะผู้ดูแลระบบ
     *
     * รายการนี้ครอบทั้งองค์กร - ชื่อเอกสารทุกฉบับที่เคยถูกแชร์ออกไป
     * เป็นข้อมูลระดับที่คนทั่วไปไม่ควรเห็น แม้เขาจะแชร์เอกสารของตัวเองได้ก็ตาม
     */
    if (!isAdminUser(user)) {
      throw new AppError('PUBLIC_SHARE_ADMIN_DENIED', 'ไม่มีสิทธิ์ดูภาพรวมลิงก์แชร์ภายนอก', 403);
    }

    const query = z
      .object({
        status: z.enum(['ACTIVE', 'EXPIRED', 'REVOKED', 'EXPIRING_SOON']).optional(),
        createdById: z.string().max(191).optional(),
        resourceId: z.string().max(191).optional(),
        allowDownload: z.coerce.boolean().optional(),
        passwordProtected: z.coerce.boolean().optional(),
        expiresBefore: z.coerce.date().optional(),
        expiresAfter: z.coerce.date().optional(),
        limit: z.coerce.number().int().min(1).max(100).default(50),
        cursor: z.string().min(1).optional(),
      })
      .parse(request.query);

    const now = new Date();
    const and: Prisma.PublicShareLinkWhereInput[] = [];

    /**
     * สถานะไม่ได้เก็บไว้ในฐานข้อมูล จึงต้องแปลงเป็นเงื่อนไขเวลาแทน
     *
     * คอลัมน์สถานะที่เก็บไว้จะเพี้ยนทันทีที่เวลาผ่านไปโดยไม่มีใครแตะแถวนั้น
     * และ "หมดอายุ" ก็เป็นเหตุการณ์ที่ไม่มีใครมากดปุ่มให้อยู่แล้ว
     */
    if (query.status === 'ACTIVE') {
      and.push({ revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] });
    } else if (query.status === 'EXPIRED') {
      and.push({ revokedAt: null, expiresAt: { lte: now } });
    } else if (query.status === 'REVOKED') {
      and.push({ revokedAt: { not: null } });
    } else if (query.status === 'EXPIRING_SOON') {
      and.push({
        revokedAt: null,
        expiresAt: {
          gt: now,
          lte: new Date(now.getTime() + EXPIRING_SOON_DAYS * 24 * 60 * 60 * 1000),
        },
      });
    }

    if (query.createdById) and.push({ createdById: query.createdById });
    if (query.resourceId) and.push({ resourceId: query.resourceId });
    if (query.allowDownload !== undefined) and.push({ allowDownload: query.allowDownload });
    if (query.passwordProtected !== undefined) {
      and.push(query.passwordProtected ? { passwordHash: { not: null } } : { passwordHash: null });
    }
    if (query.expiresBefore) and.push({ expiresAt: { lte: query.expiresBefore } });
    if (query.expiresAfter) and.push({ expiresAt: { gte: query.expiresAfter } });

    const rows = await prisma.publicShareLink.findMany({
      where: and.length > 0 ? { AND: and } : undefined,
      include: {
        resource: {
          select: { id: true, name: true, type: true, deletedAt: true, lifecycleState: true },
        },
        createdBy: { select: { id: true, displayName: true, email: true } },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    });

    const hasMore = rows.length > query.limit;
    const page = hasMore ? rows.slice(0, query.limit) : rows;

    return {
      success: true,
      data: {
        items: page.map((row) => ({
          // toShareDto เป็นตัวเดียวกับที่แผงของผู้สร้างใช้ - ไม่มีเส้นทางที่สอง
          // ที่อาจเผลอปล่อย tokenHash หรือ passwordHash ออกไป
          ...toShareDto(row, row.resource),
          createdBy: row.createdBy,
        })),
        nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
        hasMore,
      },
    };
  });

  /** สรุปจำนวนตามสถานะ - ตอบคำถาม "ตอนนี้เปิดอยู่กี่บาน" ได้ในบรรทัดเดียว */
  app.get('/admin/public-shares/summary', { preHandler: requireInternal }, async (request) => {
    if (!isAdminUser(request.authUser!)) {
      throw new AppError('PUBLIC_SHARE_ADMIN_DENIED', 'ไม่มีสิทธิ์ดูภาพรวมลิงก์แชร์ภายนอก', 403);
    }

    const now = new Date();
    const soon = new Date(now.getTime() + EXPIRING_SOON_DAYS * 24 * 60 * 60 * 1000);

    const [active, expiringSoon, expired, revoked, downloadable, passwordProtected] =
      await Promise.all([
        prisma.publicShareLink.count({
          where: { revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
        }),
        prisma.publicShareLink.count({
          where: { revokedAt: null, expiresAt: { gt: now, lte: soon } },
        }),
        prisma.publicShareLink.count({ where: { revokedAt: null, expiresAt: { lte: now } } }),
        prisma.publicShareLink.count({ where: { revokedAt: { not: null } } }),
        prisma.publicShareLink.count({
          where: {
            revokedAt: null,
            allowDownload: true,
            OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
          },
        }),
        prisma.publicShareLink.count({
          where: {
            revokedAt: null,
            passwordHash: { not: null },
            OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
          },
        }),
      ]);

    return {
      success: true,
      data: { active, expiringSoon, expired, revoked, downloadable, passwordProtected },
    };
  });
}

export type { ShareStatus };

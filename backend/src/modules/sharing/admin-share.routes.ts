import type { FastifyInstance } from 'fastify';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../core/prisma.js';
import { AppError } from '../../core/errors.js';
import { requireInternal } from '../auth/auth.guard.js';
import { isAdminUser } from '../resources/system-drive.js';
import { shareStatus, toShareDto, type ShareStatus } from './public-share.service.js';

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
        status: z.enum(['ACTIVE', 'EXPIRED', 'REVOKED', 'UNUSABLE', 'EXPIRING_SOON']).optional(),
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
          select: { id: true, name: true, type: true, deletedAt: true, lifecycleState: true, classification: true },
        },
        createdBy: { select: { id: true, displayName: true, email: true } },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    const soon = new Date(now.getTime() + EXPIRING_SOON_DAYS * 24 * 60 * 60 * 1000);
    const filtered = rows.filter((row) => {
      if (!query.status) return true;
      const status = shareStatus(row, row.resource, now);
      if (query.status === 'UNUSABLE') return status === 'LIMIT_REACHED' || status === 'RESOURCE_UNAVAILABLE';
      if (query.status === 'EXPIRING_SOON') {
        return status === 'ACTIVE' && row.expiresAt !== null && row.expiresAt <= soon;
      }
      return status === query.status;
    });
    const start = query.cursor ? Math.max(0, filtered.findIndex((row) => row.id === query.cursor) + 1) : 0;
    const page = filtered.slice(start, start + query.limit);
    const hasMore = start + query.limit < filtered.length;

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

    const rows = await prisma.publicShareLink.findMany({
      include: { resource: { select: { deletedAt: true, lifecycleState: true, classification: true } } },
    });
    const statuses = rows.map((row) => ({ row, status: shareStatus(row, row.resource, now) }));
    const activeRows = statuses.filter(({ status }) => status === 'ACTIVE');
    const active = activeRows.length;
    const expiringSoon = activeRows.filter(({ row }) => row.expiresAt && row.expiresAt <= soon).length;
    const expired = statuses.filter(({ status }) => status === 'EXPIRED').length;
    const revoked = statuses.filter(({ status }) => status === 'REVOKED').length;
    const unusable = statuses.filter(({ status }) => status === 'LIMIT_REACHED' || status === 'RESOURCE_UNAVAILABLE').length;
    const downloadable = activeRows.filter(({ row }) => row.allowDownload && (row.maxDownloads === null || row.downloadCount < row.maxDownloads)).length;
    const passwordProtected = activeRows.filter(({ row }) => row.passwordHash !== null).length;

    return {
      success: true,
      data: { active, expiringSoon, expired, revoked, unusable, downloadable, passwordProtected },
    };
  });
}

export type { ShareStatus };

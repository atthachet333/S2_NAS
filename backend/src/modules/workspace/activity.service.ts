import type { Prisma } from '@prisma/client';
import { prisma } from '../../core/prisma.js';
import { forbidden, notFound } from '../../core/errors.js';
import { capabilities, resourceInclude } from '../resources/resource.service.js';
import type { AuthUser } from '../auth/auth.service.js';

/**
 * ประวัติการใช้งาน
 *
 * แสดงได้เฉพาะกิจกรรมของทรัพยากรที่ผู้ใช้มองเห็นอยู่แล้ว
 * และไม่เปิดเผย ipAddress / userAgent ให้ผู้ใช้ทั่วไป เพราะเป็นข้อมูลติดตามตัวบุคคล
 * ผู้ดูแลระบบเท่านั้นที่เห็นสองฟิลด์นี้ผ่านหน้าผู้ดูแล
 */

const actorSelect = { id: true, displayName: true, email: true } as const;

function isAdmin(user: AuthUser): boolean {
  return user.roles.includes('SUPER_ADMIN') || user.roles.includes('ADMIN');
}

type LogRow = Prisma.ActivityLogGetPayload<{ include: { user: { select: typeof actorSelect } } }>;

function toEntry(row: LogRow, includeTrace: boolean) {
  return {
    id: row.id,
    action: row.action,
    resourceId: row.resourceId,
    actor: row.user,
    metadata: row.metadata,
    createdAt: row.createdAt,
    ...(includeTrace ? { ipAddress: row.ipAddress, userAgent: row.userAgent } : {}),
  };
}

/** ไทม์ไลน์ของทรัพยากรหนึ่งชิ้น */
export async function listResourceActivity(
  resourceId: string,
  user: AuthUser,
  options: { limit: number; cursor?: string },
) {
  const resource = await prisma.resource.findFirst({
    where: { id: resourceId },
    include: resourceInclude,
  });
  // ไม่พบ กับ ไม่มีสิทธิ์ ต้องตอบเหมือนกัน มิฉะนั้นเดาการมีอยู่ของทรัพยากรได้
  if (!resource || !capabilities(resource, user).canView) {
    throw notFound('RESOURCE_NOT_FOUND', 'ไม่พบทรัพยากร');
  }

  const rows = await prisma.activityLog.findMany({
    where: { resourceId },
    include: { user: { select: actorSelect } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: options.limit + 1,
    ...(options.cursor ? { cursor: { id: options.cursor }, skip: 1 } : {}),
  });

  const page = rows.slice(0, options.limit);
  const admin = isAdmin(user);
  return {
    items: page.map((row) => toEntry(row, admin)),
    nextCursor: rows.length > options.limit ? page[page.length - 1]?.id ?? null : null,
  };
}

export interface AdminActivityFilter {
  userId?: string;
  action?: string;
  resourceId?: string;
  from?: Date;
  to?: Date;
  limit: number;
  cursor?: string;
}

/** ประวัติทั้งระบบ สำหรับหน้าผู้ดูแลเท่านั้น */
export async function listAdminActivity(filter: AdminActivityFilter, user: AuthUser) {
  if (!isAdmin(user) && !user.permissions.includes('admin:access')) {
    throw forbidden('ไม่มีสิทธิ์ดูประวัติการใช้งานทั้งระบบ');
  }

  const where: Prisma.ActivityLogWhereInput = {
    ...(filter.userId ? { userId: filter.userId } : {}),
    ...(filter.action ? { action: filter.action } : {}),
    ...(filter.resourceId ? { resourceId: filter.resourceId } : {}),
    ...(filter.from || filter.to
      ? {
          createdAt: {
            ...(filter.from ? { gte: filter.from } : {}),
            ...(filter.to ? { lte: filter.to } : {}),
          },
        }
      : {}),
  };

  const rows = await prisma.activityLog.findMany({
    where,
    include: { user: { select: actorSelect } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: filter.limit + 1,
    ...(filter.cursor ? { cursor: { id: filter.cursor }, skip: 1 } : {}),
  });

  const page = rows.slice(0, filter.limit);
  return {
    items: page.map((row) => toEntry(row, true)),
    nextCursor: rows.length > filter.limit ? page[page.length - 1]?.id ?? null : null,
  };
}

/** รายการ action ที่เกิดขึ้นจริง ใช้เติมตัวกรองโดยไม่ต้อง hardcode */
export async function listActivityActions(user: AuthUser) {
  if (!isAdmin(user) && !user.permissions.includes('admin:access')) {
    throw forbidden('ไม่มีสิทธิ์ดูประวัติการใช้งานทั้งระบบ');
  }
  const groups = await prisma.activityLog.groupBy({ by: ['action'], _count: { _all: true } });
  return groups
    .map((group) => ({ action: group.action, count: group._count._all }))
    .sort((a, b) => a.action.localeCompare(b.action));
}

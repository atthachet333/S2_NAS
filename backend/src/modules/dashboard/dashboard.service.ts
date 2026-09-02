import { prisma } from '../../core/prisma.js';
import { forbidden } from '../../core/errors.js';
import { resourceInclude, toResourceDto } from '../resources/resource.service.js';
import type { AuthUser } from '../auth/auth.service.js';

/**
 * ข้อมูลสรุปสำหรับหน้าแดชบอร์ด
 *
 * อ่านอย่างเดียวทั้งหมด และคืนเฉพาะข้อมูลที่มีอยู่จริงในฐานข้อมูล
 * ไม่มีการประมาณค่า ไม่มีตัวเลขสมมติ และไม่เปิดเผยเส้นทางไฟล์จริงบนเซิร์ฟเวอร์
 */

/** เหตุการณ์ที่เกี่ยวกับทรัพยากรเท่านั้น ไม่รวมเหตุการณ์ยืนยันตัวตน */
const RESOURCE_ACTIONS = [
  'RESOURCE_FOLDER_CREATED',
  'RESOURCE_RENAMED',
  'RESOURCE_UPDATED',
  'RESOURCE_MOVED',
  'RESOURCE_OWNER_CHANGED',
  'RESOURCE_SOFT_DELETED',
];

export interface DashboardSummary {
  totals: { resources: number; folders: number; files: number; ownedByMe: number };
  recentResources: ReturnType<typeof toResourceDto>[];
  recentActivity: Array<{
    id: string;
    action: string;
    createdAt: Date;
    actor: { displayName: string; email: string } | null;
    resourceName: string | null;
  }>;
  /** true เมื่อผู้ใช้เห็นกิจกรรมของทั้งองค์กร ไม่ใช่เฉพาะของตนเอง */
  activityScopeIsOrganization: boolean;
}

export async function getDashboardSummary(user: AuthUser): Promise<DashboardSummary> {
  if (!user.permissions.includes('resources:read')) {
    throw forbidden('ไม่มีสิทธิ์ดูข้อมูลภาพรวม');
  }

  const isAdmin = user.permissions.includes('admin:access');

  const [folders, files, ownedByMe, recentRows, activityRows] = await Promise.all([
    prisma.resource.count({ where: { deletedAt: null, type: 'FOLDER' } }),
    prisma.resource.count({ where: { deletedAt: null, type: { not: 'FOLDER' } } }),
    prisma.resource.count({ where: { deletedAt: null, ownerId: user.id } }),
    prisma.resource.findMany({
      where: { deletedAt: null },
      include: resourceInclude,
      orderBy: { updatedAt: 'desc' },
      take: 6,
    }),
    prisma.activityLog.findMany({
      where: {
        action: { in: RESOURCE_ACTIONS },
        // ผู้ใช้ทั่วไปเห็นเฉพาะการกระทำของตนเอง ผู้ดูแลระบบเห็นทั้งองค์กร
        ...(isAdmin ? {} : { userId: user.id }),
      },
      include: { user: { select: { displayName: true, email: true } } },
      orderBy: { createdAt: 'desc' },
      take: 8,
    }),
  ]);

  // ดึงชื่อทรัพยากรของเหตุการณ์เท่าที่ยังมีอยู่ (บางรายการอาจถูกลบไปแล้ว)
  const resourceIds = [...new Set(activityRows.map((row) => row.resourceId).filter((id): id is string => Boolean(id)))];
  const names = resourceIds.length
    ? await prisma.resource.findMany({ where: { id: { in: resourceIds } }, select: { id: true, name: true } })
    : [];
  const nameById = new Map(names.map((row) => [row.id, row.name]));

  return {
    totals: { resources: folders + files, folders, files, ownedByMe },
    recentResources: recentRows.map((row) => toResourceDto(row, user)),
    recentActivity: activityRows.map((row) => ({
      id: row.id,
      action: row.action,
      createdAt: row.createdAt,
      actor: row.user ? { displayName: row.user.displayName, email: row.user.email } : null,
      resourceName: row.resourceId ? (nameById.get(row.resourceId) ?? null) : null,
    })),
    activityScopeIsOrganization: isAdmin,
  };
}

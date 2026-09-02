import type { ResourceAccessLevel } from '@prisma/client';
import { prisma } from '../../core/prisma.js';
import { AppError, forbidden, notFound } from '../../core/errors.js';
import { logger } from '../../core/logger.js';
import { capabilities, toResourceDto } from '../resources/resource.service.js';
import { resourceInclude, type AuditContext } from './workspace.service.js';
import type { AuthUser } from '../auth/auth.service.js';

/**
 * การแชร์ภายในองค์กร
 *
 * นโยบายที่เลือกใช้ (บันทึกไว้ใน docs/SHARING.md):
 * - ผู้ดูแลหลักของทรัพยากร ผู้ดูแลระบบ และผู้ที่มีสิทธิ์ resources:share เท่านั้นที่แก้ไขสิทธิ์ได้
 * - EDITOR ที่ได้รับมอบสิทธิ์ ไม่ได้อำนาจจัดการสิทธิ์ต่อโดยอัตโนมัติ
 * - การแชร์ให้สิทธิ์ได้เพียง EDITOR หรือ VIEWER เท่านั้น
 *   ความเป็นผู้ดูแลหลักเปลี่ยนผ่านขั้นตอนโอนผู้ดูแลที่มีอยู่แล้ว ไม่ใช่ผ่านการแชร์
 */

const ownerSelect = { id: true, displayName: true, email: true } as const;

export type ShareLevel = Extract<ResourceAccessLevel, 'EDITOR' | 'VIEWER'>;

async function loadResource(id: string) {
  const resource = await prisma.resource.findFirst({ where: { id }, include: resourceInclude });
  if (!resource) throw notFound('RESOURCE_NOT_FOUND', 'ไม่พบทรัพยากร');
  if (resource.deletedAt) throw notFound('RESOURCE_NOT_FOUND', 'ไม่พบทรัพยากร');
  return resource;
}

async function assertMayManageAccess(id: string, user: AuthUser) {
  const resource = await loadResource(id);
  const caps = capabilities(resource, user);
  if (!caps.canView) throw notFound('RESOURCE_NOT_FOUND', 'ไม่พบทรัพยากร');
  if (!caps.canShare) {
    throw new AppError('SHARE_DENIED', 'ไม่มีสิทธิ์จัดการสิทธิ์ของทรัพยากรนี้', 403);
  }
  return resource;
}

/* ------------------------------------------------------------------ */
/* อ่านรายชื่อผู้เข้าถึง                                                 */
/* ------------------------------------------------------------------ */

export async function listAccess(resourceId: string, user: AuthUser) {
  const resource = await loadResource(resourceId);
  const caps = capabilities(resource, user);
  if (!caps.canView) throw notFound('RESOURCE_NOT_FOUND', 'ไม่พบทรัพยากร');

  const grants = await prisma.resourceAccess.findMany({
    where: { resourceId },
    include: { user: { select: { ...ownerSelect, status: true } } },
    orderBy: { createdAt: 'asc' },
  });

  return {
    owner: resource.owner,
    visibility: resource.visibility,
    canManage: caps.canShare,
    grants: grants.map((grant) => ({
      userId: grant.userId,
      user: { id: grant.user.id, displayName: grant.user.displayName, email: grant.user.email },
      accessLevel: grant.accessLevel,
      allowDownload: grant.allowDownload,
      userStatus: grant.user.status,
    })),
  };
}

/* ------------------------------------------------------------------ */
/* ให้/แก้ไขสิทธิ์                                                      */
/* ------------------------------------------------------------------ */

export async function grantAccess(
  resourceId: string,
  input: { userId: string; accessLevel: ShareLevel; allowDownload: boolean },
  user: AuthUser,
  audit: AuditContext,
) {
  const resource = await assertMayManageAccess(resourceId, user);

  if (input.userId === resource.ownerId) {
    throw new AppError('SHARE_INVALID_TARGET', 'ผู้ดูแลหลักมีสิทธิ์เต็มอยู่แล้ว', 400);
  }

  // แชร์ให้ได้เฉพาะผู้ใช้ที่เปิดใช้งานจริงเท่านั้น
  const target = await prisma.user.findFirst({
    where: { id: input.userId, status: 'ACTIVE' },
    select: ownerSelect,
  });
  if (!target) {
    throw new AppError('SHARE_TARGET_INACTIVE', 'แชร์ได้เฉพาะผู้ใช้ที่เปิดใช้งานอยู่', 400);
  }

  await prisma.resourceAccess.upsert({
    where: { resourceId_userId: { resourceId, userId: input.userId } },
    create: {
      resourceId,
      userId: input.userId,
      accessLevel: input.accessLevel,
      allowDownload: input.allowDownload,
      createdById: user.id,
    },
    update: { accessLevel: input.accessLevel, allowDownload: input.allowDownload },
  });

  await prisma.activityLog.create({
    data: {
      userId: user.id,
      action: 'RESOURCE_ACCESS_GRANTED',
      resourceId,
      ipAddress: audit.ipAddress,
      userAgent: audit.userAgent?.slice(0, 500),
      // เก็บเฉพาะ metadata ที่ปลอดภัย ไม่เก็บอีเมลหรือข้อมูลส่วนบุคคลลง log
      metadata: { targetUserId: input.userId, accessLevel: input.accessLevel, allowDownload: input.allowDownload },
    },
  });

  logger.info(`[SHARE] ให้สิทธิ์ ${input.accessLevel} บน "${resource.name}"`);
  return listAccess(resourceId, user);
}

export async function revokeAccess(
  resourceId: string,
  targetUserId: string,
  user: AuthUser,
  audit: AuditContext,
) {
  await assertMayManageAccess(resourceId, user);

  const removed = await prisma.resourceAccess.deleteMany({ where: { resourceId, userId: targetUserId } });
  if (removed.count === 0) throw notFound('ACCESS_NOT_FOUND', 'ไม่พบสิทธิ์ที่ต้องการลบ');

  await prisma.activityLog.create({
    data: {
      userId: user.id,
      action: 'RESOURCE_ACCESS_REVOKED',
      resourceId,
      ipAddress: audit.ipAddress,
      userAgent: audit.userAgent?.slice(0, 500),
      metadata: { targetUserId },
    },
  });

  return listAccess(resourceId, user);
}

/* ------------------------------------------------------------------ */
/* แชร์กับฉัน                                                          */
/* ------------------------------------------------------------------ */

/**
 * รายการที่ "ถูกแชร์ให้ฉันโดยเฉพาะ"
 *
 * ต้องเป็นการมอบสิทธิ์รายบุคคลเท่านั้น ไม่รวมทรัพยากรที่เห็นได้เพราะเป็น ORGANIZATION
 * มิฉะนั้นหน้านี้จะกลายเป็นรายการทุกอย่างในองค์กรและไม่มีความหมาย
 */
export async function listSharedWithMe(user: AuthUser) {
  const grants = await prisma.resourceAccess.findMany({
    where: { userId: user.id, resource: { deletedAt: null } },
    include: { resource: { include: resourceInclude } },
    orderBy: { createdAt: 'desc' },
    take: 200,
  });

  return grants
    .filter((grant) => capabilities(grant.resource, user).canView)
    .map((grant) => ({
      ...toResourceDto(grant.resource, user),
      myAccessLevel: grant.accessLevel,
      myAllowDownload: grant.allowDownload,
      sharedAt: grant.createdAt,
    }));
}

/* ------------------------------------------------------------------ */
/* ค้นหาผู้ใช้สำหรับการแชร์                                              */
/* ------------------------------------------------------------------ */

/** ค้นหาผู้ใช้ที่เปิดใช้งาน เปิดเผยเฉพาะฟิลด์ที่จำเป็นต่อการเลือกคน */
export async function searchShareTargets(query: string, user: AuthUser, limit = 10) {
  if (!user.permissions.includes('resources:read')) throw forbidden('ไม่มีสิทธิ์ค้นหาผู้ใช้');

  const term = query.trim();
  if (!term) return [];

  const users = await prisma.user.findMany({
    where: {
      status: 'ACTIVE',
      id: { not: user.id },
      OR: [{ displayName: { contains: term } }, { email: { contains: term } }],
    },
    select: ownerSelect,
    orderBy: { displayName: 'asc' },
    take: limit,
  });

  return users;
}

import type { ResourceAccessLevel } from '@prisma/client';
import { prisma } from '../../core/prisma.js';
import { AppError, forbidden, notFound } from '../../core/errors.js';
import { logger } from '../../core/logger.js';
import { capabilities, toResourceDto } from '../resources/resource.service.js';
import { resourceInclude, type AuditContext } from './workspace.service.js';
import type { AuthUser } from '../auth/auth.service.js';
import { EXTERNAL_AUDIT_ACTIONS, isGrantActive } from '../portal/portal-policy.js';

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
/** ผู้รับสิทธิ์ต้องแยกได้ว่าเป็นบุคลากรภายในหรือลูกค้า ตัวตนที่กำกวมคือความเสี่ยง */
const targetSelect = { ...ownerSelect, type: true, organizationName: true } as const;

export type ShareLevel = Extract<ResourceAccessLevel, 'EDITOR' | 'VIEWER'>;

/**
 * เพดานอายุของการมอบสิทธิ์
 *
 * มีไว้กันการตั้งวันหมดอายุไกลจนไม่มีความหมาย ซึ่งเท่ากับ "ไม่หมดอายุ" แต่ดูเหมือนมีการควบคุม
 * ถ้าตั้งใจให้ไม่หมดอายุจริง ต้องเลือก "ไม่หมดอายุ" อย่างชัดเจน
 */
const MAX_EXPIRY_DAYS = 730;

/** วันหมดอายุต้องอยู่ในอนาคต และไม่ไกลเกินเพดาน - เก็บเป็นเวลาสัมบูรณ์เสมอ */
export function normalizeExpiry(value: Date | null | undefined, now: Date = new Date()): Date | null {
  if (value === null || value === undefined) return null;
  if (Number.isNaN(value.getTime())) {
    throw new AppError('SHARE_INVALID_EXPIRY', 'วันหมดอายุไม่ถูกต้อง', 400);
  }
  if (value.getTime() <= now.getTime()) {
    throw new AppError('SHARE_INVALID_EXPIRY', 'วันหมดอายุต้องอยู่ในอนาคต', 400);
  }
  const limit = now.getTime() + MAX_EXPIRY_DAYS * 24 * 60 * 60 * 1000;
  if (value.getTime() > limit) {
    throw new AppError('SHARE_INVALID_EXPIRY', 'วันหมดอายุต้องไม่เกิน ' + MAX_EXPIRY_DAYS + ' วันนับจากวันนี้', 400);
  }
  return value;
}

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
    include: { user: { select: { ...targetSelect, status: true } } },
    orderBy: { createdAt: 'asc' },
  });
  const now = new Date();

  return {
    owner: resource.owner,
    visibility: resource.visibility,
    canManage: caps.canShare,
    grants: grants.map((grant) => ({
      userId: grant.userId,
      user: {
        id: grant.user.id,
        displayName: grant.user.displayName,
        email: grant.user.email,
        userType: grant.user.type,
        organizationName: grant.user.organizationName,
      },
      accessLevel: grant.accessLevel,
      allowDownload: grant.allowDownload,
      expiresAt: grant.expiresAt,
      /** สิทธิ์ที่หมดอายุยังแสดงอยู่ในรายการ เพื่อให้ผู้ดูแลเห็นว่าเคยให้ไว้ แต่ไม่มีผลแล้ว */
      isExpired: !isGrantActive(grant, now),
      userStatus: grant.user.status,
    })),
  };
}

/* ------------------------------------------------------------------ */
/* ให้/แก้ไขสิทธิ์                                                      */
/* ------------------------------------------------------------------ */

export async function grantAccess(
  resourceId: string,
  input: { userId: string; accessLevel: ShareLevel; allowDownload: boolean; expiresAt?: Date | null },
  user: AuthUser,
  audit: AuditContext,
) {
  const resource = await assertMayManageAccess(resourceId, user);

  if (input.userId === resource.ownerId) {
    throw new AppError('SHARE_INVALID_TARGET', 'ผู้ดูแลหลักมีสิทธิ์เต็มอยู่แล้ว', 400);
  }

  /**
   * แชร์ให้ได้เฉพาะบัญชีของคนจริงที่เปิดใช้งานอยู่
   * บัญชีของระบบเชื่อมต่อ (SERVICE) ได้สิทธิ์ผ่านขอบเขตของตัวเอง ไม่ใช่ผ่านการแชร์
   */
  const target = await prisma.user.findFirst({
    where: { id: input.userId, status: 'ACTIVE', type: { in: ['INTERNAL', 'EXTERNAL'] } },
    select: targetSelect,
  });
  if (!target) {
    throw new AppError('SHARE_TARGET_INACTIVE', 'แชร์ได้เฉพาะผู้ใช้ที่เปิดใช้งานอยู่', 400);
  }

  const expiresAt = normalizeExpiry(input.expiresAt);
  const isExternal = target.type === 'EXTERNAL';

  await prisma.resourceAccess.upsert({
    where: { resourceId_userId: { resourceId, userId: input.userId } },
    create: {
      resourceId,
      userId: input.userId,
      accessLevel: input.accessLevel,
      allowDownload: input.allowDownload,
      expiresAt,
      createdById: user.id,
    },
    // การแก้ไขสิทธิ์เขียนทับวันหมดอายุเสมอ ค่าที่ไม่ได้ส่งมาแปลว่า "ไม่หมดอายุ" ไม่ใช่ "คงของเดิม"
    update: { accessLevel: input.accessLevel, allowDownload: input.allowDownload, expiresAt },
  });

  await prisma.activityLog.create({
    data: {
      userId: user.id,
      action: isExternal ? EXTERNAL_AUDIT_ACTIONS.ACCESS_GRANTED : 'RESOURCE_ACCESS_GRANTED',
      resourceId,
      ipAddress: audit.ipAddress,
      userAgent: audit.userAgent?.slice(0, 500),
      // เก็บเฉพาะ metadata ที่ปลอดภัย ไม่เก็บอีเมลหรือข้อมูลส่วนบุคคลลง log
      metadata: {
        targetUserId: input.userId,
        accessLevel: input.accessLevel,
        allowDownload: input.allowDownload,
        expiresAt: expiresAt === null ? null : expiresAt.toISOString(),
      },
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

  const target = await prisma.user.findUnique({ where: { id: targetUserId }, select: { type: true } });

  /**
   * การเพิกถอนมีผลทันที ไม่ต้องรอ session หมดอายุหรือให้ผู้ใช้ออกจากระบบ
   * เพราะทุกคำขอตรวจสิทธิ์จากฐานข้อมูลใหม่เสมอ ไม่มีการจำสิทธิ์ไว้ใน token
   */
  const removed = await prisma.resourceAccess.deleteMany({ where: { resourceId, userId: targetUserId } });
  if (removed.count === 0) throw notFound('ACCESS_NOT_FOUND', 'ไม่พบสิทธิ์ที่ต้องการลบ');

  await prisma.activityLog.create({
    data: {
      userId: user.id,
      action: target?.type === 'EXTERNAL' ? EXTERNAL_AUDIT_ACTIONS.ACCESS_REVOKED : 'RESOURCE_ACCESS_REVOKED',
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
  const now = new Date();
  const grants = await prisma.resourceAccess.findMany({
    where: { userId: user.id, resource: { deletedAt: null } },
    include: { resource: { include: resourceInclude } },
    orderBy: { createdAt: 'desc' },
    take: 200,
  });

  return grants
    // สิทธิ์ที่หมดอายุหายไปจากรายการทันที ไม่ต้องรอใครมาเก็บกวาด
    .filter((grant) => isGrantActive(grant, now))
    .filter((grant) => capabilities(grant.resource, user).canView)
    .map((grant) => ({
      ...toResourceDto(grant.resource, user),
      myAccessLevel: grant.accessLevel,
      myAllowDownload: grant.allowDownload,
      myAccessExpiresAt: grant.expiresAt,
      sharedAt: grant.createdAt,
    }));
}

/* ------------------------------------------------------------------ */
/* ค้นหาผู้ใช้สำหรับการแชร์                                              */
/* ------------------------------------------------------------------ */

/**
 * ค้นหาผู้ใช้ที่เปิดใช้งาน เปิดเผยเฉพาะฟิลด์ที่จำเป็นต่อการเลือกคน
 *
 * ผลลัพธ์ระบุชนิดบัญชีมาด้วยเสมอ หน้าจอจึงแยก "บุคลากรภายใน" ออกจาก "ลูกค้า" ได้
 * การเลือกคนผิดกลุ่มคือการเปิดเอกสารให้คนนอกโดยไม่ตั้งใจ ตัวตนจึงต้องไม่กำกวม
 * บัญชีของระบบเชื่อมต่อไม่อยู่ในผลการค้นหา เพราะไม่ใช่ผู้รับสิทธิ์ที่ถูกต้อง
 */
export async function searchShareTargets(
  query: string,
  user: AuthUser,
  limit = 10,
  scope?: 'INTERNAL' | 'EXTERNAL',
) {
  if (!user.permissions.includes('resources:read')) throw forbidden('ไม่มีสิทธิ์ค้นหาผู้ใช้');

  const term = query.trim();
  if (!term) return [];

  const users = await prisma.user.findMany({
    where: {
      status: 'ACTIVE',
      id: { not: user.id },
      type: scope ? { equals: scope } : { in: ['INTERNAL', 'EXTERNAL'] },
      OR: [{ displayName: { contains: term } }, { email: { contains: term } }],
    },
    select: targetSelect,
    orderBy: { displayName: 'asc' },
    take: limit,
  });

  return users.map((row) => ({
    id: row.id,
    displayName: row.displayName,
    email: row.email,
    userType: row.type,
    organizationName: row.organizationName,
  }));
}

import bcrypt from 'bcryptjs';
import type { Prisma, UserStatus } from '@prisma/client';
import { prisma } from '../../core/prisma.js';
import { AppError, forbidden, notFound } from '../../core/errors.js';
import { logger } from '../../core/logger.js';
import { assertPasswordStrength } from '../auth/password-policy.js';
import type { AuthUser } from '../auth/auth.service.js';

/**
 * การจัดการบัญชีผู้ใช้
 *
 * หลักสำคัญสามข้อ
 *  1. รหัสผ่านมีอยู่ในฐานข้อมูลเป็น hash เท่านั้น และไม่ถูกส่งกลับหรือบันทึกที่ใดอีก
 *  2. ปิดบัญชีที่ยังดูแลทรัพยากรอยู่ไม่ได้เงียบ ๆ ต้องส่งมอบหรือรับทราบก่อน
 *  3. ระบบต้องเหลือผู้ดูแลสูงสุดที่ใช้งานได้อย่างน้อยหนึ่งคนเสมอ
 */

const BCRYPT_ROUNDS = 12;
export const MAX_DISPLAY_NAME_LENGTH = 100;
const CONTROL_CHARACTER = /\p{Cc}/u;

export const userSelect = {
  id: true,
  email: true,
  displayName: true,
  type: true,
  status: true,
  mustChangePassword: true,
  lastLoginAt: true,
  createdAt: true,
  roles: { select: { role: { select: { id: true, code: true, name: true } } } },
} as const;

export interface AuditContext {
  ipAddress?: string;
  userAgent?: string;
}

/**
 * ชื่อที่แสดงเป็นข้อความ Unicode สำหรับมนุษย์ ไม่ใช่ข้อมูลระบุตัวตนเพื่อความปลอดภัย
 * อนุญาตชื่อซ้ำและภาษาไทย แต่ไม่รับค่าว่างหรือ control character ที่ทำให้ UI/log สับสน
 */
export function normalizeDisplayName(value: string): string {
  const displayName = value.trim();
  if (!displayName) {
    throw new AppError('INVALID_DISPLAY_NAME', 'ชื่อที่แสดงต้องไม่เป็นค่าว่าง', 400);
  }
  if (displayName.length > MAX_DISPLAY_NAME_LENGTH) {
    throw new AppError(
      'INVALID_DISPLAY_NAME',
      `ชื่อที่แสดงต้องยาวไม่เกิน ${MAX_DISPLAY_NAME_LENGTH} ตัวอักษร`,
      400,
    );
  }
  if (CONTROL_CHARACTER.test(displayName)) {
    throw new AppError('INVALID_DISPLAY_NAME', 'ชื่อที่แสดงมีอักขระควบคุมที่ไม่อนุญาต', 400);
  }
  return displayName;
}

async function logUserEvent(
  action: string,
  actor: AuthUser,
  targetUserId: string,
  audit: AuditContext,
  metadata: Record<string, unknown> = {},
) {
  await prisma.activityLog.create({
    data: {
      userId: actor.id,
      action,
      ipAddress: audit.ipAddress,
      userAgent: audit.userAgent?.slice(0, 500),
      // เก็บเฉพาะรหัสอ้างอิงและผลลัพธ์ ไม่เก็บรหัสผ่าน hash หรือ token ใด ๆ
      metadata: { targetUserId, ...metadata } as Prisma.InputJsonValue,
    },
  });
}

/* ------------------------------------------------------------------ */
/* รายชื่อผู้ใช้                                                        */
/* ------------------------------------------------------------------ */

export interface ListUsersInput {
  q?: string;
  status?: UserStatus;
  roleCode?: string;
  limit: number;
  cursor?: string;
}

export async function listUsers(input: ListUsersInput) {
  const where: Prisma.UserWhereInput = {
    ...(input.status ? { status: input.status } : {}),
    ...(input.roleCode ? { roles: { some: { role: { code: input.roleCode } } } } : {}),
    ...(input.q
      ? { OR: [{ displayName: { contains: input.q } }, { email: { contains: input.q } }] }
      : {}),
  };

  const rows = await prisma.user.findMany({
    where,
    select: userSelect,
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: input.limit + 1,
    ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
  });

  const page = rows.slice(0, input.limit);
  return {
    items: page,
    nextCursor: rows.length > input.limit ? page[page.length - 1]?.id ?? null : null,
    total: await prisma.user.count({ where }),
  };
}

/* ------------------------------------------------------------------ */
/* การป้องกันผู้ดูแลสูงสุดคนสุดท้าย                                       */
/* ------------------------------------------------------------------ */

/**
 * ระบบต้องเหลือ SUPER_ADMIN ที่ใช้งานได้อย่างน้อยหนึ่งคนเสมอ
 *
 * ถ้าปล่อยให้ถอดคนสุดท้ายออกได้ จะไม่มีใครแก้ไขบทบาทของใครได้อีกเลย
 * และต้องแก้ที่ฐานข้อมูลโดยตรงเท่านั้น ซึ่งเป็นสถานะที่กู้คืนยากที่สุด
 */
async function assertSuperAdminRemains(
  tx: Prisma.TransactionClient,
  targetUserId: string,
  next: { status?: UserStatus; roleCodes?: string[] },
) {
  const target = await tx.user.findUnique({
    where: { id: targetUserId },
    select: { status: true, roles: { select: { role: { select: { code: true } } } } },
  });
  if (!target) return;

  const wasSuperAdmin = target.roles.some((link) => link.role.code === 'SUPER_ADMIN');
  if (!wasSuperAdmin || target.status !== 'ACTIVE') return;

  const staysSuperAdmin =
    (next.roleCodes ? next.roleCodes.includes('SUPER_ADMIN') : true) &&
    (next.status ? next.status === 'ACTIVE' : true);
  if (staysSuperAdmin) return;

  const otherActive = await tx.user.count({
    where: {
      id: { not: targetUserId },
      status: 'ACTIVE',
      roles: { some: { role: { code: 'SUPER_ADMIN' } } },
    },
  });
  if (otherActive === 0) {
    throw new AppError(
      'LAST_SUPER_ADMIN',
      'ต้องเหลือผู้ดูแลสูงสุดที่เปิดใช้งานอย่างน้อยหนึ่งคน',
      409,
    );
  }
}

/* ------------------------------------------------------------------ */
/* เปิดใช้งานบัญชีที่ถูกเชิญไว้                                          */
/* ------------------------------------------------------------------ */

/**
 * เปิดใช้งานผู้ใช้ที่สถานะ INVITED โดยตั้งรหัสผ่านชั่วคราว
 *
 * ผู้ดูแลเป็นผู้กำหนดรหัสเอง ระบบไม่สุ่มให้ เพราะรหัสที่ระบบสร้างต้องถูกแสดง
 * ออกหน้าจอหรือส่งต่อทางใดทางหนึ่ง ซึ่งเป็นจุดที่รหัสรั่วได้ง่ายที่สุด
 * บังคับ mustChangePassword เสมอ รหัสชั่วคราวจึงใช้ได้ครั้งเดียวจริง ๆ
 */
export async function activateUser(
  id: string,
  temporaryPassword: string,
  actor: AuthUser,
  audit: AuditContext,
) {
  assertPasswordStrength(temporaryPassword);

  const existing = await prisma.user.findUnique({ where: { id }, select: { status: true } });
  if (!existing) throw notFound('USER_NOT_FOUND', 'ไม่พบผู้ใช้');
  if (existing.status === 'ACTIVE') {
    throw new AppError('USER_ALREADY_ACTIVE', 'บัญชีนี้เปิดใช้งานอยู่แล้ว', 409);
  }

  const passwordHash = await bcrypt.hash(temporaryPassword, BCRYPT_ROUNDS);
  const user = await prisma.user.update({
    where: { id },
    data: {
      passwordHash,
      status: 'ACTIVE',
      mustChangePassword: true,
      // ยกเลิก session เดิมทั้งหมด กันกรณีบัญชีเคยถูกปิดขณะยังมี token ค้างอยู่
      tokenVersion: { increment: 1 },
    },
    select: userSelect,
  });
  await prisma.refreshToken.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } });

  await logUserEvent('USER_ACTIVATED', actor, id, audit, { previousStatus: existing.status });
  logger.info('[USER] เปิดใช้งานบัญชีแล้ว');
  return user;
}

/* ------------------------------------------------------------------ */
/* ตั้งรหัสผ่านชั่วคราวใหม่                                              */
/* ------------------------------------------------------------------ */

export async function resetTemporaryPassword(
  id: string,
  temporaryPassword: string,
  actor: AuthUser,
  audit: AuditContext,
) {
  assertPasswordStrength(temporaryPassword);

  const existing = await prisma.user.findUnique({ where: { id }, select: { status: true } });
  if (!existing) throw notFound('USER_NOT_FOUND', 'ไม่พบผู้ใช้');

  const passwordHash = await bcrypt.hash(temporaryPassword, BCRYPT_ROUNDS);
  const user = await prisma.user.update({
    where: { id },
    data: { passwordHash, mustChangePassword: true, tokenVersion: { increment: 1 } },
    select: userSelect,
  });
  // ตัด session ที่ยังเปิดอยู่ทิ้ง มิฉะนั้นการรีเซ็ตรหัสจะไม่ได้ตัดการเข้าถึงจริง
  await prisma.refreshToken.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } });

  await logUserEvent('USER_TEMP_PASSWORD_RESET', actor, id, audit);
  logger.info('[USER] ตั้งรหัสผ่านชั่วคราวใหม่แล้ว');
  return user;
}

/* ------------------------------------------------------------------ */
/* ปิดการใช้งาน                                                        */
/* ------------------------------------------------------------------ */

export async function setUserStatus(
  id: string,
  status: UserStatus,
  options: { acknowledgeHandover?: boolean },
  actor: AuthUser,
  audit: AuditContext,
) {
  if (id === actor.id && status !== 'ACTIVE') {
    throw new AppError('CANNOT_DISABLE_SELF', 'ปิดการใช้งานบัญชีของตัวเองไม่ได้', 400);
  }

  const user = await prisma.$transaction(async (tx) => {
    const existing = await tx.user.findUnique({ where: { id }, select: { status: true } });
    if (!existing) throw notFound('USER_NOT_FOUND', 'ไม่พบผู้ใช้');

    await assertSuperAdminRemains(tx, id, { status });

    // ปิดบัญชีที่ยังถือทรัพยากรอยู่ได้ แต่ต้องรับทราบก่อน ไม่ปล่อยให้เอกสารไร้ผู้ดูแลเงียบ ๆ
    if (status !== 'ACTIVE' && existing.status === 'ACTIVE' && !options.acknowledgeHandover) {
      const ownedTotal = await tx.resource.count({ where: { ownerId: id, deletedAt: null } });
      if (ownedTotal > 0) {
        const ownedFolders = await tx.resource.count({
          where: { ownerId: id, deletedAt: null, type: 'FOLDER' },
        });
        throw new AppError(
          'USER_STILL_OWNS_RESOURCES',
          'ผู้ใช้รายนี้ยังเป็นผู้ดูแลทรัพยากรอยู่ ต้องส่งมอบก่อนหรือยืนยันการปิดใช้งาน',
          409,
          { ownedTotal, ownedFolders, ownedFiles: ownedTotal - ownedFolders },
        );
      }
    }

    return tx.user.update({
      where: { id },
      data: { status, tokenVersion: status !== 'ACTIVE' ? { increment: 1 } : undefined },
      select: userSelect,
    });
  });

  if (status !== 'ACTIVE') {
    await prisma.refreshToken.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } });
  }

  await logUserEvent(status === 'ACTIVE' ? 'USER_ACTIVATED' : 'USER_DISABLED', actor, id, audit, { status });
  return user;
}

/* ------------------------------------------------------------------ */
/* บทบาท                                                              */
/* ------------------------------------------------------------------ */

export async function changeUserRoles(
  id: string,
  roleCodes: string[],
  actor: AuthUser,
  audit: AuditContext,
) {
  if (!actor.permissions.includes('users:manage')) {
    throw forbidden('ไม่มีสิทธิ์เปลี่ยนบทบาทผู้ใช้');
  }
  const unique = [...new Set(roleCodes)];
  // ใช้ได้เฉพาะบทบาทที่มีอยู่จริงในฐานข้อมูล ไม่รับชื่อบทบาทที่พิมพ์ขึ้นมาเอง
  const roles = await prisma.role.findMany({ where: { code: { in: unique } }, select: { id: true, code: true } });
  if (roles.length !== unique.length) throw notFound('ROLE_NOT_FOUND', 'ไม่พบบทบาทที่ระบุ');

  const user = await prisma.$transaction(async (tx) => {
    const existing = await tx.user.findUnique({ where: { id }, select: { id: true } });
    if (!existing) throw notFound('USER_NOT_FOUND', 'ไม่พบผู้ใช้');

    await assertSuperAdminRemains(tx, id, { roleCodes: unique });

    await tx.userRole.deleteMany({ where: { userId: id } });
    await tx.userRole.createMany({ data: roles.map((role) => ({ userId: id, roleId: role.id })) });
    // สิทธิ์ที่ฝังอยู่ใน access token เดิมไม่ตรงกับบทบาทใหม่แล้ว จึงต้องบังคับออก session
    return tx.user.update({ where: { id }, data: { tokenVersion: { increment: 1 } }, select: userSelect });
  });

  await prisma.refreshToken.updateMany({
    where: { userId: id, revokedAt: null },
    data: { revokedAt: new Date() },
  });

  await logUserEvent('USER_ROLE_CHANGED', actor, id, audit, { roleCodes: unique });
  logger.info('[USER] เปลี่ยนบทบาทผู้ใช้แล้ว');
  return user;
}

/* ------------------------------------------------------------------ */
/* โปรไฟล์                                                            */
/* ------------------------------------------------------------------ */

/** แก้ชื่อของตัวเองได้เสมอ ส่วนการแก้ชื่อผู้อื่นต้องมี users:manage */
export async function updateUserProfile(
  id: string,
  input: { displayName: string },
  actor: AuthUser,
  audit: AuditContext,
) {
  if (id !== actor.id && !actor.permissions.includes('users:manage')) {
    throw forbidden('ไม่มีสิทธิ์แก้ไขข้อมูลผู้ใช้อื่น');
  }

  const displayName = normalizeDisplayName(input.displayName);
  const existing = await prisma.user.findUnique({
    where: { id },
    select: { id: true, displayName: true },
  });
  if (!existing) throw notFound('USER_NOT_FOUND', 'ไม่พบผู้ใช้');

  if (existing.displayName === displayName) {
    return prisma.user.findUniqueOrThrow({ where: { id }, select: userSelect });
  }

  const user = await prisma.user.update({
    where: { id },
    data: { displayName },
    select: userSelect,
  });
  await prisma.activityLog.create({
    data: {
      userId: actor.id,
      action: 'USER_PROFILE_UPDATED',
      ipAddress: audit.ipAddress,
      userAgent: audit.userAgent?.slice(0, 500),
      metadata: { userId: id, changedFields: ['displayName'] },
    },
  });
  return user;
}

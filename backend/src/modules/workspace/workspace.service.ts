import type { Prisma } from '@prisma/client';
import { prisma } from '../../core/prisma.js';
import { AppError, forbidden, notFound } from '../../core/errors.js';
import { logger } from '../../core/logger.js';
import { capabilities, resourceInclude, toResourceDto } from '../resources/resource.service.js';
import type { AuthUser } from '../auth/auth.service.js';

/**
 * พื้นที่ทำงานระดับองค์กร: รายการโปรด ปักหมุด แท็ก หมายเหตุ และการล็อก
 *
 * หลักการความปลอดภัยที่ใช้ตลอดไฟล์นี้:
 * - รายการโปรดและการปักหมุดเป็น "ความชอบส่วนบุคคล" ไม่ใช่สิทธิ์
 *   จึงต้องกรองด้วยสิทธิ์จริงทุกครั้งที่อ่าน ไม่ให้ทรัพยากรที่เข้าถึงไม่ได้รั่วออกมา
 * - แท็กต้องไม่ทำให้เดาได้ว่ามีทรัพยากรลับอยู่ จำนวนและผลค้นหาจึงนับเฉพาะที่ผู้ใช้เห็นได้
 */

const ownerSelect = { id: true, displayName: true, email: true } as const;

// ใช้นิยามกลางจาก resource.service เพื่อไม่ให้ include ของแต่ละโมดูลหลุดจากกัน
export { resourceInclude };

export interface AuditContext {
  ipAddress?: string;
  userAgent?: string;
}

async function loadResource(id: string) {
  const resource = await prisma.resource.findFirst({ where: { id }, include: resourceInclude });
  if (!resource) throw notFound('RESOURCE_NOT_FOUND', 'ไม่พบทรัพยากร');
  return resource;
}

/** ผู้ใช้ต้องมองเห็นทรัพยากรนี้จริง มิฉะนั้นถือว่าไม่พบ เพื่อไม่ให้เดาการมีอยู่ได้ */
async function assertVisible(id: string, user: AuthUser) {
  const resource = await loadResource(id);
  if (resource.deletedAt) throw notFound('RESOURCE_NOT_FOUND', 'ไม่พบทรัพยากร');
  if (!capabilities(resource, user).canView) {
    throw notFound('RESOURCE_NOT_FOUND', 'ไม่พบทรัพยากร');
  }
  return resource;
}

async function logActivity(
  action: string,
  user: AuthUser,
  resourceId: string | null,
  audit: AuditContext,
  metadata?: Prisma.InputJsonValue,
) {
  await prisma.activityLog.create({
    data: {
      userId: user.id,
      action,
      resourceId,
      ipAddress: audit.ipAddress,
      userAgent: audit.userAgent?.slice(0, 500),
      ...(metadata === undefined ? {} : { metadata }),
    },
  });
}

/* ------------------------------------------------------------------ */
/* รายการโปรด                                                          */
/* ------------------------------------------------------------------ */

export async function addFavorite(resourceId: string, user: AuthUser) {
  await assertVisible(resourceId, user);
  // ซ้ำได้อย่างปลอดภัย: กดซ้ำไม่ควรเป็นข้อผิดพลาดสำหรับผู้ใช้
  await prisma.userFavorite.upsert({
    where: { userId_resourceId: { userId: user.id, resourceId } },
    create: { userId: user.id, resourceId },
    update: {},
  });
  return { favorited: true };
}

export async function removeFavorite(resourceId: string, user: AuthUser) {
  await prisma.userFavorite.deleteMany({ where: { userId: user.id, resourceId } });
  return { favorited: false };
}

export async function listFavorites(user: AuthUser) {
  const rows = await prisma.userFavorite.findMany({
    where: { userId: user.id, resource: { deletedAt: null } },
    include: { resource: { include: resourceInclude } },
    orderBy: { createdAt: 'desc' },
    take: 200,
  });

  // กรองด้วยสิทธิ์จริง: ถ้าสิทธิ์หายไปภายหลัง ต้องไม่เปิดเผย metadata ของทรัพยากรนั้น
  return rows
    .map((row) => row.resource)
    .filter((resource) => capabilities(resource, user).canView)
    .map((resource) => toResourceDto(resource, user));
}

/* ------------------------------------------------------------------ */
/* ปักหมุด                                                             */
/* ------------------------------------------------------------------ */

export async function pinResource(resourceId: string, user: AuthUser) {
  await assertVisible(resourceId, user);
  const last = await prisma.userPinnedResource.findFirst({
    where: { userId: user.id },
    orderBy: { sortOrder: 'desc' },
    select: { sortOrder: true },
  });
  await prisma.userPinnedResource.upsert({
    where: { userId_resourceId: { userId: user.id, resourceId } },
    create: { userId: user.id, resourceId, sortOrder: (last?.sortOrder ?? 0) + 1 },
    update: {},
  });
  return { pinned: true };
}

export async function unpinResource(resourceId: string, user: AuthUser) {
  await prisma.userPinnedResource.deleteMany({ where: { userId: user.id, resourceId } });
  return { pinned: false };
}

export async function listPins(user: AuthUser) {
  const rows = await prisma.userPinnedResource.findMany({
    where: { userId: user.id, resource: { deletedAt: null } },
    include: { resource: { include: resourceInclude } },
    orderBy: { sortOrder: 'asc' },
    take: 50,
  });

  return rows
    .map((row) => row.resource)
    .filter((resource) => capabilities(resource, user).canView)
    .map((resource) => toResourceDto(resource, user));
}

/* ------------------------------------------------------------------ */
/* แท็ก                                                                */
/* ------------------------------------------------------------------ */

const MAX_TAG_LENGTH = 64;

/**
 * ทำให้ชื่อแท็กเป็นมาตรฐาน รองรับภาษาไทยและ Unicode เต็มรูปแบบ
 * ตัดช่องว่างส่วนเกินและเทียบซ้ำแบบไม่สนตัวพิมพ์ใหญ่เล็ก
 */
export function normalizeTagName(raw: string): { name: string; normalizedName: string } {
  const name = raw.normalize('NFC').replace(/\s+/gu, ' ').trim();

  if (!name) throw new AppError('INVALID_TAG_NAME', 'ชื่อแท็กว่างเปล่า', 400);
  if (name.length > MAX_TAG_LENGTH) {
    throw new AppError('INVALID_TAG_NAME', `ชื่อแท็กยาวเกิน ${MAX_TAG_LENGTH} ตัวอักษร`, 400);
  }
  if (/[\p{Cc}\p{Cf}]/u.test(name)) {
    throw new AppError('INVALID_TAG_NAME', 'ชื่อแท็กมีอักขระที่ไม่อนุญาต', 400);
  }

  return { name, normalizedName: name.toLocaleLowerCase() };
}

function isAdmin(user: AuthUser): boolean {
  return user.roles.includes('SUPER_ADMIN') || user.roles.includes('ADMIN');
}

/**
 * ผูกแท็กกับทรัพยากร
 *
 * นโยบาย: ผู้ที่แก้ไขทรัพยากรได้ ย่อมติดแท็กที่มีอยู่แล้วได้
 * แต่การ "สร้างแท็กใหม่ขององค์กร" ต้องเป็นผู้ดูแลระบบหรือผู้ที่มีสิทธิ์ resources:tag:create
 * เพื่อกันแท็กงอกซ้ำซ้อนจนใช้งานไม่ได้
 */
export async function addTagToResource(
  resourceId: string,
  rawName: string,
  user: AuthUser,
  audit: AuditContext,
) {
  const resource = await assertVisible(resourceId, user);
  if (!capabilities(resource, user).canEdit) {
    throw new AppError('RESOURCE_ACCESS_DENIED', 'ไม่มีสิทธิ์แก้ไขแท็กของทรัพยากรนี้', 403);
  }
  if (resource.isLocked) throw new AppError('RESOURCE_LOCKED', 'ทรัพยากรนี้ถูกล็อกไว้', 409);

  const { name, normalizedName } = normalizeTagName(rawName);
  let tag = await prisma.tag.findUnique({ where: { normalizedName } });

  if (!tag) {
    const mayCreate = isAdmin(user) || user.permissions.includes('resources:tag:create');
    if (!mayCreate) {
      throw new AppError('TAG_CREATE_DENIED', 'ไม่มีสิทธิ์สร้างแท็กใหม่ขององค์กร', 403);
    }
    tag = await prisma.tag.create({ data: { name, normalizedName, createdById: user.id } });
  }

  await prisma.resourceTag.upsert({
    where: { resourceId_tagId: { resourceId, tagId: tag.id } },
    create: { resourceId, tagId: tag.id, createdById: user.id },
    update: {},
  });

  await logActivity('RESOURCE_TAG_ADDED', user, resourceId, audit, { tagId: tag.id, tagName: tag.name });
  logger.info(`[TAG] "${tag.name}" → "${resource.name}"`);

  return toResourceDto(await loadResource(resourceId), user);
}

export async function removeTagFromResource(
  resourceId: string,
  tagId: string,
  user: AuthUser,
  audit: AuditContext,
) {
  const resource = await assertVisible(resourceId, user);
  if (!capabilities(resource, user).canEdit) {
    throw new AppError('RESOURCE_ACCESS_DENIED', 'ไม่มีสิทธิ์แก้ไขแท็กของทรัพยากรนี้', 403);
  }
  if (resource.isLocked) throw new AppError('RESOURCE_LOCKED', 'ทรัพยากรนี้ถูกล็อกไว้', 409);

  // อ่านชื่อแท็กไว้ก่อนลบ เพื่อให้ไทม์ไลน์อ่านออกว่าถอดแท็กอะไรออก ไม่ใช่แค่รหัส
  const tag = await prisma.tag.findUnique({ where: { id: tagId }, select: { name: true } });
  await prisma.resourceTag.deleteMany({ where: { resourceId, tagId } });
  await logActivity('RESOURCE_TAG_REMOVED', user, resourceId, audit, { tagId, tagName: tag?.name ?? null });

  return toResourceDto(await loadResource(resourceId), user);
}

/**
 * รายการแท็กพร้อมจำนวนการใช้งาน
 * จำนวนนับเฉพาะทรัพยากรที่ผู้ใช้เห็นได้จริง เพื่อไม่ให้เดาการมีอยู่ของงานลับ
 */
export async function listTags(user: AuthUser, query?: string) {
  const tags = await prisma.tag.findMany({
    where: query
      ? { normalizedName: { contains: normalizeTagName(query).normalizedName } }
      : undefined,
    include: {
      resources: {
        where: { resource: { deletedAt: null } },
        include: { resource: { include: resourceInclude } },
      },
    },
    orderBy: { name: 'asc' },
    take: 100,
  });

  return tags
    .map((tag) => ({
      id: tag.id,
      name: tag.name,
      usageCount: tag.resources.filter((link) => capabilities(link.resource, user).canView).length,
    }))
    .filter((tag) => tag.usageCount > 0 || isAdmin(user));
}

/* ------------------------------------------------------------------ */
/* หมายเหตุ                                                            */
/* ------------------------------------------------------------------ */

const MAX_REMARK_LENGTH = 1000;

export async function updateRemark(
  resourceId: string,
  remark: string | null,
  user: AuthUser,
  audit: AuditContext,
) {
  const resource = await assertVisible(resourceId, user);
  if (!capabilities(resource, user).canEdit) {
    throw new AppError('RESOURCE_ACCESS_DENIED', 'ไม่มีสิทธิ์แก้ไขหมายเหตุของทรัพยากรนี้', 403);
  }
  if (resource.isLocked) throw new AppError('RESOURCE_LOCKED', 'ทรัพยากรนี้ถูกล็อกไว้', 409);

  const value = remark === null ? null : remark.trim();
  if (value !== null && value.length > MAX_REMARK_LENGTH) {
    throw new AppError('INVALID_REMARK', `หมายเหตุยาวเกิน ${MAX_REMARK_LENGTH} ตัวอักษร`, 400);
  }
  if (value === resource.remark) return toResourceDto(resource, user);

  const updated = await prisma.resource.update({
    where: { id: resourceId },
    data: { remark: value, updatedById: user.id },
    include: resourceInclude,
  });

  // บันทึกเฉพาะว่ามีการแก้ไข ไม่เก็บเนื้อหาหมายเหตุลง log
  await logActivity('RESOURCE_REMARK_UPDATED', user, resourceId, audit, {
    cleared: value === null,
    length: value?.length ?? 0,
  });

  return toResourceDto(updated, user);
}

/* ------------------------------------------------------------------ */
/* ล็อก / ปลดล็อก                                                      */
/* ------------------------------------------------------------------ */

const MAX_LOCK_REASON = 500;

/**
 * สิทธิ์ในการล็อก: ผู้ดูแลหลักของทรัพยากร ผู้ดูแลระบบ หรือผู้ที่มีสิทธิ์ resources:lock
 * ผู้แก้ไขทั่วไปล็อกไม่ได้ เพราะการล็อกเป็นการตัดสินใจเชิงการควบคุมเอกสาร
 */
function mayLock(resource: Awaited<ReturnType<typeof loadResource>>, user: AuthUser): boolean {
  return (
    isAdmin(user) ||
    resource.ownerId === user.id ||
    user.permissions.includes('resources:lock')
  );
}

export async function lockResource(
  resourceId: string,
  input: { reason?: string | null },
  user: AuthUser,
  audit: AuditContext,
) {
  const resource = await assertVisible(resourceId, user);
  if (!mayLock(resource, user)) {
    throw new AppError('LOCK_DENIED', 'ไม่มีสิทธิ์ล็อกทรัพยากรนี้', 403);
  }
  if (resource.isLocked) throw new AppError('RESOURCE_ALREADY_LOCKED', 'ทรัพยากรนี้ถูกล็อกอยู่แล้ว', 409);

  const reason = input.reason?.trim() || null;
  if (reason && reason.length > MAX_LOCK_REASON) {
    throw new AppError('INVALID_LOCK_REASON', `เหตุผลยาวเกิน ${MAX_LOCK_REASON} ตัวอักษร`, 400);
  }

  const updated = await prisma.resource.update({
    where: { id: resourceId },
    data: { isLocked: true, lockedAt: new Date(), lockedById: user.id, lockReason: reason },
    include: resourceInclude,
  });

  await logActivity('RESOURCE_LOCKED', user, resourceId, audit, { hasReason: Boolean(reason) });
  logger.info(`[LOCK] ล็อก "${resource.name}"`);

  return toResourceDto(updated, user);
}

export async function unlockResource(resourceId: string, user: AuthUser, audit: AuditContext) {
  const resource = await assertVisible(resourceId, user);
  if (!mayLock(resource, user)) {
    throw new AppError('LOCK_DENIED', 'ไม่มีสิทธิ์ปลดล็อกทรัพยากรนี้', 403);
  }
  if (!resource.isLocked) throw new AppError('RESOURCE_NOT_LOCKED', 'ทรัพยากรนี้ไม่ได้ถูกล็อก', 409);

  const updated = await prisma.resource.update({
    where: { id: resourceId },
    data: { isLocked: false, lockedAt: null, lockedById: null, lockReason: null },
    include: resourceInclude,
  });

  await logActivity('RESOURCE_UNLOCKED', user, resourceId, audit);
  logger.info(`[LOCK] ปลดล็อก "${resource.name}"`);

  return toResourceDto(updated, user);
}

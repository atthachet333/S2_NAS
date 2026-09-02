import type { Prisma, Resource, ResourceAccessLevel, ResourceType } from '@prisma/client';
import { prisma } from '../../core/prisma.js';
import { AppError, badRequest, forbidden, notFound } from '../../core/errors.js';
import { logger } from '../../core/logger.js';
import type { AuthUser } from '../auth/auth.service.js';

const ownerSelect = { id: true, displayName: true, email: true } as const;
/** นิยามความสัมพันธ์ชุดเดียวของทั้งระบบ ทุกโมดูลต้องใช้ตัวนี้
 * มิฉะนั้น DTO จะขาดฟิลด์และ capabilities() จะคำนวณจากข้อมูลไม่ครบ */
export const resourceInclude = {
  owner: { select: ownerSelect },
  createdBy: { select: ownerSelect },
  lockedBy: { select: ownerSelect },
  tags: { include: { tag: { select: { id: true, name: true } } } },
  access: { select: { userId: true, accessLevel: true, allowDownload: true } },
  _count: { select: { children: { where: { deletedAt: null } } } },
} as const;

export type ResourceWithRelations = Prisma.ResourceGetPayload<{ include: typeof resourceInclude }>;

export function validateResourceName(rawName: string): { name: string; normalizedName: string } {
  const name = rawName.trim().replace(/\s+/gu, ' ');
  if (!name || name === '.' || name === '..' || name.length > 191) throw badRequest('INVALID_RESOURCE_NAME', 'ชื่อทรัพยากรไม่ถูกต้อง');
  if (/[\\/]/u.test(name) || /[\p{Cc}\p{Cf}]/u.test(name)) throw badRequest('INVALID_RESOURCE_NAME', 'ชื่อทรัพยากรมีอักขระที่ไม่อนุญาต');
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(name)) throw badRequest('INVALID_RESOURCE_NAME', 'ชื่อทรัพยากรเป็นชื่อสงวนของระบบ');
  return { name, normalizedName: name.normalize('NFC').toLocaleLowerCase() };
}

function siblingKey(parentId: string | null, normalizedName: string): string {
  return `${parentId ?? 'ROOT'}:${normalizedName}`;
}

function isAdmin(user: AuthUser): boolean {
  return user.roles.includes('SUPER_ADMIN') || user.roles.includes('ADMIN');
}

function directLevel(resource: ResourceWithRelations, user: AuthUser): ResourceAccessLevel | null {
  if (resource.ownerId === user.id) return 'OWNER';
  return resource.access.find((item) => item.userId === user.id)?.accessLevel ?? null;
}

/**
 * ทรัพยากรนี้เปิดให้คนในองค์กรเห็นหรือไม่
 *
 * ORGANIZATION = ผู้ใช้ ACTIVE ที่มีสิทธิ์ resources:read เปิดดูและดาวน์โหลดได้
 * RESTRICTED   = เฉพาะผู้ดูแลทรัพยากร ผู้ได้รับสิทธิ์โดยตรง และผู้ดูแลระบบ
 *
 * ไฟล์สืบทอดค่านี้จากโฟลเดอร์แม่ตอนอัปโหลด จึงตัดสินได้จากแถวเดียวโดยไม่ต้องไล่ลำดับชั้น
 */
function isOrganizationVisible(resource: ResourceWithRelations): boolean {
  return resource.visibility === 'ORGANIZATION';
}

/**
 * ทรัพยากรที่ถูกล็อกต้องแจ้งเหตุผลที่แท้จริง
 *
 * ถ้าปล่อยให้ตกไปเป็น "ไม่มีสิทธิ์" ผู้ดูแลหลักจะสับสน เพราะเขามีสิทธิ์เต็มอยู่แล้ว
 * แต่ถูกกันด้วยการล็อกที่ตัวเขาเองเป็นคนตั้ง จึงต้องเรียกตรวจก่อนด่านสิทธิ์เสมอ
 */
export function assertNotLocked(resource: { isLocked: boolean; lockReason: string | null }): void {
  if (!resource.isLocked) return;
  throw new AppError('RESOURCE_LOCKED', 'ทรัพยากรนี้ถูกล็อกอยู่ ต้องปลดล็อกก่อนจึงจะแก้ไขได้', 423, {
    lockReason: resource.lockReason,
  });
}

export function capabilities(resource: ResourceWithRelations, user: AuthUser) {
  const admin = isAdmin(user);
  const level = directLevel(resource, user);
  const orgVisible = isOrganizationVisible(resource);

  const canView =
    user.permissions.includes('resources:read') && (admin || orgVisible || level !== null);

  const writer =
    user.permissions.includes('resources:write') &&
    (admin || level === 'OWNER' || level === 'EDITOR' || (orgVisible && canView));

  const canDelete =
    user.permissions.includes('resources:delete') && (admin || level === 'OWNER');

  /**
   * สิทธิ์ดาวน์โหลด
   *
   * การให้สิทธิ์รายบุคคลมีน้ำหนักเหนือค่าเริ่มต้นขององค์กรเสมอ
   * ผู้ที่ถูกกำหนดเป็น VIEWER พร้อม allowDownload = false จึงเปิดดูได้ แต่ดาวน์โหลดไม่ได้
   * แม้โฟลเดอร์จะเป็น ORGANIZATION ก็ตาม เพราะนั่นคือเจตนาของการจำกัดรายคน
   */
  const grant = resource.access.find((item) => item.userId === user.id);
  const canDownload =
    resource.type === 'FILE' &&
    canView &&
    (admin ||
      level === 'OWNER' ||
      (grant ? grant.allowDownload : orgVisible));

  /**
   * การจัดการสิทธิ์เป็นการตัดสินใจเชิงการควบคุม ไม่ใช่การแก้ไขเนื้อหา
   * จึงสงวนไว้ให้ผู้ดูแลหลัก ผู้ดูแลระบบ หรือผู้ที่ได้รับสิทธิ์ resources:share โดยเฉพาะ
   * ผู้แก้ไข (EDITOR) ไม่ได้สิทธิ์นี้โดยอัตโนมัติ
   */
  const canShare =
    admin || resource.ownerId === user.id || user.permissions.includes('resources:share');

  /** การล็อกใช้เกณฑ์เดียวกับการจัดการสิทธิ์ แต่แยก permission ของตัวเอง */
  const canLock =
    admin || resource.ownerId === user.id || user.permissions.includes('resources:lock');

  return {
    canView,
    canEdit: writer && !resource.isLocked,
    canRename: writer && !resource.isLocked,
    canMove: writer && !resource.isLocked,
    canDelete: canDelete && !resource.isLocked,
    canShare,
    canLock,
    canDownload,
    /** อัปโหลดเวอร์ชันใหม่ถือเป็นการแก้ไขเนื้อหา จึงใช้เกณฑ์เดียวกับการแก้ไข */
    canUploadVersion: resource.type === 'FILE' && writer && !resource.isLocked,
    canTransferOwner: admin || level === 'OWNER' || user.permissions.includes('resources:owner:manage'),
  };
}

export function toResourceDto(resource: ResourceWithRelations, user: AuthUser) {
  return {
    id: resource.id, type: resource.type, name: resource.name, parentId: resource.parentId,
    owner: resource.owner, sourceType: resource.sourceType, mimeType: resource.mimeType,
    extension: resource.extension, size: resource.size === null ? null : Number(resource.size),
    externalUrl: resource.externalUrl, externalProvider: resource.externalProvider,
    remark: resource.remark, isLocked: resource.isLocked, itemCount: resource._count.children,
    visibility: resource.visibility, currentVersion: resource.currentVersion,
    tags: resource.tags.map((link) => ({ id: link.tag.id, name: link.tag.name })),
    lockedAt: resource.lockedAt, lockReason: resource.lockReason,
    lockedBy: resource.lockedBy ?? null,
    uploadedBy: resource.createdBy ? { id: resource.createdBy.id, displayName: resource.createdBy.displayName, email: resource.createdBy.email } : null,
    createdAt: resource.createdAt, updatedAt: resource.updatedAt,
    capabilities: capabilities(resource, user),
  };
}

async function findResource(id: string): Promise<ResourceWithRelations> {
  const resource = await prisma.resource.findFirst({ where: { id, deletedAt: null }, include: resourceInclude });
  if (!resource) throw notFound('RESOURCE_NOT_FOUND', 'ไม่พบทรัพยากร');
  return resource;
}

async function assertView(resource: ResourceWithRelations, user: AuthUser): Promise<void> {
  if (resource.deletedAt) throw notFound('RESOURCE_NOT_FOUND', 'ไม่พบทรัพยากร');
  if (!capabilities(resource, user).canView) {
    throw new AppError('RESOURCE_ACCESS_DENIED', 'ไม่มีสิทธิ์ดูทรัพยากร', 403);
  }
}

async function assertEdit(resource: ResourceWithRelations, user: AuthUser): Promise<void> {
  await assertView(resource, user);
  assertNotLocked(resource);
  if (!capabilities(resource, user).canEdit) throw new AppError('RESOURCE_ACCESS_DENIED', 'ไม่มีสิทธิ์แก้ไขทรัพยากร', 403);
}

function translateDuplicate(error: unknown): never {
  if ((error as { code?: string }).code === 'P2002') throw new AppError('FOLDER_NAME_EXISTS', 'มีโฟลเดอร์ชื่อนี้อยู่แล้ว', 409);
  throw error;
}

export async function listResources(user: AuthUser, input: { parentId?: string | null; type?: ResourceType; ownerId?: string; sort: 'name' | 'updatedAt' | 'createdAt' | 'size'; direction: 'asc' | 'desc'; limit: number; cursor?: string }) {
  if (!user.permissions.includes('resources:read')) throw forbidden('ไม่มีสิทธิ์ดูทรัพยากร');
  if (input.parentId) await assertView(await findResource(input.parentId), user);
  const rows = await prisma.resource.findMany({
    where: { parentId: input.parentId ?? null, deletedAt: null, type: input.type, ownerId: input.ownerId },
    include: resourceInclude,
    orderBy: input.sort === 'name' ? { normalizedName: input.direction } : { [input.sort]: input.direction },
    take: input.limit + 1,
    ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
  });
  const nextCursor = rows.length > input.limit ? rows[input.limit]?.id ?? null : null;
  const page = rows.slice(0, input.limit).filter((row) => capabilities(row, user).canView);
  logger.info(`[RESOURCE] Listed parent=${input.parentId ?? 'root'}`);
  return { items: page.map((row) => toResourceDto(row, user)), nextCursor };
}

/**
 * ทรัพยากรล่าสุดของทั้งองค์กร เรียงตามเวลาที่แก้ไขล่าสุด
 * กรองด้วยสิทธิ์การมองเห็นจริงของผู้ใช้ ไม่ใช่แค่แสดงทุกแถว
 */
export async function listRecentResources(user: AuthUser, limit: number) {
  if (!user.permissions.includes('resources:read')) throw forbidden('ไม่มีสิทธิ์ดูทรัพยากร');
  const rows = await prisma.resource.findMany({
    where: { deletedAt: null },
    include: resourceInclude,
    orderBy: { updatedAt: 'desc' },
    take: limit,
  });
  return rows.map((row) => toResourceDto(row, user)).filter((dto) => dto.capabilities.canView);
}

export async function getResource(id: string, user: AuthUser) {
  const resource = await findResource(id); await assertView(resource, user); return toResourceDto(resource, user);
}

export async function createFolder(user: AuthUser, input: { name: string; parentId?: string | null; ownerId?: string; remark?: string | null }, audit: { ipAddress?: string; userAgent?: string }) {
  const named = validateResourceName(input.name);
  let inheritedVisibility: ResourceWithRelations['visibility'] = 'ORGANIZATION';
  if (input.parentId) {
    const parent = await findResource(input.parentId);
    if (parent.type !== 'FOLDER') throw notFound('FOLDER_NOT_FOUND', 'ไม่พบโฟลเดอร์ปลายทาง');
    await assertEdit(parent, user);
    inheritedVisibility = parent.visibility;
  } else if (!user.permissions.includes('resources:write')) throw forbidden('ไม่มีสิทธิ์สร้างโฟลเดอร์');
  const ownerId = input.ownerId ?? user.id;
  if (ownerId !== user.id && !isAdmin(user) && !user.permissions.includes('resources:owner:manage')) throw new AppError('OWNER_TRANSFER_DENIED', 'ไม่มีสิทธิ์กำหนดเจ้าของรายอื่น', 403);
  const owner = await prisma.user.findFirst({ where: { id: ownerId, status: 'ACTIVE' } });
  if (!owner) throw notFound('OWNER_NOT_FOUND', 'ไม่พบเจ้าของที่เปิดใช้งาน');
  try {
    const created = await prisma.$transaction(async (tx) => {
      const resource = await tx.resource.create({ data: { type: 'FOLDER', ...named, siblingKey: siblingKey(input.parentId ?? null, named.normalizedName), parentId: input.parentId ?? null, ownerId, createdById: user.id, sourceType: 'MANUAL', visibility: inheritedVisibility, remark: input.remark ?? null } });
      await tx.activityLog.create({ data: { userId: user.id, action: 'RESOURCE_FOLDER_CREATED', resourceId: resource.id, ipAddress: audit.ipAddress, userAgent: audit.userAgent?.slice(0, 500), metadata: { parentId: resource.parentId, ownerId } } });
      return resource.id;
    });
    logger.info(`[FOLDER] Created "${named.name}"`);
    return getResource(created, user);
  } catch (error) { return translateDuplicate(error); }
}

export async function updateResource(id: string, user: AuthUser, input: { name?: string; remark?: string | null; isLocked?: boolean }, audit: { ipAddress?: string; userAgent?: string }) {
  const resource = await findResource(id); await assertEdit(resource, user);
  if (input.isLocked !== undefined && !isAdmin(user)) throw forbidden('เฉพาะผู้ดูแลระบบเท่านั้นที่เปลี่ยนสถานะล็อกได้');
  const named = input.name === undefined ? null : validateResourceName(input.name);
  try {
    await prisma.$transaction(async (tx) => {
      await tx.resource.update({ where: { id }, data: { ...(named ? { ...named, siblingKey: siblingKey(resource.parentId, named.normalizedName) } : {}), remark: input.remark, isLocked: input.isLocked, updatedById: user.id } });
      await tx.activityLog.create({ data: { userId: user.id, action: named ? 'RESOURCE_RENAMED' : 'RESOURCE_UPDATED', resourceId: id, ipAddress: audit.ipAddress, userAgent: audit.userAgent?.slice(0, 500), metadata: named ? { previousName: resource.name } : undefined } });
    });
    if (named) logger.info('[FOLDER] Renamed resource');
    return getResource(id, user);
  } catch (error) { return translateDuplicate(error); }
}

async function assertValidMove(resource: ResourceWithRelations, parentId: string | null): Promise<void> {
  if (parentId === resource.id) throw badRequest('INVALID_MOVE', 'ไม่สามารถย้ายโฟลเดอร์เข้าไปในตัวเองได้');
  let cursor = parentId;
  while (cursor) {
    if (cursor === resource.id) throw badRequest('INVALID_MOVE', 'ไม่สามารถย้ายโฟลเดอร์ไปยังโฟลเดอร์ลูกได้');
    const ancestor = await prisma.resource.findFirst({ where: { id: cursor, deletedAt: null }, select: { parentId: true, type: true } });
    if (!ancestor || ancestor.type !== 'FOLDER') throw notFound('FOLDER_NOT_FOUND', 'ไม่พบโฟลเดอร์ปลายทาง');
    cursor = ancestor.parentId;
  }
}

export async function moveResource(id: string, user: AuthUser, parentId: string | null, audit: { ipAddress?: string; userAgent?: string }) {
  const resource = await findResource(id); await assertEdit(resource, user);
  if (parentId) await assertEdit(await findResource(parentId), user);
  await assertValidMove(resource, parentId);
  try {
    await prisma.$transaction(async (tx) => {
      await tx.resource.update({ where: { id }, data: { parentId, siblingKey: siblingKey(parentId, resource.normalizedName), updatedById: user.id } });
      await tx.activityLog.create({ data: { userId: user.id, action: 'RESOURCE_MOVED', resourceId: id, ipAddress: audit.ipAddress, userAgent: audit.userAgent?.slice(0, 500), metadata: { previousParentId: resource.parentId, parentId } } });
    });
    return getResource(id, user);
  } catch (error) { return translateDuplicate(error); }
}

export async function transferOwner(id: string, user: AuthUser, newOwnerId: string, audit: { ipAddress?: string; userAgent?: string }) {
  const resource = await findResource(id);
  if (resource.type !== 'FOLDER') throw notFound('FOLDER_NOT_FOUND', 'ทรัพยากรนี้ไม่ใช่โฟลเดอร์');
  await assertView(resource, user);
  if (!capabilities(resource, user).canTransferOwner) throw new AppError('OWNER_TRANSFER_DENIED', 'ไม่มีสิทธิ์โอนเจ้าของโฟลเดอร์', 403);
  const owner = await prisma.user.findFirst({ where: { id: newOwnerId, status: 'ACTIVE' } });
  if (!owner) throw notFound('OWNER_NOT_FOUND', 'ไม่พบเจ้าของที่เปิดใช้งาน');
  await prisma.$transaction(async (tx) => {
    await tx.resource.update({ where: { id }, data: { ownerId: newOwnerId, updatedById: user.id } });
    await tx.activityLog.create({ data: { userId: user.id, action: 'RESOURCE_OWNER_CHANGED', resourceId: id, ipAddress: audit.ipAddress, userAgent: audit.userAgent?.slice(0, 500), metadata: { previousOwnerId: resource.ownerId, newOwnerId } } });
  });
  logger.info('[FOLDER] Ownership transferred');
  return getResource(id, user);
}

export async function softDeleteResource(id: string, user: AuthUser, audit: { ipAddress?: string; userAgent?: string }) {
  const resource = await findResource(id);
  assertNotLocked(resource);
  if (!capabilities(resource, user).canDelete) throw new AppError('RESOURCE_ACCESS_DENIED', 'ไม่มีสิทธิ์ลบทรัพยากร', 403);
  const activeChildren = await prisma.resource.count({ where: { parentId: id, deletedAt: null } });
  if (activeChildren) throw badRequest('FOLDER_NOT_EMPTY', 'ต้องย้ายหรือลบรายการภายในโฟลเดอร์ก่อน');
  const deletedAt = new Date();
  await prisma.$transaction(async (tx) => {
    await tx.resource.update({ where: { id }, data: { deletedAt, siblingKey: `deleted:${id}`, updatedById: user.id } });
    await tx.activityLog.create({ data: { userId: user.id, action: 'RESOURCE_SOFT_DELETED', resourceId: id, ipAddress: audit.ipAddress, userAgent: audit.userAgent?.slice(0, 500) } });
  });
  return { deleted: true, deletedAt };
}

export async function breadcrumb(id: string, user: AuthUser) {
  const nodes: Array<{ id: string; name: string }> = [];
  let cursor: string | null = id;
  const seen = new Set<string>();
  while (cursor) {
    if (seen.has(cursor)) throw badRequest('INVALID_MOVE', 'ตรวจพบวงจรในโครงสร้างโฟลเดอร์');
    seen.add(cursor);
    const resource = await findResource(cursor); await assertView(resource, user);
    nodes.unshift({ id: resource.id, name: resource.name }); cursor = resource.parentId;
  }
  return nodes;
}

export async function ownershipOverview() {
  const groups = await prisma.resource.groupBy({ by: ['ownerId'], where: { type: 'FOLDER', deletedAt: null }, _count: { _all: true } });
  const users = await prisma.user.findMany({ where: { id: { in: groups.map((group) => group.ownerId) } }, select: ownerSelect });
  const byId = new Map(users.map((user) => [user.id, user]));
  return groups.map((group) => ({ user: byId.get(group.ownerId)!, ownedFolderCount: group._count._all })).filter((row) => row.user).sort((a, b) => b.ownedFolderCount - a.ownedFolderCount);
}

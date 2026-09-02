import { prisma } from '../../core/prisma.js';
import { AppError, forbidden, notFound } from '../../core/errors.js';
import { logger } from '../../core/logger.js';
import { deleteStoredFile, removeResourceDirectory } from '../../core/file-storage.js';
import {
  assertNotLocked,
  capabilities,
  resourceInclude,
  toResourceDto,
  validateResourceName,
} from '../resources/resource.service.js';
import type { AuthUser } from '../auth/auth.service.js';
import type { AuditContext } from './file.service.js';

const ownerSelect = { id: true, displayName: true, email: true } as const;
function siblingKey(parentId: string | null, normalizedName: string): string {
  return `${parentId ?? 'ROOT'}:${normalizedName}`;
}

async function loadResource(id: string) {
  const resource = await prisma.resource.findFirst({ where: { id }, include: resourceInclude });
  if (!resource) throw notFound('RESOURCE_NOT_FOUND', 'ไม่พบทรัพยากร');
  return resource;
}

/** รวบรวม id ของทรัพยากรทั้งหมดใต้ต้นไม้ รวมตัวมันเอง (BFS ทีละชั้น ไม่เกิด N+1 รายแถว) */
async function collectSubtreeIds(rootId: string, includeDeleted: boolean): Promise<string[]> {
  const ids = [rootId];
  let frontier = [rootId];

  while (frontier.length > 0) {
    const children = await prisma.resource.findMany({
      where: { parentId: { in: frontier }, ...(includeDeleted ? {} : { deletedAt: null }) },
      select: { id: true },
    });
    frontier = children.map((child) => child.id);
    ids.push(...frontier);
    if (ids.length > 5000) throw new AppError('RESOURCE_TREE_TOO_LARGE', 'โครงสร้างโฟลเดอร์ใหญ่เกินกำหนด', 413);
  }

  return ids;
}

/* ------------------------------------------------------------------ */
/* ย้ายไปถังขยะ                                                        */
/* ------------------------------------------------------------------ */

/**
 * Soft delete ทรัพยากรและลูกหลานทั้งหมดใน transaction เดียว
 * ไม่มีการลบไฟล์จริงในขั้นตอนนี้ ไฟล์ยังอยู่ครบจนกว่าจะลบถาวร
 *
 * trashedFromId เก็บ parent เดิมไว้ เพื่อให้กู้คืนกลับตำแหน่งเดิมได้
 */
export async function trashResource(id: string, user: AuthUser, audit: AuditContext) {
  const resource = await loadResource(id);
  if (resource.deletedAt) throw notFound('RESOURCE_NOT_FOUND', 'ทรัพยากรนี้อยู่ในถังขยะแล้ว');
  assertNotLocked(resource);
  if (!capabilities(resource, user).canDelete) {
    throw new AppError('RESOURCE_ACCESS_DENIED', 'ไม่มีสิทธิ์ลบทรัพยากรนี้', 403);
  }
  if (resource.isLocked) {
    throw new AppError('RESOURCE_LOCKED', 'ทรัพยากรนี้ถูกล็อกไว้', 409);
  }

  const ids = resource.type === 'FOLDER' ? await collectSubtreeIds(id, false) : [id];
  const deletedAt = new Date();

  await prisma.$transaction(async (tx) => {
    // ลูกหลานเก็บ parent เดิมของตัวเองไว้ ส่วนตัวรากจำ parent ที่มันเคยอยู่
    await tx.resource.updateMany({
      where: { id: { in: ids }, deletedAt: null },
      data: { deletedAt, deletedById: user.id },
    });
    await tx.resource.update({
      where: { id },
      data: { trashedFromId: resource.parentId, siblingKey: `TRASH:${id}` },
    });
    await tx.activityLog.create({
      data: {
        userId: user.id,
        action: 'RESOURCE_TRASHED',
        resourceId: id,
        ipAddress: audit.ipAddress,
        userAgent: audit.userAgent?.slice(0, 500),
        metadata: { affected: ids.length, type: resource.type },
      },
    });
  });

  logger.info(`[TRASH] "${resource.name}" (${ids.length} รายการ)`);
  return { trashed: true, affected: ids.length, deletedAt };
}

/* ------------------------------------------------------------------ */
/* รายการในถังขยะ                                                      */
/* ------------------------------------------------------------------ */

/** แสดงเฉพาะรายการที่เป็น "ราก" ของการลบ ไม่แสดงลูกหลานซ้ำซ้อน */
export async function listTrash(user: AuthUser) {
  if (!user.permissions.includes('resources:read')) throw forbidden('ไม่มีสิทธิ์ดูถังขยะ');

  const rows = await prisma.resource.findMany({
    where: { deletedAt: { not: null } },
    include: { ...resourceInclude, deletedBy: { select: ownerSelect } },
    orderBy: { deletedAt: 'desc' },
    take: 200,
  });

  // รายการรากคือรายการที่ parent ของมันไม่ได้ถูกลบไปพร้อมกัน
  const deletedIds = new Set(rows.map((row) => row.id));
  const roots = rows.filter((row) => !row.parentId || !deletedIds.has(row.parentId));

  const parentIds = [...new Set(roots.map((row) => row.trashedFromId).filter((v): v is string => Boolean(v)))];
  const parents = parentIds.length
    ? await prisma.resource.findMany({ where: { id: { in: parentIds } }, select: { id: true, name: true } })
    : [];
  const parentName = new Map(parents.map((row) => [row.id, row.name]));

  return roots
    .filter((row) => capabilities(row, user).canView)
    .map((row) => ({
      ...toResourceDto(row, user),
      deletedAt: row.deletedAt,
      deletedBy: row.deletedBy,
      originalLocation: row.trashedFromId ? (parentName.get(row.trashedFromId) ?? 'โฟลเดอร์ที่ถูกลบแล้ว') : 'รากองค์กร',
      originalParentId: row.trashedFromId,
    }));
}

/* ------------------------------------------------------------------ */
/* กู้คืน                                                              */
/* ------------------------------------------------------------------ */

export interface RestoreInput {
  /** โฟลเดอร์ปลายทางที่ผู้ใช้เลือก ใช้เมื่อตำแหน่งเดิมกลับไม่ได้ */
  targetParentId?: string | null;
  /** ชื่อใหม่ ใช้เมื่อชื่อเดิมชนกับรายการที่ยังอยู่ */
  newName?: string;
}

/**
 * กู้คืนทรัพยากรจากถังขยะ
 *
 * สองกรณีที่ต้องจัดการอย่างชัดเจน ไม่เขียนทับเงียบ ๆ:
 *   1. โฟลเดอร์เดิมถูกลบไปแล้ว  → ต้องระบุปลายทางใหม่ หรือกู้ไปที่ราก
 *   2. ชื่อชนกับรายการที่ยังอยู่ → ต้องตั้งชื่อใหม่
 */
export async function restoreResource(
  id: string,
  user: AuthUser,
  input: RestoreInput,
  audit: AuditContext,
) {
  const resource = await loadResource(id);
  if (!resource.deletedAt) throw new AppError('RESOURCE_NOT_TRASHED', 'ทรัพยากรนี้ไม่ได้อยู่ในถังขยะ', 400);
  assertNotLocked(resource);
  if (!capabilities(resource, user).canDelete) {
    throw new AppError('RESOURCE_ACCESS_DENIED', 'ไม่มีสิทธิ์กู้คืนทรัพยากรนี้', 403);
  }

  // หาปลายทาง
  let targetParentId: string | null;
  if (input.targetParentId !== undefined) {
    targetParentId = input.targetParentId;
  } else {
    const original = resource.trashedFromId
      ? await prisma.resource.findFirst({ where: { id: resource.trashedFromId }, select: { id: true, deletedAt: true } })
      : null;

    if (resource.trashedFromId && (!original || original.deletedAt)) {
      throw new AppError(
        'TRASH_RESTORE_CONFLICT',
        'โฟลเดอร์เดิมถูกลบไปแล้ว กรุณาเลือกตำแหน่งปลายทางใหม่',
        409,
        { reason: 'PARENT_MISSING' },
      );
    }
    targetParentId = resource.trashedFromId;
  }

  if (targetParentId) {
    const parent = await loadResource(targetParentId);
    if (parent.deletedAt || parent.type !== 'FOLDER') {
      throw new AppError('FOLDER_NOT_FOUND', 'ไม่พบโฟลเดอร์ปลายทาง', 404);
    }
    if (!capabilities(parent, user).canEdit) {
      throw new AppError('RESOURCE_ACCESS_DENIED', 'ไม่มีสิทธิ์กู้คืนไปยังโฟลเดอร์นี้', 403);
    }
  }

  const name = input.newName ?? resource.name;
  const { normalizedName } = validateResourceName(name);
  const collision = await prisma.resource.findFirst({
    where: { siblingKey: siblingKey(targetParentId, normalizedName), deletedAt: null },
    select: { id: true, name: true },
  });
  if (collision) {
    throw new AppError('TRASH_RESTORE_CONFLICT', `มี "${name}" อยู่ในตำแหน่งปลายทางแล้ว`, 409, {
      reason: 'NAME_CONFLICT',
      existing: collision,
    });
  }

  const ids = resource.type === 'FOLDER' ? await collectSubtreeIds(id, true) : [id];

  const restored = await prisma.$transaction(async (tx) => {
    await tx.resource.updateMany({
      where: { id: { in: ids } },
      data: { deletedAt: null, deletedById: null },
    });
    const row = await tx.resource.update({
      where: { id },
      data: {
        parentId: targetParentId,
        name,
        normalizedName,
        siblingKey: siblingKey(targetParentId, normalizedName),
        trashedFromId: null,
        updatedById: user.id,
      },
      include: resourceInclude,
    });
    await tx.activityLog.create({
      data: {
        userId: user.id,
        action: 'RESOURCE_RESTORED',
        resourceId: id,
        ipAddress: audit.ipAddress,
        userAgent: audit.userAgent?.slice(0, 500),
        metadata: { affected: ids.length, targetParentId },
      },
    });
    return row;
  });

  logger.info(`[TRASH] กู้คืน "${restored.name}" (${ids.length} รายการ)`);
  return toResourceDto(restored, user);
}

/* ------------------------------------------------------------------ */
/* ลบถาวร                                                             */
/* ------------------------------------------------------------------ */

/** สรุปสิ่งที่จะถูกลบ ใช้ให้ผู้ใช้ยืนยันก่อนลงมือจริง */
export async function describePermanentDelete(id: string, user: AuthUser) {
  const resource = await loadResource(id);
  if (!resource.deletedAt) throw new AppError('RESOURCE_NOT_TRASHED', 'ต้องย้ายไปถังขยะก่อน', 400);
  assertNotLocked(resource);
  if (!capabilities(resource, user).canDelete) throw forbidden('ไม่มีสิทธิ์ลบทรัพยากรนี้');

  const ids = resource.type === 'FOLDER' ? await collectSubtreeIds(id, true) : [id];
  const [files, versions] = await Promise.all([
    prisma.resource.count({ where: { id: { in: ids }, type: 'FILE' } }),
    prisma.resourceVersion.count({ where: { resourceId: { in: ids } } }),
  ]);

  return { resourceCount: ids.length, fileCount: files, versionCount: versions, type: resource.type };
}

/**
 * ลบถาวร: ลบไฟล์จริงของทุกเวอร์ชันก่อน แล้วจึงลบ metadata
 *
 * ถ้าลบไฟล์จริงบางส่วนไม่สำเร็จ จะไม่แกล้งรายงานว่าสำเร็จ
 * metadata จะถูกเก็บไว้และบันทึกความล้มเหลวไว้ให้ผู้ดูแลตรวจสอบ
 */
export async function permanentlyDelete(id: string, user: AuthUser, audit: AuditContext) {
  const resource = await loadResource(id);
  if (!resource.deletedAt) throw new AppError('RESOURCE_NOT_TRASHED', 'ต้องย้ายไปถังขยะก่อนลบถาวร', 400);
  assertNotLocked(resource);
  if (!capabilities(resource, user).canDelete) {
    throw new AppError('RESOURCE_ACCESS_DENIED', 'ไม่มีสิทธิ์ลบทรัพยากรนี้', 403);
  }

  const ids = resource.type === 'FOLDER' ? await collectSubtreeIds(id, true) : [id];
  const versions = await prisma.resourceVersion.findMany({
    where: { resourceId: { in: ids } },
    select: { storageKey: true, resourceId: true },
  });

  const failed: string[] = [];
  for (const version of versions) {
    const ok = await deleteStoredFile(version.storageKey);
    if (!ok) failed.push(version.storageKey);
  }

  if (failed.length > 0) {
    await prisma.activityLog.create({
      data: {
        userId: user.id,
        action: 'RESOURCE_PERMANENT_DELETE_FAILED',
        resourceId: id,
        ipAddress: audit.ipAddress,
        userAgent: audit.userAgent?.slice(0, 500),
        metadata: { failedObjects: failed.length },
      },
    });
    throw new AppError(
      'PERMANENT_DELETE_FAILED',
      'ลบไฟล์จริงบางรายการไม่สำเร็จ ระบบจึงยังไม่ลบข้อมูล',
      500,
      { failedObjects: failed.length },
    );
  }

  await prisma.$transaction(async (tx) => {
    // ลบลูกก่อนพ่อเพื่อไม่ให้ชน foreign key แบบ Restrict
    for (const resourceId of [...ids].reverse()) {
      await tx.resource.deleteMany({ where: { id: resourceId } });
    }
    await tx.activityLog.create({
      data: {
        userId: user.id,
        action: 'RESOURCE_PERMANENTLY_DELETED',
        ipAddress: audit.ipAddress,
        userAgent: audit.userAgent?.slice(0, 500),
        metadata: { resourceCount: ids.length, versionCount: versions.length, name: resource.name },
      },
    });
  });

  for (const resourceId of new Set(versions.map((version) => version.resourceId))) {
    await removeResourceDirectory(resourceId);
  }

  logger.info(`[TRASH] ลบถาวร "${resource.name}" (${ids.length} รายการ, ${versions.length} เวอร์ชัน)`);
  return { deleted: true, resourceCount: ids.length, versionCount: versions.length };
}

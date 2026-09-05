/**
 * คลังเอกสาร
 *
 * **คลังไม่ใช่ถังขยะ**
 *
 *   คลัง    = ตั้งใจเก็บรักษาไว้ แค่ไม่ให้เกะกะพื้นที่ทำงานประจำวัน
 *             ไฟล์ เวอร์ชัน แท็ก ประเภท ดัชนีค้นหา และสิทธิ์ ยังอยู่ครบทุกอย่าง
 *   ถังขยะ  = ตั้งใจจะทิ้ง และจะถูกลบถาวรเมื่อครบกำหนด
 *
 * สองอย่างนี้ใช้ฟิลด์คนละตัว (lifecycleState กับ deletedAt) โดยเจตนา
 * ถ้าใช้ฟิลด์เดียวกัน เอกสารที่ตั้งใจเก็บไว้สิบปีจะถูกงานเก็บกวาดถังขยะลบทิ้งวันหนึ่ง
 *
 * การเก็บเข้าคลังเป็นการ "รักษา" ไม่ใช่การ "ทำลาย" จึงไม่ถูก Legal Hold ขวาง
 */
import { prisma } from '../../core/prisma.js';
import { AppError, notFound } from '../../core/errors.js';
import { logger } from '../../core/logger.js';
import { capabilities, resourceInclude, toResourceDto } from '../resources/resource.service.js';
import type { AuthUser } from '../auth/auth.service.js';

async function loadEditable(resourceId: string, user: AuthUser) {
  const resource = await prisma.resource.findUnique({
    where: { id: resourceId },
    include: resourceInclude,
  });
  if (!resource || resource.deletedAt) throw notFound('RESOURCE_NOT_FOUND', 'ไม่พบทรัพยากร');

  const caps = capabilities(resource, user);
  if (!caps.canView) throw notFound('RESOURCE_NOT_FOUND', 'ไม่พบทรัพยากร');
  if (!caps.canEdit) {
    throw new AppError('RESOURCE_ACCESS_DENIED', 'ไม่มีสิทธิ์แก้ไขเอกสารนี้', 403);
  }
  return resource;
}

/**
 * เก็บเข้าคลัง
 *
 * ไม่แตะไบต์ของไฟล์ ไม่แตะเวอร์ชัน ไม่แตะแท็ก ไม่แตะดัชนีค้นหา และไม่แตะสิทธิ์
 * สิ่งเดียวที่เปลี่ยนคือสถานะวงจรชีวิต และเวลา/ผู้ที่กด
 */
export async function archiveResource(
  resourceId: string,
  user: AuthUser,
  audit: { ipAddress?: string; userAgent?: string },
) {
  const resource = await loadEditable(resourceId, user);
  if (resource.lifecycleState === 'ARCHIVED') {
    throw new AppError('RESOURCE_ALREADY_ARCHIVED', 'เอกสารนี้อยู่ในคลังอยู่แล้ว', 409);
  }

  await prisma.resource.update({
    where: { id: resourceId },
    data: {
      lifecycleState: 'ARCHIVED',
      archivedAt: new Date(),
      archivedById: user.id,
      updatedById: user.id,
    },
  });

  await prisma.activityLog.create({
    data: {
      userId: user.id,
      action: 'RESOURCE_ARCHIVED',
      resourceId,
      ipAddress: audit.ipAddress,
      userAgent: audit.userAgent?.slice(0, 500),
      metadata: {},
    },
  });

  logger.info(`[ARCHIVE] เก็บเข้าคลัง "${resource.name}"`);
  const fresh = await prisma.resource.findUnique({ where: { id: resourceId }, include: resourceInclude });
  return toResourceDto(fresh!, user);
}

/** นำออกจากคลัง กลับสู่การใช้งานปกติ */
export async function unarchiveResource(
  resourceId: string,
  user: AuthUser,
  audit: { ipAddress?: string; userAgent?: string },
) {
  const resource = await loadEditable(resourceId, user);
  if (resource.lifecycleState !== 'ARCHIVED') {
    throw new AppError('RESOURCE_NOT_ARCHIVED', 'เอกสารนี้ไม่ได้อยู่ในคลัง', 409);
  }

  await prisma.resource.update({
    where: { id: resourceId },
    data: {
      lifecycleState: 'ACTIVE',
      archivedAt: null,
      archivedById: null,
      updatedById: user.id,
    },
  });

  await prisma.activityLog.create({
    data: {
      userId: user.id,
      action: 'RESOURCE_UNARCHIVED',
      resourceId,
      ipAddress: audit.ipAddress,
      userAgent: audit.userAgent?.slice(0, 500),
      metadata: {},
    },
  });

  logger.info(`[ARCHIVE] นำออกจากคลัง "${resource.name}"`);
  const fresh = await prisma.resource.findUnique({ where: { id: resourceId }, include: resourceInclude });
  return toResourceDto(fresh!, user);
}

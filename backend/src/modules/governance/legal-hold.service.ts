/**
 * การระงับการลบ (Legal Hold)
 *
 * เป็นชั้นป้องกันที่แข็งที่สุดของระบบ: นโยบายการเก็บรักษามีวันหมด
 * แต่ Legal Hold อยู่จนกว่าจะมีคนปลดอย่างตั้งใจ
 *
 * ใช้ตอนมีการตรวจสอบ ข้อพิพาท หรือคำสั่งทางกฎหมาย - สถานการณ์ที่การลบเอกสาร
 * ไม่ใช่แค่ความผิดพลาด แต่เป็นการทำลายหลักฐาน
 *
 * **ประวัติต้องไม่ถูกลบเลย** การปลดคือการเพิ่มข้อมูลว่าใครปลดเมื่อไร
 * ไม่ใช่การลบแถวทิ้ง คำถามที่ต้องตอบได้เสมอคือ "เอกสารนี้เคยถูกระงับด้วยเหตุผลอะไร"
 */
import { prisma } from '../../core/prisma.js';
import { AppError, notFound } from '../../core/errors.js';
import { logger } from '../../core/logger.js';
import { capabilities, resourceInclude } from '../resources/resource.service.js';
import { canManageRetention } from './retention.service.js';
import type { AuthUser } from '../auth/auth.service.js';

/**
 * ผู้ที่วางหรือปลด Legal Hold ได้
 *
 * ใช้สิทธิ์เดียวกับการจัดการนโยบายการเก็บรักษา - ทั้งสองอย่างคือการกำกับดูแล
 * ไม่ใช่การแก้ไขเอกสาร ผู้แก้ไขเอกสารทั่วไปจึงวางหรือปลดไม่ได้
 *
 * ถ้าผู้แก้ไขปลดเองได้ Legal Hold จะไม่มีความหมาย เพราะคนที่อยากลบเอกสาร
 * ก็คือคนที่ปลดมันได้พอดี
 */
function assertHoldManager(user: AuthUser): void {
  if (!canManageRetention(user)) {
    throw new AppError('LEGAL_HOLD_DENIED', 'ต้องมีสิทธิ์จัดการการระงับการลบจึงจะดำเนินการนี้ได้', 403);
  }
}

export interface LegalHoldDto {
  id: string;
  resourceId: string;
  resourceName: string;
  reason: string;
  caseReference: string | null;
  createdBy: { id: string; displayName: string };
  createdAt: Date;
  releasedBy: { id: string; displayName: string } | null;
  releasedAt: Date | null;
  releaseReason: string | null;
  isActive: boolean;
}

export interface LegalHoldHistoryDto extends LegalHoldDto {
  resourceType: string;
  driveScope: string;
  resourceDeleted: boolean;
}

const holdSelect = {
  id: true,
  resourceId: true,
  reason: true,
  caseReference: true,
  createdAt: true,
  releasedAt: true,
  releaseReason: true,
  isActive: true,
  resource: { select: { name: true } },
  createdBy: { select: { id: true, displayName: true } },
  releasedBy: { select: { id: true, displayName: true } },
} as const;

type HoldRow = {
  id: string;
  resourceId: string;
  reason: string;
  caseReference: string | null;
  createdAt: Date;
  releasedAt: Date | null;
  releaseReason: string | null;
  isActive: boolean;
  resource: { name: string };
  createdBy: { id: string; displayName: string };
  releasedBy: { id: string; displayName: string } | null;
};

const toDto = (row: HoldRow): LegalHoldDto => ({
  id: row.id,
  resourceId: row.resourceId,
  resourceName: row.resource.name,
  reason: row.reason,
  caseReference: row.caseReference,
  createdBy: row.createdBy,
  createdAt: row.createdAt,
  releasedBy: row.releasedBy,
  releasedAt: row.releasedAt,
  releaseReason: row.releaseReason,
  isActive: row.isActive,
});

/**
 * วาง Legal Hold
 *
 * ต้องระบุเหตุผลเสมอ - การระงับที่ไม่มีเหตุผลจะไม่มีใครกล้าปลดในอีกสองปีข้างหน้า
 * เพราะไม่มีใครรู้ว่ามันถูกวางไว้ทำไม และเอกสารจะถูกแช่แข็งตลอดไปโดยไม่ตั้งใจ
 */
export async function placeLegalHold(
  resourceId: string,
  user: AuthUser,
  input: { reason: string; caseReference?: string | null },
  audit: { ipAddress?: string; userAgent?: string },
): Promise<LegalHoldDto> {
  assertHoldManager(user);

  const reason = input.reason.trim();
  if (!reason) {
    throw new AppError('LEGAL_HOLD_REASON_REQUIRED', 'กรุณาระบุเหตุผลของการระงับการลบ', 400);
  }
  if (reason.length > 500) {
    throw new AppError('LEGAL_HOLD_REASON_TOO_LONG', 'เหตุผลยาวเกิน 500 ตัวอักษร', 400);
  }

  const resource = await prisma.resource.findUnique({
    where: { id: resourceId },
    include: resourceInclude,
  });
  if (!resource) throw notFound('RESOURCE_NOT_FOUND', 'ไม่พบทรัพยากร');
  if (!capabilities(resource, user).canView) {
    throw notFound('RESOURCE_NOT_FOUND', 'ไม่พบทรัพยากร');
  }

  const existing = await prisma.legalHold.findFirst({
    where: { resourceId, isActive: true },
    select: { id: true },
  });
  if (existing) {
    throw new AppError('LEGAL_HOLD_ALREADY_ACTIVE', 'เอกสารนี้ถูกระงับการลบอยู่แล้ว', 409);
  }

  const row = await prisma.$transaction(async (tx) => {
    const created = await tx.legalHold.create({
      data: {
        resourceId,
        reason,
        caseReference: input.caseReference?.trim() || null,
        createdById: user.id,
      },
      select: holdSelect,
    });

    // หลักฐานนี้ไม่มี FK ไปยัง Resource/LegalHold เพื่อให้รอดจากการ purge ในอนาคต
    await tx.legalHoldHistory.create({
      data: {
        legalHoldId: created.id,
        originalResourceId: resource.id,
        resourceName: resource.name,
        resourceType: resource.type,
        driveScope: resource.driveScope,
        reason,
        caseReference: input.caseReference?.trim() || null,
        createdById: user.id,
        createdAt: created.createdAt,
        isActive: true,
      },
    });

    await tx.activityLog.create({
      data: {
        userId: user.id,
        action: 'LEGAL_HOLD_CREATED',
        resourceId,
        ipAddress: audit.ipAddress,
        userAgent: audit.userAgent?.slice(0, 500),
        metadata: {
          legalHoldId: created.id,
          originalResourceId: resource.id,
          resourceName: resource.name,
          before: 'NO_ACTIVE_HOLD',
          after: 'ACTIVE',
        },
      },
    });
    return created;
  });

  logger.info(`[LEGAL HOLD] ระงับการลบ "${resource.name}"`);
  return toDto(row as HoldRow);
}

/**
 * ปลด Legal Hold
 *
 * ไม่ลบแถว - เปลี่ยนเป็นไม่มีผลแล้วบันทึกว่าใครปลดเมื่อไรเพราะอะไร
 * ประวัติการระงับต้องตอบได้ตลอดไป แม้จะปลดไปนานแล้ว
 */
export async function releaseLegalHold(
  holdId: string,
  user: AuthUser,
  input: { releaseReason: string },
  audit: { ipAddress?: string; userAgent?: string },
): Promise<LegalHoldDto> {
  assertHoldManager(user);

  const releaseReason = input.releaseReason?.trim() ?? '';
  if (!releaseReason) {
    throw new AppError('LEGAL_HOLD_RELEASE_REASON_REQUIRED', 'กรุณาระบุเหตุผลที่ปลดการระงับการลบ', 400);
  }
  if (releaseReason.length > 500) {
    throw new AppError('LEGAL_HOLD_RELEASE_REASON_TOO_LONG', 'เหตุผลที่ปลดยาวเกิน 500 ตัวอักษร', 400);
  }

  const hold = await prisma.legalHold.findUnique({
    where: { id: holdId },
    select: { id: true, isActive: true, resourceId: true, resource: { select: { name: true } } },
  });
  if (!hold) throw notFound('LEGAL_HOLD_NOT_FOUND', 'ไม่พบรายการระงับการลบ');
  if (!hold.isActive) {
    throw new AppError('LEGAL_HOLD_NOT_ACTIVE', 'รายการนี้ถูกปลดไปแล้ว', 409);
  }

  const releasedAt = new Date();
  const row = await prisma.$transaction(async (tx) => {
    const updated = await tx.legalHold.update({
      where: { id: holdId },
      data: {
        isActive: false,
        releasedById: user.id,
        releasedAt,
        releaseReason,
      },
      select: holdSelect,
    });

    const history = await tx.legalHoldHistory.updateMany({
      where: { legalHoldId: holdId, isActive: true },
      data: { isActive: false, releasedById: user.id, releasedAt, releaseReason },
    });
    if (history.count !== 1) {
      throw new AppError('LEGAL_HOLD_HISTORY_MISSING', 'ไม่พบหลักฐานประวัติ Legal Hold ที่สอดคล้องกัน', 409);
    }

    await tx.activityLog.create({
      data: {
        userId: user.id,
        action: 'LEGAL_HOLD_RELEASED',
        resourceId: hold.resourceId,
        ipAddress: audit.ipAddress,
        userAgent: audit.userAgent?.slice(0, 500),
        // Release reason เป็นหลักฐานของ privileged action จึงเปิดผ่าน Audit Explorer ที่มีสิทธิ์เท่านั้น
        metadata: {
          legalHoldId: holdId,
          originalResourceId: hold.resourceId,
          resourceName: hold.resource.name,
          releaseReason,
          before: 'ACTIVE',
          after: 'RELEASED',
        },
      },
    });
    return updated;
  });

  logger.info('[LEGAL HOLD] ปลดการระงับการลบแล้ว');
  return toDto(row as HoldRow);
}

/**
 * หลักฐาน Legal Hold ที่รอดจากการลบ Resource ถาวร
 * เห็นได้เฉพาะผู้จัดการการเก็บรักษา เพราะมีเหตุผล/เลขคดีที่อ่อนไหว
 */
export async function listLegalHoldHistory(
  user: AuthUser,
  options: { resourceId?: string; includeActive?: boolean } = {},
): Promise<LegalHoldHistoryDto[]> {
  assertHoldManager(user);
  const rows = await prisma.legalHoldHistory.findMany({
    where: {
      ...(options.resourceId ? { originalResourceId: options.resourceId } : {}),
      ...(options.includeActive === false ? { isActive: false } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: 500,
    include: {
      createdBy: { select: { id: true, displayName: true } },
      releasedBy: { select: { id: true, displayName: true } },
    },
  });
  const liveIds = [...new Set(rows.map((row) => row.originalResourceId))];
  const live = liveIds.length
    ? await prisma.resource.findMany({ where: { id: { in: liveIds } }, select: { id: true } })
    : [];
  const liveSet = new Set(live.map((row) => row.id));
  return rows.map((row) => ({
    id: row.legalHoldId,
    resourceId: row.originalResourceId,
    resourceName: row.resourceName,
    resourceType: row.resourceType,
    driveScope: row.driveScope,
    resourceDeleted: !liveSet.has(row.originalResourceId),
    reason: row.reason,
    caseReference: row.caseReference,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    releasedBy: row.releasedBy,
    releasedAt: row.releasedAt,
    releaseReason: row.releaseReason,
    isActive: row.isActive,
  }));
}

/**
 * รายการระงับการลบทั้งหมด สำหรับหน้าผู้ดูแล
 *
 * เห็นได้เฉพาะผู้ที่จัดการการระงับได้ - รายการนี้เปิดเผยว่ากำลังมีการตรวจสอบ
 * เอกสารชุดใดอยู่ ซึ่งเป็นข้อมูลที่ไม่ควรกระจายไปทั้งองค์กร
 */
export async function listLegalHolds(
  user: AuthUser,
  options: { includeReleased?: boolean } = {},
): Promise<LegalHoldDto[]> {
  assertHoldManager(user);
  const rows = await prisma.legalHold.findMany({
    where: options.includeReleased ? {} : { isActive: true },
    orderBy: [{ isActive: 'desc' }, { createdAt: 'desc' }],
    take: 200,
    select: holdSelect,
  });
  return rows.map((row) => toDto(row as HoldRow));
}

/**
 * ประวัติการระงับของเอกสารหนึ่งฉบับ
 *
 * ใช้สิทธิ์เปิดดูเอกสารเป็นเกณฑ์ แต่ **ไม่คืนเหตุผล** ให้ผู้ที่ไม่ได้จัดการการระงับ
 * ผู้ใช้ทั่วไปควรรู้ว่า "ลบไม่ได้เพราะถูกระงับ" แต่ไม่จำเป็นต้องรู้ว่าคดีอะไร
 */
export async function legalHoldsForResource(
  resourceId: string,
  user: AuthUser,
): Promise<Array<Omit<LegalHoldDto, 'reason' | 'caseReference'> & { reason: string | null; caseReference: string | null }>> {
  const resource = await prisma.resource.findUnique({
    where: { id: resourceId },
    include: resourceInclude,
  });
  if (!resource || !capabilities(resource, user).canView) {
    throw notFound('RESOURCE_NOT_FOUND', 'ไม่พบทรัพยากร');
  }

  const rows = await prisma.legalHold.findMany({
    where: { resourceId },
    orderBy: [{ isActive: 'desc' }, { createdAt: 'desc' }],
    select: holdSelect,
  });

  const manager = canManageRetention(user);
  return rows.map((row) => {
    const dto = toDto(row as HoldRow);
    return {
      ...dto,
      reason: manager ? dto.reason : null,
      caseReference: manager ? dto.caseReference : null,
    };
  });
}

/**
 * การแก้ข้อมูลประกอบของทรัพยากรหลายรายการพร้อมกัน
 *
 * หลักสำคัญสองข้อ:
 *
 * 1. **ตรวจสิทธิ์ทุกรายการ ไม่ใช่ตรวจรายการแรกแล้วเหมาเอาทั้งชุด**
 *    ผู้ใช้เลือกทรัพยากรจากหน้าจอที่ผสมของหลายเจ้าของกันได้เสมอ และคำขอ
 *    ที่ถูกแก้เองก็ยัดรหัสอะไรเข้ามาก็ได้ การอนุญาตทั้งชุดเพราะรายการแรกผ่าน
 *    คือช่องโหว่ที่ตรงไปตรงมาที่สุดของงานลักษณะนี้
 *
 * 2. **ไม่แกล้งทำเป็นว่าทำได้ครบทั้งหมด**
 *    งานหลายร้อยรายการไม่ได้อยู่ใน transaction เดียว เพราะการล็อกแถวจำนวนมาก
 *    นานหลายวินาทีจะไปขวางการใช้งานปกติของคนอื่นทั้งระบบ ผลจึงถูกรายงานเป็น
 *    สำเร็จ/ข้าม/ล้มเหลว ตามความจริง ไม่ใช่ "สำเร็จ" ก้อนเดียว
 */
import crypto from 'node:crypto';
import { prisma } from '../../core/prisma.js';
import { AppError } from '../../core/errors.js';
import { logger } from '../../core/logger.js';
import { capabilities, resourceInclude } from './resource.service.js';
import { addTagToResource, removeTagFromResource } from '../workspace/workspace.service.js';
import type { AuthUser } from '../auth/auth.service.js';

/** จำนวนสูงสุดต่อหนึ่งคำขอ - งานที่ใหญ่กว่านี้ควรถูกแบ่ง ไม่ใช่ปล่อยให้คำขอค้าง */
export const BULK_LIMIT = 200;

export interface BulkOutcome {
  /** รหัสอ้างอิงของการทำงานครั้งนี้ ใช้ผูก audit ทุกแถวเข้าด้วยกัน */
  batchId: string;
  succeeded: number;
  /** ข้าม = ไม่เข้าเงื่อนไข เช่น โฟลเดอร์ในงานที่ทำได้เฉพาะไฟล์ */
  skipped: number;
  failed: number;
  /**
   * เหตุผลของรายการที่ไม่สำเร็จ
   *
   * ไม่ใส่ชื่อทรัพยากรที่ผู้เรียกไม่มีสิทธิ์เห็น - ข้อความแสดงข้อผิดพลาด
   * ไม่ควรกลายเป็นช่องทางยืนยันว่าเอกสารลับมีอยู่จริง
   */
  errors: Array<{ resourceId: string; code: string; message: string }>;
}

interface Accumulator {
  batchId: string;
  succeeded: number;
  skipped: number;
  failed: number;
  errors: BulkOutcome['errors'];
}

function newAccumulator(): Accumulator {
  return { batchId: crypto.randomUUID(), succeeded: 0, skipped: 0, failed: 0, errors: [] };
}

function assertBatch(resourceIds: string[]): void {
  if (resourceIds.length === 0) {
    throw new AppError('BULK_EMPTY', 'กรุณาเลือกอย่างน้อยหนึ่งรายการ', 400);
  }
  if (resourceIds.length > BULK_LIMIT) {
    throw new AppError(
      'BULK_TOO_MANY',
      `ทำได้ครั้งละไม่เกิน ${BULK_LIMIT} รายการ กรุณาแบ่งเป็นหลายครั้ง`,
      400,
    );
  }
}

/**
 * บันทึกสรุปของงานหนึ่งชุด
 *
 * บันทึกเป็นแถวเดียวพร้อมจำนวน ไม่ใช่หนึ่งแถวต่อทรัพยากร - งานสองร้อยรายการ
 * ที่เขียน audit สองร้อยแถวจะทำให้ตารางบวมโดยไม่ได้ตอบคำถามอะไรเพิ่ม
 *
 * ส่วนการเปลี่ยนแปลงรายทรัพยากรยังถูกบันทึกโดยบริการเดิมที่ถูกเรียกอยู่แล้ว
 * (เช่น RESOURCE_TAG_ADDED) ร่องรอยรายรายการจึงไม่หายไปไหน
 */
async function logBatch(
  action: string,
  user: AuthUser,
  acc: Accumulator,
  audit: { ipAddress?: string; userAgent?: string },
  extra: Record<string, unknown> = {},
): Promise<void> {
  await prisma.activityLog.create({
    data: {
      userId: user.id,
      action,
      ipAddress: audit.ipAddress,
      userAgent: audit.userAgent?.slice(0, 500),
      metadata: {
        batchId: acc.batchId,
        succeeded: acc.succeeded,
        skipped: acc.skipped,
        failed: acc.failed,
        ...extra,
      },
    },
  });
}

function record(acc: Accumulator, resourceId: string, error: unknown): void {
  acc.failed += 1;
  const code = error instanceof AppError ? error.code : 'BULK_ITEM_FAILED';
  const message = error instanceof AppError ? error.message : 'ดำเนินการกับรายการนี้ไม่สำเร็จ';
  // จำกัดจำนวนเหตุผลที่ส่งกลับ เพื่อไม่ให้คำตอบบวมเมื่อทั้งชุดล้มเหลว
  if (acc.errors.length < 20) acc.errors.push({ resourceId, code, message });
}

/* ------------------------------------------------------------------ */
/* แท็ก                                                                */
/* ------------------------------------------------------------------ */

/**
 * ติดแท็กให้ทุกรายการที่เลือก
 *
 * เรียกบริการเดิมของแท็กทีละรายการ ไม่เขียนตาราง resource_tags เอง
 * บริการเดิมตรวจสิทธิ์ ตรวจการล็อก จัดการการสร้างแท็กใหม่ และเขียน audit
 * ครบอยู่แล้ว การเขียนซ้ำที่นี่จะทำให้กติกาสองชุดเพี้ยนจากกันในวันข้างหน้า
 *
 * แท็กเดิมของทรัพยากรไม่ถูกแตะ - นี่คือการ "เพิ่ม" ไม่ใช่ "แทนที่"
 */
export async function bulkAddTag(
  resourceIds: string[],
  tagName: string,
  user: AuthUser,
  audit: { ipAddress?: string; userAgent?: string },
): Promise<BulkOutcome> {
  assertBatch(resourceIds);
  const acc = newAccumulator();

  for (const resourceId of resourceIds) {
    try {
      await addTagToResource(resourceId, tagName, user, audit);
      acc.succeeded += 1;
    } catch (error) {
      record(acc, resourceId, error);
    }
  }

  await logBatch('BULK_TAG_ADDED', user, acc, audit, { tagName });
  logger.info(`[BULK] ติดแท็ก "${tagName}" สำเร็จ ${acc.succeeded}/${resourceIds.length}`);
  return toOutcome(acc);
}

/** ถอดแท็กหนึ่งอันออกจากทุกรายการที่เลือก - แท็กอื่นไม่ถูกแตะ */
export async function bulkRemoveTag(
  resourceIds: string[],
  tagId: string,
  user: AuthUser,
  audit: { ipAddress?: string; userAgent?: string },
): Promise<BulkOutcome> {
  assertBatch(resourceIds);
  const acc = newAccumulator();

  for (const resourceId of resourceIds) {
    try {
      const link = await prisma.resourceTag.findUnique({
        where: { resourceId_tagId: { resourceId, tagId } },
        select: { resourceId: true },
      });
      // ไม่มีแท็กนี้อยู่แล้ว = ผลลัพธ์ตรงกับที่ผู้ใช้ต้องการ จึงเป็น "ข้าม" ไม่ใช่ "ล้มเหลว"
      if (!link) {
        acc.skipped += 1;
        continue;
      }
      await removeTagFromResource(resourceId, tagId, user, audit);
      acc.succeeded += 1;
    } catch (error) {
      record(acc, resourceId, error);
    }
  }

  await logBatch('BULK_TAG_REMOVED', user, acc, audit, { tagId });
  return toOutcome(acc);
}

/* ------------------------------------------------------------------ */
/* ประเภทเอกสาร                                                        */
/* ------------------------------------------------------------------ */

/**
 * กำหนดประเภทเอกสารให้หลายรายการ
 *
 * ใช้ได้กับไฟล์เท่านั้น โฟลเดอร์ถูกข้าม - โฟลเดอร์เป็นที่เก็บของหลายประเภทปนกัน
 * การบอกว่าโฟลเดอร์หนึ่งเป็น "ใบกำกับภาษี" จึงไม่มีความหมายและทำให้ตัวกรองเพี้ยน
 *
 * categoryId = null คือการล้างประเภทออก ซึ่งเป็นการกระทำที่ตั้งใจได้
 */
export async function bulkSetCategory(
  resourceIds: string[],
  categoryId: string | null,
  user: AuthUser,
  audit: { ipAddress?: string; userAgent?: string },
): Promise<BulkOutcome> {
  assertBatch(resourceIds);
  const acc = newAccumulator();

  if (categoryId) {
    const category = await prisma.documentCategory.findUnique({
      where: { id: categoryId },
      select: { id: true, isActive: true },
    });
    if (!category) throw new AppError('CATEGORY_NOT_FOUND', 'ไม่พบประเภทเอกสาร', 404);
    if (!category.isActive) {
      throw new AppError('CATEGORY_INACTIVE', 'ประเภทเอกสารนี้ถูกปิดการใช้งานอยู่', 409);
    }
  }

  for (const resourceId of resourceIds) {
    try {
      const resource = await loadForWrite(resourceId, user);
      if (!resource) {
        acc.failed += 1;
        acc.errors.length < 20 &&
          acc.errors.push({
            resourceId,
            code: 'RESOURCE_ACCESS_DENIED',
            message: 'ไม่มีสิทธิ์แก้ไขรายการนี้',
          });
        continue;
      }
      if (resource.type === 'FOLDER') {
        acc.skipped += 1;
        continue;
      }

      await prisma.resource.update({
        where: { id: resourceId },
        data: { documentCategoryId: categoryId, updatedById: user.id },
      });
      acc.succeeded += 1;
    } catch (error) {
      record(acc, resourceId, error);
    }
  }

  await logBatch('BULK_CATEGORY_SET', user, acc, audit, { documentCategoryId: categoryId });
  return toOutcome(acc);
}

/* ------------------------------------------------------------------ */
/* ผู้ดูแล                                                             */
/* ------------------------------------------------------------------ */

/**
 * เปลี่ยนผู้ดูแลของหลายรายการ
 *
 * ตรวจว่าผู้รับโอนเป็นบัญชีภายในที่ยังใช้งานอยู่ก่อนเสมอ การโอนความรับผิดชอบ
 * ไปให้บัญชีที่ถูกปิดแล้ว หรือให้บัญชีลูกค้าภายนอก คือการทำให้เอกสารไม่มีคนดูแลจริง
 */
export async function bulkSetOwner(
  resourceIds: string[],
  newOwnerId: string,
  user: AuthUser,
  audit: { ipAddress?: string; userAgent?: string },
): Promise<BulkOutcome> {
  assertBatch(resourceIds);

  const owner = await prisma.user.findUnique({
    where: { id: newOwnerId },
    select: { id: true, type: true, status: true },
  });
  if (!owner || owner.status !== 'ACTIVE' || owner.type !== 'INTERNAL') {
    throw new AppError('OWNER_NOT_FOUND', 'ผู้ดูแลที่เลือกไม่ใช่บัญชีภายในที่เปิดใช้งานอยู่', 400);
  }

  const acc = newAccumulator();
  for (const resourceId of resourceIds) {
    try {
      /**
       * ใช้ capabilities().canTransferOwner ซึ่งเป็นกติกาเดียวกับการโอนทีละรายการ
       * ผู้แก้ไข (EDITOR) ไม่ได้สิทธิ์นี้โดยอัตโนมัติ เพราะการเปลี่ยนผู้รับผิดชอบ
       * เป็นการตัดสินใจเชิงการควบคุม ไม่ใช่การแก้เนื้อหา
       */
      const row = await prisma.resource.findUnique({
        where: { id: resourceId },
        include: resourceInclude,
      });
      if (!row || row.deletedAt) {
        acc.skipped += 1;
        continue;
      }
      const caps = capabilities(row, user);
      if (!caps.canView || !caps.canTransferOwner) {
        acc.failed += 1;
        if (acc.errors.length < 20) {
          acc.errors.push({
            resourceId,
            code: 'OWNER_TRANSFER_DENIED',
            message: 'ไม่มีสิทธิ์เปลี่ยนผู้ดูแลของรายการนี้',
          });
        }
        continue;
      }

      await prisma.resource.update({
        where: { id: resourceId },
        data: { ownerId: newOwnerId, updatedById: user.id },
      });
      await prisma.activityLog.create({
        data: {
          userId: user.id,
          action: 'RESOURCE_OWNER_CHANGED',
          resourceId,
          ipAddress: audit.ipAddress,
          userAgent: audit.userAgent?.slice(0, 500),
          metadata: { batchId: acc.batchId, newOwnerId },
        },
      });
      acc.succeeded += 1;
    } catch (error) {
      record(acc, resourceId, error);
    }
  }

  await logBatch('BULK_OWNER_CHANGED', user, acc, audit, { newOwnerId });
  return toOutcome(acc);
}

/* ------------------------------------------------------------------ */
/* ตัวช่วย                                                             */
/* ------------------------------------------------------------------ */

/**
 * ใช้ resourceInclude ตัวเดียวกับที่ทุกเส้นทางใช้
 *
 * capabilities() คำนวณจากความสัมพันธ์หลายชุด การประกอบ include เองที่นี่
 * ทำให้ขาดฟิลด์และคำนวณสิทธิ์จากข้อมูลไม่ครบ ซึ่งเป็นความผิดพลาดที่เงียบและอันตราย
 */

/**
 * โหลดทรัพยากรพร้อมตรวจว่าผู้เรียกแก้ไขได้จริง
 *
 * คืน null เมื่อไม่มีสิทธิ์หรือไม่มีอยู่ - ผู้เรียกแยกสองกรณีนี้ไม่ได้โดยตั้งใจ
 * เพื่อไม่ให้การยิงรหัสมั่ว ๆ กลายเป็นวิธีตรวจว่าเอกสารมีอยู่จริงหรือไม่
 */
async function loadForWrite(resourceId: string, user: AuthUser) {
  const row = await prisma.resource.findUnique({
    where: { id: resourceId },
    include: resourceInclude,
  });
  if (!row || row.deletedAt) return null;
  const caps = capabilities(row, user);
  if (!caps.canView || !caps.canEdit) return null;
  return row;
}

function toOutcome(acc: Accumulator): BulkOutcome {
  return {
    batchId: acc.batchId,
    succeeded: acc.succeeded,
    skipped: acc.skipped,
    failed: acc.failed,
    errors: acc.errors,
  };
}

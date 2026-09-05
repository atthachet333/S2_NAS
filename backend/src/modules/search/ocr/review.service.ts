/**
 * คิวตรวจผลของ OCR
 *
 * แนวคิดหลัก: **"ตรวจแล้วถูก" กับ "ตรวจแล้วแก้" ไม่ใช่เรื่องเดียวกัน**
 *
 * ผลของ OCR ส่วนใหญ่ถูกต้องอยู่แล้ว การบังคับให้คนแก้ข้อความก่อนถึงจะบันทึกได้
 * จะทำให้คนเลิกตรวจตั้งแต่เอกสารแผ่นที่สาม คิวนี้จึงรองรับการกด "ถูกต้องแล้ว"
 * โดยไม่ต้องแตะข้อความเลย
 *
 * และเมื่อกดว่าถูกต้อง **ที่มาของข้อความยังเป็น OCR อยู่** ไม่ถูกเปลี่ยนเป็น
 * HUMAN_CORRECTED เพราะไม่มีใครพิมพ์อะไรลงไป การบอกว่า "คนแก้แล้ว" ทั้งที่ไม่มี
 * ใครแก้ จะทำให้ข้อมูลที่ใช้วัดคุณภาพ OCR ในอนาคตเป็นเท็จ
 *
 * สิ่งที่เปลี่ยนคือ reviewStatus ซึ่งตอบคนละคำถามกับ textSource:
 *   textSource   = ข้อความนี้มาจากไหน
 *   reviewStatus = มีคนดูมันแล้วหรือยัง
 */
import { prisma } from '../../../core/prisma.js';
import { AppError, notFound } from '../../../core/errors.js';
import { getResource } from '../../resources/resource.service.js';
import type { AuthUser } from '../../auth/auth.service.js';

/** เกณฑ์ความมั่นใจที่ถือว่า "ต่ำ" - ใช้จัดลำดับเท่านั้น ไม่ใช้ตัดสินสิทธิ์ */
export const LOW_CONFIDENCE_THRESHOLD = 80;

export type QueueOrder = 'oldest' | 'newest' | 'lowestConfidence';

export interface ReviewQueueFilters {
  /** เฉพาะผลที่เครื่องมั่นใจน้อย ซึ่งมักเป็นกลุ่มที่อ่านผิดจริง */
  lowConfidenceOnly?: boolean;
  fileKind?: 'pdf' | 'image';
  ownerId?: string;
  from?: Date;
  to?: Date;
  order?: QueueOrder;
}

export interface ReviewQueueItem {
  resourceId: string;
  name: string;
  extension: string | null;
  ownerName: string;
  ocrConfidence: number | null;
  ocrPageCount: number | null;
  characterCount: number;
  indexedAt: Date | null;
}

export interface ReviewQueue {
  items: ReviewQueueItem[];
  /** จำนวนที่เหลือทั้งหมดที่ผู้เรียกมีสิทธิ์เห็น - นับจริง ไม่ใช่ประมาณ */
  remaining: number;
}

/**
 * เงื่อนไขของรายการที่ "ควรถูกตรวจ"
 *
 * เฉพาะผลที่มาจากการอ่านภาพ และเป็นเวอร์ชันปัจจุบันเท่านั้น
 * เอกสารที่มีข้อความอยู่ในไฟล์จริงไม่ต้องตรวจ เพราะไม่ได้ผ่านการเดาของเครื่อง
 */
function queueWhere(filters: ReviewQueueFilters) {
  return {
    status: 'READY' as const,
    textSource: 'OCR' as const,
    reviewStatus: 'UNREVIEWED' as const,
    resource: {
      deletedAt: null,
      ...(filters.ownerId ? { ownerId: filters.ownerId } : {}),
      ...(filters.fileKind === 'pdf' ? { extension: 'pdf' } : {}),
      ...(filters.fileKind === 'image'
        ? { extension: { in: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'tif', 'tiff'] } }
        : {}),
    },
    ...(filters.lowConfidenceOnly ? { ocrConfidence: { lt: LOW_CONFIDENCE_THRESHOLD } } : {}),
    ...(filters.from || filters.to
      ? {
          extractedAt: {
            ...(filters.from ? { gte: filters.from } : {}),
            ...(filters.to ? { lte: filters.to } : {}),
          },
        }
      : {}),
  };
}

function queueOrderBy(order: QueueOrder | undefined) {
  switch (order) {
    case 'newest':
      return [{ extractedAt: 'desc' as const }, { id: 'asc' as const }];
    case 'lowestConfidence':
      return [{ ocrConfidence: 'asc' as const }, { id: 'asc' as const }];
    default:
      /**
       * ค่าเริ่มต้นคือเก่าสุดก่อน - เอกสารที่รอมานานที่สุดควรได้รับการตรวจก่อน
       * ไม่อย่างนั้นของเก่าจะไม่มีวันถูกแตะเลย
       */
      return [{ extractedAt: 'asc' as const }, { id: 'asc' as const }];
  }
}

/**
 * รายการในคิวที่ผู้เรียกมีสิทธิ์เห็น
 *
 * ดึงเกินมาแล้วกรองสิทธิ์ทีละรายการ เพราะสิทธิ์ของระบบนี้คำนวณจากหลายแหล่ง
 * (เจ้าของ การแชร์รายคน ระดับการมองเห็น ไดร์ฟ) ซึ่งสรุปเป็นเงื่อนไข SQL
 * ชุดเดียวได้ไม่ครบ การกรองด้วย capabilities() จึงเป็นด่านที่เชื่อถือได้
 */
export async function reviewQueue(
  user: AuthUser,
  filters: ReviewQueueFilters = {},
  limit = 20,
): Promise<ReviewQueue> {
  if (!user.permissions.includes('resources:read')) {
    throw new AppError('OCR_REVIEW_DENIED', 'ไม่มีสิทธิ์เข้าถึงคิวตรวจ OCR', 403);
  }

  const where = queueWhere(filters);
  const rows = await prisma.resourceSearchIndex.findMany({
    where,
    orderBy: queueOrderBy(filters.order),
    // ดึงเผื่อไว้เพราะบางรายการจะถูกตัดออกด้วยสิทธิ์
    take: Math.min(limit * 5, 300),
    select: {
      resourceId: true,
      ocrConfidence: true,
      ocrPageCount: true,
      characterCount: true,
      extractedAt: true,
      resource: {
        select: { id: true, name: true, extension: true, owner: { select: { displayName: true } } },
      },
    },
  });

  const items: ReviewQueueItem[] = [];
  for (const row of rows) {
    if (items.length >= limit) break;
    // ตรวจสิทธิ์รายรายการด้วยด่านเดียวกับที่ทุกเส้นทางของทรัพยากรใช้
    const allowed = await canReview(row.resourceId, user).catch(() => null);
    if (!allowed) continue;
    items.push({
      resourceId: row.resourceId,
      name: row.resource.name,
      extension: row.resource.extension,
      ownerName: row.resource.owner.displayName,
      ocrConfidence: row.ocrConfidence,
      ocrPageCount: row.ocrPageCount,
      characterCount: row.characterCount,
      indexedAt: row.extractedAt,
    });
  }

  return { items, remaining: await remainingCount(user, filters) };
}

/**
 * จำนวนที่เหลือ
 *
 * นับจากรายการที่ผู้เรียกเห็นได้จริงเท่านั้น การรายงานตัวเลขรวมของทั้งระบบ
 * จะทำให้ผู้ใช้เห็นว่า "เหลือ 40 รายการ" แล้วตรวจไปสามรายการก็หมดคิว
 * ซึ่งดูเหมือนระบบพัง
 *
 * มีเพดานเพื่อไม่ให้การนับกลายเป็นการไล่อ่านทั้งฐานข้อมูล
 */
const COUNT_SCAN_LIMIT = 500;

async function remainingCount(user: AuthUser, filters: ReviewQueueFilters): Promise<number> {
  const rows = await prisma.resourceSearchIndex.findMany({
    where: queueWhere(filters),
    take: COUNT_SCAN_LIMIT,
    select: { resourceId: true },
  });

  let count = 0;
  for (const row of rows) {
    const allowed = await canReview(row.resourceId, user).catch(() => null);
    if (allowed) count += 1;
  }
  return count;
}

/**
 * ผู้เรียกตรวจรายการนี้ได้หรือไม่
 *
 * การตรวจเป็นการเปลี่ยนข้อมูลของทรัพยากร จึงใช้สิทธิ์แก้ไขเป็นเกณฑ์
 * ซึ่งเป็นเกณฑ์เดียวกับการสั่ง OCR และการตรวจแก้ข้อความใน F14
 * ไฟล์ที่ถูกล็อกจึงตรวจไม่ได้โดยอัตโนมัติ เพราะ canEdit นับ isLocked อยู่แล้ว
 */
async function canReview(resourceId: string, user: AuthUser): Promise<boolean> {
  const resource = await getResource(resourceId, user);
  return resource.capabilities.canEdit;
}

export interface ReviewResult {
  resourceId: string;
  reviewStatus: 'VERIFIED';
  reviewedAt: Date;
}

/**
 * ยืนยันว่าเครื่องอ่านถูกต้องแล้ว โดยไม่แก้ข้อความ
 *
 * ห้ามเปลี่ยน textSource เด็ดขาด - ข้อความยังเป็นผลของเครื่องทุกตัวอักษร
 * สิ่งที่เพิ่มเข้ามาคือหลักฐานว่ามีคนอ่านมันแล้ว
 */
export async function verifyOcrResult(resourceId: string, user: AuthUser): Promise<ReviewResult> {
  const resource = await getResource(resourceId, user);
  if (!resource.capabilities.canEdit) {
    throw new AppError('OCR_REVIEW_DENIED', 'ต้องมีสิทธิ์แก้ไขไฟล์นี้จึงจะตรวจผล OCR ได้', 403);
  }

  const target = await prisma.resource.findUnique({
    where: { id: resourceId },
    select: { currentVersion: true },
  });
  if (!target || target.currentVersion === null) {
    throw notFound('OCR_REVIEW_NOT_FOUND', 'ไม่พบเวอร์ชันปัจจุบันของไฟล์');
  }

  const index = await prisma.resourceSearchIndex.findFirst({
    where: { resourceId, versionNumber: target.currentVersion },
    select: { id: true, textSource: true, status: true },
  });
  if (!index) throw notFound('OCR_REVIEW_NOT_FOUND', 'ไฟล์นี้ยังไม่มีผลการอ่านข้อความ');
  if (index.textSource !== 'OCR' || index.status !== 'READY') {
    throw new AppError(
      'OCR_REVIEW_NOT_APPLICABLE',
      'ยืนยันได้เฉพาะเอกสารที่อ่านข้อความด้วย OCR สำเร็จแล้วเท่านั้น',
      400,
    );
  }

  const reviewedAt = new Date();
  await prisma.resourceSearchIndex.update({
    where: { id: index.id },
    data: {
      reviewStatus: 'VERIFIED',
      reviewedById: user.id,
      reviewedAt,
      // textSource ไม่ถูกแตะโดยตั้งใจ - ไม่มีใครพิมพ์อะไรลงไป
    },
  });

  return { resourceId, reviewStatus: 'VERIFIED', reviewedAt };
}

export interface ReviewSummary {
  needsReview: number;
  verified: number;
  corrected: number;
  failed: number;
}

/**
 * ตัวเลขสรุปสำหรับหน้าผู้ดูแล
 *
 * นับจากสถานะจริงในฐานข้อมูลทั้งหมด ไม่มีตัวเลขที่คำนวณจากการเดา
 * ใช้กับผู้ดูแลระบบซึ่งเห็นทุกอย่างอยู่แล้ว จึงไม่ต้องกรองสิทธิ์รายรายการ
 */
export async function reviewSummary(): Promise<ReviewSummary> {
  const currentVersionOnly = {
    resource: { deletedAt: null },
  };

  const [needsReview, verified, corrected, failed] = await Promise.all([
    prisma.resourceSearchIndex.count({
      where: { ...currentVersionOnly, status: 'READY', textSource: 'OCR', reviewStatus: 'UNREVIEWED' },
    }),
    prisma.resourceSearchIndex.count({ where: { ...currentVersionOnly, reviewStatus: 'VERIFIED' } }),
    prisma.resourceSearchIndex.count({ where: { ...currentVersionOnly, reviewStatus: 'CORRECTED' } }),
    prisma.resourceSearchIndex.count({
      where: { ...currentVersionOnly, status: 'FAILED', jobKind: 'OCR' },
    }),
  ]);

  return { needsReview, verified, corrected, failed };
}

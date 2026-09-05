import { prisma } from '../../core/prisma.js';
import { logger } from '../../core/logger.js';
import { getSetting } from '../system/settings.service.js';
import { purgeTrashedResource } from './trash.service.js';
import { governanceForResources } from '../governance/governance.guard.js';

/**
 * งานเก็บกวาดถังขยะตามอายุของแต่ละรายการ
 *
 * ถังขยะไม่ได้ถูกล้างทั้งใบทุก ๆ N วัน แต่ "แต่ละรายการหมดอายุของตัวเอง"
 * ที่ deletedAt + S2_NAS_TRASH_RETENTION_DAYS ผู้ใช้ที่ลบไฟล์วันนี้จึงมีเวลากู้คืน
 * เต็มจำนวนวันเสมอ ไม่ถูกตัดสั้นเพราะไปตรงกับรอบล้างของคนอื่น
 */

/** ครั้งแรกรันหลังระบบพร้อม จากนั้นวันละครั้ง */
const DAILY_MS = 24 * 60 * 60 * 1000;
const STARTUP_DELAY_MS = 30_000;

/** กันไม่ให้รอบเดียวกินเวลานานเกินไปเมื่อมีของค้างจำนวนมาก - ที่เหลือรอรอบถัดไป */
const MAX_PER_RUN = 200;

export interface RetentionResult {
  scanned: number;
  purged: number;
  skipped: number;
  failed: number;
}

/** เส้นแบ่งอายุ: รายการที่ถูกลบก่อนเวลานี้ถือว่าหมดอายุแล้ว */
export function retentionCutoff(now: Date, days: number): Date {
  return new Date(now.getTime() - days * DAILY_MS);
}

/**
 * รายการที่หมดอายุและควรถูกลบถาวร
 *
 * เลือกเฉพาะ "ราก" ของกิ่งที่ถูกทิ้ง (แม่ยังอยู่หรือไม่มีแม่) เพราะการลบถาวร
 * จะไล่ลบทั้งกิ่งอยู่แล้ว ถ้าส่งลูกเข้ามาด้วยจะเกิดการลบซ้ำที่หาไม่เจอในรอบเดียวกัน
 */
export async function findExpiredTrashRoots(cutoff: Date) {
  const rows = await prisma.resource.findMany({
    where: { deletedAt: { not: null, lte: cutoff } },
    select: { id: true, name: true, parentId: true, isLocked: true, deletedAt: true },
    orderBy: { deletedAt: 'asc' },
    take: MAX_PER_RUN,
  });

  const trashedIds = new Set(rows.map((row) => row.id));
  return rows.filter((row) => !(row.parentId && trashedIds.has(row.parentId)));
}

/**
 * รันหนึ่งรอบ
 *
 * ความล้มเหลวของรายการหนึ่งต้องไม่ทำให้รายการอื่นไม่ถูกเก็บกวาด จึงจับ error รายรายการ
 * รายการที่ถูกล็อกไว้จะถูกข้ามอย่างตั้งใจ ไม่ใช่ปลดล็อกให้เอง - การล็อกคือเจตนาของผู้ดูแล
 */
export async function runTrashRetention(now: Date = new Date()): Promise<RetentionResult> {
  /**
   * อ่านค่าที่มีผลจริงทุกรอบ ไม่ใช่ตอนเริ่มระบบ
   * ผู้ดูแลที่แก้ค่าในหน้าตั้งค่าจึงเห็นผลในรอบถัดไปโดยไม่ต้องรีสตาร์ท
   */
  const days = await getSetting('TRASH_RETENTION_DAYS');
  const result: RetentionResult = { scanned: 0, purged: 0, skipped: 0, failed: 0 };

  // 0 วัน = ปิดการเก็บกวาดอัตโนมัติ ไม่ใช่ "ลบทุกอย่างทันที"
  if (days <= 0) return result;

  const expired = await findExpiredTrashRoots(retentionCutoff(now, days));
  result.scanned = expired.length;

  /**
   * ตรวจการกำกับดูแลของทั้งรอบในคำสั่งเดียว
   *
   * รายการที่ถูกคุ้มครองถูกนับเป็น "ข้าม" ไม่ใช่ "ล้มเหลว"
   *
   * ถ้าปล่อยให้ไปชนด่านใน purgeTrashedResource แล้วโยนข้อผิดพลาด งานนี้จะเขียน
   * บันทึกความล้มเหลวของเอกสารชุดเดิมทุกวันไปเรื่อย ๆ จนบันทึกที่ควรบอกปัญหาจริง
   * จมหายไปในเสียงรบกวน - และเอกสารที่ถูกเก็บตามนโยบายไม่ใช่ความล้มเหลว
   * มันคือระบบทำงานถูกต้อง
   */
  const governance = await governanceForResources(expired.map((row) => row.id), now);

  for (const row of expired) {
    if (row.isLocked) {
      result.skipped += 1;
      logger.warn(`[TRASH] ข้ามการลบถาวรตามอายุ "${row.name}" เพราะถูกล็อกอยู่`);
      continue;
    }

    const state = governance.get(row.id);
    if (state && !state.canPermanentlyDelete) {
      result.skipped += 1;
      continue;
    }
    try {
      await purgeTrashedResource(row.id, { userId: null, reason: 'RETENTION' }, {});
      result.purged += 1;
    } catch (error) {
      result.failed += 1;
      logger.error({ err: error, resourceId: row.id }, `[TRASH] ลบถาวรตามอายุไม่สำเร็จ: "${row.name}"`);
    }
  }

  if (result.scanned > 0) {
    logger.info(
      `[TRASH] เก็บกวาดถังขยะ (เกิน ${days} วัน): ลบถาวร ${result.purged}, ข้าม ${result.skipped} (ถูกล็อกหรืออยู่ภายใต้นโยบายการเก็บรักษา), ล้มเหลว ${result.failed}`,
    );
  }
  return result;
}

/**
 * ตั้งเวลางานเก็บกวาด: ครั้งแรกหลังระบบพร้อม จากนั้นวันละครั้ง
 *
 * timer ถูก unref ไว้ เพื่อไม่ให้ค้างการปิดระบบตอน shutdown
 */
export function startTrashRetentionWorker(): { stop: () => void } {
  /**
   * งานถูกเปิดไว้เสมอ แล้วไปตัดสินที่แต่ละรอบว่าจะทำงานหรือไม่
   * ถ้าตัดสินใจตั้งแต่ตอน start ค่าที่แก้ภายหลังจะไม่มีผลจนกว่าจะรีสตาร์ท
   */
  const tick = (): void => {
    void runTrashRetention().catch((error) => {
      logger.error({ err: error }, '[TRASH] รอบเก็บกวาดถังขยะล้มเหลวทั้งรอบ');
    });
  };

  const first = setTimeout(tick, STARTUP_DELAY_MS);
  const daily = setInterval(tick, DAILY_MS);
  first.unref?.();
  daily.unref?.();

  logger.info('[TRASH] เปิดงานเก็บกวาดถังขยะ: อ่านจำนวนวันที่มีผลจริงในทุกรอบ');
  return {
    stop: () => {
      clearTimeout(first);
      clearInterval(daily);
    },
  };
}

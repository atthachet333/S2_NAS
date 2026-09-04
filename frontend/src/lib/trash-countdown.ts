/**
 * เวลาที่เหลือของรายการในถังขยะ
 *
 * ความจริงของนโยบายอยู่ที่ backend เสมอ: expiresAt คำนวณจาก deletedAt + retentionDays
 * ที่มีผลจริง ณ ตอนนั้น หน้าจอจึงห้ามมีเลข 14 หรือจำนวนวันใด ๆ ฝังไว้เอง
 * มิฉะนั้นวันที่ผู้ดูแลเปลี่ยนค่า ตัวนับจะโกหกผู้ใช้ทันที
 */

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/**
 * ระดับความเร่งด่วน
 *
 * ใช้คู่กับข้อความเสมอ ไม่ใช้สีเพียงอย่างเดียว - ผู้ใช้ที่แยกสีไม่ได้ต้องรู้เท่ากัน
 */
export type TrashUrgency = 'GREEN' | 'YELLOW' | 'RED';

export interface TrashCountdown {
  urgency: TrashUrgency;
  label: string;
  /** จำนวนวันที่เหลือแบบปัดขึ้น - null เมื่อเลยกำหนดแล้ว หรือไม่มีนโยบายลบอัตโนมัติ */
  remainingDays: number | null;
  expired: boolean;
}

/**
 * แปลงเวลาหมดอายุเป็นข้อความและระดับความเร่งด่วน
 *
 * expiresAt = null แปลว่าปิดการลบอัตโนมัติไว้ จึงไม่แสดงตัวนับถอยหลังที่ไม่มีวันเกิดขึ้นจริง
 */
export function trashCountdown(expiresAt: string | null, now: Date = new Date()): TrashCountdown | null {
  if (!expiresAt) return null;

  const remaining = new Date(expiresAt).getTime() - now.getTime();

  // เลยกำหนดแล้วแต่รอบเก็บกวาดยังไม่มาถึง - บอกตามจริง ไม่แสดงจำนวนวันติดลบ
  if (remaining <= 0) {
    return { urgency: 'RED', label: 'รอลบอัตโนมัติ', remainingDays: null, expired: true };
  }

  // เหลือไม่ถึงหนึ่งวัน - "เหลือ 0 วัน" อ่านแล้วเข้าใจผิดว่ายังมีเวลา
  if (remaining < DAY_MS) {
    return { urgency: 'RED', label: 'ลบอัตโนมัติวันนี้', remainingDays: 0, expired: false };
  }

  const days = Math.ceil(remaining / DAY_MS);
  return { urgency: urgencyForDays(days), label: `เหลือ ${days} วัน`, remainingDays: days, expired: false };
}

/**
 * เกณฑ์ความเร่งด่วน
 *
 * เขียว 8 วันขึ้นไป · เหลือง 3-7 วัน · แดง 2 วันหรือน้อยกว่า
 */
export function urgencyForDays(days: number): TrashUrgency {
  if (days >= 8) return 'GREEN';
  if (days >= 3) return 'YELLOW';
  return 'RED';
}

/** โทนสีของ Badge ที่มีอยู่แล้วในระบบ - ไม่สร้างชุดสีใหม่เฉพาะหน้านี้ */
export const URGENCY_TONE: Record<TrashUrgency, 'success' | 'warning' | 'danger'> = {
  GREEN: 'success',
  YELLOW: 'warning',
  RED: 'danger',
};

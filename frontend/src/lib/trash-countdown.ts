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
  /**
   * ถูกคุ้มครองไว้จนลบอัตโนมัติไม่ได้ (F16)
   *
   * หน้าจอใช้เลิกแสดงความเร่งด่วน - เอกสารที่ไม่มีวันถูกลบไม่ควรขึ้นป้ายสีแดง
   */
  protectedFromPurge?: boolean;
  /** จำนวนวันที่เหลือแบบปัดขึ้น - null เมื่อเลยกำหนดแล้ว หรือไม่มีนโยบายลบอัตโนมัติ */
  remainingDays: number | null;
  expired: boolean;
}

/**
 * แปลงเวลาหมดอายุเป็นข้อความและระดับความเร่งด่วน
 *
 * expiresAt = null แปลว่าปิดการลบอัตโนมัติไว้ จึงไม่แสดงตัวนับถอยหลังที่ไม่มีวันเกิดขึ้นจริง
 */
/**
 * สถานะการกำกับดูแลที่มีผลต่อการลบอัตโนมัติ (F16)
 *
 * เอกสารที่ถูกคุ้มครองจะไม่ถูกงานเก็บกวาดถังขยะลบ แม้จะพ้นอายุถังขยะแล้ว
 * การแสดง "เหลือ 3 วัน" กับเอกสารเหล่านี้จึงเป็นคำโกหกที่ทำให้ผู้ใช้ตกใจเปล่า ๆ
 * และอาจไปกู้คืนเอกสารที่ไม่ได้กำลังจะหายไปไหน
 */
export interface PurgeGuard {
  retentionUntil?: string | null;
  retentionForever?: boolean;
  onLegalHold?: boolean;
}

function thaiDate(value: string | Date): string {
  const date = typeof value === 'string' ? new Date(value) : value;
  return date.toLocaleDateString('th-TH', { year: 'numeric', month: 'long', day: 'numeric' });
}

export function trashCountdown(
  expiresAt: string | null,
  now: Date = new Date(),
  guard: PurgeGuard = {},
): TrashCountdown | null {
  /**
   * การคุ้มครองมาก่อนเวลาเสมอ
   *
   * ตรวจก่อน expiresAt เพราะเอกสารที่ถูกระงับการลบไม่มีกำหนดลบเลย
   * ไม่ว่าถังขยะจะบอกว่าอย่างไร
   */
  if (guard.onLegalHold) {
    return {
      urgency: 'GREEN',
      label: 'ระงับการลบ',
      remainingDays: null,
      expired: false,
      protectedFromPurge: true,
    };
  }
  if (guard.retentionForever) {
    return {
      urgency: 'GREEN',
      label: 'เก็บถาวรตามนโยบาย',
      remainingDays: null,
      expired: false,
      protectedFromPurge: true,
    };
  }
  if (guard.retentionUntil) {
    const until = new Date(guard.retentionUntil);
    if (until > now) {
      return {
        urgency: 'GREEN',
        label: `เก็บตามนโยบายถึง ${thaiDate(until)}`,
        remainingDays: null,
        expired: false,
        protectedFromPurge: true,
      };
    }
  }

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

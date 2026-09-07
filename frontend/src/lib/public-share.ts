import type { PublicShareStatus } from './api';

/**
 * ข้อความและสีของสถานะลิงก์แชร์ภายนอก (F18)
 *
 * แยกออกมาจากหน้าจอเพื่อให้แผงของผู้สร้างและหน้าของผู้ดูแลใช้ชุดเดียวกัน
 * ถ้าต่างคนต่างเขียน วันหนึ่งหน้าหนึ่งจะบอกว่า "หมดอายุ" อีกหน้าบอกว่า "ยกเลิกแล้ว"
 * สำหรับลิงก์เดียวกัน แล้วไม่มีใครรู้ว่าอันไหนจริง
 */

export interface ShareStatusStyle {
  label: string;
  className: string;
}

/**
 * สีใช้อย่างประหยัด และไม่เคยเป็นตัวบอกสถานะเพียงลำพัง
 *
 * ทุกป้ายมีข้อความกำกับเสมอ ผู้ที่แยกสีไม่ได้จึงอ่านสถานะออกเท่ากับทุกคน
 * สีตัวอักษรมาจากโทเคนของธีม ป้ายจึงอ่านออกทั้งในโหมดสว่างและมืด
 */
export const SHARE_STATUS: Record<PublicShareStatus, ShareStatusStyle> = {
  ACTIVE: {
    label: 'ใช้งานอยู่',
    className: 'border-emerald-200 bg-emerald-50 text-[var(--s2-success-ring)]',
  },
  EXPIRED: {
    label: 'หมดอายุ',
    className: 'border-line bg-[var(--s2-surface-soft)] text-navy-500',
  },
  REVOKED: {
    label: 'ยกเลิกแล้ว',
    className: 'border-line bg-[var(--s2-surface-soft)] text-navy-500',
  },
  LIMIT_REACHED: {
    label: 'ครบจำนวนใช้งาน',
    className: 'border-amber-200 bg-amber-50 text-[var(--s2-warning-ring)]',
  },
  RESOURCE_UNAVAILABLE: {
    label: 'เอกสารไม่พร้อมใช้งาน',
    className: 'border-amber-200 bg-amber-50 text-[var(--s2-warning-ring)]',
  },
};

/**
 * ข้อความบอกอายุของลิงก์
 *
 * "ไม่หมดอายุ" ต้องอ่านแล้วสะดุด ไม่ใช่กลมกลืนไปกับตัวเลือกอื่น
 * เพราะมันคือลิงก์ที่จะเปิดค้างไว้จนกว่าจะมีคนนึกขึ้นได้ว่าต้องปิด
 */
export function shareExpiryText(expiresAt: string | null, now: Date = new Date()): string {
  if (!expiresAt) return 'ไม่หมดอายุ';

  const target = new Date(expiresAt);
  if (target.getTime() <= now.getTime()) return 'หมดอายุแล้ว';

  /**
   * นับเป็น "วัน" ตามปฏิทิน ไม่ใช่ตามจำนวนชั่วโมงที่เหลือ
   *
   * ถ้าปัดเศษจากชั่วโมง ลิงก์ที่เหลืออีกสองชั่วโมงจะได้ข้อความว่า "พรุ่งนี้"
   * เพราะเศษของวันถูกปัดขึ้นเป็นหนึ่ง ซึ่งทำให้คนวางแผนผิด แล้วเปิดเอกสาร
   * ไม่ได้ในวันที่คิดว่ายังทัน
   */
  const startOfDay = (value: Date) =>
    new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  const days = Math.round((startOfDay(target) - startOfDay(now)) / 86_400_000);

  if (days < 0) return 'หมดอายุแล้ว';
  if (days === 0) return 'หมดอายุวันนี้';
  if (days === 1) return 'หมดอายุพรุ่งนี้';
  if (days <= 7) return `หมดอายุใน ${days} วัน`;

  return `หมดอายุ ${target.toLocaleDateString('th-TH', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })}`;
}

/** ลิงก์ที่ใกล้หมดอายุ - ผู้ดูแลใช้ตัดสินใจว่าจะต่ออายุหรือปล่อยให้จบ */
export function expiringSoon(expiresAt: string | null, now: Date = new Date()): boolean {
  if (!expiresAt) return false;
  const remaining = new Date(expiresAt).getTime() - now.getTime();
  return remaining > 0 && remaining <= 7 * 86_400_000;
}

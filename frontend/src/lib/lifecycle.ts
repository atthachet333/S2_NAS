/**
 * วงจรชีวิตเอกสารฝั่งหน้าจอ
 *
 * รวมป้ายภาษาไทยและการตัดสินใจว่าจะแสดงอะไร ไว้ที่เดียว
 *
 * หลักที่ยึด: **ไม่แสดงเวลานับถอยหลังที่ไม่มีวันเกิดขึ้นจริง**
 * เอกสารที่ถูกคุ้มครองไว้จะไม่ถูกลบตอนครบอายุถังขยะ การบอกว่า "เหลืออีก 3 วัน"
 * จึงเป็นคำโกหกที่ทำให้ผู้ใช้ตกใจและอาจไปกู้คืนเอกสารที่ไม่ได้กำลังจะหายไปไหน
 */

export type LifecycleState = 'ACTIVE' | 'ARCHIVED';

export const LIFECYCLE_LABELS: Record<string, string> = {
  ACTIVE: 'ใช้งานอยู่',
  ARCHIVED: 'เก็บเข้าคลัง',
};

export const RETENTION_STATUS_LABELS: Record<string, string> = {
  NONE: 'ไม่มีนโยบาย',
  ACTIVE: 'อยู่ในช่วงเก็บรักษา',
  EXPIRING: 'ใกล้ครบกำหนด',
  EXPIRED: 'หมดอายุการเก็บรักษา',
  FOREVER: 'เก็บถาวร',
};

/** สถานะการกำกับดูแลของเอกสารหนึ่งฉบับ เท่าที่หน้าจอรู้ */
export interface GovernanceInfo {
  retentionUntil?: string | null;
  retentionForever?: boolean;
  onLegalHold?: boolean;
}

export function thaiDate(value: string | Date): string {
  const date = typeof value === 'string' ? new Date(value) : value;
  return date.toLocaleDateString('th-TH', { year: 'numeric', month: 'long', day: 'numeric' });
}

/**
 * ป้ายสถานะการเก็บรักษา
 *
 * คืน null เมื่อไม่มีอะไรน่าบอก - ไม่เติมป้ายให้รกกับเอกสารที่ไม่มีนโยบาย
 * ซึ่งเป็นเอกสารส่วนใหญ่ในระบบ
 */
export function retentionBadge(
  info: GovernanceInfo,
  now: Date = new Date(),
): { label: string; tone: 'hold' | 'forever' | 'active' | 'expired' } | null {
  // การระงับการลบมาก่อนเสมอ - เป็นเหตุผลที่หนักที่สุด
  if (info.onLegalHold) return { label: 'ระงับการลบ', tone: 'hold' };
  if (info.retentionForever) return { label: 'เก็บถาวร', tone: 'forever' };
  if (!info.retentionUntil) return null;

  const until = new Date(info.retentionUntil);
  if (until <= now) return { label: 'หมดอายุการเก็บรักษา', tone: 'expired' };
  return { label: `เก็บถึง ${thaiDate(until)}`, tone: 'active' };
}

/** เหตุผลที่ลบถาวรไม่ได้ - ใช้อธิบายบนปุ่มที่กดไม่ได้ */
export function blockedDeleteReason(
  blockedBy: { kind: string; until?: string } | null,
): string | null {
  if (!blockedBy) return null;
  switch (blockedBy.kind) {
    case 'LEGAL_HOLD':
      return 'เอกสารนี้ถูกระงับการลบตาม Legal Hold';
    case 'RETAIN_FOREVER':
      return 'เอกสารนี้ถูกกำหนดให้เก็บรักษาโดยไม่มีกำหนด';
    case 'RETENTION_ACTIVE':
      return blockedBy.until
        ? `ลบถาวรไม่ได้จนถึง ${thaiDate(blockedBy.until)}`
        : 'เอกสารนี้ยังอยู่ภายใต้นโยบายการเก็บรักษา';
    default:
      return null;
  }
}

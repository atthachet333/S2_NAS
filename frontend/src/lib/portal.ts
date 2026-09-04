/**
 * กติกาฝั่งหน้าจอของพื้นที่เอกสารสำหรับลูกค้า
 *
 * ทั้งหมดนี้เป็นเรื่องของประสบการณ์ใช้งาน ไม่ใช่ความปลอดภัย
 * เซิร์ฟเวอร์เป็นผู้ตัดสินทุกครั้ง (requireInternal / requireExternal และการตรวจสิทธิ์รายทรัพยากร)
 * การซ่อนปุ่มหรือเปลี่ยนเส้นทางที่นี่มีไว้เพื่อไม่ให้ผู้ใช้เดินไปชนกำแพง ไม่ใช่เพื่อกั้นใคร
 */

export const PORTAL_HOME = '/portal';
export const INTERNAL_HOME = '/dashboard';

/** ชนิดบัญชีที่หน้าจอรู้จัก - ค่าที่ไม่รู้จักถือว่าเป็นภายในเสมอ ไม่ใช่ภายนอก */
export function isExternalAccount(user: { type?: string | null } | null | undefined): boolean {
  return user?.type === 'EXTERNAL';
}

export function isPortalPath(pathname: string): boolean {
  return pathname === PORTAL_HOME || pathname.startsWith(`${PORTAL_HOME}/`);
}

/**
 * หน้าแรกที่ผู้ใช้ควรไปถึงหลังเข้าสู่ระบบ
 *
 * ลูกค้าไปที่พื้นที่เอกสารเสมอ บุคลากรภายในไปที่หน้าทำงานภายในเสมอ
 * ค่า from ที่ติดมากับการถูกเด้งออกจากหน้าเดิมจะถูกใช้ก็ต่อเมื่ออยู่ฝั่งเดียวกับผู้ใช้เท่านั้น
 */
export function homePathFor(user: { type?: string | null } | null | undefined, from?: string | null): string {
  const external = isExternalAccount(user);
  if (!from) return external ? PORTAL_HOME : INTERNAL_HOME;
  if (external) return isPortalPath(from) ? from : PORTAL_HOME;
  return isPortalPath(from) ? INTERNAL_HOME : from;
}

/* ------------------------------------------------------------------ */
/* วันหมดอายุของการแชร์                                                */
/* ------------------------------------------------------------------ */

export type ExpiryPreset = 'NEVER' | 'DAYS_7' | 'DAYS_30' | 'DAYS_90' | 'CUSTOM';

export const EXPIRY_OPTIONS: Array<{ value: ExpiryPreset; label: string }> = [
  { value: 'NEVER', label: 'ไม่หมดอายุ' },
  { value: 'DAYS_7', label: '7 วัน' },
  { value: 'DAYS_30', label: '30 วัน' },
  { value: 'DAYS_90', label: '90 วัน' },
  { value: 'CUSTOM', label: 'กำหนดเอง' },
];

const PRESET_DAYS: Partial<Record<ExpiryPreset, number>> = {
  DAYS_7: 7,
  DAYS_30: 30,
  DAYS_90: 90,
};

/**
 * แปลงตัวเลือกเป็นเวลาสัมบูรณ์ที่จะส่งให้เซิร์ฟเวอร์
 *
 * เซิร์ฟเวอร์เก็บ "วันที่หมดอายุ" ไม่ใช่ "จำนวนวัน" เพราะจุดอ้างอิงของจำนวนวัน
 * จะกำกวมทันทีที่มีการแก้ไขสิทธิ์ในภายหลัง (นับจากวันไหน วันที่ให้ครั้งแรกหรือวันที่แก้)
 *
 * คืน null เมื่อเลือก "ไม่หมดอายุ" และคืน undefined เมื่อยังเลือกวันที่เองไม่ครบ
 * ซึ่งต่างกัน: null คือคำตอบที่สมบูรณ์ ส่วน undefined คือยังตอบไม่ได้
 */
export function expiryToIso(
  preset: ExpiryPreset,
  customDate?: string,
  now: Date = new Date(),
): string | null | undefined {
  if (preset === 'NEVER') return null;

  if (preset === 'CUSTOM') {
    if (!customDate) return undefined;
    // input[type=date] ให้ค่ารูปแบบ YYYY-MM-DD - ถือว่าหมดอายุตอนสิ้นสุดของวันนั้นตามเวลาเครื่องผู้ใช้
    const parsed = new Date(`${customDate}T23:59:59`);
    if (Number.isNaN(parsed.getTime())) return undefined;
    return parsed.toISOString();
  }

  const days = PRESET_DAYS[preset];
  if (days === undefined) return undefined;
  return new Date(now.getTime() + days * 24 * 60 * 60 * 1000).toISOString();
}

/** ข้อความบอกสถานะอายุของสิทธิ์ - ต้องอ่านแล้วรู้ทันทีว่ายังใช้ได้อยู่หรือไม่ */
export function expiryLabel(expiresAt: string | null | undefined, now: Date = new Date()): string {
  if (!expiresAt) return 'ไม่หมดอายุ';

  const target = new Date(expiresAt);
  if (Number.isNaN(target.getTime())) return 'ไม่หมดอายุ';

  const remaining = target.getTime() - now.getTime();
  if (remaining <= 0) return 'หมดอายุแล้ว';

  const days = Math.ceil(remaining / (24 * 60 * 60 * 1000));
  // "หมดอายุใน 0 วัน" อ่านแล้วเข้าใจผิดว่ายังมีเวลาเหลือ
  if (days <= 1) return 'หมดอายุวันนี้';
  return `หมดอายุใน ${days} วัน`;
}

export function isExpired(expiresAt: string | null | undefined, now: Date = new Date()): boolean {
  if (!expiresAt) return false;
  const target = new Date(expiresAt);
  if (Number.isNaN(target.getTime())) return false;
  return target.getTime() <= now.getTime();
}

/* ------------------------------------------------------------------ */
/* ป้ายกำกับ                                                          */
/* ------------------------------------------------------------------ */

/** ป้ายกำกับชนิดบัญชีในหน้าจัดการและหน้าแชร์ - ตัวตนต้องไม่กำกวม */
export function accountTypeLabel(type: string | null | undefined): string | null {
  if (type === 'EXTERNAL') return 'ภายนอก';
  return null;
}

export const SHARE_GROUP_LABEL = {
  INTERNAL: 'บุคลากรภายใน',
  EXTERNAL: 'ลูกค้า / ผู้ใช้งานภายนอก',
} as const;

/** ระดับสิทธิ์ที่มอบให้ลูกค้าได้ พร้อมคำอธิบายที่บอกผลลัพธ์จริง ไม่ใช่ชื่อทางเทคนิค */
export const PORTAL_LEVELS = [
  { value: 'VIEWER', label: 'ดูอย่างเดียว', hint: 'เปิดดูเอกสารได้ แต่เพิ่มหรือแก้ไขไม่ได้' },
  { value: 'EDITOR', label: 'อัปโหลดได้', hint: 'เปิดดูได้ และส่งไฟล์เข้าโฟลเดอร์นี้ได้' },
] as const;

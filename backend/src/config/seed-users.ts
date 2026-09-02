/**
 * รายชื่อผู้ใช้งานเริ่มต้นสำหรับ seed / import (ใช้งานจริงใน Phase 2)
 *
 * ข้อกำหนด
 * - normalize อีเมลเป็นตัวพิมพ์เล็กก่อนบันทึกเสมอ
 * - ห้าม hardcode รหัสผ่านในซอร์สโค้ด รหัสผ่านมาจาก environment เท่านั้น
 * - ผู้ใช้ทุกคนต้องตั้ง mustChangePassword = true ในการ seed ครั้งแรก
 */
export type SeedRole =
  | 'SUPER_ADMIN'
  | 'ADMIN'
  | 'MANAGER'
  | 'MEMBER'
  | 'VIEWER';

export interface SeedUser {
  email: string;
  role: SeedRole;
  note?: string;
}

/** อีเมลที่ยืนยันรูปแบบแล้ว พร้อม seed ได้ */
const RAW_SEED_USERS: SeedUser[] = [
  { email: 's2a.admincorporate@gmail.com', role: 'SUPER_ADMIN' },
  { email: 's2a.manage@gmail.com', role: 'ADMIN' },
  { email: 's2a.backupdata@gmail.com', role: 'ADMIN', note: 'ดูแลงาน backup' },
  { email: 's2a.consulstant@gmail.com', role: 'MEMBER' },
  { email: 's2a.customer@gmail.com', role: 'VIEWER' },
  { email: 'atthachetthongchat333@gmail.com', role: 'MEMBER' },
  { email: 'neww.pwin@gmail.com', role: 'MEMBER' },
];

export const SEED_USERS: SeedUser[] = RAW_SEED_USERS.map((user) => ({
  ...user,
  email: normalizeEmail(user.email),
}));

/**
 * อีเมลที่ยังไม่ยืนยันรูปแบบ - ห้าม seed จนกว่าจะได้รับการยืนยันจากผู้ใช้
 * ค่าที่ได้รับมาคือ "@wpueng@gmail.com" ซึ่งมี @ นำหน้าและไม่ผ่านการตรวจรูปแบบ
 */
export const UNCONFIRMED_SEED_EMAILS: string[] = ['@wpueng@gmail.com'];

/** ตัดช่องว่างและแปลงเป็นตัวพิมพ์เล็ก */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidEmail(email: string): boolean {
  return EMAIL_PATTERN.test(normalizeEmail(email));
}

/**
 * คืนเฉพาะรายการที่พร้อม seed จริง
 * กรองอีเมลผิดรูปแบบและรายการซ้ำออก
 */
export function getSeedableUsers(users: SeedUser[] = SEED_USERS): SeedUser[] {
  const seen = new Set<string>();
  const result: SeedUser[] = [];

  for (const user of users) {
    const email = normalizeEmail(user.email);
    if (!isValidEmail(email)) continue;
    if (seen.has(email)) continue;
    seen.add(email);
    result.push({ ...user, email });
  }

  return result;
}

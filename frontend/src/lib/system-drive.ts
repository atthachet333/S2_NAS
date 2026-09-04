import type { AuthUser } from './api';

/**
 * นโยบายไดร์ฟของระบบฝั่งหน้าจอ
 *
 * ใช้เพื่อ "ไม่แสดงปุ่มที่กดแล้วจะโดนปฏิเสธ" เท่านั้น ไม่ใช่ด่านความปลอดภัย
 * ด่านจริงอยู่ที่ backend (backend/src/modules/resources/system-drive.ts) เสมอ
 * ถ้าสองที่ไม่ตรงกัน ให้ยึด backend เป็นความจริง
 */

/** สิทธิ์เฉพาะที่อนุญาตให้สร้าง/อัปโหลดในไดร์ฟของระบบได้โดยไม่ต้องเป็นผู้ดูแลระบบ */
export const SYSTEM_DRIVE_CREATE_PERMISSION = 'system-drive:write';

export function isAdminUser(user: Pick<AuthUser, 'roles'> | null | undefined): boolean {
  return Boolean(user?.roles.includes('SUPER_ADMIN') || user?.roles.includes('ADMIN'));
}

/** ผู้ใช้ภายในที่อ่านทรัพยากรได้ ย่อมเห็นไดร์ฟของระบบ */
export function canViewSystemDrive(user: Pick<AuthUser, 'permissions'> | null | undefined): boolean {
  return Boolean(user?.permissions.includes('resources:read'));
}

/** สร้าง/อัปโหลดในไดร์ฟของระบบ: ผู้ดูแลระบบ หรือผู้ที่ได้รับสิทธิ์เฉพาะเท่านั้น */
export function canCreateInSystemDrive(
  user: Pick<AuthUser, 'roles' | 'permissions'> | null | undefined,
): boolean {
  return isAdminUser(user) || Boolean(user?.permissions.includes(SYSTEM_DRIVE_CREATE_PERMISSION));
}

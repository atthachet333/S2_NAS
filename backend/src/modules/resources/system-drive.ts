import type { DriveScope } from '@prisma/client';
import { AppError } from '../../core/errors.js';
import type { AuthUser } from '../auth/auth.service.js';
import { isExternalUser } from '../portal/portal-policy.js';

/**
 * นโยบายไดร์ฟของระบบ (ไดร์ฟกลางขององค์กร)
 *
 * อ่านได้ทั้งองค์กร แต่ "เขียนไม่ได้โดยปริยาย"
 *
 * ไดร์ฟของฉันใช้หลักว่าทรัพยากรที่เปิดให้ทั้งองค์กรเห็น (ORGANIZATION) ก็แก้ไขได้
 * ถ้ายกหลักนั้นมาใช้กับไดร์ฟของระบบ พนักงานทุกคนจะแก้คู่มือบริษัทและแบบฟอร์มกลางได้ทันที
 * ไดร์ฟของระบบจึงต้องตัดเส้นทาง "เห็น = แก้ได้" ทิ้ง แล้วเหลือเฉพาะ
 * ผู้ดูแลระบบ หรือผู้ที่ได้รับสิทธิ์ OWNER/EDITOR บนทรัพยากรนั้นโดยตรงเท่านั้น
 */

export function isAdminUser(user: AuthUser): boolean {
  return user.roles.includes('SUPER_ADMIN') || user.roles.includes('ADMIN');
}

/** สิทธิ์เฉพาะที่อนุญาตให้สร้าง/อัปโหลดในไดร์ฟของระบบได้โดยไม่ต้องเป็นผู้ดูแลระบบ */
export const SYSTEM_DRIVE_CREATE_PERMISSION = 'system-drive:write';

/**
 * ผู้ใช้ภายในที่ ACTIVE ทุกคนเห็นไดร์ฟของระบบได้
 *
 * บัญชีลูกค้า (UserType.EXTERNAL) ไม่ได้รับสิทธิ์นี้ไม่ว่าจะถือบทบาทใด - ดู docs/SYSTEM_DRIVE.md
 * ลูกค้าเห็นได้เฉพาะโฟลเดอร์ในไดร์ฟของระบบที่ถูกแชร์ให้โดยตรง และเห็นผ่าน /portal เท่านั้น
 * ไม่เคยเห็นตัวไดร์ฟหรือรายการระดับรากของมันเลย
 */
export function canViewSystemDrive(user: AuthUser): boolean {
  if (isExternalUser(user)) return false;
  return user.permissions.includes('resources:read');
}

/** สร้าง/อัปโหลดที่ระดับรากของไดร์ฟของระบบ */
export function canCreateInSystemDrive(user: AuthUser): boolean {
  return isAdminUser(user) || user.permissions.includes(SYSTEM_DRIVE_CREATE_PERMISSION);
}

export function assertCanCreateInSystemDrive(user: AuthUser): void {
  if (!canCreateInSystemDrive(user)) {
    throw new AppError(
      'SYSTEM_DRIVE_WRITE_DENIED',
      'ไม่มีสิทธิ์เพิ่มทรัพยากรในไดร์ฟของระบบ',
      403,
    );
  }
}

/**
 * การย้ายข้ามไดร์ฟเป็นการเปลี่ยนขอบเขตการเข้าถึงขององค์กร ไม่ใช่การจัดระเบียบไฟล์
 * จึงสงวนไว้ให้ผู้ดูแลระบบ และต้องบันทึก audit ทุกครั้ง
 */
export function assertCanMoveAcrossDrives(user: AuthUser, from: DriveScope, to: DriveScope): void {
  if (from === to) return;
  if (!isAdminUser(user)) {
    throw new AppError(
      'CROSS_DRIVE_MOVE_DENIED',
      'การย้ายทรัพยากรข้ามไดร์ฟสงวนไว้สำหรับผู้ดูแลระบบ',
      403,
    );
  }
}

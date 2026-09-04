import type { AuthUser } from './api';
import type { DriveRoot } from './drive-labels';
import { isAdminUser } from './system-drive';

/**
 * กติกาของตัวเลือกโฟลเดอร์ปลายทาง
 *
 * ตัวเลือกนี้เป็นแค่การนำทาง ไม่ใช่ด่านสิทธิ์ - backend เป็นผู้ตัดสินสุดท้ายเสมอ
 * ที่นี่เพียงไม่เสนอปลายทางที่รู้อยู่แล้วว่าจะถูกปฏิเสธ เพื่อไม่ให้ผู้ใช้เดินไปชนกำแพง
 */

export const DRIVE_ROOTS: DriveRoot[] = ['MY_DRIVE', 'SYSTEM_DRIVE'];

/**
 * ไดร์ฟที่เลือกเป็นปลายทางได้
 *
 * ย้ายภายในไดร์ฟเดิมทำได้เสมอถ้ามีสิทธิ์แก้ไขทรัพยากรนั้น
 * แต่การย้ายข้ามไดร์ฟเปลี่ยนขอบเขตการเข้าถึงขององค์กร backend จึงสงวนไว้ให้ผู้ดูแลระบบ
 * (assertCanMoveAcrossDrives → CROSS_DRIVE_MOVE_DENIED) หน้าจอต้องสะท้อนกติกาเดียวกัน
 */
export function canSelectDriveRoot(
  user: Pick<AuthUser, 'roles' | 'permissions'> | null | undefined,
  currentDriveRoot: DriveRoot,
  target: DriveRoot,
): boolean {
  if (target === currentDriveRoot) return true;
  return isAdminUser(user);
}

export function selectableDriveRoots(
  user: Pick<AuthUser, 'roles' | 'permissions'> | null | undefined,
  currentDriveRoot: DriveRoot,
): DriveRoot[] {
  return DRIVE_ROOTS.filter((root) => canSelectDriveRoot(user, currentDriveRoot, root));
}

/**
 * ปลายทางที่เลือกอยู่คือตำแหน่งเดิมหรือไม่
 *
 * ต้องเทียบทั้งโฟลเดอร์แม่และไดร์ฟ เพราะรากของสองไดร์ฟใช้ parentId = null เหมือนกัน
 * ถ้าเทียบแค่ parentId การย้ายจากรากไดร์ฟหนึ่งไปรากอีกไดร์ฟจะถูกมองว่า "ไม่ได้ย้าย" อย่างผิด ๆ
 */
export function isSameLocation(
  current: { driveRoot: DriveRoot; parentId: string | null },
  selected: { driveRoot: DriveRoot; parentId: string | null },
): boolean {
  return current.driveRoot === selected.driveRoot && (current.parentId ?? null) === (selected.parentId ?? null);
}

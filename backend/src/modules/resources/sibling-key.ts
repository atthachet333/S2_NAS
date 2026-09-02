import type { DriveScope } from '@prisma/client';

/**
 * คีย์กันชื่อซ้ำในระดับเดียวกัน
 *
 * รายการที่มีโฟลเดอร์แม่ใช้ id ของแม่เป็นขอบเขตอยู่แล้ว จึงไม่ต้องพึ่งไดร์ฟ
 * แต่รายการระดับรากต้องผูกไดร์ฟเข้าไปด้วย มิฉะนั้นโฟลเดอร์ชื่อเดียวกัน
 * ที่รากของ "ไดร์ฟของฉัน" และ "ไดร์ฟของระบบ" จะชนกันบน unique constraint เดียวกัน
 */
export function siblingKey(
  parentId: string | null,
  normalizedName: string,
  driveScope: DriveScope = 'MY_DRIVE',
): string {
  return parentId ? `${parentId}:${normalizedName}` : `${driveScope}:ROOT:${normalizedName}`;
}

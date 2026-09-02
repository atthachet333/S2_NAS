/**
 * ป้ายชื่อไดร์ฟที่ผู้ใช้เห็น - รวมไว้ที่เดียวเพื่อไม่ให้ชื่อเพี้ยนกันระหว่างหน้า
 *
 * "ไดร์ฟของฉัน" ไม่ได้แปลว่าเป็นทรัพย์สินส่วนตัว แต่หมายถึงพื้นที่ที่ผู้ใช้คนนี้
 * รับผิดชอบหรือทำงานด้วยตามนโยบายการเข้าถึงของ S2 NAS - ข้อมูลเป็นของบริษัท
 */
export type DriveRoot = 'MY_DRIVE' | 'SYSTEM_DRIVE';

export const MY_DRIVE_LABEL = 'ไดร์ฟของฉัน';
export const SYSTEM_DRIVE_LABEL = 'ไดร์ฟของระบบ';

export const DRIVE_ROOT_LABEL: Record<DriveRoot, string> = {
  MY_DRIVE: MY_DRIVE_LABEL,
  SYSTEM_DRIVE: SYSTEM_DRIVE_LABEL,
};

export const DRIVE_ROOT_PATH: Record<DriveRoot, string> = {
  MY_DRIVE: '/files',
  SYSTEM_DRIVE: '/system-drive',
};

export function driveRootLabel(root: DriveRoot | null | undefined): string {
  return DRIVE_ROOT_LABEL[root ?? 'MY_DRIVE'];
}

/** ปลายทางเชิงตรรกะที่ผู้ใช้อ่านเข้าใจ เช่น "ไดร์ฟของระบบ / คู่มือบริษัท" */
export function driveDestination(root: DriveRoot | null | undefined, segments: string[] = []): string {
  return [driveRootLabel(root), ...segments.filter(Boolean)].join(' / ');
}

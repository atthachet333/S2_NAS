import type { DriveEntry } from './drive';
import { driveDestination } from './drive-labels';
import { sourceLabel } from './resource-sources';

/**
 * ความหมายของคอลัมน์ในตารางทรัพยากรมาตรฐาน
 *
 * แยกออกมาจากคอมโพเนนต์เพราะเป็นข้อตกลงเชิงความหมาย ไม่ใช่เรื่องการจัดวาง
 * และต้องอ่านตรงกันทุกหน้าที่ใช้ตารางนี้
 */

/** คอลัมน์มาตรฐานตามลำดับที่ตกลงไว้ (คอลัมน์ "ชื่อไฟล์" ถูกวางไว้ก่อนเสมอโดยตัวตาราง) */
export const STANDARD_COLUMN_LABEL = {
  uploader: 'ผู้อัปโหลด',
  responsible: 'ผู้ดูแล',
  source: 'ต้นทาง',
  destination: 'ปลายทาง',
  uploadedAt: 'วันที่อัปโหลด',
  modified: 'แก้ไขล่าสุด',
  size: 'ขนาด',
} as const;

/**
 * ผู้อัปโหลด
 *
 * ไฟล์ที่คนอัปโหลดเอง  → ผู้อัปโหลดตามประวัติ (createdBy) ไม่ใช่ผู้ดูแลปัจจุบัน
 * ทรัพยากรที่ระบบเชื่อมต่อสร้าง → ชื่อแอปที่เป็นผู้ลงมือจริง เพื่อไม่ให้ดูเหมือนคนทำ
 *
 * ผู้อัปโหลดเป็นข้อเท็จจริงย้อนหลัง จึงไม่เปลี่ยนตามการโอนผู้ดูแลภายหลัง
 */
export function uploaderLabel(entry: DriveEntry): string {
  if (entry.createdByIntegrationApp) return entry.createdByIntegrationApp.name;
  return entry.uploadedBy?.displayName ?? '—';
}

/**
 * ผู้ดูแล
 *
 * คือผู้รับผิดชอบพื้นที่/ทรัพยากรนั้น (ownerId) ไม่ได้แปลว่าเป็นทรัพย์สินส่วนตัว
 * กรรมสิทธิ์ของข้อมูลยังเป็นของบริษัทเสมอ
 */
export function responsibleLabel(entry: DriveEntry): string {
  return entry.ownerName || '—';
}

/**
 * สถานะของช่อง "เลือกทั้งหมด"
 *
 * "ทั้งหมด" หมายถึงรายการที่โหลดมาแล้วและผู้ใช้เห็นอยู่ตรงหน้าเท่านั้น
 * ไม่ลามไปหน้าถัดไปหรือผลลัพธ์ที่ยังไม่ได้ดึงมา - การเลือกสิ่งที่มองไม่เห็น
 * แล้วกดลบทีเดียวคือความเสียหายที่ผู้ใช้ย้อนกลับไม่ได้
 */
export type SelectAllState = 'unchecked' | 'checked' | 'indeterminate';

export function selectAllState(loadedIds: string[], selectedIds: Set<string>): SelectAllState {
  if (loadedIds.length === 0) return 'unchecked';
  const selectedOnPage = loadedIds.filter((id) => selectedIds.has(id)).length;
  if (selectedOnPage === 0) return 'unchecked';
  return selectedOnPage === loadedIds.length ? 'checked' : 'indeterminate';
}

/** กดช่อง "เลือกทั้งหมด" แล้วได้อะไร - เลือกครบอยู่แล้วจึงล้าง นอกนั้นเลือกให้ครบ */
export function nextSelection(loadedIds: string[], selectedIds: Set<string>): Set<string> {
  return selectAllState(loadedIds, selectedIds) === 'checked' ? new Set() : new Set(loadedIds);
}

/** ต้นทาง: ระบบที่ทรัพยากรนี้เข้ามาจริง */
export function originLabel(entry: DriveEntry): string {
  return sourceLabel(entry.source);
}

/**
 * ปลายทาง: เส้นทางเชิงตรรกะใน S2 NAS เท่านั้น
 *
 * ห้ามแสดง path จริงบนดิสก์หรือ storageKey เด็ดขาด - ผู้ใช้ไม่ควรรู้ และไม่ควรพึ่งพา
 * ถ้าไม่รู้เส้นทางย่อยจริง ๆ จะแสดงแค่ระดับไดร์ฟ ซึ่งยังเป็นความจริงเสมอ
 */
export function destinationLabel(entry: DriveEntry, segments: string[] = []): string {
  return driveDestination(entry.driveRoot, segments);
}

import type { DriveEntry } from './drive';
import { isExternalEntry } from './external-resources';
import { formatBytes, formatRelativeTime } from './utils';

/**
 * ข้อมูลประกอบของรายการหนึ่งบรรทัดบนมือถือ (F24-C)
 *
 * **ทำไมต้องยุบเหลือบรรทัดเดียว:** ตารางเดสก์ท็อปมีเจ็ดคอลัมน์ ถ้ายกมาทั้งหมด
 * แต่ละรายการจะสูงสามถึงสี่บรรทัด ทำให้จอโทรศัพท์เห็นได้ทีละสามไฟล์
 * การหาไฟล์ด้วยการกวาดสายตาจึงกลายเป็นการเลื่อนจอไปเรื่อย ๆ แทน
 *
 * **เลือกเก็บอะไรไว้:** ขนาดกับเวลาที่แก้ล่าสุด เป็นสองอย่างที่ใช้แยกไฟล์ที่ชื่อคล้ายกัน
 * ได้จริง ส่วนผู้ดูแล ผู้อัปโหลด และแหล่งที่มา ดูได้จากแผงรายละเอียดเมื่อผู้ใช้ต้องการ
 */
export function mobileMetaLine(entry: DriveEntry): string {
  const parts: string[] = [];

  if (entry.kind === 'folder') {
    // จำนวนรายการคือสิ่งที่บอกได้จริงเกี่ยวกับโฟลเดอร์ ขนาดรวมของโฟลเดอร์ไม่มีค่าที่เชื่อถือได้
    parts.push(typeof entry.itemCount === 'number' ? `${entry.itemCount} รายการ` : 'โฟลเดอร์');
  } else if (isExternalEntry(entry)) {
    parts.push('ลิงก์ภายนอก');
  } else if (typeof entry.sizeBytes === 'number') {
    parts.push(formatBytes(entry.sizeBytes));
  }

  const modified = formatRelativeTime(entry.modifiedAt);
  if (modified && modified !== '-') parts.push(modified);

  return parts.join(' · ');
}

/**
 * ชื่อไฟล์นี้ยาวจนน่าจะถูกตัดบนจอแคบหรือไม่
 *
 * ใช้ตัดสินว่าควรเปิดทางให้ผู้ใช้ดูชื่อเต็มหรือไม่ ไม่ได้ใช้กำหนดการแสดงผลโดยตรง
 * เกณฑ์มาจากจำนวนอักขระที่พอดีสองบรรทัดบนจอ 375px ด้วยขนาดตัวอักษรที่ใช้จริง
 */
export function isLikelyTruncated(name: string, charsPerLine = 30, lines = 2): boolean {
  return name.length > charsPerLine * lines;
}

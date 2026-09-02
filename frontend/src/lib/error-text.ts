/**
 * ข้อความภาษาไทยของรหัสข้อผิดพลาดจาก backend
 *
 * แยกเป็นโมดูลอิสระที่ไม่พึ่งพาโมดูลอื่น เพื่อให้ทดสอบได้ตรง ๆ
 * และให้ทุกส่วนของ UI แปลรหัสเดียวกันเป็นข้อความเดียวกันเสมอ
 */
export const UPLOAD_ERROR_TEXT: Record<string, string> = {
  FILE_TOO_LARGE: 'ไฟล์มีขนาดใหญ่เกินกว่าที่ระบบอนุญาต',
  FILE_EMPTY: 'ไฟล์ว่างเปล่า ไม่สามารถอัปโหลดได้',
  FILE_UPLOAD_FAILED: 'อัปโหลดไฟล์ไม่สำเร็จ',
  FILE_TYPE_REJECTED: 'ระบบไม่รับไฟล์ประเภทนี้',
  FILE_NAME_EXISTS: 'มีไฟล์ชื่อนี้อยู่แล้ว',
  FILE_MISSING: 'ไม่พบไฟล์ที่อัปโหลด',
  DUPLICATE_CONTENT: 'พบไฟล์ที่มีเนื้อหาเหมือนกันในระบบแล้ว',
  INVALID_RESOURCE_NAME: 'ชื่อไฟล์ไม่ถูกต้อง',
  RESOURCE_ACCESS_DENIED: 'คุณไม่มีสิทธิ์อัปโหลดไฟล์ในตำแหน่งนี้',
  RESOURCE_LOCKED: 'ทรัพยากรนี้ถูกล็อกไว้',
  FOLDER_NOT_FOUND: 'ไม่พบโฟลเดอร์ปลายทาง',
  RESOURCE_NOT_FOUND: 'ไม่พบไฟล์ที่ต้องการดาวน์โหลด',
  RESOURCE_NOT_TRASHED: 'ต้องย้ายไปถังขยะก่อน',
  VERSION_CONFLICT: 'สร้างเวอร์ชันใหม่ไม่สำเร็จ กรุณาลองใหม่',
  VERSION_NOT_FOUND: 'ไม่พบเวอร์ชันที่ระบุ',
  PREVIEW_NOT_SUPPORTED: 'ไม่รองรับการแสดงตัวอย่างไฟล์ประเภทนี้',
  DOWNLOAD_DENIED: 'คุณไม่มีสิทธิ์ดาวน์โหลดไฟล์นี้',
  ZIP_TOO_LARGE: 'รายการที่เลือกมีขนาดใหญ่เกินกว่าจะดาวน์โหลดเป็น ZIP ได้',
  TRASH_RESTORE_CONFLICT: 'กู้คืนไม่สำเร็จเนื่องจากมีรายการชื่อเดียวกันอยู่แล้ว',
  PERMANENT_DELETE_FAILED: 'ลบถาวรไม่สำเร็จ ระบบจึงยังไม่ลบข้อมูล',
  UPLOAD_CANCELLED: 'ยกเลิกการอัปโหลดแล้ว',
  NETWORK_ERROR: 'เชื่อมต่อเซิร์ฟเวอร์ไม่ได้',
};

export function uploadErrorText(code: string, fallback?: string): string {
  return UPLOAD_ERROR_TEXT[code] ?? fallback ?? 'ดำเนินการไม่สำเร็จ';
}

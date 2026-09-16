/**
 * การตัดสินใจเรื่องการอัปเดตแอป (F24-B)
 *
 * **ทำไมแยกออกจาก hook:** การเปลี่ยนไปใช้เวอร์ชันใหม่คือการโหลดหน้าใหม่ทั้งหน้า
 * ถ้าทำผิดจังหวะ ไฟล์ที่ผู้ใช้กำลังอัปโหลดอยู่จะหายไปกลางคัน กฎที่ตัดสินว่า
 * "ตอนนี้ปลอดภัยหรือยัง" จึงต้องทดสอบได้โดยไม่ต้องมี service worker จริง
 */

export type UpdateBlockReason = 'UPLOAD_ACTIVE';

export interface UpdateReadiness {
  /** สั่งให้เปลี่ยนไปใช้เวอร์ชันใหม่ได้ทันทีหรือไม่ */
  canActivate: boolean;
  /** เหตุผลที่ยังทำไม่ได้ - มีค่าเมื่อ canActivate เป็นเท็จเท่านั้น */
  reason?: UpdateBlockReason;
  /** ข้อความที่แสดงให้ผู้ใช้เห็น */
  message: string;
}

export const UPDATE_AVAILABLE_TEXT = 'มีเวอร์ชันใหม่พร้อมใช้งาน';
export const UPDATE_ACTION_TEXT = 'อัปเดตตอนนี้';
const UPLOAD_BLOCKED_TEXT = 'กำลังอัปโหลดอยู่ ระบบจะอัปเดตให้เมื่ออัปโหลดเสร็จ';

/**
 * ประเมินว่าเปลี่ยนเวอร์ชันได้หรือยัง
 *
 * การอัปโหลดที่ทำอยู่เป็นเหตุผลเดียวที่เลื่อนออกไป เพราะเป็นงานเดียวที่ผู้ใช้
 * เสียของจริงถ้าหน้าโหลดใหม่ การพิมพ์หรือการดูเอกสารเริ่มใหม่ได้ แต่ไฟล์ที่ส่งไปครึ่งทางไม่ได้
 */
export function evaluateUpdateReadiness(activeUploads: number): UpdateReadiness {
  if (activeUploads > 0) {
    return { canActivate: false, reason: 'UPLOAD_ACTIVE', message: UPLOAD_BLOCKED_TEXT };
  }
  return { canActivate: true, message: UPDATE_AVAILABLE_TEXT };
}

/**
 * ควรเปลี่ยนเวอร์ชันให้อัตโนมัติเมื่อสิ่งที่ขวางอยู่หมดไปหรือไม่
 *
 * ใช้กับกรณีที่ผู้ใช้กด "อัปเดตตอนนี้" ไปแล้วระหว่างที่ยังอัปโหลดอยู่ ระบบจำเจตนานั้นไว้
 * แล้วทำให้เมื่อปลอดภัย ผู้ใช้จึงไม่ต้องกลับมากดซ้ำ
 */
export function shouldActivateNow(options: {
  updateAvailable: boolean;
  userRequested: boolean;
  activeUploads: number;
}): boolean {
  if (!options.updateAvailable || !options.userRequested) return false;
  return evaluateUpdateReadiness(options.activeUploads).canActivate;
}

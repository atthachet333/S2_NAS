/**
 * การตัดสินใจกับพารามิเตอร์ `focus` ในหน้าไฟล์
 *
 * หน้าอื่น (ผลการค้นหา บันทึกกิจกรรม การแจ้งเตือน) พาผู้ใช้มาที่โฟลเดอร์พร้อมบอกว่า
 * ให้เลือกทรัพยากรชิ้นไหน เมื่อเลือกแล้วต้องลบพารามิเตอร์ทิ้ง ไม่งั้นการรีเฟรช
 * จะเด้งกลับมาเลือกซ้ำทุกครั้ง
 *
 * **ปัญหาที่ต้องกัน:** การลบพารามิเตอร์ทำผ่าน navigation แบบ replace ซึ่งไม่ได้เอา
 * `focus` ออกจาก render ปัจจุบันทันที effect เดิมจึงทำงานซ้ำด้วยค่าเดิม แล้วสั่ง
 * setState อีกรอบ - เกิดเป็นวงวนที่แผงรายละเอียดกระพริบและปิดเองไม่ได้
 *
 * ทางแก้คือจำไว้ว่า id ไหนถูกจัดการไปแล้ว การตัดสินใจจึงแยกออกมาเป็นฟังก์ชันบริสุทธิ์
 * ที่ทดสอบได้ แทนที่จะซ่อนอยู่ในเงื่อนไขซ้อนกันภายใน effect
 */

export type FocusDecision =
  /** ไม่มีพารามิเตอร์ - ล้างความจำ เพื่อให้ id เดิมถูกใช้ได้อีกถ้ากลับมาใหม่ */
  | 'IDLE'
  /** id นี้จัดการไปแล้วในรอบก่อน - ห้ามทำซ้ำ นี่คือด่านที่กันวงวน */
  | 'ALREADY_HANDLED'
  /** รายการยังโหลดไม่เสร็จ - รอรอบถัดไป ไม่ใช่ความผิดพลาด */
  | 'WAITING_FOR_ENTRIES'
  /** โหลดเสร็จแล้วแต่ไม่มีทรัพยากรนี้ในโฟลเดอร์ - อาจถูกย้ายหรือลบไปแล้ว */
  | 'NOT_PRESENT'
  /** เลือกและเปิดแผงรายละเอียด แล้วลบพารามิเตอร์ทิ้ง */
  | 'HANDLE';

export function focusDecision(input: {
  focusId: string | null;
  handledId: string | null;
  entryIds: readonly string[];
}): FocusDecision {
  if (!input.focusId) return 'IDLE';
  if (input.handledId === input.focusId) return 'ALREADY_HANDLED';
  if (input.entryIds.length === 0) return 'WAITING_FOR_ENTRIES';
  return input.entryIds.includes(input.focusId) ? 'HANDLE' : 'NOT_PRESENT';
}

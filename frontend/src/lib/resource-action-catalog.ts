/**
 * ชื่อและความหมายของการกระทำกับทรัพยากร (F24-C)
 *
 * **ทำไมต้องมีที่เดียว:** เมนูคลิกขวาของเดสก์ท็อปกับแผ่นกระทำของมือถือต้องเสนอ
 * สิ่งเดียวกันด้วยถ้อยคำเดียวกัน ถ้าแยกกันเขียน วันหนึ่งจะมีการกระทำที่ทำได้บนเครื่องหนึ่ง
 * แต่หายไปอีกเครื่องหนึ่งโดยไม่มีใครตั้งใจ
 *
 * **ไม่มีการกระทำใหม่ในนี้** ทุกคีย์มาจาก visibleResourceActions ซึ่งตัดสินจากสิทธิ์จริง
 * ของผู้ใช้กับทรัพยากรนั้น โมดูลนี้แปลคีย์เป็นถ้อยคำเท่านั้น ไม่ตัดสินว่าใครทำอะไรได้
 */

export interface ResourceActionMeta {
  label: string;
  /** การกระทำที่ย้อนกลับยาก ต้องเน้นให้ต่างจากรายการอื่นและถามยืนยันก่อน */
  danger?: boolean;
}

export const RESOURCE_ACTION_CATALOG: Record<string, ResourceActionMeta> = {
  open: { label: 'เปิด' },
  'open-external': { label: 'เปิดลิงก์' },
  'copy-external-link': { label: 'คัดลอกลิงก์' },
  'edit-external': { label: 'แก้ไขลิงก์' },
  preview: { label: 'ดูตัวอย่าง' },
  download: { label: 'ดาวน์โหลดไฟล์ต้นฉบับ' },
  'download-zip': { label: 'ดาวน์โหลดเป็น ZIP' },
  'new-version': { label: 'อัปโหลดเวอร์ชันใหม่' },
  'create-folder-inside': { label: 'สร้างโฟลเดอร์ภายใน' },
  'upload-here': { label: 'อัปโหลดไฟล์ที่นี่' },
  favorite: { label: 'เพิ่มในรายการโปรด' },
  unfavorite: { label: 'นำออกจากรายการโปรด' },
  pin: { label: 'ปักหมุด' },
  unpin: { label: 'ยกเลิกปักหมุด' },
  tags: { label: 'จัดการแท็ก' },
  remark: { label: 'หมายเหตุ' },
  share: { label: 'จัดการสิทธิ์เข้าถึง' },
  lock: { label: 'ล็อกทรัพยากร' },
  unlock: { label: 'ปลดล็อก' },
  rename: { label: 'เปลี่ยนชื่อ' },
  move: { label: 'ย้าย' },
  owner: { label: 'เปลี่ยนผู้ดูแล' },
  details: { label: 'รายละเอียด' },
  activity: { label: 'ประวัติการใช้งาน' },
  trash: { label: 'ย้ายไปถังขยะ', danger: true },
};

/** การกระทำที่ต้องถามยืนยันก่อนเสมอ ไม่ว่าจะเรียกจากหน้าจอไหน */
export function requiresConfirmation(action: string): boolean {
  return RESOURCE_ACTION_CATALOG[action]?.danger === true;
}

export function actionLabel(action: string): string {
  return RESOURCE_ACTION_CATALOG[action]?.label ?? action;
}

/**
 * ทุกคีย์ที่ระบบเสนอได้ ต้องมีถ้อยคำของมัน
 *
 * ใช้ในชุดทดสอบเพื่อกันไม่ให้มีการกระทำที่โผล่บนหน้าจอเป็นชื่อคีย์ดิบ ๆ
 */
export function hasLabel(action: string): boolean {
  return action in RESOURCE_ACTION_CATALOG;
}

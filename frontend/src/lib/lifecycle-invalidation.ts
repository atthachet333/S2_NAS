/**
 * คีย์แคชที่ต้องล้างเมื่อวงจรชีวิตของทรัพยากรเปลี่ยน (F19)
 *
 * รวมไว้ที่เดียวเพราะ Legal Hold คลัง ถังขยะ และการกู้คืน ล้วนเปลี่ยนคำตอบของ
 * `/resources/:id/google-drive` โดยที่ตัวการผูกกับ Google ไม่ได้ถูกแตะเลยสักนิด
 * สถานะการซิงก์ถูกคำนวณจากวงจรชีวิตทุกครั้งที่ถาม ไม่ได้เก็บไว้ในตาราง
 *
 * ถ้าปล่อยให้แต่ละหน้าจอจำเองว่าต้องล้างแคชอะไรบ้าง จะมีหน้าจอที่ลืม - และป้าย
 * "ซิงก์แล้ว" จะยังค้างอยู่ทั้งที่เซิร์ฟเวอร์หยุดซิงก์ไปแล้ว ผู้ใช้จะเชื่อว่าเอกสาร
 * ยังรับเนื้อหาใหม่จาก Google อยู่ ซึ่งตรงข้ามกับความจริงพอดี
 */

/** คำนำหน้าของแคชสถานะการซิงก์รายทรัพยากร - ตรงกับคีย์ที่ GoogleDrivePanel ใช้ */
export const DRIVE_SYNC_KEY = 'drive-sync';

export type QueryKey = readonly string[];

/**
 * การกระทำที่รู้ตัวทรัพยากรแน่ชัด - Legal Hold และคลัง
 *
 * ล้างแบบเจาะจง id ได้ เพราะแผงที่เปิดอยู่คือทรัพยากรชิ้นนั้นชิ้นเดียว
 */
export function lifecycleInvalidationKeys(resourceId: string): QueryKey[] {
  return [['drive'], ['legal-holds'], ['search'], ['trash'], [DRIVE_SYNC_KEY, resourceId]];
}

/**
 * การกระทำจากหน้าไฟล์ - รวมถึงการย้ายไปถังขยะ
 *
 * ล้างทั้งคำนำหน้าเพราะการกระทำครั้งเดียวกระทบได้หลายทรัพยากร: ย้ายโฟลเดอร์ไปถังขยะ
 * พาลูกหลานไปด้วยทั้งกิ่ง และหน้าจอไม่ได้ถือรายการ id ของลูกหลานเหล่านั้นไว้เลย
 */
export function resourceMutationInvalidationKeys(): QueryKey[] {
  return [['drive'], ['resource'], ['folder-picker'], ['admin-ownership'], [DRIVE_SYNC_KEY]];
}

/** การกู้คืนจากถังขยะ - ล้างทั้งคำนำหน้าด้วยเหตุผลเดียวกับหน้าไฟล์ */
export function trashInvalidationKeys(): QueryKey[] {
  return [['trash'], ['drive'], ['dashboard-summary'], ['managed-storage'], [DRIVE_SYNC_KEY]];
}

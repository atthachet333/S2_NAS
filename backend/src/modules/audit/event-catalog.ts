/**
 * สารบัญเหตุการณ์ของระบบ
 *
 * แหล่งความจริงเดียวของ "รหัสเหตุการณ์ → ชื่อภาษาไทย + หมวดหมู่"
 *
 * รหัสอย่าง OCR_CORRECTION_UPDATED เป็นภาษาของฐานข้อมูล ไม่ใช่ภาษาของคนที่ต้อง
 * ตอบผู้ตรวจสอบว่าเกิดอะไรขึ้นกับเอกสารฉบับนั้น หน้าจอจึงต้องแสดงชื่อที่อ่านรู้เรื่อง
 * ส่วนรหัสดิบยังดูได้ในรายละเอียดสำหรับผู้ดูแลที่ต้องการความแม่นยำ
 *
 * **ในสารบัญนี้มีเฉพาะรหัสที่ระบบบันทึกจริง** ไม่มีเหตุการณ์ที่เดาว่าน่าจะมี
 * รายการที่ผู้ตรวจสอบกรองแล้วได้ผลเป็นศูนย์เสมอ เพราะระบบไม่เคยบันทึกมัน
 * แย่กว่าการไม่มีตัวเลือกนั้นเลย - มันทำให้คนสรุปผิดว่า "ไม่มีเหตุการณ์เกิดขึ้น"
 */

/** หมวดหมู่ที่คนใช้จริงในการสืบค้น ไม่ใช่การแบ่งตามโมดูลของโค้ด */
export const EVENT_CATEGORIES = [
  'AUTH',
  'FILE',
  'SHARING',
  'CLIENT',
  'OCR',
  'GOVERNANCE',
  'BACKUP',
  'INTEGRATION',
  'SYSTEM',
] as const;

export type EventCategory = (typeof EVENT_CATEGORIES)[number];

export const CATEGORY_LABELS: Record<EventCategory, string> = {
  AUTH: 'เข้าสู่ระบบ',
  FILE: 'ไฟล์และโฟลเดอร์',
  SHARING: 'การแชร์และสิทธิ์',
  CLIENT: 'ลูกค้า',
  OCR: 'OCR และการค้นหา',
  GOVERNANCE: 'การเก็บรักษาและคลัง',
  BACKUP: 'สำรองและกู้คืน',
  INTEGRATION: 'การเชื่อมต่อระบบอื่น',
  SYSTEM: 'ระบบ',
};

/**
 * ระดับความสำคัญของเหตุการณ์
 *
 * ใช้เลือกสีอย่างประหยัด - ถ้าทุกแถวมีสี จะไม่มีแถวไหนโดดเด่นเลย
 * เหตุการณ์ปกติจึงเป็นกลาง และเก็บสีไว้ให้ความล้มเหลวกับการถูกปฏิเสธ
 */
export type EventTone = 'NEUTRAL' | 'SUCCESS' | 'WARNING' | 'DANGER';

export interface EventDefinition {
  category: EventCategory;
  label: string;
  tone?: EventTone;
  /**
   * เหตุการณ์นี้คือความล้มเหลวหรือการถูกปฏิเสธ
   *
   * แยกจาก tone โดยตั้งใจ - tone บอกว่า "น่าตกใจแค่ไหน" ส่วนธงนี้บอกว่า "สำเร็จหรือไม่"
   * การลบถาวรที่สำเร็จเป็นเหตุการณ์ที่น่าจับตา (DANGER) แต่ไม่ใช่ความล้มเหลว
   * ถ้าใช้ tone แทนกัน ตัวกรอง "เฉพาะที่ล้มเหลว" จะคืนรายการที่สำเร็จปนมาด้วย
   * ซึ่งทำให้ผู้ตรวจสอบสรุปผิดว่ามีเหตุขัดข้องมากกว่าความเป็นจริง
   */
  failure?: true;
}

/**
 * รหัสเหตุการณ์ทั้งหมดที่ระบบบันทึกจริง
 *
 * ตรวจสอบจากซอร์สโดยตรง (ทั้ง activityLog.create และตัวช่วย logActivity)
 * มีชุดทดสอบคอยเตือนเมื่อมีรหัสใหม่เกิดขึ้นในโค้ดแต่ยังไม่มีชื่อภาษาไทยที่นี่
 */
export const EVENT_CATALOG: Record<string, EventDefinition> = {
  /* ---------------- เข้าสู่ระบบ ---------------- */
  LOGIN: { category: 'AUTH', label: 'เข้าสู่ระบบ', tone: 'SUCCESS' },
  CHANGE_PASSWORD: { category: 'AUTH', label: 'เปลี่ยนรหัสผ่าน' },
  GOOGLE_LOGIN_SUCCEEDED: { category: 'AUTH', label: 'เข้าสู่ระบบด้วย Google สำเร็จ', tone: 'SUCCESS' },
  GOOGLE_LOGIN_FAILED: { category: 'AUTH', label: 'เข้าสู่ระบบด้วย Google ไม่สำเร็จ', tone: 'DANGER', failure: true },
  GOOGLE_IDENTITY_LINKED: { category: 'AUTH', label: 'ผูกบัญชี Google กับผู้ใช้' },
  GOOGLE_IDENTITY_CONFLICT: { category: 'AUTH', label: 'บัญชี Google ชนกับผู้ใช้อื่น', tone: 'WARNING' },
  EXTERNAL_LOGIN: { category: 'CLIENT', label: 'ลูกค้าเข้าสู่ระบบ', tone: 'SUCCESS' },

  /* ---------------- ผู้ใช้ ---------------- */
  CREATE_USER: { category: 'SYSTEM', label: 'สร้างบัญชีผู้ใช้' },
  USER_ACTIVATED: { category: 'SYSTEM', label: 'เปิดใช้งานบัญชี', tone: 'SUCCESS' },
  USER_DISABLED: { category: 'SYSTEM', label: 'ปิดใช้งานบัญชี', tone: 'WARNING' },
  USER_PROFILE_UPDATED: { category: 'SYSTEM', label: 'แก้ไขข้อมูลผู้ใช้' },
  USER_ROLE_CHANGED: { category: 'SYSTEM', label: 'เปลี่ยนบทบาทผู้ใช้', tone: 'WARNING' },
  USER_TEMP_PASSWORD_RESET: { category: 'SYSTEM', label: 'ตั้งรหัสผ่านชั่วคราวใหม่', tone: 'WARNING' },

  /* ---------------- ไฟล์และโฟลเดอร์ ---------------- */
  RESOURCE_UPLOADED: { category: 'FILE', label: 'อัปโหลดไฟล์' },
  RESOURCE_FOLDER_CREATED: { category: 'FILE', label: 'สร้างโฟลเดอร์' },
  RESOURCE_EXTERNAL_CREATED: { category: 'FILE', label: 'เพิ่มลิงก์ภายนอก' },
  RESOURCE_EXTERNAL_URL_UPDATED: { category: 'FILE', label: 'แก้ไขลิงก์ภายนอก' },
  RESOURCE_VERSION_CREATED: { category: 'FILE', label: 'อัปโหลดเวอร์ชันใหม่' },
  RESOURCE_DOWNLOADED: { category: 'FILE', label: 'ดาวน์โหลดไฟล์' },
  RESOURCE_ZIP_DOWNLOADED: { category: 'FILE', label: 'ดาวน์โหลดเป็น ZIP' },
  RESOURCE_MOVED: { category: 'FILE', label: 'ย้ายตำแหน่ง' },
  RESOURCE_RENAMED: { category: 'FILE', label: 'เปลี่ยนชื่อ' },
  RESOURCE_DRIVE_CHANGED: { category: 'FILE', label: 'ย้ายข้ามไดร์ฟ', tone: 'WARNING' },
  RESOURCE_REMARK_UPDATED: { category: 'FILE', label: 'แก้ไขหมายเหตุ' },
  RESOURCE_TAG_ADDED: { category: 'FILE', label: 'เพิ่มแท็ก' },
  RESOURCE_TAG_REMOVED: { category: 'FILE', label: 'ลบแท็ก' },
  RESOURCE_LOCKED: { category: 'FILE', label: 'ล็อกทรัพยากร', tone: 'WARNING' },
  RESOURCE_UNLOCKED: { category: 'FILE', label: 'ปลดล็อกทรัพยากร' },
  BULK_TAG_ADDED: { category: 'FILE', label: 'เพิ่มแท็กหลายรายการ' },
  BULK_TAG_REMOVED: { category: 'FILE', label: 'ลบแท็กหลายรายการ' },
  BULK_CATEGORY_SET: { category: 'FILE', label: 'กำหนดประเภทเอกสารหลายรายการ' },

  /* ---------------- การลบและการกู้คืน ---------------- */
  RESOURCE_TRASHED: { category: 'FILE', label: 'ย้ายไปถังขยะ', tone: 'WARNING' },
  RESOURCE_SOFT_DELETED: { category: 'FILE', label: 'ย้ายไปถังขยะ', tone: 'WARNING' },
  RESOURCE_RESTORED: { category: 'FILE', label: 'กู้คืนจากถังขยะ', tone: 'SUCCESS' },
  RESOURCE_PERMANENTLY_DELETED: { category: 'FILE', label: 'ลบถาวร', tone: 'DANGER' },
  RESOURCE_PERMANENT_DELETE_FAILED: { category: 'FILE', label: 'ลบถาวรไม่สำเร็จ', tone: 'DANGER', failure: true },

  /* ---------------- การแชร์และสิทธิ์ ---------------- */
  RESOURCE_OWNER_CHANGED: { category: 'SHARING', label: 'เปลี่ยนผู้ดูแล', tone: 'WARNING' },
  BULK_OWNER_CHANGED: { category: 'SHARING', label: 'เปลี่ยนผู้ดูแลหลายรายการ', tone: 'WARNING' },
  OWNERSHIP_BULK_TRANSFERRED: { category: 'SHARING', label: 'โอนความรับผิดชอบทั้งชุด', tone: 'WARNING' },
  EXTERNAL_ACCESS_GRANTED: { category: 'SHARING', label: 'ให้สิทธิ์ลูกค้าเข้าถึงเอกสาร', tone: 'WARNING' },
  EXTERNAL_ACCESS_REVOKED: { category: 'SHARING', label: 'เพิกถอนสิทธิ์ของลูกค้า' },

  /* ---------------- ลิงก์แชร์ภายนอก (F18) ---------------- */
  PUBLIC_SHARE_CREATED: {
    category: 'SHARING',
    label: 'สร้างลิงก์แชร์ภายนอก',
    tone: 'WARNING',
  },
  PUBLIC_SHARE_REVOKED: { category: 'SHARING', label: 'ยกเลิกลิงก์แชร์ภายนอก' },
  PUBLIC_SHARE_ACCESSED: { category: 'SHARING', label: 'แขกเปิดลิงก์แชร์ภายนอก' },
  PUBLIC_SHARE_DOWNLOADED: {
    category: 'SHARING',
    label: 'แขกดาวน์โหลดผ่านลิงก์แชร์',
    tone: 'WARNING',
  },
  PUBLIC_SHARE_PASSWORD_FAILED: {
    category: 'SHARING',
    label: 'ใส่รหัสผ่านลิงก์แชร์ไม่ถูกต้อง',
    tone: 'DANGER',
    failure: true,
  },
  PUBLIC_SHARE_EXPIRED_ACCESS_ATTEMPT: {
    category: 'SHARING',
    label: 'พยายามเปิดลิงก์แชร์ที่ใช้ไม่ได้แล้ว',
    tone: 'DANGER',
    failure: true,
  },
  PUBLIC_SHARE_LIMIT_REACHED: {
    category: 'SHARING',
    label: 'ลิงก์แชร์ใช้สิทธิ์ครบตามที่กำหนด',
    tone: 'DANGER',
    failure: true,
  },

  /* ---------------- ลูกค้า ---------------- */
  EXTERNAL_FILE_UPLOADED: { category: 'CLIENT', label: 'ลูกค้าอัปโหลดไฟล์' },
  EXTERNAL_RESOURCE_VIEWED: { category: 'CLIENT', label: 'ลูกค้าเปิดดูเอกสาร' },
  EXTERNAL_RESOURCE_DOWNLOADED: { category: 'CLIENT', label: 'ลูกค้าดาวน์โหลดเอกสาร' },

  /* ---------------- OCR ---------------- */
  OCR_REQUESTED: { category: 'OCR', label: 'สั่งอ่านข้อความด้วย OCR' },
  OCR_CORRECTION_CREATED: { category: 'OCR', label: 'ตรวจแก้ข้อความ OCR ครั้งแรก' },
  OCR_CORRECTION_UPDATED: { category: 'OCR', label: 'แก้ไขข้อความ OCR' },
  OCR_CORRECTION_RESET: { category: 'OCR', label: 'ย้อนกลับไปใช้ผล OCR เดิม' },

  /* ---------------- การเก็บรักษาและคลัง ---------------- */
  RETENTION_POLICY_ASSIGNED: { category: 'GOVERNANCE', label: 'กำหนดนโยบายการเก็บรักษา' },
  RETENTION_POLICY_CHANGED: { category: 'GOVERNANCE', label: 'เปลี่ยนนโยบายการเก็บรักษา', tone: 'WARNING' },
  RETENTION_POLICY_UPDATED: { category: 'GOVERNANCE', label: 'แก้ไขนิยามนโยบายการเก็บรักษา', tone: 'WARNING' },
  RESOURCE_ARCHIVED: { category: 'GOVERNANCE', label: 'เก็บเอกสารเข้าคลัง' },
  RESOURCE_UNARCHIVED: { category: 'GOVERNANCE', label: 'นำเอกสารออกจากคลัง' },
  LEGAL_HOLD_CREATED: { category: 'GOVERNANCE', label: 'วาง Legal Hold', tone: 'WARNING' },
  LEGAL_HOLD_RELEASED: { category: 'GOVERNANCE', label: 'ยกเลิก Legal Hold', tone: 'WARNING' },
  /**
   * ความพยายามลบที่ถูกปฏิเสธ
   *
   * บันทึกเฉพาะตอน "คนกด" ไม่ใช่ตอนงานเก็บกวาดข้าม - งานเก็บกวาดเจอเอกสารชุดเดิม
   * ทุกวัน การบันทึกทุกครั้งจะกลบเหตุการณ์ที่มีความหมายจริงจนหาไม่เจอ
   */
  PERMANENT_DELETE_BLOCKED_RETENTION: {
    category: 'GOVERNANCE',
    label: 'ลบถาวรถูกปฏิเสธ - ติดนโยบายการเก็บรักษา',
    tone: 'DANGER',
    failure: true,
  },
  PERMANENT_DELETE_BLOCKED_HOLD: {
    category: 'GOVERNANCE',
    label: 'ลบถาวรถูกปฏิเสธ - ติด Legal Hold',
    tone: 'DANGER',
    failure: true,
  },

  /* ---------------- สำรองและกู้คืน ---------------- */
  BACKUP_CREATED: { category: 'BACKUP', label: 'สร้างชุดสำรอง', tone: 'SUCCESS' },
  BACKUP_FAILED: { category: 'BACKUP', label: 'สร้างชุดสำรองไม่สำเร็จ', tone: 'DANGER', failure: true },
  BACKUP_DELETED: { category: 'BACKUP', label: 'ลบชุดสำรอง', tone: 'WARNING' },
  BACKUP_SCHEDULED_STARTED: { category: 'BACKUP', label: 'เริ่มสำรองตามกำหนดเวลา' },
  BACKUP_SCHEDULED_COMPLETED: { category: 'BACKUP', label: 'สำรองตามกำหนดเวลาเสร็จ', tone: 'SUCCESS' },
  BACKUP_SCHEDULE_UPDATED: { category: 'BACKUP', label: 'แก้ไขตารางการสำรอง' },
  BACKUP_RETENTION_DELETED: { category: 'BACKUP', label: 'ลบชุดสำรองที่หมดอายุ' },
  BACKUP_RETENTION_FAILED: { category: 'BACKUP', label: 'ลบชุดสำรองที่หมดอายุไม่สำเร็จ', tone: 'DANGER', failure: true },
  BACKUP_OFFSITE_COPY_STARTED: { category: 'BACKUP', label: 'เริ่มคัดลอกไปนอกสถานที่' },
  BACKUP_OFFSITE_COPY_VERIFIED: { category: 'BACKUP', label: 'ตรวจสอบสำเนานอกสถานที่แล้ว', tone: 'SUCCESS' },
  BACKUP_OFFSITE_COPY_FAILED: { category: 'BACKUP', label: 'คัดลอกไปนอกสถานที่ไม่สำเร็จ', tone: 'DANGER', failure: true },
  RESTORE_PRECHECK_STARTED: { category: 'BACKUP', label: 'เริ่มตรวจก่อนกู้คืน' },
  RESTORE_PRECHECK_FAILED: { category: 'BACKUP', label: 'ตรวจก่อนกู้คืนไม่ผ่าน', tone: 'DANGER', failure: true },
  RESTORE_STAGE_CREATED: { category: 'BACKUP', label: 'สร้างพื้นที่พักสำหรับกู้คืน' },
  RESTORE_REHEARSAL_PASSED: { category: 'BACKUP', label: 'ซ้อมกู้คืนผ่าน', tone: 'SUCCESS' },
  RESTORE_REHEARSAL_FAILED: { category: 'BACKUP', label: 'ซ้อมกู้คืนไม่ผ่าน', tone: 'DANGER', failure: true },
  RESTORE_REHEARSAL_SCHEDULE_UPDATED: { category: 'BACKUP', label: 'แก้ไขตารางการซ้อมกู้คืน' },

  /* ---------------- การเชื่อมต่อระบบอื่น ---------------- */
  INTEGRATION_APP_CREATED: { category: 'INTEGRATION', label: 'สร้างแอปเชื่อมต่อ' },
  INTEGRATION_APP_UPDATED: { category: 'INTEGRATION', label: 'แก้ไขแอปเชื่อมต่อ' },
  INTEGRATION_CREDENTIAL_CREATED: { category: 'INTEGRATION', label: 'ออกกุญแจให้แอปเชื่อมต่อ', tone: 'WARNING' },
  INTEGRATION_CREDENTIAL_REVOKED: { category: 'INTEGRATION', label: 'เพิกถอนกุญแจของแอปเชื่อมต่อ', tone: 'WARNING' },
  INTEGRATION_RESOURCE_CREATED: { category: 'INTEGRATION', label: 'ระบบอื่นสร้างทรัพยากร' },
  INTEGRATION_RESOURCE_UPDATED: { category: 'INTEGRATION', label: 'ระบบอื่นแก้ไขทรัพยากร' },

  /* ---------------- ระบบ ---------------- */
  SYSTEM_SETTING_UPDATED: { category: 'SYSTEM', label: 'แก้ไขค่าตั้งค่าระบบ', tone: 'WARNING' },
  SYSTEM_SETTING_RESET: { category: 'SYSTEM', label: 'คืนค่าตั้งค่าระบบเป็นค่าเริ่มต้น', tone: 'WARNING' },
  AUDIT_LOG_EXPORTED: { category: 'SYSTEM', label: 'ส่งออกบันทึกกิจกรรม', tone: 'WARNING' },
};

/**
 * คำอธิบายของรหัสที่ยังไม่มีในสารบัญ
 *
 * ไม่ทิ้งแถวนั้นไปเฉย ๆ - บันทึกที่มีอยู่จริงต้องแสดงได้เสมอ แม้จะยังไม่มีชื่อสวย ๆ
 * การซ่อนเหตุการณ์ที่ระบบไม่รู้จักคือการทำให้ผู้ตรวจสอบเห็นภาพที่ไม่ครบ
 */
export function describeEvent(action: string): EventDefinition {
  return EVENT_CATALOG[action] ?? { category: 'SYSTEM', label: action, tone: 'NEUTRAL' };
}

/** รหัสทั้งหมดในหมวดหนึ่ง - ใช้แปลงตัวกรองหมวดหมู่เป็นเงื่อนไขฐานข้อมูล */
export function actionsInCategory(category: EventCategory): string[] {
  return Object.entries(EVENT_CATALOG)
    .filter(([, definition]) => definition.category === category)
    .map(([code]) => code);
}

/* ------------------------------------------------------------------ */
/* ชุดค้นหาสำเร็จรูป                                                     */
/* ------------------------------------------------------------------ */

/**
 * ชุดเงื่อนไขที่ผู้ตรวจสอบใช้จริง
 *
 * เป็นเพียง "รายชื่อรหัสเหตุการณ์" ไม่ใช่โค้ดรายงานชุดที่สอง
 * การทำระบบออกแบบรายงานทั่วไปจะได้เครื่องมือที่ยืดหยุ่นมากแต่ไม่มีใครใช้เป็น
 */
export interface AuditPreset {
  slug: string;
  name: string;
  description: string;
  actions: string[];
}

const DESTRUCTIVE = [
  'RESOURCE_TRASHED',
  'RESOURCE_SOFT_DELETED',
  'RESOURCE_RESTORED',
  'RESOURCE_PERMANENTLY_DELETED',
  'RESOURCE_PERMANENT_DELETE_FAILED',
  'RESOURCE_ARCHIVED',
  'RESOURCE_UNARCHIVED',
  'RESOURCE_OWNER_CHANGED',
  'BULK_OWNER_CHANGED',
  'OWNERSHIP_BULK_TRANSFERRED',
  'LEGAL_HOLD_CREATED',
  'LEGAL_HOLD_RELEASED',
  'RETENTION_POLICY_ASSIGNED',
  'RETENTION_POLICY_CHANGED',
  'PERMANENT_DELETE_BLOCKED_RETENTION',
  'PERMANENT_DELETE_BLOCKED_HOLD',
];

export const AUDIT_PRESETS: AuditPreset[] = [
  {
    slug: 'all',
    name: 'กิจกรรมทั้งหมด',
    description: 'ทุกเหตุการณ์ที่ระบบบันทึกไว้',
    actions: [],
  },
  {
    slug: 'auth',
    name: 'การเข้าสู่ระบบ',
    description: 'การเข้าสู่ระบบ การเปลี่ยนรหัสผ่าน และการผูกบัญชี Google',
    actions: actionsInCategory('AUTH'),
  },
  {
    slug: 'client',
    name: 'กิจกรรมลูกค้า',
    description: 'สิ่งที่ผู้ใช้ภายนอกทำในพื้นที่ลูกค้า',
    actions: actionsInCategory('CLIENT'),
  },
  {
    slug: 'sharing',
    name: 'การแชร์และสิทธิ์',
    description: 'การให้และเพิกถอนสิทธิ์ รวมถึงการเปลี่ยนผู้ดูแล',
    actions: actionsInCategory('SHARING'),
  },
  {
    slug: 'public-shares',
    name: 'ลิงก์แชร์ภายนอก',
    description: 'การสร้าง ยกเลิก และการใช้งานลิงก์ที่ส่งให้คนนอกองค์กร',
    actions: [
      'PUBLIC_SHARE_CREATED',
      'PUBLIC_SHARE_REVOKED',
      'PUBLIC_SHARE_ACCESSED',
      'PUBLIC_SHARE_DOWNLOADED',
      'PUBLIC_SHARE_PASSWORD_FAILED',
      'PUBLIC_SHARE_EXPIRED_ACCESS_ATTEMPT',
      'PUBLIC_SHARE_LIMIT_REACHED',
    ],
  },
  {
    slug: 'downloads',
    name: 'การดาวน์โหลด',
    description: 'การดาวน์โหลดเอกสารทั้งจากฝั่งภายในและฝั่งลูกค้า',
    actions: ['RESOURCE_DOWNLOADED', 'RESOURCE_ZIP_DOWNLOADED', 'EXTERNAL_RESOURCE_DOWNLOADED'],
  },
  {
    slug: 'destructive',
    name: 'การลบและการเปลี่ยนแปลงสำคัญ',
    description: 'การลบ กู้คืน เก็บเข้าคลัง เปลี่ยนผู้ดูแล และการกำกับดูแล - ใช้ตอนสืบสวน',
    actions: DESTRUCTIVE,
  },
  {
    slug: 'governance',
    name: 'การเก็บรักษาและ Legal Hold',
    description: 'นโยบายการเก็บรักษา คลังเอกสาร การระงับการลบ และการลบที่ถูกปฏิเสธ',
    actions: actionsInCategory('GOVERNANCE'),
  },
  {
    slug: 'ocr',
    name: 'การตรวจแก้ข้อความ OCR',
    description: 'การสั่งอ่านข้อความและการตรวจแก้โดยมนุษย์',
    actions: actionsInCategory('OCR'),
  },
  {
    slug: 'backup',
    name: 'Backup และ Recovery',
    description: 'การสำรอง การตรวจสอบ สำเนานอกสถานที่ และการซ้อมกู้คืน',
    actions: actionsInCategory('BACKUP'),
  },
  {
    slug: 'files',
    name: 'กิจกรรมไฟล์',
    description: 'การอัปโหลด เพิ่มเวอร์ชัน ย้าย เปลี่ยนชื่อ และดาวน์โหลด',
    actions: actionsInCategory('FILE'),
  },
];

export function findPreset(slug: string): AuditPreset | null {
  return AUDIT_PRESETS.find((preset) => preset.slug === slug) ?? null;
}

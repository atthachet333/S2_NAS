/**
 * คำอธิบายเหตุการณ์ในบันทึกกิจกรรม
 *
 * แยกออกมาเป็นโมดูลอิสระ ไม่พึ่งพา React หรือไอคอน เพื่อให้ทดสอบได้ตรง ๆ
 * และให้ทั้งแดชบอร์ด แผงรายละเอียด และหน้าผู้ดูแลใช้คำเดียวกัน
 * เหตุการณ์ที่ไม่รู้จักต้องอ่านออกเสมอ ห้ามแสดงเป็นช่องว่าง
 */

export type ActivityTone = 'brand' | 'neutral' | 'positive' | 'warning' | 'danger';

interface ActivityMeta {
  label: string;
  tone: ActivityTone;
}

const ACTIVITY_TEXT: Record<string, ActivityMeta> = {
  /* ทรัพยากร */
  RESOURCE_FOLDER_CREATED: { label: 'สร้างโฟลเดอร์', tone: 'brand' },
  RESOURCE_EXTERNAL_CREATED: { label: 'เพิ่มลิงก์ภายนอก', tone: 'brand' },
  RESOURCE_EXTERNAL_URL_UPDATED: { label: 'แก้ไขลิงก์ภายนอก', tone: 'warning' },
  RESOURCE_RENAMED: { label: 'เปลี่ยนชื่อ', tone: 'neutral' },
  RESOURCE_UPDATED: { label: 'แก้ไขข้อมูล', tone: 'neutral' },
  RESOURCE_MOVED: { label: 'ย้ายตำแหน่ง', tone: 'neutral' },
  RESOURCE_OWNER_CHANGED: { label: 'เปลี่ยนผู้ดูแล', tone: 'warning' },
  RESOURCE_SOFT_DELETED: { label: 'ย้ายไปถังขยะ', tone: 'danger' },
  RESOURCE_UPLOADED: { label: 'อัปโหลดไฟล์', tone: 'brand' },
  RESOURCE_VERSION_CREATED: { label: 'เพิ่มเวอร์ชันใหม่', tone: 'brand' },
  RESOURCE_DOWNLOADED: { label: 'ดาวน์โหลดไฟล์', tone: 'neutral' },
  RESOURCE_TRASHED: { label: 'ย้ายไปถังขยะ', tone: 'danger' },
  RESOURCE_RESTORED: { label: 'กู้คืน', tone: 'positive' },
  RESOURCE_PERMANENTLY_DELETED: { label: 'ลบถาวร', tone: 'danger' },

  /* Phase E */
  RESOURCE_ACCESS_GRANTED: { label: 'ให้สิทธิ์เข้าถึง', tone: 'warning' },
  RESOURCE_ACCESS_REVOKED: { label: 'ยกเลิกสิทธิ์เข้าถึง', tone: 'warning' },
  RESOURCE_TAG_ADDED: { label: 'เพิ่มแท็ก', tone: 'neutral' },
  RESOURCE_TAG_REMOVED: { label: 'ลบแท็ก', tone: 'neutral' },
  RESOURCE_REMARK_UPDATED: { label: 'แก้ไขหมายเหตุ', tone: 'neutral' },
  RESOURCE_LOCKED: { label: 'ล็อกทรัพยากร', tone: 'warning' },
  RESOURCE_UNLOCKED: { label: 'ปลดล็อกทรัพยากร', tone: 'positive' },
  OWNERSHIP_BULK_TRANSFERRED: { label: 'ส่งมอบความรับผิดชอบทั้งชุด', tone: 'warning' },

  /* บัญชีผู้ใช้ */
  LOGIN_SUCCESS: { label: 'เข้าสู่ระบบ', tone: 'positive' },
  LOGIN_FAILED: { label: 'เข้าสู่ระบบไม่สำเร็จ', tone: 'danger' },
  LOGOUT: { label: 'ออกจากระบบ', tone: 'neutral' },
  PASSWORD_CHANGED: { label: 'เปลี่ยนรหัสผ่าน', tone: 'warning' },
  CREATE_USER: { label: 'สร้างผู้ใช้', tone: 'brand' },
  UPDATE_USER: { label: 'แก้ไขผู้ใช้', tone: 'neutral' },
  USER_PROFILE_UPDATED: { label: 'แก้ไขโปรไฟล์ผู้ใช้', tone: 'neutral' },
  USER_ROLE_CHANGED: { label: 'เปลี่ยนบทบาทผู้ใช้', tone: 'warning' },
  USER_ACTIVATED: { label: 'เปิดใช้งานผู้ใช้', tone: 'positive' },
};

export function activityLabel(action: string): string {
  return ACTIVITY_TEXT[action]?.label ?? action;
}

export function activityTone(action: string): ActivityTone {
  return ACTIVITY_TEXT[action]?.tone ?? 'neutral';
}

/**
 * รายละเอียดเสริมของเหตุการณ์ ในรูปแบบที่อ่านได้
 *
 * metadata มาจากเซิร์ฟเวอร์และตั้งใจเก็บเฉพาะข้อมูลที่ไม่ละเอียดอ่อน
 * ฟังก์ชันนี้จึงแสดงเฉพาะคีย์ที่รู้จักเท่านั้น ไม่เทข้อมูลดิบทั้งก้อนออกหน้าจอ
 */
export function activityDetail(action: string, metadata: unknown): string | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const data = metadata as Record<string, unknown>;

  if (action === 'RESOURCE_TAG_ADDED' || action === 'RESOURCE_TAG_REMOVED') {
    return typeof data.tagName === 'string' ? `แท็ก “${data.tagName}”` : null;
  }
  if (action === 'RESOURCE_REMARK_UPDATED') {
    // ตัวหมายเหตุไม่เคยถูกบันทึกลง log จึงบอกได้แค่ว่าเพิ่ม แก้ หรือลบ
    return data.cleared === true ? 'ลบหมายเหตุออก' : 'บันทึกหมายเหตุใหม่';
  }
  if (action === 'RESOURCE_LOCKED') {
    // ตัวเหตุผลอยู่ที่ทรัพยากรโดยตรง บันทึกเก็บไว้เพียงว่ามีเหตุผลกำกับหรือไม่
    return data.hasReason === true ? 'ระบุเหตุผลกำกับไว้' : null;
  }
  if (action === 'OWNERSHIP_BULK_TRANSFERRED') {
    return typeof data.count === 'number' ? `${data.count} รายการ` : null;
  }
  if (action === 'RESOURCE_ACCESS_GRANTED') {
    const level = data.accessLevel === 'EDITOR' ? 'แก้ไขได้' : 'เปิดดูได้';
    return data.allowDownload === false ? `${level} (ห้ามดาวน์โหลด)` : level;
  }
  return null;
}

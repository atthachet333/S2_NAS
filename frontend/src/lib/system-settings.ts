/**
 * ค่าตั้งค่าการทำงานของระบบ ฝั่งหน้าจอ
 *
 * หน้าจอเป็นเพียงตัวช่วยกรอก ไม่ใช่ผู้ตัดสิน - backend ตรวจซ้ำทุกค่าเสมอ
 * ที่นี่มีไว้เพื่อบอกผู้ใช้ก่อนกดบันทึกว่าค่าไหนใช้ไม่ได้และเพราะอะไร
 */
export type SettingKey = 'TRASH_RETENTION_DAYS' | 'MAX_UPLOAD_SIZE_MB' | 'ZIP_MAX_RESOURCES' | 'ZIP_MAX_BYTES';
export type SettingSource = 'DATABASE' | 'ENVIRONMENT' | 'DEFAULT';
export type SettingUnit = 'DAYS' | 'MEGABYTES' | 'ITEMS' | 'BYTES';

export interface SettingView {
  key: SettingKey;
  section: 'UPLOAD' | 'TRASH' | 'ZIP';
  label: string;
  description: string;
  unit: SettingUnit;
  value: number;
  source: SettingSource;
  defaultValue: number;
  envKey: string;
  hotReload: 'FULL' | 'LOWER_ONLY';
  restartNote?: string;
}

export const SECTION_TITLE: Record<SettingView['section'], string> = {
  UPLOAD: 'ไฟล์และการอัปโหลด',
  TRASH: 'ถังขยะ',
  ZIP: 'ดาวน์โหลด ZIP',
};

/** ลำดับที่แสดงบนหน้าจอ ตามลำดับที่ผู้ดูแลมักคิดถึง */
export const SECTION_ORDER: Array<SettingView['section']> = ['UPLOAD', 'TRASH', 'ZIP'];

export const SOURCE_LABEL: Record<SettingSource, string> = {
  DATABASE: 'ค่าจากระบบ',
  ENVIRONMENT: 'ค่าจาก Environment',
  DEFAULT: 'ค่าเริ่มต้นของระบบ',
};

export const UNIT_LABEL: Record<SettingUnit, string> = {
  DAYS: 'วัน',
  MEGABYTES: 'MB',
  ITEMS: 'รายการ',
  BYTES: 'ไบต์',
};

/** ขอบเขตต้องตรงกับฝั่ง backend มิฉะนั้นผู้ใช้จะกดบันทึกแล้วเจอ error ที่หน้าจอไม่ได้เตือนไว้ */
const BOUNDS: Record<SettingKey, { min: number; max: number }> = {
  TRASH_RETENTION_DAYS: { min: 1, max: 365 },
  MAX_UPLOAD_SIZE_MB: { min: 1, max: 10_240 },
  ZIP_MAX_RESOURCES: { min: 1, max: 100_000 },
  ZIP_MAX_BYTES: { min: 1, max: 1024 ** 4 },
};

/** ข้อความบอกว่าค่านี้ผิดตรงไหน - คืน null เมื่อใช้ได้ */
export function validateSettingValue(key: SettingKey, raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === '') return 'กรุณากรอกค่า';

  const value = Number(trimmed);
  if (!Number.isFinite(value)) return 'ต้องเป็นตัวเลข';
  if (!Number.isInteger(value)) return 'ต้องเป็นจำนวนเต็ม';
  if (!Number.isSafeInteger(value)) return 'ตัวเลขเกินช่วงที่ระบบรองรับ';

  const { min, max } = BOUNDS[key];
  if (value < min) return `ต้องไม่น้อยกว่า ${min}`;
  if (value > max) return `ต้องไม่เกิน ${max.toLocaleString('th-TH')}`;
  return null;
}

/**
 * การลดจำนวนวันของถังขยะทำให้รายการที่ค้างอยู่หมดอายุเร็วขึ้น
 *
 * ต้องเตือนก่อน เพราะผลลัพธ์คือการลบถาวรที่ย้อนกลับไม่ได้
 * และเกิดกับรายการที่ผู้ใช้คนอื่นทิ้งไว้ ไม่ใช่ของผู้ที่กดบันทึก
 */
export function retentionWarning(current: number, next: number): string | null {
  if (next >= current) return null;
  return `ลดระยะเวลาถังขยะจาก ${current} วันเหลือ ${next} วัน อาจทำให้บางรายการถูกลบถาวรเร็วขึ้นในรอบเก็บกวาดถัดไป`;
}

/** มีอะไรเปลี่ยนไปจากค่าที่มีผลอยู่บ้าง */
export function changedEntries(
  settings: SettingView[],
  drafts: Record<string, string>,
): Array<{ key: SettingKey; value: number }> {
  return settings
    .filter((setting) => {
      const draft = drafts[setting.key];
      return draft !== undefined && draft.trim() !== '' && Number(draft) !== setting.value;
    })
    .map((setting) => ({ key: setting.key, value: Number(drafts[setting.key]) }));
}

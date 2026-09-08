import type { DriveConnectionState, DriveEntryKind, DriveSyncStatus } from './api';

/**
 * ข้อความและสถานะของ Google Drive (F19)
 *
 * แยกจากหน้าจอเพื่อให้แผงของผู้ใช้ หน้าผู้ดูแล และป้ายในแผงรายละเอียด
 * ใช้ชุดเดียวกัน - ถ้าต่างคนต่างเขียน วันหนึ่งหน้าหนึ่งจะบอกว่า "ซิงก์แล้ว"
 * อีกหน้าบอกว่า "ต้นทางหาย" สำหรับไฟล์เดียวกัน
 */

export interface StatusStyle {
  label: string;
  className: string;
  /** ผู้ใช้ต้องลงมือทำอะไรบางอย่างหรือไม่ */
  needsAction?: boolean;
}

/**
 * สถานะของการเชื่อมต่อ
 *
 * ทุกป้ายมีข้อความเสมอ ไม่พึ่งสีอย่างเดียว และสีตัวอักษรมาจากโทเคนของธีม
 * จึงอ่านออกทั้งโหมดสว่างและมืด
 */
export const CONNECTION_STATUS: Record<DriveConnectionState, StatusStyle> = {
  ACTIVE: {
    label: 'เชื่อมต่อแล้ว',
    className: 'border-emerald-200 bg-emerald-50 text-[var(--s2-success-ring)]',
  },
  REAUTH_REQUIRED: {
    label: 'ต้องเชื่อมต่อใหม่',
    className: 'border-amber-200 bg-amber-50 text-[var(--s2-warning-ring)]',
    needsAction: true,
  },
  CREDENTIAL_UNREADABLE: {
    label: 'อ่านข้อมูลรับรองไม่ได้',
    className: 'border-red-200 bg-red-50 text-[var(--s2-danger-ring)]',
    needsAction: true,
  },
  DISCONNECTED: {
    label: 'ยังไม่ได้เชื่อมต่อ',
    className: 'border-line bg-[var(--s2-surface-soft)] text-navy-500',
  },
};

/** สถานะการซิงก์ของทรัพยากรหนึ่งชิ้น */
export const SYNC_STATUS: Record<DriveSyncStatus, StatusStyle> = {
  SYNCED: {
    label: 'ซิงก์แล้ว',
    className: 'border-emerald-200 bg-emerald-50 text-[var(--s2-success-ring)]',
  },
  UPDATE_AVAILABLE: {
    label: 'มีการเปลี่ยนแปลงที่ต้นทาง',
    className: 'border-amber-200 bg-amber-50 text-[var(--s2-warning-ring)]',
  },
  PAUSED_LIFECYCLE: {
    label: 'หยุดซิงก์ชั่วคราว',
    className: 'border-line bg-[var(--s2-surface-soft)] text-navy-500',
  },
  PAUSED_LEGAL_HOLD: {
    label: 'หยุดโดย Legal Hold',
    className: 'border-amber-200 bg-amber-50 text-[var(--s2-warning-ring)]',
  },
  SOURCE_MISSING: {
    label: 'ต้นทางหาย',
    className: 'border-red-200 bg-red-50 text-[var(--s2-danger-ring)]',
    needsAction: true,
  },
  ERROR: {
    label: 'ซิงก์ไม่สำเร็จ',
    className: 'border-red-200 bg-red-50 text-[var(--s2-danger-ring)]',
    needsAction: true,
  },
  REAUTH_REQUIRED: {
    label: 'ต้องเชื่อมต่อใหม่',
    className: 'border-amber-200 bg-amber-50 text-[var(--s2-warning-ring)]',
    needsAction: true,
  },
  DISCONNECTED: {
    label: 'ตัดการเชื่อมต่อแล้ว',
    className: 'border-line bg-[var(--s2-surface-soft)] text-navy-500',
  },
  DETACHED: {
    label: 'หยุดซิงก์',
    className: 'border-line bg-[var(--s2-surface-soft)] text-navy-500',
  },
};

/** ชนิดของรายการใน Drive - ผู้ใช้ต้องรู้ว่าจะได้ไฟล์แบบไหนก่อนกดนำเข้า */
export const ENTRY_KIND: Record<DriveEntryKind, { label: string; importable: boolean }> = {
  FOLDER: { label: 'โฟลเดอร์', importable: true },
  BINARY: { label: 'ไฟล์', importable: true },
  GOOGLE_DOC: { label: 'Google Docs → DOCX', importable: true },
  GOOGLE_SHEET: { label: 'Google Sheets → XLSX', importable: true },
  GOOGLE_SLIDES: { label: 'Google Slides → PPTX', importable: true },
  SHORTCUT: { label: 'ทางลัด', importable: true },
  UNSUPPORTED: { label: 'ยังนำเข้าไม่ได้', importable: false },
};

/**
 * ผลลัพธ์ของขั้นตอน OAuth ที่กลับมาทาง URL
 *
 * เซิร์ฟเวอร์ส่งกลับมาเป็นรหัสสั้น ๆ ไม่ใช่ข้อความ เพราะค่าใน query string
 * ไปโผล่ในประวัติเบราว์เซอร์และบันทึกของ proxy
 */
export const CALLBACK_TEXT: Record<string, string> = {
  connected: 'เชื่อมต่อ Google Drive แล้ว',
  cancelled: 'ยกเลิกการเชื่อมต่อที่หน้าจอของ Google',
  failed: 'เชื่อมต่อ Google Drive ไม่สำเร็จ',
};

export const CALLBACK_REASON: Record<string, string> = {
  'account-changed': 'เชื่อมต่อด้วยบัญชี Google คนละบัญชีกับเดิม - การผูกไฟล์เก่ายังหยุดอยู่',
  GOOGLE_DRIVE_STATE_INVALID: 'คำขอเชื่อมต่อไม่ถูกต้องหรือถูกใช้ไปแล้ว',
  GOOGLE_DRIVE_STATE_EXPIRED: 'คำขอเชื่อมต่อหมดอายุ กรุณาลองใหม่',
  GOOGLE_DRIVE_NOT_CONFIGURED: 'ยังไม่ได้ตั้งค่าการเชื่อมต่อ Google Drive',
  INTEGRATION_ENCRYPTION_UNAVAILABLE: 'ยังไม่ได้ตั้งค่ากุญแจเข้ารหัสข้อมูลรับรอง',
};

/** ขนาดของไฟล์ Google เองไม่มีค่า - แสดงชนิดแทนที่จะแสดงช่องว่าง */
export function entrySizeText(entry: { size: number | null; kind: DriveEntryKind }): string {
  if (entry.size === null) return ENTRY_KIND[entry.kind].label;
  if (entry.size < 1024) return `${entry.size} B`;
  if (entry.size < 1024 * 1024) return `${(entry.size / 1024).toFixed(1)} KB`;
  return `${(entry.size / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * ข้อความอธิบายโหมดการนำเข้า
 *
 * ความต่างของสองโหมดนี้ต้องอ่านแล้วเข้าใจทันที เพราะเลือกผิดแล้วผลต่างกันมาก:
 * โหมดหนึ่งได้สำเนาที่นิ่ง อีกโหมดได้ไฟล์ที่เปลี่ยนตามต้นทางตลอดไป
 */
export const IMPORT_MODE = {
  IMPORT_ONCE: {
    label: 'คัดลอกครั้งเดียว',
    description: 'สำเนาใน S2 NAS เป็นอิสระ การแก้ไขฝั่ง Google หลังจากนี้ไม่มีผล',
  },
  SYNCED: {
    label: 'คัดลอกและซิงก์ต่อเนื่อง',
    description: 'Google ยังเป็นต้นทาง เมื่อไฟล์ที่นั่นเปลี่ยน ระบบจะสร้างเวอร์ชันใหม่ให้',
  },
} as const;

/** ยอมให้เปิดเฉพาะ URL มาตรฐานของ Google Drive/Docs ผ่าน HTTPS */
export function safeGoogleDriveUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') return null;
    if (!['drive.google.com', 'docs.google.com'].includes(url.hostname.toLowerCase())) return null;
    return url.toString();
  } catch {
    return null;
  }
}

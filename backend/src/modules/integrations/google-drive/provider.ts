import type { Readable } from 'node:stream';

/**
 * ตัวเชื่อมกับ Google Drive (F19)
 *
 * **นี่คือที่เดียวในระบบที่พูดกับ Google** บริการอื่นเรียกผ่านอินเทอร์เฟซนี้เท่านั้น
 *
 * เหตุผลสองข้อ:
 *
 *   1. ชุดทดสอบใช้ตัวปลอมที่ทำงานเหมือนกันทุกประการได้ จึงทดสอบตรรกะการนำเข้า
 *      การซิงก์ และการจัดการข้อผิดพลาดได้จริงโดยไม่ต้องต่อเน็ตและไม่ต้องมีบัญชี Google
 *
 *   2. เมื่อ Google เปลี่ยน API มีที่ต้องแก้ที่เดียว ไม่ใช่กระจายอยู่ใน route กับ service
 *      ซึ่งเป็นสภาพที่ไม่มีใครกล้าแตะเมื่อเวลาผ่านไปสองปี
 */

/* ------------------------------------------------------------------ */
/* ชนิดข้อมูล                                                          */
/* ------------------------------------------------------------------ */

/** ตัวตนของบัญชี Google ที่เชื่อมต่อ */
export interface GoogleAccount {
  /** ตัวระบุถาวรของบัญชี - อีเมลเปลี่ยนได้ แต่ค่านี้ไม่เปลี่ยน */
  subject: string;
  email: string;
}

export interface GoogleTokens {
  accessToken: string;
  /**
   * Google ไม่ได้คืน refresh token ทุกครั้ง - จะคืนเฉพาะตอนยินยอมครั้งแรก
   * หรือเมื่อขอ prompt=consent เท่านั้น การเชื่อมต่อที่ไม่มีค่านี้จะซิงก์ระยะยาวไม่ได้
   */
  refreshToken: string | null;
  expiresAt: Date;
  scope: string;
}

/** ชนิดของรายการใน Drive ที่เราสนใจ */
export type DriveEntryKind = 'FOLDER' | 'BINARY' | 'GOOGLE_DOC' | 'GOOGLE_SHEET' | 'GOOGLE_SLIDES' | 'SHORTCUT' | 'UNSUPPORTED';

export interface DriveEntry {
  id: string;
  name: string;
  kind: DriveEntryKind;
  mimeType: string;
  /** ขนาดของไฟล์ไบนารี - ไฟล์ของ Google เองไม่มีค่านี้ */
  size: number | null;
  modifiedTime: Date | null;
  /** ใช้ตรวจการเปลี่ยนแปลงของไฟล์ Google ที่ไม่มี checksum */
  version: string | null;
  /** เบาะแสจาก Google - ไม่เคยแทนที่ checksum ที่ S2 NAS คำนวณเอง */
  md5Checksum: string | null;
  webViewLink: string | null;
  /** ปลายทางจริงของทางลัด */
  shortcutTargetId: string | null;
  parents: string[];
}

export interface DriveListPage {
  items: DriveEntry[];
  /** โทเคนหน้าถัดไปของ Google - ส่งกลับมาให้ตรง ๆ ไม่ตีความ */
  nextPageToken: string | null;
}

export interface DriveListOptions {
  folderId?: string;
  /** ค้นตามชื่อไฟล์ */
  query?: string;
  pageToken?: string;
  pageSize?: number;
}

export interface DriveDownload {
  stream: Readable;
  /** MIME จริงของไบต์ที่ได้ - สำหรับไฟล์ Google คือชนิดของไฟล์ที่ส่งออกแล้ว */
  mimeType: string;
  /** ชื่อไฟล์พร้อมนามสกุลที่ถูกต้องของรูปแบบที่ได้จริง */
  fileName: string;
}

export interface GoogleDriveProvider {
  getAuthorizationUrl(input: { state: string; codeChallenge: string; forceConsent: boolean }): string;
  exchangeCode(input: { code: string; codeVerifier: string }): Promise<GoogleTokens>;
  refreshAccessToken(refreshToken: string): Promise<GoogleTokens>;
  getAccount(accessToken: string): Promise<GoogleAccount>;
  listFiles(accessToken: string, options: DriveListOptions): Promise<DriveListPage>;
  getFileMetadata(accessToken: string, fileId: string): Promise<DriveEntry>;
  /** ดาวน์โหลดไฟล์ไบนารีเป็นสตรีม - ไม่โหลดทั้งไฟล์เข้าหน่วยความจำ */
  downloadFile(accessToken: string, entry: DriveEntry): Promise<DriveDownload>;
  /** ส่งออกไฟล์ของ Google เอง (Docs/Sheets/Slides) เป็นรูปแบบที่เปิดได้จริง */
  exportGoogleFile(accessToken: string, entry: DriveEntry): Promise<DriveDownload>;
  /** เพิกถอนสิทธิ์ที่ฝั่ง Google - ล้มเหลวได้โดยไม่ทำให้การตัดการเชื่อมต่อฝั่งเราล้มเหลว */
  revokeToken(token: string): Promise<void>;
}

/* ------------------------------------------------------------------ */
/* การจัดประเภทและการส่งออก                                              */
/* ------------------------------------------------------------------ */

export const FOLDER_MIME = 'application/vnd.google-apps.folder';
export const SHORTCUT_MIME = 'application/vnd.google-apps.shortcut';

/**
 * รูปแบบมาตรฐานที่ใช้ส่งออกไฟล์ของ Google
 *
 * เลือกรูปแบบที่ยังแก้ไขต่อได้ ไม่ใช่ PDF
 *
 * เหตุผล: เอกสารที่นำเข้ามาแล้วแก้ไม่ได้ก็เป็นแค่ภาพถ่ายของเอกสาร องค์กรที่ย้าย
 * งานจาก Google มาเก็บที่นี่ต้องทำงานกับไฟล์นั้นต่อได้ ไม่ใช่แค่เปิดดู
 *
 * ผลพลอยได้: DOCX/XLSX/PPTX เป็นรูปแบบที่ตัวสกัดข้อความของ F12 อ่านได้อยู่แล้ว
 * เนื้อหาจึงเข้าดัชนีค้นหาโดยไม่ต้องพึ่ง OCR
 *
 * **สร้างสำเนาเดียวเท่านั้น** ไม่สร้าง PDF คู่กันโดยอัตโนมัติ เพราะสองสำเนา
 * ของเอกสารเดียวกันจะแยกกันเดินทันทีที่มีคนแก้ฉบับใดฉบับหนึ่ง
 */
export const GOOGLE_EXPORT: Record<string, { mimeType: string; extension: string }> = {
  'application/vnd.google-apps.document': {
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    extension: 'docx',
  },
  'application/vnd.google-apps.spreadsheet': {
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    extension: 'xlsx',
  },
  'application/vnd.google-apps.presentation': {
    mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    extension: 'pptx',
  },
};

/**
 * ชนิดของไฟล์ Google ที่เราไม่รองรับการนำเข้า
 *
 * ฟอร์ม แผนที่ และไซต์ ไม่มีรูปแบบไฟล์ที่ถือเป็น "เอกสาร" ได้จริง
 * การส่งออกเป็น PDF จะได้ภาพนิ่งที่ไม่สะท้อนสิ่งที่ผู้ใช้คิดว่ากำลังเก็บ
 */
const UNSUPPORTED_GOOGLE_MIME = new Set([
  'application/vnd.google-apps.form',
  'application/vnd.google-apps.map',
  'application/vnd.google-apps.site',
  'application/vnd.google-apps.script',
  'application/vnd.google-apps.fusiontable',
  'application/vnd.google-apps.drawing',
]);

export function classifyEntry(mimeType: string): DriveEntryKind {
  if (mimeType === FOLDER_MIME) return 'FOLDER';
  if (mimeType === SHORTCUT_MIME) return 'SHORTCUT';
  if (mimeType === 'application/vnd.google-apps.document') return 'GOOGLE_DOC';
  if (mimeType === 'application/vnd.google-apps.spreadsheet') return 'GOOGLE_SHEET';
  if (mimeType === 'application/vnd.google-apps.presentation') return 'GOOGLE_SLIDES';
  if (UNSUPPORTED_GOOGLE_MIME.has(mimeType)) return 'UNSUPPORTED';
  // ไฟล์ของ Google ชนิดอื่นที่เราไม่รู้จัก ก็ยังส่งออกไม่ได้เช่นกัน
  if (mimeType.startsWith('application/vnd.google-apps.')) return 'UNSUPPORTED';
  return 'BINARY';
}

/** นำเข้าได้หรือไม่ - โฟลเดอร์นำเข้าได้ในความหมายของการสร้างโครงสร้าง */
export function isImportable(kind: DriveEntryKind): boolean {
  return kind !== 'UNSUPPORTED';
}

/**
 * ชื่อไฟล์ที่ควรใช้ใน S2 NAS
 *
 * ไฟล์ของ Google ไม่มีนามสกุลในชื่อ ("รายงานประจำปี" ไม่ใช่ "รายงานประจำปี.docx")
 * ถ้าเก็บชื่อดิบไว้ ผู้ใช้จะดาวน์โหลดไปแล้วเปิดไม่ได้เพราะระบบปฏิบัติการไม่รู้ว่าเป็นไฟล์อะไร
 */
export function importedFileName(entry: DriveEntry): string {
  const exported = GOOGLE_EXPORT[entry.mimeType];
  if (!exported) return entry.name;

  const suffix = `.${exported.extension}`;
  return entry.name.toLowerCase().endsWith(suffix) ? entry.name : `${entry.name}${suffix}`;
}

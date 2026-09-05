/**
 * ตัวกรองการค้นหาฝั่งหน้าจอ
 *
 * ทำหน้าที่สองอย่าง:
 *   1. แปลงระหว่างตัวกรองกับ URL - เพื่อให้รีเฟรช บุ๊กมาร์ก และส่งลิงก์ให้กันได้
 *   2. เก็บ "ป้ายภาษาไทย" ของทุกตัวเลือกไว้ที่เดียว
 *
 * ผู้ใช้ไม่ควรต้องเห็นชื่อค่าภายในอย่าง EXTERNAL_UPLOAD หรือ HUMAN_CORRECTED
 * ชื่อพวกนี้เป็นเรื่องของฐานข้อมูล ไม่ใช่ภาษาที่คนทำงานเอกสารใช้
 */

export interface SearchFilters {
  fileKind?: string;
  driveScope?: string;
  ownerId?: string;
  createdById?: string;
  sourceType?: string;
  tagId?: string;
  untaggedOnly?: boolean;
  documentCategoryId?: string;
  uncategorizedOnly?: boolean;
  textSource?: string;
  ocrState?: string;
  hasText?: boolean;
  favoriteOnly?: boolean;
  uploadedPreset?: string;
  uploadedFrom?: string;
  uploadedTo?: string;
  updatedPreset?: string;
  updatedFrom?: string;
  updatedTo?: string;
  sort?: string;
}

/** คีย์ทั้งหมดที่เดินทางผ่าน URL - ต้องตรงกับ schema ฝั่งเซิร์ฟเวอร์ */
export const FILTER_KEYS = [
  'q',
  'type',
  'fileKind',
  'driveScope',
  'ownerId',
  'createdById',
  'sourceType',
  'tagId',
  'untaggedOnly',
  'documentCategoryId',
  'uncategorizedOnly',
  'textSource',
  'ocrState',
  'hasText',
  'favoriteOnly',
  'visibility',
  'uploadedPreset',
  'uploadedFrom',
  'uploadedTo',
  'updatedPreset',
  'updatedFrom',
  'updatedTo',
  'sort',
] as const;

export type FilterKey = (typeof FILTER_KEYS)[number];

/** คีย์ที่เป็นค่าจริง/เท็จ - ต้องแปลงกลับเป็น boolean เมื่ออ่านจาก URL */
const BOOLEAN_KEYS = new Set<string>(['untaggedOnly', 'uncategorizedOnly', 'hasText', 'favoriteOnly']);

/* ------------------------------------------------------------------ */
/* ป้ายภาษาไทย                                                          */
/* ------------------------------------------------------------------ */

export const FILE_KIND_LABELS: Record<string, string> = {
  pdf: 'PDF',
  image: 'รูปภาพ',
  word: 'Word',
  excel: 'Excel',
  powerpoint: 'PowerPoint',
  text: 'ข้อความ',
  link: 'ลิงก์',
  folder: 'โฟลเดอร์',
  other: 'อื่น ๆ',
};

export const TEXT_SOURCE_LABELS: Record<string, string> = {
  NATIVE_TEXT: 'ข้อความปกติ',
  OCR: 'OCR',
  HUMAN_CORRECTED: 'ตรวจแก้แล้ว',
};

/**
 * สถานะการอ่าน/ตรวจข้อความ
 *
 * ทุกค่าที่นี่สะท้อนสถานะที่ระบบรู้จริง ไม่มีสถานะที่แต่งขึ้นเพื่อให้เมนูดูสมบูรณ์
 */
export const OCR_STATE_LABELS: Record<string, string> = {
  PENDING: 'ยังไม่ประมวลผล',
  PROCESSING: 'กำลังประมวลผล',
  READY: 'พร้อมค้นหา',
  NEEDS_OCR: 'ต้องใช้ OCR',
  OCR_DONE: 'OCR สำเร็จ',
  FAILED: 'OCR ล้มเหลว',
  REVIEWED: 'ตรวจแล้ว',
};

export const SOURCE_TYPE_LABELS: Record<string, string> = {
  MANUAL: 'อัปโหลดเอง',
  GOOGLE: 'Google',
  S2_PAYROLL: 'S2 Payroll',
  S2_ERP: 'S2 ERP',
  S2_LINE_BOT: 'LINE Bot',
  EXTERNAL_UPLOAD: 'ลูกค้าอัปโหลด',
  SYSTEM: 'ระบบ',
};

export const DATE_PRESET_LABELS: Record<string, string> = {
  today: 'วันนี้',
  last7: '7 วันที่ผ่านมา',
  last30: '30 วันที่ผ่านมา',
  thisMonth: 'เดือนนี้',
  custom: 'กำหนดเอง',
};

export const SORT_LABELS: Record<string, string> = {
  relevance: 'เกี่ยวข้องมากที่สุด',
  newest: 'ล่าสุด',
  oldest: 'เก่าสุด',
  name: 'ชื่อ ก-ฮ',
  largest: 'ขนาดใหญ่สุด',
};

export const DRIVE_SCOPE_LABELS: Record<string, string> = {
  MY_DRIVE: 'ไดร์ฟของฉัน',
  SYSTEM_DRIVE: 'ไดร์ฟของระบบ',
};

/* ------------------------------------------------------------------ */
/* URL ↔ ตัวกรอง                                                        */
/* ------------------------------------------------------------------ */

/** อ่านตัวกรองออกจาก URL - ค่าที่ไม่รู้จักถูกละไว้ ไม่ทำให้ทั้งหน้าพัง */
export function filtersFromParams(params: URLSearchParams): SearchFilters {
  const filters: Record<string, string | boolean> = {};
  for (const key of FILTER_KEYS) {
    if (key === 'q') continue;
    const value = params.get(key);
    if (!value) continue;
    filters[key] = BOOLEAN_KEYS.has(key) ? value === 'true' : value;
  }
  return filters as SearchFilters;
}

/**
 * เขียนตัวกรองลง URL
 *
 * ค่าที่เป็นเท็จหรือว่างถูกลบออกจาก URL แทนที่จะเขียน "false" ลงไป
 * URL จึงสั้นและอ่านออก และไม่มีพารามิเตอร์ที่ไม่ได้ทำอะไรค้างอยู่
 */
export function paramsFromFilters(query: string, filters: SearchFilters): URLSearchParams {
  const params = new URLSearchParams();
  if (query) params.set('q', query);
  for (const [key, value] of Object.entries(filters)) {
    if (value === undefined || value === null || value === '' || value === false) continue;
    params.set(key, String(value));
  }
  return params;
}

/* ------------------------------------------------------------------ */
/* ป้ายของตัวกรองที่กำลังใช้อยู่                                          */
/* ------------------------------------------------------------------ */

export interface ActiveChip {
  key: FilterKey;
  label: string;
}

/**
 * แปลงตัวกรองที่กำลังใช้อยู่เป็นป้ายที่กดปิดได้
 *
 * ไม่รวมคำค้นและการเรียงลำดับ - คำค้นมีช่องของตัวเองอยู่แล้ว ส่วนการเรียง
 * ไม่ได้ "กรอง" อะไรออก การแสดงมันเป็นป้ายที่กดปิดได้จะทำให้ผู้ใช้เข้าใจผิด
 */
export function activeChips(
  filters: SearchFilters,
  lookups: {
    owners?: Map<string, string>;
    tags?: Map<string, string>;
    categories?: Map<string, string>;
  } = {},
): ActiveChip[] {
  const chips: ActiveChip[] = [];
  const add = (key: FilterKey, label: string) => chips.push({ key, label });

  if (filters.fileKind) add('fileKind', FILE_KIND_LABELS[filters.fileKind] ?? filters.fileKind);
  if (filters.driveScope) add('driveScope', DRIVE_SCOPE_LABELS[filters.driveScope] ?? filters.driveScope);
  if (filters.ownerId) add('ownerId', `ผู้ดูแล: ${lookups.owners?.get(filters.ownerId) ?? 'ที่เลือก'}`);
  if (filters.createdById) {
    add('createdById', `ผู้อัปโหลด: ${lookups.owners?.get(filters.createdById) ?? 'ที่เลือก'}`);
  }
  if (filters.sourceType) {
    add('sourceType', SOURCE_TYPE_LABELS[filters.sourceType] ?? filters.sourceType);
  }
  if (filters.tagId) add('tagId', `แท็ก: ${lookups.tags?.get(filters.tagId) ?? 'ที่เลือก'}`);
  if (filters.untaggedOnly) add('untaggedOnly', 'ยังไม่มีแท็ก');
  if (filters.documentCategoryId) {
    add(
      'documentCategoryId',
      `ประเภท: ${lookups.categories?.get(filters.documentCategoryId) ?? 'ที่เลือก'}`,
    );
  }
  if (filters.uncategorizedOnly) add('uncategorizedOnly', 'ยังไม่ระบุประเภท');
  if (filters.textSource) {
    add('textSource', TEXT_SOURCE_LABELS[filters.textSource] ?? filters.textSource);
  }
  if (filters.ocrState) add('ocrState', OCR_STATE_LABELS[filters.ocrState] ?? filters.ocrState);
  if (filters.hasText) add('hasText', 'มีข้อความในเอกสาร');
  if (filters.favoriteOnly) add('favoriteOnly', 'รายการโปรด');
  if (filters.uploadedPreset) {
    add('uploadedPreset', `อัปโหลด: ${DATE_PRESET_LABELS[filters.uploadedPreset] ?? filters.uploadedPreset}`);
  }
  if (filters.updatedPreset) {
    add('updatedPreset', `แก้ไข: ${DATE_PRESET_LABELS[filters.updatedPreset] ?? filters.updatedPreset}`);
  }

  return chips;
}

/** มีตัวกรองอะไรอยู่จริงหรือไม่ - การเรียงลำดับไม่นับว่าเป็นตัวกรอง */
export function hasActiveFilters(filters: SearchFilters): boolean {
  return activeChips(filters).length > 0;
}

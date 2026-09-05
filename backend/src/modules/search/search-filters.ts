/**
 * นิยามตัวกรองการค้นหาที่ใช้ร่วมกันทั้งระบบ
 *
 * ที่นี่คือ "แหล่งความจริงเดียว" ของรูปร่างตัวกรอง ทุกทางเข้าใช้ schema ตัวเดียวกันนี้:
 *
 *   - query string ของ GET /search
 *   - ตัวกรองที่ถูกเก็บใน SavedSearch.filters
 *   - ค่าตั้งต้นของมุมมองอัจฉริยะ (Smart View)
 *   - สถานะบน URL ของหน้าจอ
 *
 * เหตุผลที่ต้องเป็นตัวเดียวกัน: ชุดค้นหาที่บันทึกไว้เมื่อเดือนก่อนต้องให้ผลเหมือนเดิม
 * เมื่อเปิดใหม่ ถ้าแต่ละทางเข้ามี schema ของตัวเอง วันหนึ่งมันจะเพี้ยนจากกัน
 * และชุดที่บันทึกไว้จะกลายเป็นค้นหาคนละอย่างโดยไม่มีใครรู้ตัว
 *
 * ตัวกรองไม่เคยมีสิทธิ์ "ขยาย" สิ่งที่ผู้ใช้เห็น มันกรองให้แคบลงได้อย่างเดียว
 * เงื่อนไขสิทธิ์ถูกใส่ก่อนเสมอใน searchResources() และไม่มีตัวกรองใดถอดมันออกได้
 */
import { z } from 'zod';

/* ------------------------------------------------------------------ */
/* กลุ่มชนิดไฟล์ที่คนเข้าใจ                                             */
/* ------------------------------------------------------------------ */

/**
 * ผู้ใช้คิดเป็น "ไฟล์ Word" ไม่ใช่
 * "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
 *
 * การจับคู่ทำจากนามสกุลไฟล์ ไม่ใช่ MIME เพราะ MIME ที่ browser ส่งมาตอนอัปโหลด
 * เชื่อถือไม่ได้ ในขณะที่นามสกุลเป็นสิ่งที่ผู้ใช้เห็นและเข้าใจตรงกัน
 */
export const FILE_KIND_EXTENSIONS = {
  pdf: ['pdf'],
  image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'tif', 'tiff', 'svg', 'heic'],
  word: ['doc', 'docx', 'rtf', 'odt'],
  excel: ['xls', 'xlsx', 'csv', 'ods'],
  powerpoint: ['ppt', 'pptx', 'odp'],
  text: ['txt', 'md', 'log', 'json', 'xml', 'yml', 'yaml'],
} as const;

export type FileKind = keyof typeof FILE_KIND_EXTENSIONS | 'link' | 'folder' | 'other';

export const FILE_KINDS: FileKind[] = [
  'pdf',
  'image',
  'word',
  'excel',
  'powerpoint',
  'text',
  'link',
  'folder',
  'other',
];

/** นามสกุลทั้งหมดที่ถูกจัดกลุ่มไว้แล้ว - ใช้หา "อื่น ๆ" ด้วยการยกเว้น */
const CLASSIFIED_EXTENSIONS = Object.values(FILE_KIND_EXTENSIONS).flat();

/* ------------------------------------------------------------------ */
/* schema ของตัวกรอง                                                    */
/* ------------------------------------------------------------------ */

/**
 * ช่วงวันที่แบบสำเร็จรูป
 *
 * ผู้ใช้คิดเป็น "เดือนนี้" ไม่ใช่ "2026-09-01T00:00:00Z ถึง 2026-09-30T23:59:59Z"
 * แต่ฐานข้อมูลต้องการอย่างหลัง การแปลงจึงเกิดที่เซิร์ฟเวอร์ตอนค้นหาจริง
 * ไม่ใช่ตอนบันทึกชุดค้นหา - "เดือนนี้" ที่บันทึกไว้เดือนสิงหาคม
 * ต้องหมายถึงเดือนกันยายนเมื่อเปิดในเดือนกันยายน
 */
export const DATE_PRESETS = ['today', 'last7', 'last30', 'thisMonth', 'custom'] as const;
export type DatePreset = (typeof DATE_PRESETS)[number];

export const searchFiltersSchema = z
  .object({
    /** กลุ่มชนิดไฟล์ที่คนเข้าใจ ไม่ใช่ MIME */
    fileKind: z.enum(['pdf', 'image', 'word', 'excel', 'powerpoint', 'text', 'link', 'folder', 'other']).optional(),
    driveScope: z.enum(['MY_DRIVE', 'SYSTEM_DRIVE']).optional(),
    /** ผู้ดูแล - ไม่ใช่ผู้สร้าง สองอย่างนี้ต่างกันและมักไม่ใช่คนเดียวกัน */
    ownerId: z.string().min(1).max(191).optional(),
    /** ผู้ที่อัปโหลด/สร้างรายการนี้เข้ามา */
    createdById: z.string().min(1).max(191).optional(),
    sourceType: z
      .enum(['MANUAL', 'GOOGLE', 'S2_PAYROLL', 'S2_ERP', 'S2_LINE_BOT', 'EXTERNAL_UPLOAD', 'SYSTEM'])
      .optional(),
    tagId: z.string().min(1).max(191).optional(),
    /** ยังไม่ได้ติดแท็กเลย - ใช้ตามหาเอกสารที่ตกหล่นจากการจัดระเบียบ */
    untaggedOnly: z.boolean().optional(),
    documentCategoryId: z.string().min(1).max(191).optional(),
    /** ยังไม่ได้จัดประเภท */
    uncategorizedOnly: z.boolean().optional(),
    /** ที่มาของข้อความที่ค้นได้ */
    textSource: z.enum(['NATIVE_TEXT', 'OCR', 'HUMAN_CORRECTED']).optional(),
    /** สถานะการอ่าน/ตรวจข้อความ - ค่าที่ระบบรู้จริง ไม่ใช่สถานะสมมุติ */
    ocrState: z
      .enum(['PENDING', 'PROCESSING', 'READY', 'NEEDS_OCR', 'OCR_DONE', 'FAILED', 'REVIEWED'])
      .optional(),
    /** มีข้อความที่ค้นได้อยู่ข้างในหรือไม่ */
    hasText: z.boolean().optional(),
    favoriteOnly: z.boolean().optional(),
    /** วันที่อัปโหลด (createdAt) */
    uploadedPreset: z.enum(DATE_PRESETS).optional(),
    uploadedFrom: z.coerce.date().optional(),
    uploadedTo: z.coerce.date().optional(),
    /** วันที่แก้ไข (updatedAt) */
    updatedPreset: z.enum(DATE_PRESETS).optional(),
    updatedFrom: z.coerce.date().optional(),
    updatedTo: z.coerce.date().optional(),
    /* ---- วงจรชีวิตเอกสาร (F16) ---- */
    /**
     * ใช้งานอยู่ / เก็บเข้าคลัง / ทั้งหมด
     *
     * ค่าเริ่มต้นของการค้นหาคือ "ทั้งหมด" โดยตั้งใจ - ผู้ใช้ที่พิมพ์ชื่อเอกสาร
     * แล้วไม่เจอเพราะมันถูกเก็บเข้าคลังไปแล้ว จะสรุปว่าเอกสารหายไป
     * การค้นหาต้องหาเจอเสมอ ส่วนการ "ไม่เกะกะ" เป็นเรื่องของหน้าเรียกดู
     */
    lifecycleState: z.enum(['ACTIVE', 'ARCHIVED']).optional(),
    retentionPolicyId: z.string().min(1).max(191).optional(),
    /** สถานะการเก็บรักษา - คำนวณจากวันหมดอายุและการระงับ */
    retentionStatus: z.enum(['NONE', 'ACTIVE', 'EXPIRING', 'EXPIRED', 'FOREVER']).optional(),
    /** เฉพาะเอกสารที่ถูกระงับการลบอยู่ */
    legalHoldOnly: z.boolean().optional(),
    sort: z.enum(['relevance', 'newest', 'oldest', 'name', 'largest']).optional(),
  })
  .strict();

export type SearchFilters = z.infer<typeof searchFiltersSchema>;

/* ------------------------------------------------------------------ */
/* ช่วงวันที่                                                           */
/* ------------------------------------------------------------------ */

/**
 * แปลงช่วงวันที่สำเร็จรูปเป็นช่วงเวลาจริง
 *
 * คำนวณที่เซิร์ฟเวอร์เสมอ ไม่รับช่วงเวลาที่ browser คำนวณมาให้
 * เพราะนาฬิกาและโซนเวลาของเครื่องผู้ใช้เชื่อถือไม่ได้ และผลการค้นหา
 * ที่ต่างกันตามเครื่องที่ใช้เปิดคือสิ่งที่อธิบายให้ผู้ใช้ฟังไม่ได้
 */
export function resolveDateRange(
  preset: DatePreset | undefined,
  from: Date | undefined,
  to: Date | undefined,
  now: Date = new Date(),
): { gte?: Date; lte?: Date } | null {
  if (preset === 'custom' || (!preset && (from || to))) {
    if (!from && !to) return null;
    return { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) };
  }
  if (!preset) return null;

  const startOfDay = new Date(now);
  startOfDay.setHours(0, 0, 0, 0);

  switch (preset) {
    case 'today':
      return { gte: startOfDay };
    case 'last7': {
      const start = new Date(startOfDay);
      start.setDate(start.getDate() - 6);
      return { gte: start };
    }
    case 'last30': {
      const start = new Date(startOfDay);
      start.setDate(start.getDate() - 29);
      return { gte: start };
    }
    case 'thisMonth': {
      const start = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
      return { gte: start };
    }
    default:
      return null;
  }
}

/* ------------------------------------------------------------------ */
/* ชนิดไฟล์                                                             */
/* ------------------------------------------------------------------ */

/** ชนิดทรัพยากรที่ถือว่าเป็น "ลิงก์ภายนอก" */
const LINK_TYPES = ['GOOGLE_SHEET', 'GOOGLE_DOC', 'GOOGLE_DRIVE', 'WEB_LINK', 'SHORTCUT'] as const;

export interface FileKindCondition {
  type?: { in: string[] } | { equals: string };
  extension?: { in: string[] } | { notIn: string[] } | null;
  isExtensionNull?: boolean;
}

/**
 * เงื่อนไขฐานข้อมูลของกลุ่มชนิดไฟล์หนึ่งกลุ่ม
 *
 * คืนรูปที่ประกอบเข้ากับ Prisma where ได้ตรง ๆ โดยผู้เรียกไม่ต้องรู้ว่าภายในจัดกลุ่มอย่างไร
 */
export function fileKindWhere(kind: FileKind): Record<string, unknown> {
  if (kind === 'folder') return { type: 'FOLDER' };
  if (kind === 'link') return { type: { in: [...LINK_TYPES] } };

  if (kind === 'other') {
    /**
     * "อื่น ๆ" คือไฟล์ที่ไม่เข้ากลุ่มไหนเลย นิยามด้วยการยกเว้น ไม่ใช่การไล่รายชื่อ
     * เพราะรายชื่อจะล้าสมัยทันทีที่มีคนอัปโหลดนามสกุลที่ไม่เคยเจอ
     */
    return {
      type: { in: ['FILE', 'SYSTEM_FILE'] },
      OR: [{ extension: null }, { extension: { notIn: CLASSIFIED_EXTENSIONS } }],
    };
  }

  return {
    type: { in: ['FILE', 'SYSTEM_FILE'] },
    extension: { in: [...FILE_KIND_EXTENSIONS[kind]] },
  };
}

/* ------------------------------------------------------------------ */
/* สถานะข้อความ/OCR                                                     */
/* ------------------------------------------------------------------ */

/**
 * เงื่อนไข SQL ของสถานะการอ่าน/ตรวจข้อความ บนดัชนีของ "เวอร์ชันปัจจุบัน" เท่านั้น
 *
 * ต้องผูกกับเวอร์ชันปัจจุบันเสมอ ไม่อย่างนั้นไฟล์ที่เคย OCR ล้มเหลวใน v1
 * แล้วอัปโหลด v2 ที่อ่านได้ดีจะยังโผล่ในตัวกรอง "OCR ล้มเหลว" ตลอดไป
 *
 * Prisma เทียบคอลัมน์ของตารางลูกกับตารางแม่ในเงื่อนไข relation ไม่ได้
 * จึงใช้ SQL ตรงเหมือนที่ contentMatchResourceIds ทำอยู่แล้ว
 *
 * ทุกค่าที่รองรับสะท้อนสถานะที่ระบบรู้จริงจาก F12/F13/F14 ไม่มีสถานะที่แต่งขึ้น
 * ผู้ใช้ที่กรอง "OCR ล้มเหลว" แล้วได้รายการมา ต้องกดแก้ไขได้จริงทุกรายการ
 */
export function ocrStateCondition(state: NonNullable<SearchFilters['ocrState']>): string {
  switch (state) {
    case 'PENDING':
      return "i.status = 'PENDING'";
    case 'PROCESSING':
      return "i.status = 'PROCESSING'";
    case 'READY':
      return "i.status = 'READY'";
    case 'NEEDS_OCR':
      // เอกสารที่การสกัดปกติไม่ได้ข้อความ และยังไม่เคยมีใครสั่ง OCR - กลุ่มที่ OCR ช่วยได้
      return "i.status IN ('NO_TEXT','UNSUPPORTED') AND i.ocrRequested = 0";
    case 'OCR_DONE':
      return "i.status = 'READY' AND i.textSource IN ('OCR','HUMAN_CORRECTED')";
    case 'FAILED':
      return "i.status = 'FAILED'";
    case 'REVIEWED':
      return "i.reviewStatus IN ('VERIFIED','CORRECTED')";
    default:
      return '1 = 0';
  }
}

/** เงื่อนไข "มีข้อความที่ค้นได้อยู่ข้างใน" บนดัชนีของเวอร์ชันปัจจุบัน */
export function hasTextCondition(hasText: boolean): string {
  return hasText
    ? "i.status = 'READY' AND i.normalizedText IS NOT NULL AND i.normalizedText <> ''"
    : "i.status <> 'READY' OR i.normalizedText IS NULL OR i.normalizedText = ''";
}

/* ------------------------------------------------------------------ */
/* การเรียงลำดับ                                                        */
/* ------------------------------------------------------------------ */

export type SortKey = NonNullable<SearchFilters['sort']>;

/**
 * ลำดับที่ฐานข้อมูลทำได้จริง
 *
 * "เกี่ยวข้องมากที่สุด" ไม่อยู่ที่นี่ เพราะความเกี่ยวข้องถูกคำนวณหลังดึงข้อมูลมาแล้ว
 * (rankOf ใน content-match.ts) การอ้างว่าฐานข้อมูลเรียงตามความเกี่ยวข้องได้
 * ทั้งที่มันไม่รู้จักคำค้นเลย จะเป็นการโกหกผู้ใช้
 */
export function orderByFor(sort: SortKey | undefined): Array<Record<string, 'asc' | 'desc'>> {
  switch (sort) {
    case 'newest':
      return [{ updatedAt: 'desc' }, { id: 'asc' }];
    case 'oldest':
      return [{ updatedAt: 'asc' }, { id: 'asc' }];
    case 'name':
      return [{ normalizedName: 'asc' }, { id: 'asc' }];
    case 'largest':
      return [{ size: 'desc' }, { id: 'asc' }];
    default:
      // ค่าเริ่มต้นเดิมของระบบ - โฟลเดอร์ก่อน แล้วค่อยเรียงตามการแก้ไขล่าสุด
      return [{ type: 'asc' }, { updatedAt: 'desc' }, { id: 'asc' }];
  }
}

/** ตัวกรองนี้มีเงื่อนไขอะไรอยู่จริงหรือไม่ - ใช้ตัดสินว่าจะแสดงปุ่ม "ล้างตัวกรอง" ไหม */
export function hasAnyFilter(filters: SearchFilters): boolean {
  return Object.entries(filters).some(([key, value]) => {
    if (key === 'sort') return false;
    return value !== undefined && value !== null && value !== false;
  });
}

/* ------------------------------------------------------------------ */
/* สถานะการเก็บรักษา                                                    */
/* ------------------------------------------------------------------ */

/**
 * จำนวนวันที่ถือว่า "ใกล้ครบกำหนด"
 *
 * สามสิบวันให้เวลาพอที่จะตัดสินใจว่าจะต่ออายุ เก็บเข้าคลัง หรือปล่อยให้หมดอายุ
 * โดยไม่ต้องรีบร้อน และไม่ยาวจนรายการยาวเกินกว่าจะมีใครดูจริง
 */
export const EXPIRING_SOON_DAYS = 30;

export type RetentionStatus = NonNullable<SearchFilters['retentionStatus']>;

/**
 * เงื่อนไขฐานข้อมูลของสถานะการเก็บรักษาแต่ละแบบ
 *
 * "หมดอายุแล้ว" ไม่ได้แปลว่าต้องลบทันที - แปลว่า "ลบได้แล้วถ้ากติกาอื่นอนุญาต"
 * ระบบไม่เคยลบเอกสารเองเพียงเพราะนโยบายหมดอายุ
 */
export function retentionStatusWhere(
  status: RetentionStatus,
  now: Date = new Date(),
): Record<string, unknown> {
  const soon = new Date(now);
  soon.setDate(soon.getDate() + EXPIRING_SOON_DAYS);

  switch (status) {
    case 'NONE':
      // ยังไม่มีใครกำหนดนโยบายให้ - กลุ่มที่ต้องตามเก็บ
      return { retentionPolicyId: null };
    case 'FOREVER':
      return { retentionForever: true };
    case 'ACTIVE':
      return { retentionForever: false, retentionUntil: { gt: soon } };
    case 'EXPIRING':
      return { retentionForever: false, retentionUntil: { gt: now, lte: soon } };
    case 'EXPIRED':
      return { retentionForever: false, retentionUntil: { lte: now } };
    default:
      return {};
  }
}

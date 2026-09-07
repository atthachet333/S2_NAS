/**
 * การส่งออกบันทึกการตรวจสอบเป็น CSV
 *
 * ใช้ตัวกรองและด่านสิทธิ์ชุดเดียวกับหน้าจอทุกประการ - ไม่มีเส้นทางค้นหาชุดที่สอง
 * ที่ "กว้างกว่า" สำหรับการส่งออก เพราะเส้นทางที่สองคือที่ที่ข้อมูลรั่วโดยไม่มีใครสังเกต
 */
import { prisma } from '../../core/prisma.js';
import { AppError } from '../../core/errors.js';
import { logger } from '../../core/logger.js';
import {
  assertCanExport,
  searchAuditEvents,
  type AuditEventDto,
  type AuditFilters,
} from './audit.service.js';
import { CATEGORY_LABELS } from './event-catalog.js';
import type { AuthUser } from '../auth/auth.service.js';

/**
 * เพดานจำนวนแถวต่อการส่งออกหนึ่งครั้ง
 *
 * ไม่เปิดให้ส่งออกไม่จำกัด - คำขอที่กินหน่วยความจำหลายกิกะไบต์จะทำให้เซิร์ฟเวอร์
 * ล่มทั้งเครื่อง และผู้ที่กดก็จะไม่ได้ไฟล์อยู่ดี บอกให้เขาแคบตัวกรองลงตรงไปตรงมากว่า
 */
export const EXPORT_MAX_ROWS = 50_000;

/** ดึงทีละหน้าเพื่อไม่ให้ถือทั้งชุดไว้ในหน่วยความจำพร้อมกันตั้งแต่ต้น */
const PAGE_SIZE = 500;

const COLUMNS = [
  'วันที่เวลา (เวลาไทย)',
  'เหตุการณ์',
  'รหัสเหตุการณ์',
  'หมวดหมู่',
  'ผู้ดำเนินการ',
  'ประเภทผู้ใช้',
  'อีเมล',
  'ทรัพยากร',
  'ประเภททรัพยากร',
  'IP',
  'อุปกรณ์',
  'รายละเอียด',
] as const;

const ACTOR_TYPE_LABELS: Record<string, string> = {
  INTERNAL: 'บุคลากร',
  EXTERNAL: 'ลูกค้า',
  SERVICE: 'บัญชีบริการ',
  SYSTEM: 'ระบบ',
  INTEGRATION: 'การเชื่อมต่อ',
};

/**
 * ป้องกันสูตรใน spreadsheet
 *
 * ค่าที่ขึ้นต้นด้วย = + - @ หรือ tab/CR ถูก Excel และ Google Sheets ตีความเป็นสูตร
 * ชื่อไฟล์อย่าง "=cmd|'/c calc'!A1" ที่ผู้ใช้ตั้งเองได้ จึงกลายเป็นคำสั่งที่รันบนเครื่อง
 * ของคนที่เปิดไฟล์ตรวจสอบ - เป็นช่องทางโจมตีที่ผ่านระบบเราไปโดยไม่แตะอะไรเลย
 *
 * เติม single quote นำหน้า ซึ่งเป็นวิธีที่ spreadsheet เข้าใจว่า "นี่คือข้อความ"
 * และยังอ่านค่าเดิมออกได้ครบ
 */
export function escapeCsvValue(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return '';
  const text = String(value);

  const dangerous = /^[=+\-@\t\r]/.test(text);
  const guarded = dangerous ? `'${text}` : text;

  // อัญประกาศคู่ภายในต้องถูกซ้ำตามมาตรฐาน CSV
  return `"${guarded.replace(/"/g, '""')}"`;
}

/** แปลงรายละเอียดที่ผ่านบัญชีอนุญาตแล้วเป็นข้อความสั้น ๆ */
function formatDetails(details: Record<string, string | number | boolean>): string {
  const entries = Object.entries(details);
  if (entries.length === 0) return '';
  return entries.map(([key, value]) => `${key}=${value}`).join('; ').slice(0, 500);
}

/**
 * เวลาในไฟล์ต้องตรงกับเวลาบนหน้าจอ
 *
 * ถ้าไฟล์เขียนเป็น UTC แต่หน้าจอแสดงเวลาไทย ตัวเลขจะต่างกัน 7 ชั่วโมง
 * ผู้ตรวจสอบที่เทียบสองแหล่งจะสรุปว่ามีเหตุการณ์ที่ไม่ตรงกัน หรือแย่กว่านั้นคือ
 * สรุปว่าเหตุการณ์เกิดนอกเวลาทำการทั้งที่เกิดตอนบ่าย
 *
 * รูปแบบ YYYY-MM-DD HH:mm:ss เพราะ Excel อ่านเป็นวันเวลาได้ทันที และเรียงลำดับถูกต้อง
 * ส่วนโซนเวลาบอกไว้ที่หัวคอลัมน์ ไม่ใช่ต่อท้ายทุกแถวซึ่งจะทำให้ Excel อ่านไม่ออก
 */
const TIMEZONE = 'Asia/Bangkok';

export function formatExportTimestamp(value: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(value);

  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')}`;
}

function formatRow(event: AuditEventDto): string {
  const cells = [
    formatExportTimestamp(event.createdAt),
    event.label,
    event.action,
    CATEGORY_LABELS[event.category] ?? event.category,
    event.actor.displayName,
    ACTOR_TYPE_LABELS[event.actor.type] ?? event.actor.type,
    event.actor.email ?? '',
    event.resource ? (event.resource.name ?? 'ทรัพยากรถูกลบแล้ว') : '',
    event.resource?.type ?? '',
    event.ipAddress ?? '',
    event.userAgent ?? '',
    formatDetails(event.details),
  ];
  return cells.map(escapeCsvValue).join(',');
}

export interface ExportResult {
  filename: string;
  /** เนื้อไฟล์พร้อม BOM */
  content: string;
  rowCount: number;
}

/**
 * สร้างชื่อไฟล์ที่เซิร์ฟเวอร์กำหนดเอง
 *
 * ไม่รับชื่อจากผู้ใช้เลย - ชื่อไฟล์ที่ผู้ใช้กำหนดได้คือทางเข้าของ path traversal
 * และของอักขระที่ทำให้ header ของ HTTP เพี้ยน
 */
export function exportFilename(now: Date = new Date()): string {
  const date = now.toISOString().slice(0, 10);
  return `s2-nas-audit-${date}.csv`;
}

/** สรุปตัวกรองแบบสั้นสำหรับบันทึกลง audit - ไม่ใส่เนื้อหาที่ส่งออก */
export function summarizeFilters(filters: AuditFilters): string {
  const parts: string[] = [];
  if (filters.preset) parts.push(`preset=${filters.preset}`);
  if (filters.category) parts.push(`category=${filters.category}`);
  if (filters.action) parts.push(`action=${filters.action}`);
  if (filters.actorId) parts.push('actor=set');
  if (filters.actorType) parts.push(`actorType=${filters.actorType}`);
  if (filters.resourceId) parts.push('resource=set');
  if (filters.failuresOnly) parts.push('failuresOnly');
  if (filters.q) parts.push('q=set');
  return parts.join(' ') || 'ไม่มีตัวกรอง';
}

/**
 * ส่งออกผลลัพธ์ตามตัวกรองปัจจุบัน
 *
 * ตัว export เองถูกบันทึกเป็นเหตุการณ์ - การนำบันทึกออกนอกระบบเป็นการกระทำ
 * ที่ผู้ตรวจสอบคนถัดไปต้องเห็นได้ว่าใครทำ เมื่อไร ด้วยเงื่อนไขอะไร และได้ไปกี่แถว
 *
 * **ไม่บันทึกเนื้อหาที่ส่งออก** - บันทึกว่าส่งออกอะไรไป ไม่ใช่ทำสำเนาไว้อีกชุด
 */
export async function exportAuditCsv(
  user: AuthUser,
  filters: AuditFilters,
  audit: { ipAddress?: string; userAgent?: string },
): Promise<ExportResult> {
  assertCanExport(user);

  const lines: string[] = [COLUMNS.map(escapeCsvValue).join(',')];
  let rowCount = 0;
  let cursor: string | undefined;

  while (rowCount < EXPORT_MAX_ROWS) {
    const remaining = EXPORT_MAX_ROWS - rowCount;
    const page = await searchAuditEvents(user, filters, {
      limit: Math.min(PAGE_SIZE, remaining),
      cursor,
    });

    for (const event of page.items) {
      lines.push(formatRow(event));
      rowCount += 1;
    }

    if (!page.nextCursor) break;
    cursor = page.nextCursor;

    /**
     * ถึงเพดานแล้วแต่ยังมีข้อมูลเหลือ - ปฏิเสธแทนที่จะส่งไฟล์ที่ไม่ครบ
     *
     * ไฟล์ที่ถูกตัดกลางคันคืออันตรายที่สุดในงานตรวจสอบ เพราะดูเหมือนสมบูรณ์
     * และคนจะสรุปว่า "ไม่มีเหตุการณ์หลังจากนี้" ทั้งที่มี
     */
    if (rowCount >= EXPORT_MAX_ROWS) {
      throw new AppError(
        'AUDIT_EXPORT_TOO_LARGE',
        `ผลลัพธ์เกิน ${EXPORT_MAX_ROWS.toLocaleString('th-TH')} รายการ กรุณาแคบช่วงวันที่หรือเพิ่มตัวกรอง`,
        413,
      );
    }
  }

  await prisma.activityLog.create({
    data: {
      userId: user.id,
      action: 'AUDIT_LOG_EXPORTED',
      ipAddress: audit.ipAddress,
      userAgent: audit.userAgent?.slice(0, 500),
      metadata: {
        rowCount,
        format: 'CSV',
        from: filters.from?.toISOString() ?? null,
        to: filters.to?.toISOString() ?? null,
        filterSummary: summarizeFilters(filters),
      },
    },
  });

  logger.info(`[AUDIT] ส่งออกบันทึกกิจกรรม ${rowCount} รายการ โดย ${user.email}`);

  return {
    filename: exportFilename(),
    /**
     * BOM นำหน้าเพื่อให้ Excel บนเครื่อง Windows อ่านภาษาไทยออก
     *
     * ถ้าไม่มี Excel จะเดา encoding เป็น ANSI และภาษาไทยจะกลายเป็นอักขระขยะ
     * ซึ่งทำให้ไฟล์ตรวจสอบที่ส่งให้ผู้สอบบัญชีใช้ไม่ได้เลย
     */
    content: `﻿${lines.join('\r\n')}\r\n`,
    rowCount,
  };
}

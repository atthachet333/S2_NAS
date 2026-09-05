import { Prisma } from '@prisma/client';
import { prisma } from '../../core/prisma.js';
import { normalizeForSearch } from './extract/normalize.js';

/**
 * การจับคู่คำค้นกับเนื้อในเอกสาร
 *
 * ทำไมไม่ใช้ FULLTEXT ของ MariaDB
 * -------------------------------
 * FULLTEXT ตัดคำด้วยช่องว่างและเครื่องหมายวรรคตอน ซึ่งเป็นสมมติฐานของภาษาที่มีช่องว่าง
 * ภาษาไทยเขียนติดกันทั้งประโยค ทั้งประโยคจึงกลายเป็น "คำ" เดียว
 * ผลคือค้น "ภาษี" จะไม่เจอ "ใบกำกับภาษี" ซึ่งเป็นสิ่งที่ผู้ใช้คาดหวังที่สุด
 *
 * ที่นี่จึงใช้การหาข้อความย่อย (LIKE) บนคอลัมน์ที่ปรับรูปแบบไว้แล้ว
 * ซึ่งให้ผลถูกต้องกับทั้งไทยและอังกฤษ
 *
 * ราคาที่ต้องจ่ายอย่างตรงไปตรงมา: LIKE '%คำ%' ใช้ดัชนีไม่ได้ จึงเป็นการไล่อ่านแถว
 * ระบบนี้เป็นพื้นที่เก็บเอกสารขององค์กรเดียว จำนวนแถวอยู่ในหลักหมื่น
 * และการค้นถูกจำกัดจำนวนผลลัพธ์ไว้ จึงยอมรับได้ ถ้าปริมาณโตขึ้นมาก
 * ทางแก้คือ n-gram parser ของ MariaDB หรือดัชนีคำแยกต่างหาก ไม่ใช่การถอยไปใช้ FULLTEXT ปกติ
 */

/** จำนวนทรัพยากรสูงสุดที่การจับคู่เนื้อหาคืนกลับมาในหนึ่งคำค้น */
const CONTENT_CANDIDATE_LIMIT = 500;

export const MIN_CONTENT_QUERY_LENGTH = 2;

/** อักขระพิเศษของ LIKE - ใช้ ! เป็นตัว escape เพราะ backslash ต้อง escape ซ้ำหลายชั้น */
function escapeLike(value: string): string {
  return value.replace(/[!%_]/g, (match) => `!${match}`);
}

/**
 * หารหัสทรัพยากรที่ "เนื้อในเวอร์ชันปัจจุบัน" ตรงกับคำค้น
 *
 * เงื่อนไข versionNumber = currentVersion คือหัวใจของความถูกต้องตามเวอร์ชัน
 * ข้อความของเวอร์ชันเก่ายังอยู่ในตาราง แต่ไม่มีทางถูกคืนเป็นผลลัพธ์ปัจจุบัน
 *
 * ฟังก์ชันนี้ไม่รู้เรื่องสิทธิ์เลยโดยตั้งใจ - ผู้เรียกต้องนำรหัสที่ได้ไปกรองด้วย
 * เงื่อนไขสิทธิ์ของตัวเองเสมอ การคืนรหัสที่ผู้ใช้ไม่มีสิทธิ์เห็นออกไปตรง ๆ
 * จึงเป็นความผิดของผู้เรียก ไม่ใช่ของที่นี่ (ดูการใช้งานใน search.service และ portal-search)
 */
export async function contentMatchResourceIds(term: string): Promise<string[]> {
  const query = normalizeForSearch(term);
  if (query.length < MIN_CONTENT_QUERY_LENGTH) return [];

  const pattern = `%${escapeLike(query)}%`;

  const rows = await prisma.$queryRaw<Array<{ resourceId: string }>>(Prisma.sql`
    SELECT i.resourceId AS resourceId
    FROM resource_search_index i
    INNER JOIN resources r
      ON r.id = i.resourceId
     AND r.currentVersion = i.versionNumber
    WHERE i.status = 'READY'
      AND r.deletedAt IS NULL
      AND i.normalizedText LIKE ${pattern} ESCAPE '!'
    LIMIT ${CONTENT_CANDIDATE_LIMIT}
  `);

  return [...new Set(rows.map((row) => row.resourceId))];
}

/* ------------------------------------------------------------------ */
/* ตัวอย่างข้อความรอบคำค้น                                              */
/* ------------------------------------------------------------------ */

/** ความยาวของตัวอย่างข้อความที่ตัดมาแสดง */
const SNIPPET_RADIUS = 60;
const SNIPPET_MAX = 200;

export interface ContentSnippet {
  resourceId: string;
  snippet: string;
}

/** ตัวอย่างข้อความพร้อมที่มา - NATIVE_TEXT เชื่อถือได้กว่า OCR ซึ่งเป็นการคาดเดา */
export interface ContentSnippetInfo {
  snippet: string;
  textSource: string | null;
}

/**
 * ตัดข้อความรอบตำแหน่งที่ตรงกับคำค้น
 *
 * ข้อความที่คืนเป็นข้อความล้วนเสมอ ไม่มีแท็กและไม่มีเครื่องหมายไฮไลต์ใด ๆ
 * การเน้นคำเป็นหน้าที่ของหน้าจอ ซึ่งทำได้จากตำแหน่งที่ตรงกันโดยไม่ต้องแทรก HTML
 * นี่คือเหตุผลที่ไม่มีทางเกิดการฉีดสคริปต์จากเนื้อในเอกสารที่ผู้ใช้อัปโหลด
 */
export function buildSnippet(text: string, term: string): string | null {
  const haystack = normalizeForSearch(text);
  const needle = normalizeForSearch(term);
  if (!needle) return null;

  const at = haystack.indexOf(needle);
  if (at < 0) return null;

  /**
   * ตำแหน่งอ้างอิงจากข้อความที่ปรับรูปแบบแล้ว ซึ่งอาจสั้นกว่าต้นฉบับเล็กน้อย
   * จึงตัดจากข้อความที่ปรับรูปแบบแล้วด้วย เพื่อให้ตำแหน่งกับเนื้อหาตรงกันเสมอ
   */
  const start = Math.max(0, at - SNIPPET_RADIUS);
  const end = Math.min(haystack.length, at + needle.length + SNIPPET_RADIUS);

  let snippet = haystack.slice(start, end).trim();
  if (snippet.length > SNIPPET_MAX) snippet = snippet.slice(0, SNIPPET_MAX).trim();

  const prefix = start > 0 ? '…' : '';
  const suffix = end < haystack.length ? '…' : '';
  return `${prefix}${snippet}${suffix}`;
}

/**
 * ดึงตัวอย่างข้อความของทรัพยากรที่ระบุ
 *
 * รับเฉพาะรหัสที่ผ่านการกรองสิทธิ์มาแล้วเท่านั้น - ผู้เรียกต้องกรองก่อนเสมอ
 * ที่นี่ไม่ตรวจสิทธิ์ซ้ำ แต่ก็ไม่มีทางถูกเรียกด้วยรหัสที่ยังไม่ผ่านการกรอง
 * เพราะทุกจุดที่เรียกส่งเข้ามาเฉพาะรายการที่กำลังจะแสดงผลอยู่แล้ว
 */
export async function snippetsFor(
  allowedResourceIds: string[],
  term: string,
): Promise<Map<string, ContentSnippetInfo>> {
  const result = new Map<string, ContentSnippetInfo>();
  if (allowedResourceIds.length === 0) return result;

  const rows = await prisma.$queryRaw<
    Array<{ resourceId: string; extractedText: string | null; textSource: string | null }>
  >(Prisma.sql`
    SELECT i.resourceId AS resourceId, i.extractedText AS extractedText, i.textSource AS textSource
    FROM resource_search_index i
    INNER JOIN resources r
      ON r.id = i.resourceId
     AND r.currentVersion = i.versionNumber
    WHERE i.status = 'READY'
      AND i.resourceId IN (${Prisma.join(allowedResourceIds)})
  `);

  for (const row of rows) {
    if (!row.extractedText) continue;
    const snippet = buildSnippet(row.extractedText, term);
    /**
     * ที่มาของข้อความเดินทางไปพร้อมกับตัวอย่าง
     * ผู้ใช้ที่เห็นผลลัพธ์ต้องรู้ว่ากำลังอ่านข้อความจากไฟล์จริง หรือจากการที่เครื่องอ่านภาพ
     */
    if (snippet) result.set(row.resourceId, { snippet, textSource: row.textSource });
  }

  return result;
}

/* ------------------------------------------------------------------ */
/* เหตุผลที่ผลลัพธ์ตรงกับคำค้น                                          */
/* ------------------------------------------------------------------ */

export type MatchReason = 'NAME' | 'TAG' | 'REMARK' | 'CONTENT';

export const MATCH_REASON_LABEL: Record<MatchReason, string> = {
  NAME: 'ตรงกับชื่อไฟล์',
  TAG: 'ตรงกับแท็ก',
  REMARK: 'ตรงกับหมายเหตุ',
  CONTENT: 'ตรงกับเนื้อหาเอกสาร',
};

/**
 * เหตุผลเดียวต่อหนึ่งผลลัพธ์ - เรียงตามความชัดเจนที่ผู้ใช้คาดหวัง
 *
 * ชื่อไฟล์ชัดที่สุดเพราะผู้ใช้มักจำชื่อได้ ส่วนเนื้อหาอยู่ท้ายสุด
 * เพราะเป็นการค้นเจอที่ต้องอธิบายมากที่สุด และเป็นจุดที่ตัวอย่างข้อความช่วยได้
 */
export function matchReasonFor(input: {
  name: string;
  remark: string | null;
  tags: string[];
  term: string;
  hasContentMatch: boolean;
}): MatchReason | null {
  const needle = normalizeForSearch(input.term);
  if (!needle) return null;

  if (normalizeForSearch(input.name).includes(needle)) return 'NAME';
  if (input.tags.some((tag) => normalizeForSearch(tag).includes(needle))) return 'TAG';
  if (input.remark && normalizeForSearch(input.remark).includes(needle)) return 'REMARK';
  if (input.hasContentMatch) return 'CONTENT';
  return null;
}

/**
 * ลำดับความสำคัญของผลลัพธ์
 *
 * ตั้งใจให้เรียบง่ายและอธิบายได้ ไม่ใช่ระบบให้คะแนนความเกี่ยวข้องเต็มรูปแบบ
 *
 *   ชื่อที่ตรงทั้งชื่อ > ขึ้นต้นด้วยคำค้น > ชื่อมีคำค้น > แท็ก > หมายเหตุ
 *   > เนื้อหาจากไฟล์จริง > เนื้อหาที่เครื่องอ่านจากภาพ
 *
 * ข้อความจาก OCR อยู่ท้ายสุดเพราะเป็นการคาดเดา ผลที่อ่านผิดจึงไม่ควรขึ้นก่อน
 * ชื่อไฟล์ที่ตรงเป๊ะ ซึ่งผู้ใช้ตั้งใจตั้งชื่อไว้เอง
 */
export function rankOf(input: {
  name: string;
  term: string;
  reason: MatchReason | null;
  textSource?: string | null;
}): number {
  const needle = normalizeForSearch(input.term);
  const name = normalizeForSearch(input.name);

  if (needle && name === needle) return 0;
  if (needle && name.startsWith(needle)) return 1;
  switch (input.reason) {
    case 'NAME':
      return 2;
    case 'TAG':
      return 3;
    case 'REMARK':
      return 4;
    case 'CONTENT':
      return input.textSource === 'OCR' ? 6 : 5;
    default:
      return 7;
  }
}

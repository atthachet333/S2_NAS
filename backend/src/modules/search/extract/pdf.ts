import zlib from 'node:zlib';

/**
 * การสกัดข้อความจาก PDF ที่มีข้อความฝังอยู่จริง
 *
 * เขียนเองโดยตั้งใจ ไม่ใช้ไลบรารีภายนอก
 *
 * PDF เป็นชนิดไฟล์ที่อันตรายที่สุดที่ระบบนี้รับ - มันมีสคริปต์ฝังได้ มีการกระทำเมื่อเปิดไฟล์ได้
 * และมีการอ้างอิงทรัพยากรภายนอกได้ ไลบรารีที่ "อ่าน PDF" ส่วนใหญ่จึงมีความสามารถ
 * มากเกินกว่าที่งานนี้ต้องการมาก การพาโค้ดเหล่านั้นเข้ามาเพื่อดึงข้อความอย่างเดียว
 * คือการเพิ่มพื้นที่โจมตีโดยไม่จำเป็น
 *
 * ตัวสกัดนี้ทำแค่สามอย่าง:
 *   1. หาสตรีมเนื้อหาในไฟล์ แล้วคลายบีบอัดด้วย zlib (FlateDecode) เท่านั้น
 *   2. อ่านตัวดำเนินการวาดข้อความ (Tj TJ ' ") ออกมา
 *   3. แปลงรหัสอักขระเป็นข้อความจริงผ่านตาราง ToUnicode ที่ฝังอยู่ในไฟล์
 *
 * ไม่มีการเรนเดอร์ ไม่มีการรันสคริปต์ ไม่มีการตามลิงก์ ไม่มีการเรียกโปรแกรมภายนอก
 *
 * ขอบเขตที่รู้และยอมรับ:
 *   - รองรับเฉพาะสตรีมที่ไม่บีบอัดหรือบีบด้วย FlateDecode (ครอบคลุม PDF ส่วนใหญ่ในทางปฏิบัติ)
 *   - ข้อความที่ไม่ใช่ ASCII เช่นภาษาไทย ต้องมีตาราง ToUnicode อยู่ในไฟล์
 *     ถ้าไม่มี จะคืนค่าว่างแทนการเดา เพราะข้อความที่เดาผิดแย่กว่าการไม่มีข้อความ
 *   - PDF ที่เป็นภาพสแกนล้วนจะไม่มีข้อความให้สกัด และถูกบันทึกเป็น NO_TEXT อย่างตรงไปตรงมา
 *     ระบบนี้ยังไม่มี OCR และจะไม่แกล้งทำเป็นว่ามี
 */

export class PdfExtractError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'PdfExtractError';
  }
}

/** ขนาดรวมสูงสุดหลังคลายบีบอัด กันสตรีมที่ขยายตัวไม่รู้จบ */
const MAX_INFLATED_BYTES = 96 * 1024 * 1024;
/** จำนวนวัตถุสูงสุดที่จะไล่อ่าน */
const MAX_OBJECTS = 20_000;

interface PdfObject {
  dict: string;
  streamStart: number;
  streamEnd: number;
}

/**
 * ไล่หาวัตถุทั้งหมดในไฟล์แบบตรงไปตรงมา
 *
 * ไม่พึ่งตารางอ้างอิง (xref) โดยตั้งใจ - xref ของไฟล์ที่เสียหายหรือถูกแก้ไขมักผิด
 * และการไล่อ่านทั้งไฟล์ให้ผลที่ทนต่อไฟล์เสียได้ดีกว่าสำหรับงานสกัดข้อความ
 */
function findObjects(buffer: Buffer): PdfObject[] {
  const text = buffer.toString('latin1');
  const objects: PdfObject[] = [];
  const pattern = /(\d+)\s+(\d+)\s+obj\b/g;

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null && objects.length < MAX_OBJECTS) {
    const bodyStart = match.index + match[0].length;
    const endObj = text.indexOf('endobj', bodyStart);
    const body = text.slice(bodyStart, endObj < 0 ? Math.min(bodyStart + 65536, text.length) : endObj);

    const streamMarker = body.indexOf('stream');
    if (streamMarker < 0) {
      objects.push({ dict: body, streamStart: -1, streamEnd: -1 });
      continue;
    }

    // ข้ามตัวจบบรรทัดหลังคำว่า stream ตามที่มาตรฐานกำหนด
    let dataStart = bodyStart + streamMarker + 'stream'.length;
    if (text[dataStart] === '\r') dataStart += 1;
    if (text[dataStart] === '\n') dataStart += 1;

    const endStream = text.indexOf('endstream', dataStart);
    objects.push({
      dict: body.slice(0, streamMarker),
      streamStart: dataStart,
      streamEnd: endStream < 0 ? -1 : endStream,
    });
  }

  return objects;
}

/** คลายบีบอัดสตรีมหนึ่งก้อน - รองรับเฉพาะ FlateDecode และสตรีมที่ไม่บีบอัด */
function inflateStream(buffer: Buffer, object: PdfObject, budget: { used: number }): string | null {
  if (object.streamStart < 0 || object.streamEnd < 0) return null;

  const raw = buffer.subarray(object.streamStart, object.streamEnd);
  if (raw.length === 0) return null;

  const filters = /\/Filter\s*(\[[^\]]*\]|\/\w+)/.exec(object.dict)?.[1] ?? '';

  // ตัวกรองที่ไม่รองรับถูกข้ามไปเงียบ ๆ - ไฟล์อาจยังมีสตรีมอื่นที่อ่านได้
  if (filters && !filters.includes('FlateDecode')) return null;
  // บีบซ้อนกันหลายชั้นไม่รองรับ เพราะเป็นช่องขยายตัวที่ควบคุมยาก
  if ((filters.match(/\//g)?.length ?? 0) > 1) return null;

  let data: Buffer;
  try {
    data = filters.includes('FlateDecode') ? zlib.inflateSync(raw) : Buffer.from(raw);
  } catch {
    try {
      // PDF บางตัวมีไบต์เกินท้ายสตรีม - ลองแบบผ่อนปรนอีกครั้งก่อนยอมแพ้
      data = zlib.inflateSync(raw, { finishFlush: zlib.constants.Z_SYNC_FLUSH });
    } catch {
      return null;
    }
  }

  budget.used += data.length;
  if (budget.used > MAX_INFLATED_BYTES) {
    throw new PdfExtractError('PDF_TOO_LARGE', 'เนื้อหาของ PDF ขยายตัวใหญ่เกินกำหนด');
  }

  return data.toString('latin1');
}

/**
 * อ่านตาราง ToUnicode ที่แปลงรหัสในไฟล์เป็นอักขระจริง
 *
 * นี่คือส่วนที่ทำให้ภาษาไทยอ่านออก - PDF เก็บ "รหัสในฟอนต์" ไม่ใช่ตัวอักษร
 * ถ้าไม่มีตารางนี้ รหัสเหล่านั้นแปลไม่ได้ และเราจะไม่เดา
 */
function parseToUnicode(content: string, map: Map<number, string>): void {
  for (const block of content.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const pair of (block[1] ?? '').matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) {
      const code = parseInt(pair[1] ?? '', 16);
      const value = hexToText(pair[2] ?? '');
      if (Number.isFinite(code) && value) map.set(code, value);
    }
  }

  for (const block of content.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    const body = block[1] ?? '';
    for (const row of body.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) {
      const from = parseInt(row[1] ?? '', 16);
      const to = parseInt(row[2] ?? '', 16);
      const start = parseInt(row[3] ?? '', 16);
      if (!Number.isFinite(from) || !Number.isFinite(to) || to < from || to - from > 65535) continue;
      for (let offset = 0; offset <= to - from; offset += 1) {
        map.set(from + offset, safeChar(start + offset));
      }
    }
  }
}

function hexToText(hex: string): string {
  let out = '';
  for (let index = 0; index + 3 < hex.length + 1; index += 4) {
    const code = parseInt(hex.slice(index, index + 4), 16);
    if (Number.isFinite(code)) out += safeChar(code);
  }
  return out;
}

function safeChar(code: number): string {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return '';
  // ช่วง surrogate เดี่ยวไม่ใช่อักขระที่ถูกต้อง
  if (code >= 0xd800 && code <= 0xdfff) return '';
  try {
    return String.fromCodePoint(code);
  } catch {
    return '';
  }
}

/** แปลงสตริงตามไวยากรณ์ของ PDF ให้เป็นข้อความ */
function decodeLiteral(literal: string, map: Map<number, string> | null): string {
  let out = '';
  for (let index = 0; index < literal.length; index += 1) {
    const char = literal[index]!;
    if (char !== '\\') {
      out += char;
      continue;
    }
    const next = literal[index + 1];
    index += 1;
    if (next === undefined) break;
    const escapes: Record<string, string> = { n: '\n', r: '\r', t: '\t', b: '', f: '', '(': '(', ')': ')', '\\': '\\' };
    if (next in escapes) {
      out += escapes[next];
    } else if (next >= '0' && next <= '7') {
      // เลขฐานแปดสูงสุดสามหลัก
      let digits = next;
      while (digits.length < 3 && literal[index + 1] && literal[index + 1]! >= '0' && literal[index + 1]! <= '7') {
        digits += literal[index + 1];
        index += 1;
      }
      out += safeChar(parseInt(digits, 8));
    } else if (next === '\n') {
      // ขึ้นบรรทัดใหม่ที่ถูก escape คือการต่อบรรทัด ไม่ใช่ตัวอักษร
    } else {
      out += next;
    }
  }
  return mapCodes(out, map, 1);
}

/** สตริงฐานสิบหก มักใช้กับฟอนต์สองไบต์ ซึ่งเป็นกรณีของภาษาไทยเกือบทั้งหมด */
function decodeHexString(hex: string, map: Map<number, string> | null): string {
  const clean = hex.replace(/[^0-9a-fA-F]/g, '');
  if (map && map.size > 0) {
    let out = '';
    for (let index = 0; index + 1 < clean.length; index += 4) {
      const code = parseInt(clean.slice(index, index + 4).padEnd(4, '0'), 16);
      out += map.get(code) ?? '';
    }
    return out;
  }
  let out = '';
  for (let index = 0; index + 1 < clean.length; index += 2) {
    out += safeChar(parseInt(clean.slice(index, index + 2), 16));
  }
  return out;
}

/**
 * แปลงรหัสหนึ่งไบต์ผ่านตาราง ToUnicode
 *
 * เมื่อไม่มีตารางและอักขระอยู่นอกช่วง ASCII เราคืนค่าว่างแทนการเดา
 * เพราะการเดาจะได้ข้อความขยะที่ดูเหมือนสกัดสำเร็จ ซึ่งหลอกทั้งผู้ใช้และการค้นหา
 */
function mapCodes(value: string, map: Map<number, string> | null, bytesPerCode: number): string {
  if (!map || map.size === 0) {
    // ไม่มีตาราง: รับเฉพาะ ASCII ที่อ่านออกแน่นอน
    return value.replace(/[^\x09\x0a\x0d\x20-\x7e]/g, '');
  }
  let out = '';
  for (let index = 0; index < value.length; index += bytesPerCode) {
    const code = value.charCodeAt(index);
    out += map.get(code) ?? (code >= 0x20 && code <= 0x7e ? value[index]! : '');
  }
  return out;
}

/** อ่านตัวดำเนินการวาดข้อความออกจากสตรีมเนื้อหาหนึ่งก้อน */
function extractFromContent(content: string, map: Map<number, string> | null): string {
  const parts: string[] = [];

  // (ข้อความ) Tj   และ  (ข้อความ) '   และ  (ข้อความ) "
  for (const match of content.matchAll(/\(((?:\\.|[^\\()])*)\)\s*(?:Tj|'|")/g)) {
    parts.push(decodeLiteral(match[1] ?? '', map));
  }
  // <ฐานสิบหก> Tj
  for (const match of content.matchAll(/<([0-9a-fA-F\s]+)>\s*Tj/g)) {
    parts.push(decodeHexString(match[1] ?? '', map));
  }
  // [ ... ] TJ - อาร์เรย์ที่ผสมข้อความกับระยะห่าง
  for (const match of content.matchAll(/\[((?:[^\][\\]|\\.)*)\]\s*TJ/g)) {
    const array = match[1] ?? '';
    let line = '';
    for (const piece of array.matchAll(/\(((?:\\.|[^\\()])*)\)|<([0-9a-fA-F\s]+)>/g)) {
      line += piece[1] !== undefined ? decodeLiteral(piece[1], map) : decodeHexString(piece[2] ?? '', map);
    }
    if (line) parts.push(line);
  }

  return parts.join(' ');
}

/**
 * สกัดข้อความจาก PDF
 *
 * คืนสตริงว่างเมื่อไฟล์ถูกต้องแต่ไม่มีข้อความให้สกัด (เช่น เอกสารสแกน)
 * ผู้เรียกเป็นผู้แปลงกรณีนั้นเป็นสถานะ NO_TEXT
 */
export function extractPdfText(buffer: Buffer): string {
  if (!buffer.subarray(0, 5).toString('latin1').startsWith('%PDF-')) {
    throw new PdfExtractError('PDF_INVALID', 'ไฟล์นี้ไม่ใช่ PDF ที่อ่านได้');
  }

  const header = buffer.toString('latin1', 0, Math.min(buffer.length, 4096));
  if (/\/Encrypt\b/.test(buffer.toString('latin1', 0, Math.min(buffer.length, 1024 * 1024)))) {
    throw new PdfExtractError('PDF_ENCRYPTED', 'PDF นี้มีการเข้ารหัสหรือใส่รหัสผ่านไว้');
  }
  void header;

  const objects = findObjects(buffer);
  const budget = { used: 0 };

  // รอบแรก: รวบรวมตาราง ToUnicode ทั้งหมดของไฟล์
  const unicodeMap = new Map<number, string>();
  for (const object of objects) {
    if (!/\/ToUnicode\b/.test(object.dict) && !/CMapType/.test(object.dict)) continue;
    const content = inflateStream(buffer, object, budget);
    if (content && content.includes('beginbfchar')) parseToUnicode(content, unicodeMap);
    if (content && content.includes('beginbfrange')) parseToUnicode(content, unicodeMap);
  }
  // สตรีมที่เป็น CMap อาจไม่มีคำใบ้ใน dictionary เลย - กวาดอีกรอบเฉพาะที่มีเครื่องหมายชัดเจน
  if (unicodeMap.size === 0) {
    for (const object of objects) {
      const content = inflateStream(buffer, object, budget);
      if (content && (content.includes('beginbfchar') || content.includes('beginbfrange'))) {
        parseToUnicode(content, unicodeMap);
      }
    }
  }

  const map = unicodeMap.size > 0 ? unicodeMap : null;
  const parts: string[] = [];
  for (const object of objects) {
    const content = inflateStream(buffer, object, budget);
    if (!content) continue;
    // สนใจเฉพาะสตรีมที่มีตัวดำเนินการข้อความจริง
    if (!/\bTj\b|\bTJ\b|\bBT\b/.test(content)) continue;
    const text = extractFromContent(content, map);
    if (text.trim()) parts.push(text);
  }

  return parts.join('\n').trim();
}

export const __testing = { findObjects, parseToUnicode, decodeLiteral, decodeHexString, extractFromContent };

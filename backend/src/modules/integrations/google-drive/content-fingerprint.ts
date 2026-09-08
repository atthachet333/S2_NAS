import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';

/**
 * ลายนิ้วมือเนื้อหาของไฟล์ที่ส่งออกจาก Google (F19 · D1)
 *
 * **ปัญหาที่แก้:** Google ประทับ "เวลาที่ส่งออก" ลงในหัวของแต่ละรายการใน ZIP
 * การส่งออกเอกสารเดิมที่ไม่มีใครแก้สองครั้ง จึงได้ไบต์ไม่เหมือนกันและ SHA-256
 * ของทั้งไฟล์ต่างกัน ทั้งที่ทุกส่วนข้างในเหมือนกันทุกไบต์
 *
 * ผลคือการเทียบ checksum ของทั้งคอนเทนเนอร์ใช้ตัดสิน "เนื้อหาเปลี่ยนไหม" ไม่ได้เลย
 * สำหรับไฟล์ Google และประวัติเวอร์ชันจะเต็มไปด้วยเวอร์ชันที่เอกสารเหมือนกันทุกประการ
 *
 * ลายนิ้วมือนี้จึงมองข้ามเปลือกของ ZIP ทั้งหมด - เวลา ลำดับ ระดับการบีบอัด
 * และโครงสร้างไบนารีของคอนเทนเนอร์ - แล้วดูเฉพาะ "ชื่อส่วน + เนื้อในของส่วนนั้น"
 *
 * **ขอบเขต:** ใช้กับไฟล์ที่ส่งออกจาก Google Docs/Sheets/Slides เท่านั้น
 * ไฟล์ไบนารีปกติยังใช้ SHA-256 ของไบต์จริงตามเดิม และ ResourceVersion.checksum
 * ก็ยังเป็น SHA-256 ของไบต์ที่เก็บจริงเสมอ ไม่ถูกแตะโดยไฟล์นี้
 */

/* ------------------------------------------------------------------ */
/* ขอบเขตความปลอดภัยของตัวอ่าน ZIP                                       */
/* ------------------------------------------------------------------ */

/**
 * เพดานที่ตั้งไว้เพราะไฟล์ที่อ่านมาจากภายนอกระบบ
 *
 * ตัวอ่านนี้ไม่เขียนไฟล์ลงดิสก์เลยแม้แต่ไฟล์เดียว จึงไม่มีช่องให้ path traversal
 * แต่ยังต้องกัน zip bomb ที่บีบอัดไม่กี่กิโลไบต์แล้วคลายออกเป็นหลายกิกะไบต์
 */
const MAX_ENTRIES = 4096;
const MAX_ENTRY_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_BYTES = 256 * 1024 * 1024;

const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;

/** MIME ที่ Google ส่งออกให้ - มีเฉพาะสามชนิดนี้ที่ต้องใช้ลายนิ้วมือ */
const OOXML_MIME = new Set([
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
]);

export function isOoxmlExportMime(mimeType: string): boolean {
  return OOXML_MIME.has(mimeType);
}

interface ZipEntry {
  name: string;
  data: Buffer;
}

/**
 * อ่านสารบัญกลางของ ZIP แล้วคลายเฉพาะรายการที่ประกาศไว้ในสารบัญ
 *
 * ใช้สารบัญกลาง (central directory) ไม่ใช่หัวของแต่ละรายการ เพราะหัวรายการ
 * ของไฟล์ที่เขียนแบบสตรีมมักไม่บอกขนาดจริง (ไปอยู่ใน data descriptor แทน)
 * ซึ่งเป็นรูปแบบที่ Google ใช้จริง
 *
 * คืน null เมื่อไฟล์ไม่ใช่ ZIP ที่อ่านได้ - ผู้เรียกจะถอยไปใช้ SHA-256 ปกติ
 * แทนที่จะทำให้การซิงก์ล้มทั้งรายการ
 */
function readZipEntries(buffer: Buffer): ZipEntry[] | null {
  const eocd = findEndOfCentralDirectory(buffer);
  if (eocd === null) return null;

  const count = buffer.readUInt16LE(eocd + 10);
  if (count === 0 || count > MAX_ENTRIES) return null;

  let offset = buffer.readUInt32LE(eocd + 16);
  const entries: ZipEntry[] = [];
  let total = 0;

  for (let index = 0; index < count; index += 1) {
    if (offset + 46 > buffer.length) return null;
    if (buffer.readUInt32LE(offset) !== SIG_CENTRAL) return null;

    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);

    if (uncompressedSize > MAX_ENTRY_BYTES || compressedSize > MAX_ENTRY_BYTES) return null;
    total += uncompressedSize;
    if (total > MAX_TOTAL_BYTES) return null;

    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');

    // โฟลเดอร์ไม่มีเนื้อหา จึงไม่มีความหมายต่อการเทียบเอกสาร
    if (!name.endsWith('/')) {
      const data = readLocalEntry(buffer, localOffset, method, compressedSize);
      if (data === null) return null;
      entries.push({ name, data });
    }

    offset += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

function readLocalEntry(
  buffer: Buffer,
  localOffset: number,
  method: number,
  compressedSize: number,
): Buffer | null {
  if (localOffset + 30 > buffer.length) return null;
  const nameLength = buffer.readUInt16LE(localOffset + 26);
  const extraLength = buffer.readUInt16LE(localOffset + 28);
  const start = localOffset + 30 + nameLength + extraLength;
  const end = start + compressedSize;
  if (end > buffer.length) return null;

  const raw = buffer.subarray(start, end);
  if (method === 0) return Buffer.from(raw);
  if (method !== 8) return null;

  try {
    const out = inflateRawSync(raw, { maxOutputLength: MAX_ENTRY_BYTES });
    return out;
  } catch {
    return null;
  }
}

/** ท้ายสารบัญอยู่ใกล้ท้ายไฟล์เสมอ - ค้นถอยหลังในช่วงที่สเปกอนุญาต */
function findEndOfCentralDirectory(buffer: Buffer): number | null {
  const maxComment = 0xffff;
  const start = Math.max(0, buffer.length - maxComment - 22);
  for (let i = buffer.length - 22; i >= start; i -= 1) {
    if (buffer.readUInt32LE(i) === SIG_EOCD) return i;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* ลายนิ้วมือ                                                           */
/* ------------------------------------------------------------------ */

const sha256 = (input: Buffer | string) => createHash('sha256').update(input).digest('hex');

/**
 * ลายนิ้วมือตามหลักเกณฑ์เดียว: ชื่อส่วน + แฮชของเนื้อในส่วนนั้น เรียงตามชื่อ
 *
 * เรียงตามชื่อเพื่อให้ลำดับรายการใน ZIP เปลี่ยนแล้วผลไม่เปลี่ยน และใช้แฮชของ
 * เนื้อที่คลายแล้ว ไม่ใช่ CRC ในหัวรายการ เพราะ CRC สั้นเกินกว่าจะใช้ตัดสิน
 * ความเท่ากันของเอกสารอย่างปลอดภัย
 *
 * คืน null เมื่ออ่าน ZIP ไม่ได้ ผู้เรียกจะถอยไปใช้ SHA-256 ของไบต์ทั้งไฟล์
 */
/**
 * ส่วนที่ Google สลับเลขไปมาเองระหว่างการส่งออกสองครั้ง
 *
 * พบจาก live QA: ส่งออกไฟล์สไลด์เดิมที่ไม่มีใครแก้สองครั้งห่างกันไม่กี่นาที
 * Google สลับเนื้อหาของ ppt/theme/theme1.xml กับ theme2.xml เข้าหากัน แล้วแก้
 * เป้าหมายในไฟล์ .rels ให้ตรงกับเลขใหม่ - 33 จาก 38 ส่วนเหมือนเดิมทุกไบต์
 * ส่วนที่ต่างคือคู่ธีมกับสายสัมพันธ์ที่ชี้ไปหามันเท่านั้น
 *
 * เอกสารไม่ได้เปลี่ยนอะไรเลย เปลี่ยนแค่เลขที่ Google ตั้งให้ส่วนประกอบ
 */
const THEME_PART = /^(?:ppt|word|xl)\/theme\/theme\d+\.xml$/;
const THEME_REFERENCE = /theme\d+\.xml/g;

/** เลขของธีมไม่มีความหมาย - ยุบให้เป็นชื่อเดียวกันก่อนเทียบ */
function canonicalName(name: string): string {
  return THEME_PART.test(name) ? name.replace(/theme\d+\.xml$/, 'theme.xml') : name;
}

/**
 * สายสัมพันธ์อ้างถึงธีมด้วยเลข จึงต้องยุบเลขในนั้นด้วย
 *
 * ถ้ายุบแต่ชื่อไฟล์แล้วไม่ยุบข้อความข้างใน ไฟล์ .rels สองชุดจะยังต่างกัน
 * และลายนิ้วมือก็จะยังไม่นิ่งอยู่ดี
 */
function canonicalBytes(name: string, data: Buffer): Buffer {
  if (!name.endsWith('.rels')) return data;
  return Buffer.from(data.toString('utf8').replace(THEME_REFERENCE, 'theme.xml'), 'utf8');
}

/**
 * ลายนิ้วมือตามหลักเกณฑ์เดียว: ชื่อส่วน + แฮชของเนื้อในส่วนนั้น เรียงตามชื่อ
 *
 * เรียงตามชื่อเพื่อให้ลำดับรายการใน ZIP เปลี่ยนแล้วผลไม่เปลี่ยน และใช้แฮชของ
 * เนื้อที่คลายแล้ว ไม่ใช่ CRC ในหัวรายการ เพราะ CRC สั้นเกินกว่าจะใช้ตัดสิน
 * ความเท่ากันของเอกสารอย่างปลอดภัย
 *
 * ส่วนที่ชื่อยุบมาเป็นชื่อเดียวกัน (คู่ธีม) ถูกเก็บเป็นชุดที่เรียงแล้ว จึงสลับที่กัน
 * ได้โดยผลไม่เปลี่ยน แต่ถ้า "เนื้อของธีม" เปลี่ยนจริง ชุดนั้นก็จะเปลี่ยนตาม
 * - จึงไม่ได้ตาบอดต่อการแก้ธีมของผู้ใช้
 *
 * คืน null เมื่ออ่าน ZIP ไม่ได้ ผู้เรียกจะถอยไปใช้ SHA-256 ของไบต์ทั้งไฟล์
 */
export function ooxmlContentFingerprint(buffer: Buffer): string | null {
  const entries = readZipEntries(buffer);
  if (entries === null || entries.length === 0) return null;

  const grouped = new Map<string, string[]>();
  for (const entry of entries) {
    const name = canonicalName(entry.name);
    const digest = sha256(canonicalBytes(entry.name, entry.data));
    const bucket = grouped.get(name);
    if (bucket) bucket.push(digest);
    else grouped.set(name, [digest]);
  }

  const hash = createHash('sha256');
  for (const name of [...grouped.keys()].sort()) {
    hash.update(name, 'utf8');
    hash.update('\u0000');
    for (const digest of grouped.get(name)!.sort()) {
      hash.update(digest, 'utf8');
      hash.update('\u0000');
    }
  }
  return `ooxml:${hash.digest('hex')}`;
}

/**
 * ลายนิ้วมือของเนื้อหาที่ใช้ตัดสินว่า "ต้องสร้างเวอร์ชันใหม่ไหม"
 *
 * ไฟล์ Google ที่ส่งออกเป็น OOXML ใช้ลายนิ้วมือตามส่วนประกอบ
 * ไฟล์อื่นทั้งหมดใช้ SHA-256 ของไบต์จริง ซึ่งเป็นความหมายเดิมของระบบ
 */
export function contentFingerprint(buffer: Buffer, mimeType: string): string {
  if (isOoxmlExportMime(mimeType)) {
    const canonical = ooxmlContentFingerprint(buffer);
    if (canonical) return canonical;
  }
  return `bytes:${sha256(buffer)}`;
}

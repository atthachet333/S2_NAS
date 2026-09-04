import { Open as unzipOpen } from 'unzipper';

/**
 * การสกัดข้อความจากเอกสาร OOXML (DOCX / XLSX / PPTX)
 *
 * ไฟล์เหล่านี้คือ ZIP ที่ข้างในเป็น XML ดังนั้นการอ่านจึงเป็นการ "แกะ ZIP ที่ไม่น่าไว้ใจ"
 * ทั้งหมด และต้องปฏิบัติกับมันแบบนั้น
 *
 * สิ่งที่ไม่ทำโดยเด็ดขาด:
 *   - ไม่เปิดโปรแกรม Office ใด ๆ
 *   - ไม่รันมาโคร ไม่ประเมินสูตร ไม่ตามลิงก์ภายนอก
 *   - ไม่แกะทั้งไฟล์ลงดิสก์ - อ่านเฉพาะรายการที่ต้องใช้ ทีละรายการ
 *
 * การป้องกันระเบิดบีบอัด (zip bomb) มีสามชั้น:
 *   1. จำกัดจำนวนรายการในไฟล์
 *   2. จำกัดขนาดรวมหลังคลายบีบอัด
 *   3. จำกัดอัตราส่วนขยายตัวของแต่ละรายการ
 *
 * ไฟล์ที่มีมาโคร (.docm .xlsm .pptm) ไม่ถูกรับเข้ามาที่นี่ - ดูตารางชนิดไฟล์ใน dispatcher
 * ไม่ใช่เพราะแกะไม่ได้ แต่เพราะการประกาศว่า "รองรับ" ไฟล์ที่มีโค้ดฝังอยู่เป็นการเชิญปัญหา
 */

/** จำนวนรายการสูงสุดใน ZIP หนึ่งไฟล์ - เอกสารจริงไม่เคยมีถึงหลักพัน */
const MAX_ENTRIES = 2000;
/** ขนาดรวมหลังคลายบีบอัดที่ยอมให้อ่าน */
const MAX_TOTAL_UNCOMPRESSED = 128 * 1024 * 1024;
/** อัตราขยายตัวสูงสุดต่อหนึ่งรายการ - ระเบิดบีบอัดมีอัตราหลักพันขึ้นไป */
const MAX_RATIO = 200;
/** ขนาดสูงสุดของ XML หนึ่งไฟล์ที่ยอมอ่านเข้าหน่วยความจำ */
const MAX_ENTRY_BYTES = 32 * 1024 * 1024;

export class OoxmlSafetyError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'OoxmlSafetyError';
  }
}

interface ZipEntry {
  path: string;
  uncompressedSize: number;
  compressedSize: number;
  buffer(): Promise<Buffer>;
}

/**
 * เปิด ZIP แล้วคืนเฉพาะรายการที่ผ่านการตรวจความปลอดภัยแล้ว
 * การตรวจทำจาก "สิ่งที่ประกาศไว้ในสารบัญ" ก่อน จึงปฏิเสธได้ก่อนคลายบีบอัดจริง
 */
async function openSafely(filePath: string): Promise<ZipEntry[]> {
  const archive = await unzipOpen.file(filePath);
  const files = archive.files as unknown as Array<{
    path: string;
    type: string;
    uncompressedSize: number;
    compressedSize: number;
    buffer: () => Promise<Buffer>;
  }>;

  if (files.length > MAX_ENTRIES) {
    throw new OoxmlSafetyError('ZIP_TOO_MANY_ENTRIES', 'เอกสารมีรายการภายในมากผิดปกติ');
  }

  let total = 0;
  const entries: ZipEntry[] = [];
  for (const file of files) {
    if (file.type !== 'File') continue;

    const uncompressed = Number(file.uncompressedSize ?? 0);
    const compressed = Number(file.compressedSize ?? 0);

    total += uncompressed;
    if (total > MAX_TOTAL_UNCOMPRESSED) {
      throw new OoxmlSafetyError('ZIP_TOO_LARGE', 'เอกสารขยายตัวใหญ่เกินกำหนด');
    }
    // อัตราส่วนสูงผิดปกติคือลายเซ็นของระเบิดบีบอัด
    if (compressed > 0 && uncompressed / compressed > MAX_RATIO && uncompressed > 1024 * 1024) {
      throw new OoxmlSafetyError('ZIP_RATIO_SUSPICIOUS', 'อัตราการบีบอัดของเอกสารผิดปกติ');
    }

    entries.push({
      path: file.path,
      uncompressedSize: uncompressed,
      compressedSize: compressed,
      buffer: () => file.buffer(),
    });
  }

  return entries;
}

async function readEntry(entry: ZipEntry): Promise<string> {
  if (entry.uncompressedSize > MAX_ENTRY_BYTES) {
    throw new OoxmlSafetyError('ZIP_ENTRY_TOO_LARGE', 'ส่วนหนึ่งของเอกสารใหญ่เกินกำหนด');
  }
  const buffer = await entry.buffer();
  return buffer.toString('utf8');
}

/**
 * ดึงข้อความออกจาก XML แบบไม่ตีความโครงสร้าง
 *
 * ไม่ใช้ตัวแยก XML เต็มรูปแบบโดยตั้งใจ - ตัวแยกที่รองรับ entity ภายนอกเปิดช่อง
 * ให้เกิดการอ่านไฟล์ในเครื่อง (XXE) และระเบิดเอนทิตี ที่นี่จึงตัดแท็กทิ้งตรง ๆ
 * แล้วแปลงเฉพาะเอนทิตีมาตรฐานห้าตัวที่ปลอดภัย
 */
function stripXml(xml: string, blockSeparators: string[] = []): string {
  let text = xml;
  // ตัดส่วนที่ไม่ใช่เนื้อหาออกก่อน เพื่อไม่ให้ความเห็นหรือ CDATA ปนเข้ามาผิดรูป
  text = text.replace(/<!--[\s\S]*?-->/g, ' ');
  text = text.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');

  // แท็กที่ควรกลายเป็นการขึ้นบรรทัดหรือช่องว่าง มิฉะนั้นคำจากคนละย่อหน้าจะติดกัน
  for (const tag of blockSeparators) {
    text = text.replace(new RegExp(`</${tag}>`, 'g'), '\n');
    text = text.replace(new RegExp(`<${tag}[^>]*/>`, 'g'), '\n');
  }

  text = text.replace(/<[^>]*>/g, ' ');

  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    // & ต้องแปลงเป็นตัวสุดท้าย มิฉะนั้น &amp;lt; จะกลายเป็น < ซึ่งผิด
    .replace(/&amp;/g, '&')
    // เลขอ้างอิงอักขระ ใช้กับภาษาไทยในเอกสารบางตัว
    .replace(/&#(\d+);/g, (_, code: string) => safeCodePoint(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code: string) => safeCodePoint(parseInt(code, 16)));
}

function safeCodePoint(code: number): string {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return '';
  try {
    return String.fromCodePoint(code);
  } catch {
    return '';
  }
}

/** DOCX - เนื้อหาหลักอยู่ใน word/document.xml ส่วนหัวและท้ายกระดาษอยู่แยกไฟล์ */
export async function extractDocx(filePath: string): Promise<string> {
  const entries = await openSafely(filePath);
  const wanted = entries.filter(
    (entry) =>
      entry.path === 'word/document.xml' ||
      /^word\/(header|footer)\d*\.xml$/.test(entry.path) ||
      entry.path === 'word/footnotes.xml' ||
      entry.path === 'word/endnotes.xml',
  );

  const parts: string[] = [];
  for (const entry of wanted) {
    parts.push(stripXml(await readEntry(entry), ['w:p', 'w:br', 'w:tab']));
  }
  return parts.join('\n');
}

/**
 * XLSX - ข้อความส่วนใหญ่อยู่ในตารางสตริงร่วม (sharedStrings.xml)
 *
 * เซลล์ที่เป็นสูตรจะถูกอ่านจาก "ค่าที่คำนวณไว้แล้ว" (<v>) ที่ Excel เก็บไว้ในไฟล์
 * ไม่มีการประเมินสูตรใด ๆ ทั้งสิ้น
 */
export async function extractXlsx(filePath: string): Promise<string> {
  const entries = await openSafely(filePath);
  const parts: string[] = [];

  const shared = entries.find((entry) => entry.path === 'xl/sharedStrings.xml');
  if (shared) parts.push(stripXml(await readEntry(shared), ['si', 't']));

  // ชื่อชีตช่วยให้ค้นเจอ "ใบกำกับภาษี" ที่เป็นชื่อแท็บ ไม่ใช่เนื้อในเซลล์
  const workbook = entries.find((entry) => entry.path === 'xl/workbook.xml');
  if (workbook) {
    const xml = await readEntry(workbook);
    for (const match of xml.matchAll(/<sheet[^>]*name="([^"]*)"/g)) {
      parts.push(stripXml(match[1] ?? ''));
    }
  }

  const sheets = entries.filter((entry) => /^xl\/worksheets\/sheet\d+\.xml$/.test(entry.path));
  for (const sheet of sheets.slice(0, 100)) {
    const xml = await readEntry(sheet);
    // เก็บเฉพาะค่าที่แสดงผลได้: <v> คือค่าที่คำนวณไว้แล้ว, <t> คือข้อความในเซลล์
    for (const match of xml.matchAll(/<(?:v|t)(?:\s[^>]*)?>([\s\S]*?)<\/(?:v|t)>/g)) {
      parts.push(stripXml(match[1] ?? ''));
    }
  }

  return parts.join(' ');
}

/** PPTX - ข้อความอยู่ในกล่องข้อความของแต่ละสไลด์ */
export async function extractPptx(filePath: string): Promise<string> {
  const entries = await openSafely(filePath);
  const slides = entries
    .filter((entry) => /^ppt\/slides\/slide\d+\.xml$/.test(entry.path))
    .sort((a, b) => a.path.localeCompare(b.path, 'en', { numeric: true }));

  const parts: string[] = [];
  for (const slide of slides.slice(0, 500)) {
    parts.push(stripXml(await readEntry(slide), ['a:p']));
  }
  return parts.join('\n');
}

export const __testing = { stripXml };

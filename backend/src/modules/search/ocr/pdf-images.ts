import zlib from 'node:zlib';

/**
 * การดึงภาพของหน้าออกจาก PDF ที่เป็นเอกสารสแกน
 *
 * ทำไมไม่ใช้ตัวเรนเดอร์
 * --------------------
 * ทางเลือกปกติคือเรนเดอร์หน้า PDF เป็นภาพด้วยเครื่องมือภายนอก (poppler, Ghostscript, MuPDF)
 * แต่การเรนเดอร์แปลว่า "ตีความคำสั่งวาดของเอกสารที่ไม่น่าไว้ใจ" ซึ่งเป็นพื้นที่โจมตีที่กว้างมาก
 * และเครื่องนี้ก็ไม่มีเครื่องมือเหล่านั้นติดตั้งอยู่เลย
 *
 * เอกสารสแกนมีโครงสร้างที่ง่ายกว่านั้นมาก: แต่ละหน้าคือ "ภาพหนึ่งภาพ" ที่ฝังอยู่ในไฟล์
 * เราจึงดึงภาพนั้นออกมาตรง ๆ แล้วส่งให้ OCR อ่าน
 *
 * ผลคือ **ไม่มีอะไรในระบบตีความคำสั่งวาดของ PDF เลย** ไม่มีการรันสคริปต์
 * ไม่มีการตามลิงก์ ไม่มีการเรียกโปรแกรมภายนอกเพื่อเรนเดอร์
 *
 * ขอบเขตที่รู้และยอมรับ
 * --------------------
 * วิธีนี้ใช้ได้กับเอกสารที่แต่ละหน้าเป็นภาพ ซึ่งคือเอกสารสแกนทั้งหมด - เป้าหมายของ OCR พอดี
 * เอกสารที่วาดด้วยเส้นและตัวอักษรจริงจะไม่มีภาพให้ดึง แต่เอกสารแบบนั้นมีข้อความฝังอยู่แล้ว
 * และถูกอ่านด้วยการสกัดข้อความปกติของ F12 ไปตั้งแต่ต้น จึงไม่เข้าเงื่อนไข OCR อยู่ดี
 *
 * รองรับภาพที่บีบอัดแบบ DCTDecode (JPEG) ซึ่งเป็นรูปแบบที่เครื่องสแกนใช้เกือบทั้งหมด
 * และ FlateDecode (บิตแมปดิบ) ที่แปลงเป็น PNG ให้
 * รูปแบบอื่นเช่น CCITTFaxDecode และ JPXDecode ยังไม่รองรับ และถูกรายงานตามจริง
 */

export type PageImageFormat = 'jpg' | 'png';

export interface PageImage {
  data: Buffer;
  format: PageImageFormat;
  width: number;
  height: number;
}

export class PdfImageError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'PdfImageError';
  }
}

interface RawObject {
  dict: string;
  streamStart: number;
  streamEnd: number;
}

const MAX_OBJECTS = 20_000;

/** ไล่หาวัตถุทั้งหมดแบบตรงไปตรงมา ไม่พึ่งตารางอ้างอิงซึ่งมักผิดในไฟล์ที่เสียหาย */
function findObjects(buffer: Buffer): RawObject[] {
  const text = buffer.toString('latin1');
  const objects: RawObject[] = [];
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

function readNumber(dict: string, key: string): number | null {
  const match = new RegExp(`/${key}\\s+(\\d+)`).exec(dict);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

/** สร้างไฟล์ PNG จากบิตแมปดิบ - ใช้ zlib ของ Node ไม่มีไลบรารีภายนอก */
function encodePng(pixels: Buffer, width: number, height: number, channels: 1 | 3): Buffer {
  const colorType = channels === 1 ? 0 : 2;

  // PNG ต้องมีไบต์ตัวกรองนำหน้าทุกแถว - ใช้ 0 (ไม่มีการกรอง)
  const stride = width * channels;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }

  const chunk = (type: string, data: Buffer): Buffer => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body), 0);
    return Buffer.concat([length, body, crc]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // บิตต่อช่องสี
  ihdr[9] = colorType;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * ดึงภาพของแต่ละหน้าออกจาก PDF
 *
 * คืนอาร์เรย์ว่างเมื่อไม่มีภาพให้ดึง - ผู้เรียกเป็นผู้แปลงเป็นสถานะที่เหมาะสม
 */
export function extractPageImages(
  buffer: Buffer,
  limits: { maxPages: number; maxPixels: number },
): { images: PageImage[]; totalFound: number; unsupportedFilters: string[] } {
  if (!buffer.subarray(0, 5).toString('latin1').startsWith('%PDF-')) {
    throw new PdfImageError('OCR_RENDER_FAILED', 'ไฟล์นี้ไม่ใช่ PDF ที่อ่านได้');
  }

  const objects = findObjects(buffer);
  const images: PageImage[] = [];
  const unsupported = new Set<string>();
  let totalFound = 0;

  for (const object of objects) {
    if (!/\/Subtype\s*\/Image/.test(object.dict)) continue;
    if (object.streamStart < 0 || object.streamEnd < 0) continue;

    totalFound += 1;
    if (images.length >= limits.maxPages) continue;

    const width = readNumber(object.dict, 'Width');
    const height = readNumber(object.dict, 'Height');
    if (!width || !height) continue;

    // กันภาพที่บีบมาเล็กแต่คลายออกมาใหญ่มหาศาล
    if (width * height > limits.maxPixels) {
      throw new PdfImageError('OCR_IMAGE_TOO_LARGE', 'ภาพในเอกสารมีขนาดใหญ่เกินกำหนด');
    }

    const raw = buffer.subarray(object.streamStart, object.streamEnd);
    const filter = /\/Filter\s*(\[[^\]]*\]|\/\w+)/.exec(object.dict)?.[1] ?? '';

    /**
     * DCTDecode คือ JPEG - ไบต์ในสตรีมเป็นไฟล์ JPEG ที่สมบูรณ์อยู่แล้ว
     * เขียนออกไปตรง ๆ ได้เลย ไม่ต้องถอดรหัสภาพเอง
     */
    if (filter.includes('DCTDecode')) {
      images.push({ data: Buffer.from(raw), format: 'jpg', width, height });
      continue;
    }

    if (filter.includes('FlateDecode')) {
      const bits = readNumber(object.dict, 'BitsPerComponent') ?? 8;
      const isGray = /\/DeviceGray/.test(object.dict);
      const isRgb = /\/DeviceRGB/.test(object.dict);
      if (bits !== 8 || (!isGray && !isRgb)) {
        unsupported.add('FlateDecode(unsupported colorspace)');
        continue;
      }
      try {
        const pixels = zlib.inflateSync(raw);
        const channels = isGray ? 1 : 3;
        if (pixels.length < width * height * channels) {
          unsupported.add('FlateDecode(truncated)');
          continue;
        }
        images.push({ data: encodePng(pixels, width, height, channels), format: 'png', width, height });
      } catch {
        unsupported.add('FlateDecode(corrupt)');
      }
      continue;
    }

    // รูปแบบที่ยังไม่รองรับถูกรายงานตามจริง ไม่ใช่ข้ามไปเงียบ ๆ
    unsupported.add(filter.replace(/[[\]/\s]/g, '') || 'unknown');
  }

  return { images, totalFound, unsupportedFilters: [...unsupported] };
}

export const __testing = { encodePng, findObjects };

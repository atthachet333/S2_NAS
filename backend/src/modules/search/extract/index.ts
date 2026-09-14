import fsp from 'node:fs/promises';
import { env } from '../../../config/env.js';
import { createStoredFileStream, statStoredFile } from '../../../core/file-storage.js';
import { withLocalMaterialization } from '../../../core/storage/materialize.js';
import type { StorageProviderKind } from '../../../core/storage/provider.js';
import { cleanExtractedText, normalizeForSearch, truncateText } from './normalize.js';
import { extractDocx, extractPptx, extractXlsx, OoxmlSafetyError } from './ooxml.js';
import { extractPdfText, PdfExtractError } from './pdf.js';

/**
 * ตัวเลือกชนิดไฟล์และการสกัดข้อความ
 *
 * รุ่นของตัวสกัดถูกบันทึกไว้กับทุกแถวดัชนี เมื่อกติกาการสกัดเปลี่ยนไปในอนาคต
 * ผู้ดูแลจึงบอกได้ว่าแถวไหนควรทำใหม่ โดยไม่ต้องเดาจากวันที่
 */
export const EXTRACTOR_VERSION = 'f13.1';

export type ExtractOutcome =
  | { kind: 'TEXT'; text: string; normalized: string; truncated: boolean }
  | { kind: 'NO_TEXT' }
  | { kind: 'UNSUPPORTED' }
  | { kind: 'FAILED'; errorCode: string };

/**
 * ชนิดไฟล์ที่สกัดข้อความได้
 *
 * ตัดสินจากนามสกุลคู่กับชนิดที่เซิร์ฟเวอร์ยืนยันจากลายเซ็นไฟล์จริงตอนอัปโหลด
 * ไม่เชื่อค่าที่เบราว์เซอร์ประกาศมาเพียงอย่างเดียว
 */
type Handler = 'TEXT' | 'PDF' | 'DOCX' | 'XLSX' | 'PPTX';

const BY_EXTENSION: Record<string, Handler> = {
  txt: 'TEXT',
  csv: 'TEXT',
  tsv: 'TEXT',
  json: 'TEXT',
  xml: 'TEXT',
  md: 'TEXT',
  markdown: 'TEXT',
  log: 'TEXT',
  yml: 'TEXT',
  yaml: 'TEXT',
  ini: 'TEXT',
  sql: 'TEXT',
  pdf: 'PDF',
  docx: 'DOCX',
  xlsx: 'XLSX',
  pptx: 'PPTX',
};

/**
 * ชนิดที่มีมาโครฝังได้ ถูกกันออกโดยตั้งใจ
 *
 * แกะได้ในทางเทคนิค แต่การประกาศว่า "รองรับ" ไฟล์ที่มีโค้ดฝังอยู่
 * เชิญให้คนถือว่ามันปลอดภัยกว่าที่เป็นจริง
 */
const MACRO_ENABLED = new Set(['docm', 'xlsm', 'pptm', 'dotm', 'xltm', 'potm']);

export function handlerFor(extension: string | null, mimeType: string | null): Handler | null {
  const ext = (extension ?? '').toLowerCase().replace(/^\./, '');
  if (MACRO_ENABLED.has(ext)) return null;
  if (ext && BY_EXTENSION[ext]) return BY_EXTENSION[ext]!;

  // ไม่มีนามสกุลที่รู้จัก - ยอมรับเฉพาะชนิดที่เซิร์ฟเวอร์ยืนยันแล้วว่าเป็นข้อความ
  const mime = (mimeType ?? '').toLowerCase();
  if (mime === 'application/pdf') return 'PDF';
  if (mime.startsWith('text/')) return 'TEXT';
  if (mime === 'application/json' || mime === 'application/xml') return 'TEXT';
  return null;
}

/**
 * ตรวจว่าไบต์ก้อนนี้เป็นข้อความจริงหรือไม่
 *
 * ไฟล์ไบนารีที่บังเอิญมีนามสกุลเป็น .txt ต้องไม่ถูกอ่านเป็นข้อความ
 * มิฉะนั้นดัชนีจะเต็มไปด้วยอักขระขยะที่ไม่มีใครค้นหา
 */
function looksLikeText(buffer: Buffer): boolean {
  if (buffer.length === 0) return true;
  const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
  // ไบต์ศูนย์แทบไม่ปรากฏในไฟล์ข้อความ UTF-8 เลย
  if (sample.includes(0)) return false;

  const decoded = new TextDecoder('utf-8', { fatal: false }).decode(sample);
  // อักขระแทนที่จำนวนมากแปลว่าถอดรหัสไม่ได้จริง
  const replacements = (decoded.match(/�/g) ?? []).length;
  return replacements / Math.max(decoded.length, 1) < 0.05;
}

/**
 * อ่านเนื้อไฟล์ผ่านสตรีมของผู้ให้บริการ โดยหยุดเมื่อครบเพดานที่ตั้งไว้
 *
 * ไม่เปิดไฟล์บนดิสก์โดยตรง เพราะวัตถุอาจไม่ได้อยู่บนดิสก์ และการหยุดอ่านเมื่อครบ
 * เพดานทำให้ไฟล์ใหญ่ไม่ถูกดึงลงมาทั้งก้อนเพียงเพื่อจะตัดทิ้งภายหลัง
 */
async function readWholeFile(
  storageKey: string, maxBytes: number, provider: StorageProviderKind,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  const stream = await createStoredFileStream(storageKey, undefined, provider);
  for await (const chunk of stream) {
    const buffer = chunk as Buffer;
    chunks.push(buffer);
    total += buffer.length;
    if (total >= maxBytes) { stream.destroy(); break; }
  }
  return Buffer.concat(chunks).subarray(0, maxBytes);
}

/** ตัวจับเวลาต่อไฟล์ - ไฟล์ที่ทำให้ตัวสกัดช้าผิดปกติต้องไม่หยุดคิวทั้งคิว */
function withTimeout<T>(work: () => Promise<T>, seconds: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new PdfExtractError('EXTRACT_TIMEOUT', 'ใช้เวลาสกัดข้อความนานเกินกำหนด')),
      seconds * 1000,
    );
    work().then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error as Error);
      },
    );
  });
}

/**
 * สกัดข้อความจากไฟล์หนึ่งเวอร์ชัน
 *
 * ไม่โยน error ออกไปในกรณีปกติ - ความล้มเหลวเป็น "ผลลัพธ์ชนิดหนึ่ง" ที่ถูกบันทึกไว้
 * เพราะไฟล์ที่สกัดไม่ได้ต้องไม่ทำให้คิวหยุด และต้องไม่ทำให้ไฟล์นั้นดาวน์โหลดไม่ได้
 */
export async function extractFromStorage(input: {
  storageKey: string;
  extension: string | null;
  mimeType: string | null;
  /** ผู้ให้บริการที่บันทึกไว้กับเวอร์ชันนี้ - ค่าที่ไม่ได้ส่งมาหมายถึงดิสก์ของเครื่อง */
  storageProvider?: StorageProviderKind;
}): Promise<ExtractOutcome> {
  const provider = input.storageProvider ?? 'LOCAL';
  const handler = handlerFor(input.extension, input.mimeType);
  if (!handler) return { kind: 'UNSUPPORTED' };

  const stat = await statStoredFile(input.storageKey, provider);
  if (!stat) return { kind: 'FAILED', errorCode: 'FILE_MISSING' };
  if (stat.size > env.S2_NAS_EXTRACT_MAX_FILE_BYTES) {
    return { kind: 'FAILED', errorCode: 'FILE_TOO_LARGE_TO_INDEX' };
  }

  try {
    const raw = await withTimeout(async () => {
      const buffer = await readWholeFile(input.storageKey, env.S2_NAS_EXTRACT_MAX_FILE_BYTES, provider);

      switch (handler) {
        case 'TEXT':
          if (!looksLikeText(buffer)) return null;
          return buffer.toString('utf8');
        case 'PDF':
          return extractPdfText(buffer);
        case 'DOCX':
        case 'XLSX':
        case 'PPTX': {
          const target = { storageKey: input.storageKey, storageProvider: provider, expectedSize: stat.size };
          return withLocalMaterialization(target, async (localPath) => {
            if (handler === 'DOCX') return extractDocx(localPath);
            if (handler === 'XLSX') return extractXlsx(localPath);
            return extractPptx(localPath);
          });
        }
        default:
          return null;
      }
    }, env.S2_NAS_EXTRACT_MAX_SECONDS);

    if (raw === null) return { kind: 'UNSUPPORTED' };

    const cleaned = cleanExtractedText(raw);
    if (!cleaned) return { kind: 'NO_TEXT' };

    const { text, truncated } = truncateText(cleaned, env.S2_NAS_EXTRACT_MAX_TEXT_CHARS);
    return { kind: 'TEXT', text, normalized: normalizeForSearch(text), truncated };
  } catch (error) {
    /**
     * ห้ามบันทึกข้อความของเอกสารหรือเส้นทางจริงลง log
     * เก็บเฉพาะรหัสสั้น ๆ ที่ผู้ดูแลใช้ตัดสินใจได้ว่าจะลองใหม่หรือไม่
     */
    if (error instanceof PdfExtractError || error instanceof OoxmlSafetyError) {
      return { kind: 'FAILED', errorCode: error.code };
    }
    return { kind: 'FAILED', errorCode: 'EXTRACT_ERROR' };
  }
}

/** รหัสความล้มเหลวที่ลองใหม่แล้วก็ไม่มีทางสำเร็จ - อย่าวนลองไปเรื่อย ๆ */
export const PERMANENT_FAILURES = new Set([
  'PDF_INVALID',
  'PDF_ENCRYPTED',
  'PDF_TOO_LARGE',
  'ZIP_TOO_MANY_ENTRIES',
  'ZIP_TOO_LARGE',
  'ZIP_RATIO_SUSPICIOUS',
  'ZIP_ENTRY_TOO_LARGE',
  'FILE_TOO_LARGE_TO_INDEX',
]);

export function isPermanentFailure(errorCode: string | null | undefined): boolean {
  return errorCode !== null && errorCode !== undefined && PERMANENT_FAILURES.has(errorCode);
}

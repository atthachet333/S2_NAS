import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import { env } from '../config/env.js';
import { AppError } from './errors.js';
import { resolveInsideStorage } from './storage.js';
import { storageProviderFor, writeStorageProvider } from './storage/index.js';
import type { StorageProviderKind } from './storage/provider.js';

/**
 * เส้นทางอ่านเขียนไฟล์ของชั้นธุรกิจ (F23-B)
 *
 * **ไฟล์นี้ไม่รู้จักดิสก์อีกต่อไป** ทุกการอ่านเขียนวัตถุถูกส่งต่อให้ผู้ให้บริการ
 * พื้นที่จัดเก็บ ส่วนที่เหลือที่ยังใช้ node:fs โดยตรงคือ "พื้นที่พักระหว่างอัปโหลด"
 * ซึ่งเป็นของชั่วคราวบนเครื่องที่รันอยู่ ไม่ใช่ที่เก็บถาวรของเอกสาร
 *
 * หลักการเดิมที่ยังใช้อยู่ทุกข้อ:
 * - สตรีมเสมอ ไม่โหลดไฟล์ทั้งก้อนเข้าหน่วยความจำ
 * - พักไฟล์ก่อน คำนวณ checksum ระหว่างสตรีม แล้วค่อยย้ายเข้าที่จริง
 * - ถ้าขั้นตอนฐานข้อมูลล้มเหลว ผู้เรียกต้องสั่งลบไฟล์ที่พักไว้ (ดู discardStagedFile)
 * - storageKey เป็นตัวระบุภายในเท่านั้น ห้ามส่งออกไปยัง client
 *
 * **ผู้ให้บริการของแถว ไม่ใช่ของระบบ:** ทุกฟังก์ชันที่อ่านวัตถุรับ provider ของเวอร์ชัน
 * นั้นได้ ค่าที่ไม่ได้ส่งมาหมายถึงดิสก์ของเครื่อง ซึ่งเป็นที่อยู่ของทุกแถวในวันนี้
 */

export interface StagedFile {
  /** ตำแหน่งชั่วคราวบนดิสก์ ใช้ภายในกระบวนการอัปโหลดเท่านั้น */
  tempPath: string;
  size: number;
  checksum: string;
}

export interface StoredFile {
  storageKey: string;
  size: number;
  checksum: string;
  /** ผู้ให้บริการที่วัตถุนี้ถูกเขียนลงไปจริง - ต้องถูกบันทึกคู่กับคีย์เสมอ */
  provider: StorageProviderKind;
}

const TEMP_DIR = 'temp';

/** สตรีมข้อมูลขาเข้าลงไฟล์ชั่วคราว พร้อมคำนวณ SHA-256 ไปในรอบเดียว */
export async function stageUpload(
  source: Readable,
  options: { maxBytes?: number } = {},
): Promise<StagedFile> {
  const maxBytes = options.maxBytes ?? env.MAX_UPLOAD_SIZE_BYTES;

  await fsp.mkdir(resolveInsideStorage(TEMP_DIR), { recursive: true });
  const tempPath = resolveInsideStorage(TEMP_DIR, `upload-${crypto.randomUUID()}`);

  const hash = crypto.createHash('sha256');
  let size = 0;
  let tooLarge = false;

  const measure = async function* (stream: Readable) {
    for await (const chunk of stream) {
      const buffer = chunk as Buffer;
      size += buffer.length;
      if (size > maxBytes) {
        tooLarge = true;
        // หยุดทันทีเพื่อไม่ให้เขียนไฟล์ใหญ่เกินกำหนดลงดิสก์
        throw new AppError('FILE_TOO_LARGE', 'ไฟล์มีขนาดเกินกำหนด', 413);
      }
      hash.update(buffer);
      yield buffer;
    }
  };

  try {
    await pipeline(source, measure, fs.createWriteStream(tempPath));
  } catch (error) {
    await safeUnlink(tempPath);
    if (tooLarge || error instanceof AppError) {
      throw error instanceof AppError
        ? error
        : new AppError('FILE_TOO_LARGE', 'ไฟล์มีขนาดเกินกำหนด', 413);
    }
    throw new AppError('FILE_UPLOAD_FAILED', 'อัปโหลดไฟล์ไม่สำเร็จ', 500);
  }

  if (size === 0) {
    await safeUnlink(tempPath);
    throw new AppError('FILE_EMPTY', 'ไฟล์ว่างเปล่า', 400);
  }

  return { tempPath, size, checksum: hash.digest('hex') };
}

/**
 * ย้ายไฟล์ที่พักไว้เข้าตำแหน่งจริงภายใต้ storage key ที่ backend เป็นผู้กำหนด
 *
 * คีย์และการเตรียมที่ทางมาจากผู้ให้บริการ ผู้เรียกจึงไม่ต้องรู้ว่าปลายทางหน้าตาอย่างไร
 */
export async function commitStagedFile(staged: StagedFile, resourceId: string): Promise<StoredFile> {
  /**
   * จับผู้ให้บริการไว้ครั้งเดียวแล้วใช้ตัวเดิมตลอดการทำงานนี้
   *
   * ถ้าเรียกใหม่ทุกบรรทัด การเปลี่ยนค่าตั้งระหว่างที่การอัปโหลดกำลังทำงานอยู่
   * จะทำให้คีย์ถูกสร้างจากผู้ให้บริการหนึ่งแต่ไบต์ไปอยู่กับอีกผู้ให้บริการหนึ่ง
   * และค่าที่บันทึกลงฐานข้อมูลจะไม่ตรงกับที่ใดเลย
   */
  const provider = writeStorageProvider();
  await provider.prepare(resourceId);
  const storageKey = provider.createStorageKey(resourceId);
  await provider.commitStaged(storageKey, {
    path: staged.tempPath, size: staged.size, checksum: staged.checksum,
  });
  return { storageKey, size: staged.size, checksum: staged.checksum, provider: provider.kind };
}

/** ลบไฟล์ชั่วคราวเมื่อกระบวนการล้มเหลวก่อนบันทึกฐานข้อมูลสำเร็จ */
export async function discardStagedFile(staged: StagedFile): Promise<void> {
  await safeUnlink(staged.tempPath);
}

/**
 * อ่านไบต์แรกของไฟล์ที่พักไว้ เพื่อตรวจชนิดไฟล์จากลายเซ็นจริง
 *
 * ชั้นธุรกิจไม่ควรรู้ว่าไฟล์ที่พักไว้เป็นไฟล์บนดิสก์หรืออะไรอย่างอื่น มันรู้แค่ว่า
 * "ขอไบต์แรกของสิ่งที่เพิ่งอัปโหลดมา" การเปิด createReadStream เองในบริการอัปโหลด
 * ทำให้รูปแบบของพื้นที่พักรั่วออกไป และกลายเป็นจุดที่ต้องแก้เมื่อพื้นที่พักเปลี่ยนรูป
 */
export async function readStagedHead(staged: StagedFile, bytes: number): Promise<Buffer> {
  const handle = await fsp.open(staged.tempPath, 'r');
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/**
 * ลบวัตถุของ storage key หนึ่ง ๆ
 * คืน false เมื่อลบไม่สำเร็จ เพื่อให้ผู้เรียกรายงานความล้มเหลวตามจริง ไม่ใช่แกล้งว่าสำเร็จ
 */
export async function deleteStoredFile(
  storageKey: string,
  provider?: StorageProviderKind | null,
): Promise<boolean> {
  return storageProviderFor(provider).delete(storageKey);
}

/** ลบวัตถุทั้งหมดของทรัพยากรเมื่อไม่มีเวอร์ชันเหลืออยู่แล้ว */
export async function removeResourceDirectory(
  resourceId: string,
  provider?: StorageProviderKind | null,
): Promise<void> {
  await storageProviderFor(provider).removeResourceScope(resourceId);
}

export interface StoredFileStat {
  size: number;
  mtime: Date;
}

export async function statStoredFile(
  storageKey: string,
  provider?: StorageProviderKind | null,
): Promise<StoredFileStat | null> {
  return storageProviderFor(provider).stat(storageKey);
}

/**
 * เปิดสตรีมอ่านวัตถุ รองรับ HTTP Range ผ่าน start/end
 *
 * ช่วงไบต์รวมปลายทั้งสองด้านตามความหมายของ HTTP ซึ่งตรงกับพฤติกรรมเดิมของ
 * fs.createReadStream ทุกประการ ผู้เรียกที่ส่ง range มาจึงได้ผลเหมือนเดิม
 */
export async function createStoredFileStream(
  storageKey: string,
  range?: { start: number; end: number },
  provider?: StorageProviderKind | null,
): Promise<Readable> {
  const target = storageProviderFor(provider);
  return range
    ? target.getRangeStream(storageKey, range.start, range.end)
    : target.getStream(storageKey);
}

async function safeUnlink(target: string): Promise<void> {
  try {
    await fsp.unlink(target);
  } catch {
    /* ไฟล์อาจถูกลบไปแล้ว */
  }
}

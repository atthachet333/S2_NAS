import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import { env } from '../config/env.js';
import { AppError } from './errors.js';
import { logger } from './logger.js';
import { resolveInsideStorage } from './storage.js';
import { storageProvider, resolveStorageKey } from './storage-provider.js';

/**
 * การเขียนและอ่านไฟล์จริงบนดิสก์
 *
 * หลักการ:
 * - สตรีมเสมอ ไม่โหลดไฟล์ทั้งก้อนเข้าหน่วยความจำ
 * - เขียนลงพื้นที่ชั่วคราวก่อน คำนวณ checksum ระหว่างสตรีม แล้วค่อยย้ายเข้าที่จริง
 * - ถ้าขั้นตอนฐานข้อมูลล้มเหลว ผู้เรียกต้องสั่งลบไฟล์ที่ staged ไว้ (ดู discardStagedFile)
 * - storageKey เป็นตัวระบุภายในเท่านั้น ห้ามส่งออกไปยัง client
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
 * ย้ายไฟล์ที่ staged ไว้เข้าตำแหน่งจริงภายใต้ storage key ที่ backend เป็นผู้กำหนด
 * ใช้ rename ก่อน ถ้าข้าม volume ไม่ได้จึงถอยไปใช้ copy + unlink
 */
export async function commitStagedFile(staged: StagedFile, resourceId: string): Promise<StoredFile> {
  await storageProvider.ensureResourceDirectory(resourceId);
  const storageKey = storageProvider.createStorageKey(resourceId);
  const target = resolveStorageKey(storageKey);

  await fsp.mkdir(path.dirname(target), { recursive: true });

  try {
    await fsp.rename(staged.tempPath, target);
  } catch {
    await fsp.copyFile(staged.tempPath, target);
    await safeUnlink(staged.tempPath);
  }

  return { storageKey, size: staged.size, checksum: staged.checksum };
}

/** ลบไฟล์ชั่วคราวเมื่อกระบวนการล้มเหลวก่อนบันทึกฐานข้อมูลสำเร็จ */
export async function discardStagedFile(staged: StagedFile): Promise<void> {
  await safeUnlink(staged.tempPath);
}

/**
 * ลบไฟล์จริงของ storage key หนึ่ง ๆ
 * คืน false เมื่อลบไม่สำเร็จ เพื่อให้ผู้เรียกรายงานความล้มเหลวตามจริง ไม่ใช่แกล้งว่าสำเร็จ
 */
export async function deleteStoredFile(storageKey: string): Promise<boolean> {
  try {
    await fsp.unlink(resolveStorageKey(storageKey));
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return true; // ไม่มีไฟล์อยู่แล้ว ถือว่าปลายทางถูกต้อง
    logger.error({ code }, '[STORAGE] ลบไฟล์จริงไม่สำเร็จ');
    return false;
  }
}

/** ลบโฟลเดอร์ของทรัพยากรเมื่อไม่มีเวอร์ชันเหลืออยู่แล้ว */
export async function removeResourceDirectory(resourceId: string): Promise<void> {
  try {
    await fsp.rm(resolveInsideStorage('resources', resourceId), { recursive: true, force: true });
  } catch {
    /* ไม่ใช่ความล้มเหลวร้ายแรง ปล่อยให้ retention job เก็บกวาดภายหลัง */
  }
}

export interface StoredFileStat {
  size: number;
  mtime: Date;
}

export async function statStoredFile(storageKey: string): Promise<StoredFileStat | null> {
  try {
    const stat = await fsp.stat(resolveStorageKey(storageKey));
    return { size: stat.size, mtime: stat.mtime };
  } catch {
    return null;
  }
}

/** เปิดสตรีมอ่านไฟล์ รองรับ HTTP Range ผ่าน start/end */
export function createStoredFileStream(
  storageKey: string,
  range?: { start: number; end: number },
): fs.ReadStream {
  return fs.createReadStream(resolveStorageKey(storageKey), range);
}

async function safeUnlink(target: string): Promise<void> {
  try {
    await fsp.unlink(target);
  } catch {
    /* ไฟล์อาจถูกลบไปแล้ว */
  }
}

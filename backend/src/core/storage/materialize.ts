import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { AppError } from '../errors.js';
import { logger } from '../logger.js';
import { resolveInsideStorage } from '../storage.js';
import { storageProviderFor } from './index.js';
import type { StorageProviderKind } from './provider.js';

/**
 * ทำให้วัตถุมีเส้นทางบนดิสก์ชั่วคราว สำหรับผู้บริโภคที่รับได้เฉพาะไฟล์จริง (F23-D)
 *
 * **ใครใช้ได้:** ตัวสกัดข้อความจากเอกสาร (docx/xlsx/pptx) และ OCR ทั้งสองเรียก
 * ไลบรารีและโปรแกรมภายนอกที่รับได้เฉพาะเส้นทางไฟล์ ไม่รับสตรีม
 *
 * **ใครใช้ไม่ได้:** ทุกอย่างที่เหลือ การอัปโหลด ดาวน์โหลด บีบอัด และบริการทางธุรกิจ
 * ต้องใช้สตรีมจากผู้ให้บริการโดยตรง ถ้าโค้ดใหม่อยากได้เส้นทางไฟล์ นั่นมักแปลว่า
 * มันควรรับสตรีมแทน
 *
 * **ทำไมต้องเป็นฟังก์ชันที่ครอบการทำงาน:** ถ้าคืนเส้นทางเฉย ๆ ผู้เรียกต้องจำว่า
 * ต้องลบไฟล์ชั่วคราวเอง และจะมีสักวันที่ลืมบนเส้นทางที่ล้มเหลว รูปแบบนี้บังคับให้
 * การเก็บกวาดเกิดขึ้นใน finally เสมอ ไม่ว่างานข้างในจะจบแบบใด
 *
 * **ผู้ให้บริการบนดิสก์ไม่ต้องคัดลอก** ไฟล์อยู่บนดิสก์อยู่แล้ว การคัดลอกจะเพิ่ม I/O
 * เท่าตัวให้ทุกเอกสารในระบบโดยไม่ได้อะไรกลับมา
 */

const MATERIALIZE_DIR = 'temp';

export interface MaterializeTarget {
  storageKey: string;
  storageProvider: StorageProviderKind;
  /** ขนาดที่ metadata อ้าง ใช้ตรวจว่าไฟล์ที่ดึงมาครบจริง */
  expectedSize?: number;
}

export async function withLocalMaterialization<T>(
  target: MaterializeTarget,
  work: (localPath: string) => Promise<T>,
): Promise<T> {
  const provider = storageProviderFor(target.storageProvider);

  const existing = provider.localPathFor(target.storageKey);
  if (existing) return work(existing);

  await fsp.mkdir(resolveInsideStorage(MATERIALIZE_DIR), { recursive: true });
  /**
   * ชื่อไฟล์ชั่วคราวสุ่มล้วน ไม่มีส่วนใดมาจากชื่อที่ผู้ใช้ตั้ง
   *
   * ชื่อที่ผู้ใช้ควบคุมได้จะกลายเป็นทั้งช่องชนกันเองและช่องเดินออกนอกโฟลเดอร์
   * และรหัสสุ่มยังทำให้สองงานที่ทำเอกสารเดียวกันพร้อมกันไม่เขียนทับกัน
   */
  const localPath = resolveInsideStorage(MATERIALIZE_DIR, `materialize-${crypto.randomUUID()}`);

  try {
    await pipeline(await provider.getStream(target.storageKey), fs.createWriteStream(localPath));

    /**
     * ตรวจว่าไฟล์ที่ดึงมาครบตามที่ metadata อ้าง
     *
     * สตรีมที่ขาดกลางคันอาจจบลงอย่างเงียบ ๆ ด้วยไฟล์ที่สั้นกว่าจริง ซึ่งจะถูกสกัด
     * ข้อความได้บางส่วนแล้วบันทึกเป็นดัชนีที่ดูปกติ ความเสียหายแบบนั้นเงียบและ
     * ค้นหาไม่เจอ การหยุดตรงนี้ทำให้มันกลายเป็นความล้มเหลวที่มองเห็นแทน
     */
    if (target.expectedSize !== undefined) {
      const stat = await fsp.stat(localPath);
      if (stat.size !== target.expectedSize) {
        throw new AppError('STORAGE_MATERIALIZE_INCOMPLETE',
          'ดึงวัตถุจากพื้นที่จัดเก็บมาได้ไม่ครบ', 502);
      }
    }

    return await work(localPath);
  } finally {
    try {
      await fsp.unlink(localPath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // ไม่มีไฟล์ให้ลบเป็นเรื่องปกติเมื่อการดึงล้มเหลวตั้งแต่ต้น
      if (code !== 'ENOENT') logger.warn({ code }, '[STORAGE] ลบไฟล์ชั่วคราวไม่สำเร็จ');
    }
  }
}

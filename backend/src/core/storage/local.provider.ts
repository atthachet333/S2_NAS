import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import { logger } from '../logger.js';
import { resolveInsideStorage, verifyStorage } from '../storage.js';
import type {
  StagedObject, StorageHealth, StorageProvider, StorageStat, StoredObject,
} from './provider.js';

/**
 * พื้นที่จัดเก็บบนไฟล์ระบบของเครื่อง (F23-B)
 *
 * **นี่คือที่เดียวที่ยังรู้จัก node:fs สำหรับไบต์ของเอกสาร** พฤติกรรมทุกอย่างในไฟล์นี้
 * ถูกยกมาจากโค้ดเดิมแบบคำต่อคำ ไม่ใช่เขียนใหม่ เพราะงานของ F23-B คือย้ายที่อยู่ของ
 * ตรรกะเดิม ไม่ใช่เปลี่ยนความหมายของมัน สิ่งที่เคยสำเร็จต้องยังสำเร็จเหมือนเดิม
 * และสิ่งที่เคยล้มเหลวต้องยังล้มเหลวด้วยรหัสเดิม
 *
 * ทุกเส้นทางผ่าน resolveInsideStorage ซึ่งบังคับให้อยู่ใต้รากของพื้นที่จัดเก็บเสมอ
 * คีย์ที่พยายามเดินออกนอกรากจะถูกปฏิเสธตั้งแต่ชั้นนั้น
 */
export class LocalStorageProvider implements StorageProvider {
  readonly kind = 'LOCAL' as const;

  /**
   * รูปแบบคีย์เดิมทุกประการ: resources/<resourceId>/<uuid>
   *
   * ไม่เปลี่ยนรูปแบบใน F23-B แม้จะมีรูปแบบที่อ่านง่ายกว่า เพราะแถวที่มีอยู่แล้วนับพัน
   * ใช้รูปแบบนี้ การเปลี่ยนตอนนี้จะสร้างสองรูปแบบในระบบเดียวโดยไม่ได้อะไรกลับมา
   */
  createStorageKey(resourceId: string): string {
    return `resources/${resourceId}/${crypto.randomUUID()}`;
  }

  async prepare(resourceId: string): Promise<void> {
    await fsp.mkdir(resolveInsideStorage('resources', resourceId), { recursive: true });
  }

  async put(key: string, source: Readable): Promise<StoredObject> {
    const target = this.pathOf(key);
    await fsp.mkdir(path.dirname(target), { recursive: true });

    const hash = crypto.createHash('sha256');
    let size = 0;
    const measure = async function* (stream: Readable) {
      for await (const chunk of stream) {
        const buffer = chunk as Buffer;
        size += buffer.length;
        hash.update(buffer);
        yield buffer;
      }
    };

    await pipeline(source, measure, fs.createWriteStream(target));
    return { size, checksum: hash.digest('hex') };
  }

  /**
   * ย้ายไฟล์ที่พักไว้เข้าที่จริง
   *
   * ใช้ rename ก่อนเพราะอยู่ใต้รากเดียวกันจึงเป็นการเปลี่ยนชื่อในระบบไฟล์ ไม่ต้องอ่านซ้ำ
   * ถ้าข้าม volume ไม่ได้จึงถอยไปคัดลอกแล้วลบต้นทาง - ตรงกับพฤติกรรมเดิมทุกประการ
   */
  async commitStaged(key: string, staged: StagedObject): Promise<void> {
    const target = this.pathOf(key);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    try {
      await fsp.rename(staged.path, target);
    } catch {
      await fsp.copyFile(staged.path, target);
      await safeUnlink(staged.path);
    }
  }

  async getStream(key: string): Promise<Readable> {
    return fs.createReadStream(this.pathOf(key));
  }

  async getRangeStream(key: string, start: number, end: number): Promise<Readable> {
    return fs.createReadStream(this.pathOf(key), { start, end });
  }

  async stat(key: string): Promise<StorageStat | null> {
    try {
      const stat = await fsp.stat(this.pathOf(key));
      return { size: stat.size, mtime: stat.mtime };
    } catch {
      return null;
    }
  }

  async exists(key: string): Promise<boolean> {
    return (await this.stat(key)) !== null;
  }

  /**
   * ลบวัตถุ
   *
   * ไฟล์ที่ไม่มีอยู่แล้วถือว่าปลายทางถูกต้อง คืน true เพราะผลลัพธ์ที่ผู้เรียกต้องการ
   * คือ "ไม่มีวัตถุนี้แล้ว" ความล้มเหลวจริงคืนเป็น false เพื่อให้ผู้เรียกรายงานตามจริง
   * ไม่ใช่แกล้งว่าสำเร็จ
   */
  async delete(key: string): Promise<boolean> {
    try {
      await fsp.unlink(this.pathOf(key));
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return true;
      logger.error({ code, provider: this.kind }, '[STORAGE] ลบวัตถุไม่สำเร็จ');
      return false;
    }
  }

  async copy(fromKey: string, toKey: string): Promise<void> {
    const target = this.pathOf(toKey);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.copyFile(this.pathOf(fromKey), target);
  }

  async removeResourceScope(resourceId: string): Promise<void> {
    try {
      await fsp.rm(resolveInsideStorage('resources', resourceId), { recursive: true, force: true });
    } catch {
      /* ไม่ใช่ความล้มเหลวร้ายแรง ปล่อยให้ retention job เก็บกวาดภายหลัง */
    }
  }

  /**
   * สุขภาพของพื้นที่จัดเก็บบนดิสก์
   *
   * ใช้ผลของ verifyStorage เดิมซึ่งตรวจว่าสร้างได้ อ่านได้ และเขียนได้จริง
   * แปลงเป็นคำศัพท์กลางของสัญญา: เขียนไม่ได้แต่ยังอ่านได้คือ DEGRADED ไม่ใช่พังทั้งหมด
   */
  async health(): Promise<StorageHealth> {
    const check = await verifyStorage();
    if (check.status === 'READY') return { status: 'READY' };
    if (check.status === 'READ_ONLY') return { status: 'DEGRADED', detail: 'พื้นที่จัดเก็บเขียนไม่ได้' };
    return { status: 'UNAVAILABLE', detail: 'เข้าถึงพื้นที่จัดเก็บไม่ได้' };
  }

  localPathFor(key: string): string | null {
    return this.pathOf(key);
  }

  private pathOf(key: string): string {
    return resolveInsideStorage(...key.split('/').filter(Boolean));
  }
}

async function safeUnlink(target: string): Promise<void> {
  try {
    await fsp.unlink(target);
  } catch {
    /* ไฟล์อาจถูกลบไปแล้ว */
  }
}

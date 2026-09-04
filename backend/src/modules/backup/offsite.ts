import fsp from 'node:fs/promises';
import path from 'node:path';
import { env } from '../../config/env.js';
import { AppError } from '../../core/errors.js';
import { logger } from '../../core/logger.js';
import { BACKUP_PATHS, backupDirectory } from './backup.service.js';
import { isSafeStorageKey, readManifest, sha256File } from './manifest.js';

/**
 * สำเนานอกเครื่อง
 *
 * ชุดสำรองที่อยู่บนเครื่องเดียวกับข้อมูลจริงไม่รอดจากดิสก์เสีย เครื่องหาย ไฟไหม้ หรือ ransomware
 * ส่วนนี้จึงคัดลอกชุดสำรองออกไปยังปลายทางอื่น แล้ว "ตรวจซ้ำที่ปลายทาง" เสมอ
 *
 * ตั้งใจทำเป็น interface ก่อน ไม่ผูกกับผู้ให้บริการรายใดรายหนึ่ง
 * ผู้ให้บริการแรกคือระบบไฟล์ (ดิสก์อีกลูกหรือ network share) ซึ่งทดสอบได้จริงทั้งหมด
 */

export interface OffsiteCopyResult {
  ok: boolean;
  copiedObjects: number;
  verifiedObjects: number;
  bytes: number;
  problems: string[];
}

export interface OffsiteHealth {
  configured: boolean;
  reachable: boolean;
  reason?: string;
}

export interface OffsiteBackupProvider {
  readonly kind: string;
  healthCheck(): Promise<OffsiteHealth>;
  uploadBackup(backupName: string, backupId: string): Promise<OffsiteCopyResult>;
  verifyRemote(backupName: string, backupId: string): Promise<OffsiteCopyResult>;
  deleteRemote(backupId: string): Promise<void>;
}

/* ------------------------------------------------------------------ */
/* ผู้ให้บริการแบบระบบไฟล์                                              */
/* ------------------------------------------------------------------ */

/** โครงสร้างที่ปลายทางใช้ backupId เป็นชื่อโฟลเดอร์ และคงรูปแพ็กเกจไว้ทั้งชุด */
function remoteDirectory(root: string, backupId: string): string {
  /**
   * backupId มาจาก cuid ที่ระบบออกให้ แต่ยังกรองซ้ำก่อนนำไปต่อเป็นเส้นทาง
   * ไม่มีส่วนใดของเส้นทางปลายทางมาจากอินพุตของผู้ใช้
   */
  const safe = backupId.replace(/[^a-zA-Z0-9_-]/g, '');
  if (!safe || safe !== backupId) {
    throw new AppError('OFFSITE_INVALID_ID', 'รหัสชุดสำรองไม่ถูกต้องสำหรับสำเนานอกเครื่อง', 400);
  }
  return path.join(root, safe);
}

export class FilesystemOffsiteProvider implements OffsiteBackupProvider {
  readonly kind = 'FILESYSTEM';

  constructor(private readonly root: string | null = env.OFFSITE_BACKUP_ROOT) {}

  /**
   * ปลายทางอาจเป็น network share ที่หายไปชั่วคราว
   * ต้องตอบกลับเร็วและไม่ทำให้แอปค้าง - ระบบยังต้องทำงานได้แม้ปลายทางล่ม
   */
  async healthCheck(): Promise<OffsiteHealth> {
    if (!this.root) return { configured: false, reachable: false, reason: 'ยังไม่ได้ตั้งค่าปลายทางนอกเครื่อง' };
    try {
      await fsp.mkdir(this.root, { recursive: true });
      const probe = path.join(this.root, '.write-probe');
      await fsp.writeFile(probe, 'ok');
      await fsp.rm(probe, { force: true });
      return { configured: true, reachable: true };
    } catch {
      // ไม่ส่ง path จริงหรือข้อความ error ของระบบไฟล์กลับไป
      return { configured: true, reachable: false, reason: 'เข้าถึงปลายทางนอกเครื่องไม่ได้' };
    }
  }

  async uploadBackup(backupName: string, backupId: string): Promise<OffsiteCopyResult> {
    const health = await this.healthCheck();
    if (!health.configured) throw new AppError('OFFSITE_NOT_CONFIGURED', 'ยังไม่ได้ตั้งค่าปลายทางนอกเครื่อง', 400);
    if (!health.reachable) throw new AppError('OFFSITE_UNREACHABLE', health.reason ?? 'เข้าถึงปลายทางไม่ได้', 503);

    const source = backupDirectory(backupName);
    const destination = remoteDirectory(this.root!, backupId);

    // เขียนทับของเดิมเสมอ สำเนาที่ค้างครึ่งทางจากรอบก่อนต้องไม่ถูกนับว่าใช้ได้
    await fsp.rm(destination, { recursive: true, force: true });
    await fsp.mkdir(destination, { recursive: true });

    const manifest = await readManifest(path.join(source, BACKUP_PATHS.MANIFEST_FILE));

    // แพ็กเกจต้องคงรูปเดิม ไม่ยุบโครงสร้าง มิฉะนั้นการกู้คืนจากสำเนานี้จะไม่เหมือนจากต้นฉบับ
    for (const relative of [BACKUP_PATHS.MANIFEST_FILE, BACKUP_PATHS.BACKUP_FILE, manifest.database.fileName]) {
      const from = path.join(source, ...relative.split('/'));
      const to = path.join(destination, ...relative.split('/'));
      await fsp.mkdir(path.dirname(to), { recursive: true });
      await fsp.copyFile(from, to);
    }

    let copiedObjects = 0;
    let bytes = 0;
    for (const object of manifest.storage.objects) {
      if (!isSafeStorageKey(object.storageKey)) {
        throw new AppError('OFFSITE_UNSAFE_PATH', 'manifest มีเส้นทางที่ไม่ปลอดภัย', 500);
      }
      const from = path.join(source, BACKUP_PATHS.STORAGE_DIR, object.storageKey);
      const to = path.join(destination, BACKUP_PATHS.STORAGE_DIR, object.storageKey);
      await fsp.mkdir(path.dirname(to), { recursive: true });
      await fsp.copyFile(from, to);
      copiedObjects += 1;
      bytes += object.size;
    }

    logger.info(`[OFFSITE] คัดลอกแล้ว ${copiedObjects} ไฟล์ กำลังตรวจสอบที่ปลายทาง`);

    // การคัดลอกสำเร็จยังไม่พอ ต้องอ่านกลับมาตรวจที่ปลายทางจริง
    const verification = await this.verifyRemote(backupName, backupId);
    return { ...verification, copiedObjects, bytes };
  }

  /**
   * ตรวจสำเนาที่ปลายทางโดยอ่านไฟล์ที่ปลายทางกลับมาคำนวณ checksum ใหม่
   *
   * ไม่เชื่อผลของการ copy เพียงอย่างเดียว - การเขียนลง network share อาจสำเร็จบางส่วน
   * หรือถูกตัดกลางทางโดยที่ระบบปฏิบัติการไม่รายงานข้อผิดพลาด
   */
  async verifyRemote(backupName: string, backupId: string): Promise<OffsiteCopyResult> {
    if (!this.root) throw new AppError('OFFSITE_NOT_CONFIGURED', 'ยังไม่ได้ตั้งค่าปลายทางนอกเครื่อง', 400);

    const destination = remoteDirectory(this.root, backupId);
    const problems: string[] = [];
    let verifiedObjects = 0;
    let bytes = 0;

    let manifest;
    try {
      manifest = await readManifest(path.join(destination, BACKUP_PATHS.MANIFEST_FILE));
    } catch {
      return { ok: false, copiedObjects: 0, verifiedObjects: 0, bytes: 0, problems: ['อ่าน manifest ที่ปลายทางไม่ได้'] };
    }

    // manifest ที่ปลายทางต้องเหมือนต้นฉบับทุกไบต์
    const localManifest = path.join(backupDirectory(backupName), BACKUP_PATHS.MANIFEST_FILE);
    try {
      const [local, remote] = await Promise.all([
        sha256File(localManifest),
        sha256File(path.join(destination, BACKUP_PATHS.MANIFEST_FILE)),
      ]);
      if (local !== remote) problems.push('manifest ที่ปลายทางไม่ตรงกับต้นฉบับ');
    } catch {
      problems.push('เทียบ manifest ที่ปลายทางไม่ได้');
    }

    try {
      const dumpChecksum = await sha256File(path.join(destination, ...manifest.database.fileName.split('/')));
      if (dumpChecksum !== manifest.database.checksum) problems.push('checksum ของดัมป์ฐานข้อมูลที่ปลายทางไม่ตรง');
    } catch {
      problems.push('ไม่พบดัมป์ฐานข้อมูลที่ปลายทาง');
    }

    for (const object of manifest.storage.objects) {
      const target = path.join(destination, BACKUP_PATHS.STORAGE_DIR, object.storageKey);
      try {
        const checksum = await sha256File(target);
        if (checksum === object.checksum) {
          verifiedObjects += 1;
          bytes += object.size;
        } else {
          problems.push(`checksum ที่ปลายทางไม่ตรง: ${object.storageKey}`);
        }
      } catch {
        problems.push(`ไม่พบไฟล์ที่ปลายทาง: ${object.storageKey}`);
      }
    }

    if (verifiedObjects !== manifest.storage.objectCount) {
      problems.push(`จำนวนไฟล์ที่ปลายทางไม่ครบ (${verifiedObjects}/${manifest.storage.objectCount})`);
    }

    return {
      ok: problems.length === 0,
      copiedObjects: manifest.storage.objectCount,
      verifiedObjects,
      bytes,
      problems,
    };
  }

  /**
   * ลบสำเนาที่ปลายทาง
   *
   * ไม่ถูกเรียกโดยนโยบายเก็บอัตโนมัติในรุ่นนี้ - การลบของนอกเครื่องเป็นการตัดสินใจของผู้ดูแล
   * จนกว่าการตรวจสอบที่ปลายทางจะผ่านการใช้งานจริงมาสักระยะ ดู docs/OFFSITE_BACKUP.md
   */
  async deleteRemote(backupId: string): Promise<void> {
    if (!this.root) throw new AppError('OFFSITE_NOT_CONFIGURED', 'ยังไม่ได้ตั้งค่าปลายทางนอกเครื่อง', 400);
    await fsp.rm(remoteDirectory(this.root, backupId), { recursive: true, force: true });
  }
}

/** ผู้ให้บริการที่ระบบใช้อยู่ - จุดเดียวที่ต้องแก้เมื่อเพิ่มผู้ให้บริการบนคลาวด์ในอนาคต */
export function offsiteProvider(): OffsiteBackupProvider {
  return new FilesystemOffsiteProvider();
}

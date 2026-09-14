import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import type { StorageProviderKind } from '@prisma/client';
import { storageProviderFor } from '../../core/storage/index.js';
import { isSafeStorageKey, type ManifestObject } from './manifest.js';

/**
 * ปลายทางของการกู้คืนวัตถุ (F23-F)
 *
 * **ปลายทางมาจากคำสั่ง ไม่ใช่จากชุดสำรอง** ชุดสำรองบันทึกไว้ว่าวัตถุเคยอยู่ที่ใด
 * แต่ค่านั้นเป็นข้อมูลประกอบเท่านั้น การกู้คืนไปยังระบบใหม่ที่ใช้ผู้ให้บริการคนละราย
 * เป็นกรณีปกติ ไม่ใช่ข้อยกเว้น ชุดสำรองจึงต้องไม่ผูกปลายทางไว้ล่วงหน้า
 *
 * **ตรวจสองชั้นเสมอ** ชั้นแรกตรวจไบต์ที่อ่านจากชุดสำรองว่าตรงกับ manifest
 * ชั้นที่สองตรวจไบต์ที่อ่านกลับมาจากปลายทางว่าตรงกับ manifest เช่นกัน
 * ชั้นแรกจับชุดสำรองที่เสียหาย ชั้นที่สองจับการเขียนที่ไม่ครบ ซึ่งเป็นคนละปัญหากัน
 *
 * **พื้นที่พักของการกู้คืนแยกจากข้อมูลที่ใช้งานจริงเสมอ** ปลายทางบนดิสก์เป็นโฟลเดอร์พัก
 * ส่วนปลายทางบนที่เก็บวัตถุใช้คำนำหน้าเชิงตรรกะของการกู้คืนโดยเฉพาะ วัตถุที่ใช้งานอยู่
 * จึงไม่มีทางถูกเขียนทับจากการซ้อมกู้คืน
 */

export const RESTORE_STAGE_PREFIX = 'restore-stage';

export interface RestoreTarget {
  provider: StorageProviderKind;
  /** โฟลเดอร์พักบนดิสก์ - ใช้เมื่อปลายทางเป็นดิสก์ของเครื่อง */
  localStageDir: string;
  /** ตัวคั่นของรอบการกู้คืนนี้ ใช้กันไม่ให้สองรอบเขียนทับกัน */
  runId: string;
}

export interface RestoreObjectResult {
  restored: number;
  verified: number;
  problems: string[];
}

async function measure(stream: Readable): Promise<{ size: number; checksum: string }> {
  const hash = crypto.createHash('sha256');
  let size = 0;
  for await (const chunk of stream) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    hash.update(buffer);
  }
  return { size, checksum: hash.digest('hex') };
}

/** คีย์ของวัตถุที่ถูกกู้คืนไว้ในพื้นที่พักของที่เก็บวัตถุ */
export function stagedObjectKey(runId: string, storageKey: string): string {
  return `${RESTORE_STAGE_PREFIX}/${runId}/${storageKey}`;
}

/**
 * นำวัตถุจากชุดสำรองขึ้นปลายทางที่เลือก แล้วตรวจซ้ำจากปลายทางเอง
 *
 * ลำดับ: อ่านจากชุดสำรอง -> ตรวจ -> เขียนลงปลายทาง -> อ่านกลับจากปลายทาง -> ตรวจ
 * ไม่มีจังหวะใดที่ข้อมูลกำกับชี้ไปยังวัตถุที่ยังไม่ถูกพิสูจน์ว่าครบ
 */
export async function restoreObjectsToTarget(
  objects: ManifestObject[],
  backupStorageDir: string,
  target: RestoreTarget,
): Promise<RestoreObjectResult> {
  const problems: string[] = [];
  let restored = 0;
  let verified = 0;

  for (const object of objects) {
    if (!isSafeStorageKey(object.storageKey)) {
      problems.push('พบเส้นทางที่ไม่ปลอดภัยใน manifest');
      continue;
    }

    const source = path.join(backupStorageDir, object.storageKey);

    /* ---- 1. ตรวจไบต์ที่อยู่ในชุดสำรองก่อน ---- */
    let packaged: { size: number; checksum: string };
    try {
      packaged = await measure(fs.createReadStream(source));
    } catch {
      problems.push(`ไม่พบไฟล์ในชุดสำรอง: ${object.storageKey}`);
      continue;
    }
    if (packaged.size !== object.size || packaged.checksum !== object.checksum) {
      problems.push(`ไฟล์ในชุดสำรองไม่ตรงกับ manifest: ${object.storageKey}`);
      continue;
    }

    /* ---- 2. เขียนลงปลายทางที่เลือก ---- */
    try {
      if (target.provider === 'LOCAL') {
        const destination = path.join(target.localStageDir, object.storageKey);
        await fsp.mkdir(path.dirname(destination), { recursive: true });
        await pipeline(fs.createReadStream(source), fs.createWriteStream(destination));
      } else {
        const provider = storageProviderFor(target.provider);
        await provider.put(stagedObjectKey(target.runId, object.storageKey), fs.createReadStream(source));
      }
      restored += 1;
    } catch {
      problems.push(`เขียนลงปลายทางไม่สำเร็จ: ${object.storageKey}`);
      continue;
    }

    /* ---- 3. อ่านกลับจากปลายทางแล้วตรวจอีกครั้ง ---- */
    try {
      const readBack = target.provider === 'LOCAL'
        ? await measure(fs.createReadStream(path.join(target.localStageDir, object.storageKey)))
        : await measure(await storageProviderFor(target.provider)
          .getStream(stagedObjectKey(target.runId, object.storageKey)));

      if (readBack.size === object.size && readBack.checksum === object.checksum) verified += 1;
      else problems.push(`ไฟล์ที่กู้มาไม่ตรงกับ manifest: ${object.storageKey}`);
    } catch {
      problems.push(`อ่านไฟล์ที่กู้มาไม่ได้: ${object.storageKey}`);
    }
  }

  return { restored, verified, problems };
}

/**
 * คีย์เชิงตรรกะของวัตถุที่กู้คืนไว้ในพื้นที่พักของรอบนี้ - คืนเป็นคีย์เดิมของวัตถุ
 *
 * ใช้กระทบยอด "ไฟล์ส่วนเกิน" ให้ทำงานเหมือนกันทั้งสองปลายทาง
 */
export async function listStagedObjectKeys(
  provider: StorageProviderKind, runId: string,
): Promise<string[]> {
  if (provider === 'LOCAL') return [];
  const storage = storageProviderFor(provider);
  const { S3StorageProvider } = await import('../../core/storage/s3.provider.js');
  if (!(storage instanceof S3StorageProvider)) return [];

  const scope = `${RESTORE_STAGE_PREFIX}/${runId}/`;
  return (await storage.listLogicalKeys(scope)).map((key) => key.slice(scope.length));
}

/**
 * เก็บกวาดวัตถุที่กู้คืนไว้ในพื้นที่พักของที่เก็บวัตถุ
 *
 * พื้นที่พักของการกู้คืนเป็นของชั่วคราวเสมอ ถ้าไม่เก็บกวาด การซ้อมกู้คืนทุกครั้ง
 * จะทิ้งสำเนาทั้งคลังไว้ในถังจริง ซึ่งทั้งเปลืองและทำให้การตรวจหาวัตถุกำพร้าสับสน
 */
export async function cleanupStagedObjects(
  provider: StorageProviderKind, runId: string,
): Promise<number> {
  if (provider === 'LOCAL') return 0;
  const storage = storageProviderFor(provider);
  const { S3StorageProvider } = await import('../../core/storage/s3.provider.js');
  if (!(storage instanceof S3StorageProvider)) return 0;

  const keys = await storage.listLogicalKeys(`${RESTORE_STAGE_PREFIX}/${runId}/`);
  for (const key of keys) await storage.delete(key);
  return keys.length;
}

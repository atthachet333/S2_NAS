import fsp from 'node:fs/promises';
import path from 'node:path';
import type { BackupLog } from '@prisma/client';
import { env } from '../../config/env.js';
import { AppError, notFound } from '../../core/errors.js';
import { logger } from '../../core/logger.js';
import { prisma } from '../../core/prisma.js';
import type { AuthUser } from '../auth/auth.service.js';
import { checkTooling, dumpDatabase, parseDatabaseUrl } from './mariadb-cli.js';
import {
  MANIFEST_VERSION,
  isSafeStorageKey,
  manifestChecksum,
  readManifest,
  sha256File,
  writeManifest,
  type BackupManifest,
  type ManifestObject,
} from './manifest.js';
import { acquireOperationLock } from './operation-lock.js';
import { acquireDistributedLock } from './distributed-lock.js';

/**
 * การสำรองข้อมูลของ S2 NAS
 *
 * หนึ่งชุดสำรอง = ภาพนิ่งหนึ่งชุดที่สอดคล้องกัน ประกอบด้วยดัมป์ฐานข้อมูล ไฟล์จริงที่ metadata
 * อ้างถึง และ manifest ที่บอกว่าควรมีอะไรบ้าง
 *
 * ลำดับสำคัญ: ดัมป์ฐานข้อมูลก่อน แล้วจึงคัดลอกไฟล์ตามรายการที่ได้จาก snapshot นั้น
 * ไม่ใช่ไล่คัดลอกทั้งต้นไม้ storage แบบไม่ดูข้อมูล เพราะการอัปโหลดที่เกิดขึ้นระหว่างทาง
 * จะทำให้ได้ไฟล์ที่ฐานข้อมูลในชุดสำรองไม่รู้จัก
 */

const DATABASE_DIR = 'database';
const STORAGE_DIR = 'storage';
const DUMP_FILE = 's2_nas.sql';
const MANIFEST_FILE = 'manifest.json';
const BACKUP_FILE = 'backup.json';
const APP_VERSION = '0.1.0';

/** ชื่อโฟลเดอร์ชุดสำรองสร้างจากเวลาและ id เท่านั้น ไม่มีส่วนใดมาจากผู้ใช้ */
export function backupFolderName(now: Date, backupId: string): string {
  const stamp = now.toISOString().replace(/[:.]/g, '-').replace(/-\d{3}Z$/, 'Z');
  return `${stamp}_${backupId}`;
}

export function backupDirectory(backupName: string): string {
  return path.join(env.BACKUP_ROOT, backupName);
}

/* ------------------------------------------------------------------ */
/* DTO                                                                 */
/* ------------------------------------------------------------------ */

export interface BackupDto {
  id: string;
  status: BackupLog['status'];
  type: BackupLog['type'];
  trigger: BackupLog['trigger'];
  offsiteState: BackupLog['offsiteState'];
  offsiteVerifiedAt: Date | null;
  offsiteError: string | null;
  startedAt: Date;
  completedAt: Date | null;
  databaseBytes: number | null;
  storageBytes: number | null;
  totalBytes: number | null;
  fileCount: number | null;
  createdBy: { id: string; displayName: string; email: string } | null;
  errorCode: string | null;
  errorMessage: string | null;
  durationMs: number | null;
}

/**
 * DTO ไม่มี backupName และไม่มี path จริงเด็ดขาด
 * ตำแหน่งบนดิสก์เป็นเรื่องของเครื่อง ไม่ใช่ข้อมูลที่ browser ควรรู้หรือพึ่งพา
 */
export function toBackupDto(row: BackupLog & { triggeredBy?: { id: string; displayName: string; email: string } | null }): BackupDto {
  return {
    id: row.id,
    status: row.status,
    type: row.type,
    trigger: row.trigger,
    offsiteState: row.offsiteState,
    offsiteVerifiedAt: row.offsiteVerifiedAt,
    offsiteError: row.offsiteErrorSafe,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    databaseBytes: row.databaseBytes === null ? null : Number(row.databaseBytes),
    storageBytes: row.storageBytes === null ? null : Number(row.storageBytes),
    totalBytes: row.totalBytes === null ? null : Number(row.totalBytes),
    fileCount: row.fileCount,
    createdBy: row.triggeredBy ?? null,
    errorCode: row.errorCode,
    errorMessage: row.errorMessageSafe,
    durationMs: row.completedAt ? row.completedAt.getTime() - row.startedAt.getTime() : null,
  };
}

const withUser = { triggeredBy: { select: { id: true, displayName: true, email: true } } } as const;

export async function listBackups(limit = 50): Promise<BackupDto[]> {
  const rows = await prisma.backupLog.findMany({
    include: withUser,
    orderBy: { startedAt: 'desc' },
    take: limit,
  });
  return rows.map(toBackupDto);
}

export async function getBackup(id: string): Promise<BackupDto> {
  const row = await prisma.backupLog.findUnique({ where: { id }, include: withUser });
  if (!row) throw notFound('BACKUP_NOT_FOUND', 'ไม่พบชุดสำรองข้อมูล');
  return toBackupDto(row);
}

/* ------------------------------------------------------------------ */
/* รายการไฟล์ที่ต้องสำรอง                                              */
/* ------------------------------------------------------------------ */

/**
 * รายการไฟล์จริงที่ metadata อ้างถึง
 *
 * ใช้ ResourceVersion เป็นแหล่งหลัก เพราะประวัติเวอร์ชันคือความจริงทางประวัติศาสตร์
 * และครอบคลุมทั้งไฟล์ปัจจุบันและเวอร์ชันเก่า
 *
 * รายการที่อยู่ในถังขยะยังมีแถวอยู่ จึงถูกรวมมาโดยอัตโนมัติ - ต้องเป็นเช่นนั้น
 * มิฉะนั้นการกู้คืนจะได้ระบบที่ metadata บอกว่ามีไฟล์ แต่ไฟล์จริงหายไป
 *
 * รายการที่ถูกลบถาวรแล้วไม่มีแถวเหลือ จึงไม่อยู่ในชุดสำรองโดยธรรมชาติ
 */
export async function collectManifestObjects(): Promise<{ objects: ManifestObject[]; skipped: string[] }> {
  const versions = await prisma.resourceVersion.findMany({
    select: { storageKey: true, size: true, checksum: true, resourceId: true, versionNumber: true },
    orderBy: { storageKey: 'asc' },
  });

  const objects: ManifestObject[] = [];
  const skipped: string[] = [];
  const seen = new Set<string>();

  for (const version of versions) {
    if (!isSafeStorageKey(version.storageKey)) {
      skipped.push(version.storageKey);
      continue;
    }
    seen.add(version.storageKey);
    objects.push({
      storageKey: version.storageKey,
      size: Number(version.size),
      checksum: version.checksum,
      resourceId: version.resourceId,
      versionNumber: version.versionNumber,
    });
  }

  /**
   * ไฟล์ที่ Resource ชี้อยู่แต่ไม่มีแถวเวอร์ชันคู่กัน (ข้อมูลเก่าก่อนมีระบบเวอร์ชัน)
   * ต้องไม่ตกหล่น มิฉะนั้นการกู้คืนจะได้ระเบียนที่ไม่มีไฟล์
   */
  const orphans = await prisma.resource.findMany({
    where: { storageKey: { not: null }, type: 'FILE' },
    select: { id: true, storageKey: true, size: true, checksum: true },
  });
  for (const row of orphans) {
    const key = row.storageKey!;
    if (seen.has(key)) continue;
    if (!isSafeStorageKey(key)) { skipped.push(key); continue; }
    seen.add(key);
    objects.push({
      storageKey: key,
      size: row.size === null ? 0 : Number(row.size),
      checksum: row.checksum ?? '',
      resourceId: row.id,
      versionNumber: null,
    });
  }

  return { objects, skipped };
}

/* ------------------------------------------------------------------ */
/* สร้างชุดสำรอง                                                       */
/* ------------------------------------------------------------------ */

async function copyStorageObjects(
  objects: ManifestObject[],
  destinationRoot: string,
): Promise<{ copied: ManifestObject[]; bytes: number; missing: string[] }> {
  const copied: ManifestObject[] = [];
  const missing: string[] = [];
  let bytes = 0;

  for (const object of objects) {
    const source = path.join(env.STORAGE_ROOT, object.storageKey);
    const target = path.join(destinationRoot, object.storageKey);
    try {
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.copyFile(source, target);
      const stat = await fsp.stat(target);
      // ยึด checksum ที่คำนวณจากไฟล์จริงในชุดสำรอง ไม่ใช่ค่าที่ metadata อ้าง
      const checksum = await sha256File(target);
      copied.push({ ...object, size: stat.size, checksum });
      bytes += stat.size;
    } catch {
      // ไฟล์ที่ metadata อ้างถึงแต่หายไปจากดิสก์ ต้องรายงาน ไม่ใช่ข้ามเงียบ ๆ
      missing.push(object.storageKey);
    }
  }

  return { copied, bytes, missing };
}

export interface CreateBackupResult {
  backup: BackupDto;
  manifest?: BackupManifest;
}

/**
 * สร้างชุดสำรองเต็มหนึ่งชุด
 *
 * ทำงานแบบซิงโครนัสจนจบแล้วจึงตอบกลับ ระบบนี้มีข้อมูลไม่ใหญ่และการรอจนเสร็จ
 * ทำให้สถานะที่ผู้ใช้เห็นตรงกับความจริงเสมอ ไม่ต้องเดา progress ที่ไม่มีจริง
 */
export async function createBackup(
  user: AuthUser,
  audit: { ipAddress?: string; userAgent?: string } = {},
  trigger: 'MANUAL' | 'SCHEDULED' = 'MANUAL',
): Promise<CreateBackupResult> {
  // ด่านเร็วภายใน process ก่อน แล้วจึงขอด่านข้ามอินสแตนซ์
  const release = acquireOperationLock('BACKUP');
  const distributed = await acquireDistributedLock('BACKUP').catch(async (error: unknown) => {
    release();
    throw error;
  });
  const startedAt = new Date();
  let row: BackupLog | null = null;

  const failed = async (code: string, message: string): Promise<never> => {
    if (row) {
      await prisma.backupLog.update({
        where: { id: row.id },
        data: { status: 'FAILED', completedAt: new Date(), errorCode: code, errorMessageSafe: message },
      });
      await prisma.activityLog.create({
        data: {
          userId: user.id, action: 'BACKUP_FAILED', ipAddress: audit.ipAddress,
          userAgent: audit.userAgent?.slice(0, 500), metadata: { backupId: row.id, code },
        },
      });
    }
    logger.error(`[BACKUP] ล้มเหลว: ${code}`);
    throw new AppError(code, message, 500);
  };

  try {
    // ตรวจเครื่องมือก่อนสร้างระเบียนใด ๆ จะได้ไม่มีชุดสำรองค้างที่ไม่มีวันสำเร็จ
    const tooling = await checkTooling();
    if (!tooling.available) {
      throw new AppError('BACKUP_TOOLING_UNAVAILABLE', tooling.reason ?? 'ไม่พบเครื่องมือสำรองฐานข้อมูล', 503);
    }

    row = await prisma.backupLog.create({
      data: {
        status: 'RUNNING', type: 'FULL', startedAt, triggeredByUserId: user.id,
        backupName: 'pending', trigger,
      },
    });
    const backupName = backupFolderName(startedAt, row.id);
    row = await prisma.backupLog.update({ where: { id: row.id }, data: { backupName } });

    const root = backupDirectory(backupName);
    const databaseDir = path.join(root, DATABASE_DIR);
    const storageDir = path.join(root, STORAGE_DIR);
    await fsp.mkdir(databaseDir, { recursive: true });
    await fsp.mkdir(storageDir, { recursive: true });

    /* ---- 1. ดัมป์ฐานข้อมูลก่อน เพื่อให้ได้ snapshot เป็นจุดอ้างอิง ---- */
    const dumpPath = path.join(databaseDir, DUMP_FILE);
    try {
      await dumpDatabase(parseDatabaseUrl(), dumpPath);
    } catch (error) {
      return failed('BACKUP_DATABASE_FAILED', error instanceof AppError ? error.message : 'ไม่สามารถสำรองฐานข้อมูลได้');
    }
    const databaseBytes = (await fsp.stat(dumpPath)).size;
    const databaseChecksum = await sha256File(dumpPath);

    /**
     * ---- 2. คัดลอกเฉพาะไฟล์ที่ snapshot อ้างถึง ----
     *
     * ลำดับสำคัญมาก: ต้องอ่านรายการไฟล์ "หลัง" ดัมป์เสมอ
     *
     * อ่านหลังดัมป์  → รายการไฟล์ครอบคลุมทุกแถวในดัมป์เสมอ ไฟล์ที่เพิ่มมาระหว่างนั้น
     *                 จะถูกคัดลอกเกินมาเป็นไฟล์ส่วนเกิน ซึ่งไม่เป็นอันตราย
     * อ่านก่อนดัมป์  → ดัมป์อาจมีแถวที่รายการไฟล์ไม่มี ทำให้กู้คืนแล้วไฟล์หาย ซึ่งเป็นความเสียหายจริง
     *
     * จึงเลือกฝั่งที่ผิดพลาดแล้วยังปลอดภัย
     */
    const { objects, skipped } = await collectManifestObjects();
    if (skipped.length > 0) {
      logger.warn(`[BACKUP] ข้าม storageKey ที่ไม่ปลอดภัย ${skipped.length} รายการ`);
    }
    const { copied, bytes: storageBytes, missing } = await copyStorageObjects(objects, storageDir);
    if (missing.length > 0) {
      return failed(
        'BACKUP_STORAGE_INCOMPLETE',
        `ไม่พบไฟล์จริง ${missing.length} รายการที่ข้อมูลอ้างถึง ชุดสำรองจึงไม่สมบูรณ์`,
      );
    }

    /* ---- 3. manifest ---- */
    const [resources, versions, trashed] = await Promise.all([
      prisma.resource.count(),
      prisma.resourceVersion.count(),
      prisma.resource.count({ where: { deletedAt: { not: null } } }),
    ]);

    const manifest: BackupManifest = {
      manifestVersion: MANIFEST_VERSION,
      backupId: row.id,
      backupName,
      createdAt: startedAt.toISOString(),
      appVersion: APP_VERSION,
      database: { fileName: `${DATABASE_DIR}/${DUMP_FILE}`, bytes: databaseBytes, checksum: databaseChecksum },
      storage: { objectCount: copied.length, bytes: storageBytes, objects: copied },
      counts: { resources, versions, trashedResources: trashed },
      totalBytes: databaseBytes + storageBytes,
    };

    const checksum = await writeManifest(path.join(root, MANIFEST_FILE), manifest);
    await fsp.writeFile(
      path.join(root, BACKUP_FILE),
      `${JSON.stringify({ backupId: row.id, backupName, createdAt: startedAt.toISOString(), appVersion: APP_VERSION, manifestChecksum: checksum }, null, 2)}\n`,
      'utf8',
    );

    /* ---- 4. ตรวจตัวเองก่อนประกาศว่าสำเร็จ ---- */
    const verification = await verifyBackupFiles(backupName);
    if (!verification.valid) {
      return failed('BACKUP_VERIFICATION_FAILED', verification.summary);
    }

    const completedAt = new Date();
    const finished = await prisma.backupLog.update({
      where: { id: row.id },
      data: {
        status: 'COMPLETED',
        completedAt,
        databaseBytes: BigInt(databaseBytes),
        storageBytes: BigInt(storageBytes),
        totalBytes: BigInt(databaseBytes + storageBytes),
        fileCount: copied.length,
        manifestChecksum: checksum,
      },
      include: withUser,
    });

    await prisma.activityLog.create({
      data: {
        userId: user.id, action: 'BACKUP_CREATED', ipAddress: audit.ipAddress,
        userAgent: audit.userAgent?.slice(0, 500),
        metadata: { backupId: row.id, fileCount: copied.length, totalBytes: databaseBytes + storageBytes },
      },
    });

    logger.info(`[BACKUP] สำเร็จ: ${copied.length} ไฟล์, ${databaseBytes + storageBytes} ไบต์`);
    return { backup: toBackupDto(finished), manifest };
  } catch (error) {
    if (error instanceof AppError) {
      if (row && error.code !== 'BACKUP_TOOLING_UNAVAILABLE') {
        await prisma.backupLog.updateMany({
          where: { id: row.id, status: 'RUNNING' },
          data: { status: 'FAILED', completedAt: new Date(), errorCode: error.code, errorMessageSafe: error.message },
        });
      }
      throw error;
    }
    return failed('BACKUP_FAILED', 'สำรองข้อมูลไม่สำเร็จ');
  } finally {
    await distributed.release();
    release();
  }
}

/* ------------------------------------------------------------------ */
/* ตรวจสอบชุดสำรอง                                                     */
/* ------------------------------------------------------------------ */

export interface VerificationResult {
  valid: boolean;
  summary: string;
  checkedObjects: number;
  missingObjects: string[];
  checksumMismatches: string[];
  databaseChecksumValid: boolean;
  manifestChecksumValid: boolean;
}

/**
 * ตรวจว่าชุดสำรองบนดิสก์ยังตรงกับ manifest ของตัวเอง
 *
 * ตรวจทุกไฟล์ ไม่สุ่ม - ชุดสำรองที่ตรวจแบบสุ่มแล้วบอกว่า "น่าจะใช้ได้"
 * ไม่ได้ให้ความมั่นใจอะไรเลยในวันที่ต้องกู้คืนจริง
 */
export async function verifyBackupFiles(backupName: string): Promise<VerificationResult> {
  const root = backupDirectory(backupName);
  const manifestPath = path.join(root, MANIFEST_FILE);

  const result: VerificationResult = {
    valid: false,
    summary: '',
    checkedObjects: 0,
    missingObjects: [],
    checksumMismatches: [],
    databaseChecksumValid: false,
    manifestChecksumValid: false,
  };

  let manifest: BackupManifest;
  try {
    manifest = await readManifest(manifestPath);
  } catch {
    result.summary = 'อ่าน manifest ของชุดสำรองไม่ได้ หรือไฟล์เสียหาย';
    return result;
  }

  if (manifest.manifestVersion !== MANIFEST_VERSION) {
    result.summary = `รูปแบบ manifest ไม่รองรับ (เวอร์ชัน ${manifest.manifestVersion})`;
    return result;
  }

  // manifest ต้องไม่ถูกแก้ไขหลังสร้าง - เทียบกับค่าที่บันทึกไว้ในฐานข้อมูล
  const stored = await prisma.backupLog.findFirst({ where: { backupName }, select: { manifestChecksum: true } });
  const actualManifestChecksum = await manifestChecksum(manifestPath);
  result.manifestChecksumValid = !stored?.manifestChecksum || stored.manifestChecksum === actualManifestChecksum;

  const dumpPath = path.join(root, ...manifest.database.fileName.split('/'));
  try {
    result.databaseChecksumValid = (await sha256File(dumpPath)) === manifest.database.checksum;
  } catch {
    result.databaseChecksumValid = false;
  }

  for (const object of manifest.storage.objects) {
    const filePath = path.join(root, STORAGE_DIR, object.storageKey);
    try {
      const actual = await sha256File(filePath);
      result.checkedObjects += 1;
      if (actual !== object.checksum) result.checksumMismatches.push(object.storageKey);
    } catch {
      result.missingObjects.push(object.storageKey);
    }
  }

  const problems: string[] = [];
  if (!result.manifestChecksumValid) problems.push('manifest ถูกแก้ไขหลังสร้าง');
  if (!result.databaseChecksumValid) problems.push('checksum ของดัมป์ฐานข้อมูลไม่ตรง');
  if (result.missingObjects.length > 0) problems.push(`ไฟล์หาย ${result.missingObjects.length} รายการ`);
  if (result.checksumMismatches.length > 0) problems.push(`checksum ไม่ตรง ${result.checksumMismatches.length} รายการ`);

  result.valid = problems.length === 0;
  result.summary = result.valid
    ? `ตรวจสอบผ่าน: ไฟล์ ${result.checkedObjects} รายการและดัมป์ฐานข้อมูลตรงกับ manifest`
    : `ชุดสำรองไม่ผ่านการตรวจสอบ: ${problems.join(', ')}`;
  return result;
}

export async function verifyBackup(id: string): Promise<VerificationResult> {
  const row = await prisma.backupLog.findUnique({ where: { id } });
  if (!row) throw notFound('BACKUP_NOT_FOUND', 'ไม่พบชุดสำรองข้อมูล');
  if (row.status !== 'COMPLETED') {
    throw new AppError('BACKUP_NOT_COMPLETED', 'ตรวจสอบได้เฉพาะชุดสำรองที่ทำสำเร็จแล้ว', 409);
  }
  return verifyBackupFiles(row.backupName);
}

/* ------------------------------------------------------------------ */
/* ลบชุดสำรอง                                                          */
/* ------------------------------------------------------------------ */

/**
 * ลบไฟล์ก่อน แล้วจึงลบระเบียน
 *
 * ถ้าลบไฟล์ไม่สำเร็จ ระเบียนต้องยังอยู่ มิฉะนั้นจะเหลือชุดสำรองกำพร้าบนดิสก์
 * ที่ไม่มีใครรู้ว่ามีอยู่และไม่มีทางลบผ่านระบบได้อีก
 */
export async function deleteBackup(
  id: string,
  user: AuthUser,
  audit: { ipAddress?: string; userAgent?: string } = {},
): Promise<{ deleted: true }> {
  const row = await prisma.backupLog.findUnique({ where: { id } });
  if (!row) throw notFound('BACKUP_NOT_FOUND', 'ไม่พบชุดสำรองข้อมูล');
  if (row.status === 'RUNNING' || row.status === 'PENDING') {
    throw new AppError('BACKUP_IN_PROGRESS', 'ลบชุดสำรองที่กำลังทำงานอยู่ไม่ได้', 409);
  }

  try {
    await fsp.rm(backupDirectory(row.backupName), { recursive: true, force: true });
  } catch {
    throw new AppError('BACKUP_DELETE_FAILED', 'ลบไฟล์ของชุดสำรองไม่สำเร็จ ระบบจึงยังไม่ลบระเบียน', 500);
  }

  await prisma.backupLog.delete({ where: { id } });
  await prisma.activityLog.create({
    data: {
      userId: user.id, action: 'BACKUP_DELETED', ipAddress: audit.ipAddress,
      userAgent: audit.userAgent?.slice(0, 500), metadata: { backupId: id },
    },
  });
  logger.info('[BACKUP] ลบชุดสำรองแล้ว');
  return { deleted: true };
}

export const BACKUP_PATHS = { DATABASE_DIR, STORAGE_DIR, DUMP_FILE, MANIFEST_FILE, BACKUP_FILE } as const;

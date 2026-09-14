import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { env } from '../../config/env.js';
import { AppError, notFound } from '../../core/errors.js';
import { logger } from '../../core/logger.js';
import { prisma } from '../../core/prisma.js';
import { storageProviderFor } from '../../core/storage/index.js';
import type { StorageProviderKind } from '@prisma/client';
import type { AuthUser } from '../auth/auth.service.js';
import { BACKUP_PATHS, backupDirectory, verifyBackupFiles } from './backup.service.js';
import { importDump, parseDatabaseUrl, runSql } from './mariadb-cli.js';
import { isSafeStorageKey, readManifest, sha256File, type BackupManifest } from './manifest.js';
import { listStagedObjectKeys, restoreObjectsToTarget, stagedObjectKey } from './restore-target.js';
import { acquireOperationLock } from './operation-lock.js';
import { acquireDistributedLock } from './distributed-lock.js';

/**
 * การกู้คืนแบบมีพื้นที่พัก (staged restore)
 *
 * การกู้คืนอันตรายกว่าการสำรองมาก เพราะมันเขียนทับสิ่งที่ยังใช้งานอยู่
 * F5 จึงหยุดที่ "เตรียมพร้อมและพิสูจน์แล้วว่าใช้ได้" ไม่ทำ cutover อัตโนมัติ
 *
 * ทุกอย่างเกิดในฐานข้อมูลชั่วคราวและโฟลเดอร์ชั่วคราว ระบบที่ใช้งานจริงไม่ถูกแตะต้องเลย
 * แม้แต่ขั้นตอนเดียว จนกว่าผู้ดูแลจะลงมือ cutover ด้วยตนเองตามขั้นตอนใน docs/RESTORE.md
 */

export type RestoreStage = 'PRECHECK' | 'STAGED';

export interface RestorePrecheckResult {
  ok: boolean;
  backupId: string;
  problems: string[];
  objectCount: number;
  databaseBytes: number;
  storageBytes: number;
  freeDiskBytes: number | null;
}

export interface RestoreStageResult {
  ok: boolean;
  backupId: string;
  /** ผู้ให้บริการที่ไบต์ถูกกู้คืนไปจริง - มาจากคำสั่ง ไม่ใช่จากชุดสำรอง */
  targetProvider: StorageProviderKind;
  stagedDatabase: string;
  /** ชื่อโฟลเดอร์พักเท่านั้น ไม่ใช่ absolute path */
  stagedStorageName: string;
  restoredObjects: number;
  verifiedObjects: number;
  reconciliation: ReconciliationResult;
  problems: string[];
}

export interface ReconciliationResult {
  ok: boolean;
  expectedObjects: number;
  presentObjects: number;
  missingFiles: string[];
  orphanFiles: string[];
  sizeMismatches: string[];
  checksumMismatches: string[];
  resourceRows: number;
  versionRows: number;
}

function stagedDatabaseName(backupId: string): string {
  /**
   * ชื่อฐานข้อมูลถูกสร้างจาก id ที่ระบบออกให้เท่านั้น และกรองอักขระให้เหลือเฉพาะที่ปลอดภัย
   * เพราะชื่อฐานข้อมูลไม่สามารถส่งเป็น parameter ได้ ต้องต่อเป็นสตริงใน SQL
   */
  const safe = backupId.replace(/[^a-zA-Z0-9_]/g, '').slice(0, 40);
  if (!safe) throw new AppError('RESTORE_INVALID_TARGET', 'รหัสชุดสำรองไม่ถูกต้อง', 400);
  return `${env.S2_NAS_RESTORE_DB_PREFIX}${safe}`;
}

async function loadCompletedBackup(id: string) {
  const row = await prisma.backupLog.findUnique({ where: { id } });
  if (!row) throw notFound('BACKUP_NOT_FOUND', 'ไม่พบชุดสำรองข้อมูล');
  if (row.status !== 'COMPLETED') {
    throw new AppError('RESTORE_BACKUP_NOT_COMPLETED', 'กู้คืนได้เฉพาะชุดสำรองที่ทำสำเร็จแล้ว', 409);
  }
  return row;
}

/* ------------------------------------------------------------------ */
/* 1. ตรวจก่อนแตะอะไรทั้งสิ้น                                          */
/* ------------------------------------------------------------------ */

/**
 * ถ้าด่านนี้ไม่ผ่าน จะไม่มีการเปลี่ยนแปลงใด ๆ เกิดขึ้นทั้งกับระบบจริงและพื้นที่พัก
 */
export async function restorePrecheck(
  id: string,
  user: AuthUser,
  audit: { ipAddress?: string; userAgent?: string } = {},
): Promise<RestorePrecheckResult> {
  const row = await loadCompletedBackup(id);

  await prisma.activityLog.create({
    data: {
      userId: user.id, action: 'RESTORE_PRECHECK_STARTED', ipAddress: audit.ipAddress,
      userAgent: audit.userAgent?.slice(0, 500), metadata: { backupId: id },
    },
  });

  const problems: string[] = [];
  let manifest: BackupManifest | null = null;
  try {
    manifest = await readManifest(path.join(backupDirectory(row.backupName), BACKUP_PATHS.MANIFEST_FILE));
  } catch {
    problems.push('อ่าน manifest ไม่ได้ หรือไฟล์เสียหาย');
  }

  const verification = await verifyBackupFiles(row.backupName);
  if (!verification.valid) problems.push(verification.summary);

  // เส้นทางที่ไม่ปลอดภัยใน manifest ต้องหยุดตั้งแต่ตรงนี้ ไม่ใช่ตอนเขียนไฟล์แล้ว
  const unsafe = (manifest?.storage.objects ?? []).filter((object) => !isSafeStorageKey(object.storageKey));
  if (unsafe.length > 0) problems.push(`manifest มีเส้นทางที่ไม่ปลอดภัย ${unsafe.length} รายการ`);

  let freeDiskBytes: number | null = null;
  const required = (manifest?.totalBytes ?? 0) * 2;
  try {
    await fsp.mkdir(env.RESTORE_STAGE_ROOT, { recursive: true });
    const stat = await fsp.statfs(env.RESTORE_STAGE_ROOT);
    freeDiskBytes = Number(stat.bsize) * Number(stat.bavail);
    if (freeDiskBytes < required) {
      problems.push('พื้นที่ดิสก์สำหรับพื้นที่พักไม่เพียงพอ');
    }
  } catch {
    // ระบบไฟล์บางแบบไม่รายงานพื้นที่ว่าง ไม่ถือเป็นความล้มเหลว แต่ต้องไม่แกล้งว่าตรวจแล้ว
    freeDiskBytes = null;
  }

  const result: RestorePrecheckResult = {
    ok: problems.length === 0,
    backupId: id,
    problems,
    objectCount: manifest?.storage.objectCount ?? 0,
    databaseBytes: manifest?.database.bytes ?? 0,
    storageBytes: manifest?.storage.bytes ?? 0,
    freeDiskBytes,
  };

  if (!result.ok) {
    await prisma.activityLog.create({
      data: {
        userId: user.id, action: 'RESTORE_PRECHECK_FAILED', ipAddress: audit.ipAddress,
        userAgent: audit.userAgent?.slice(0, 500), metadata: { backupId: id, problemCount: problems.length },
      },
    });
  }
  return result;
}

/* ------------------------------------------------------------------ */
/* 2. เตรียมพื้นที่พักและพิสูจน์ว่ากู้คืนได้จริง                        */
/* ------------------------------------------------------------------ */

/**
 * นำชุดสำรองขึ้นสู่ฐานข้อมูลชั่วคราวและโฟลเดอร์ชั่วคราว แล้วตรวจสอบความสอดคล้อง
 * ระหว่าง metadata ที่กู้มากับไฟล์ที่กู้มา
 *
 * ระบบที่ใช้งานจริงไม่ถูกเขียนแม้แต่ไบต์เดียวในขั้นตอนนี้
 */
export interface StageRestoreOptions {
  /**
   * ผู้ให้บริการปลายทางของไบต์ที่กู้คืน - ค่าเริ่มต้นคือดิสก์ของเครื่อง
   *
   * ไม่เคยอ่านจาก manifest เด็ดขาด ชุดสำรองที่มาจากระบบซึ่งใช้ที่เก็บวัตถุ
   * ต้องกู้ลงดิสก์ได้ และชุดสำรองจากดิสก์ต้องกู้ขึ้นที่เก็บวัตถุได้เช่นกัน
   */
  targetProvider?: StorageProviderKind;
}

export async function stageRestore(
  id: string,
  user: AuthUser,
  audit: { ipAddress?: string; userAgent?: string } = {},
  options: StageRestoreOptions = {},
): Promise<RestoreStageResult> {
  const targetProvider = options.targetProvider ?? 'LOCAL';
  const release = acquireOperationLock('RESTORE');
  const distributed = await acquireDistributedLock('RESTORE_STAGE').catch(async (error: unknown) => {
    release();
    throw error;
  });
  try {
    const precheck = await restorePrecheck(id, user, audit);
    if (!precheck.ok) {
      throw new AppError('RESTORE_PRECHECK_FAILED', precheck.problems.join(' · '), 409, {
        problems: precheck.problems,
      });
    }

    const row = await loadCompletedBackup(id);
    const backupRoot = backupDirectory(row.backupName);
    const manifest = await readManifest(path.join(backupRoot, BACKUP_PATHS.MANIFEST_FILE));

    /* ---- 2a. ฐานข้อมูลพัก ---- */
    const target = parseDatabaseUrl();
    const stagedDatabase = stagedDatabaseName(id);
    await runSql(target, `DROP DATABASE IF EXISTS \`${stagedDatabase}\``);
    await runSql(target, `CREATE DATABASE \`${stagedDatabase}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    await importDump(target, stagedDatabase, path.join(backupRoot, ...manifest.database.fileName.split('/')));

    /* ---- 2b. โฟลเดอร์พักของไฟล์ ---- */
    const stagedStorageName = `stage-${id}`;
    const stageDir = path.join(env.RESTORE_STAGE_ROOT, stagedStorageName);
    await fsp.rm(stageDir, { recursive: true, force: true });
    await fsp.mkdir(stageDir, { recursive: true });

    /**
     * กู้ไบต์ขึ้นปลายทางที่เลือก แล้วตรวจซ้ำจากปลายทางเอง
     *
     * ปลายทางมาจากคำสั่งเสมอ ไม่ใช่จาก originalProvider ที่บันทึกไว้ใน manifest
     * ชุดสำรองจากระบบที่ใช้ที่เก็บวัตถุจึงกู้ลงดิสก์ได้ และกลับกันก็ได้เช่นกัน
     */
    const { restored: restoredObjects, verified: verifiedObjects, problems } =
      await restoreObjectsToTarget(
        manifest.storage.objects,
        path.join(backupRoot, BACKUP_PATHS.STORAGE_DIR),
        { provider: targetProvider, localStageDir: stageDir, runId: id },
      );

    /**
     * ข้อมูลกำกับในฐานข้อมูลพักต้องชี้ไปยังปลายทางที่กู้จริง
     *
     * ถ้าคงค่าเดิมจากชุดสำรองไว้ ระบบที่กู้คืนแล้วจะไปหาไฟล์ที่ผู้ให้บริการเดิม
     * ซึ่งอาจไม่มีอยู่ในโลกของเครื่องปลายทางเลย แถว Resource ถูกปรับตามด้วย
     * เพราะมันสะท้อนเวอร์ชันปัจจุบันซึ่งย้ายปลายทางไปพร้อมกันทั้งชุด
     */
    await runSql(target,
      `UPDATE resource_versions SET storageProvider = '${targetProvider}'`, stagedDatabase);
    await runSql(target,
      `UPDATE resources SET storageProvider = '${targetProvider}' WHERE storageKey IS NOT NULL`, stagedDatabase);

    /* ---- 2c. กระทบยอดฐานข้อมูลที่กู้มากับไฟล์ที่กู้มา ---- */
    const reconciliation = await reconcile(target, stagedDatabase, stageDir, manifest, targetProvider, id);
    if (!reconciliation.ok) problems.push('ข้อมูลกับไฟล์ที่กู้คืนมาไม่สอดคล้องกัน');

    const ok = problems.length === 0 && reconciliation.ok && verifiedObjects === manifest.storage.objectCount;

    await prisma.activityLog.create({
      data: {
        userId: user.id, action: 'RESTORE_STAGE_CREATED', ipAddress: audit.ipAddress,
        userAgent: audit.userAgent?.slice(0, 500),
        metadata: { backupId: id, ok, restoredObjects, verifiedObjects },
      },
    });

    logger.info(`[RESTORE] เตรียมพื้นที่พักเสร็จ: ${verifiedObjects}/${manifest.storage.objectCount} ไฟล์ผ่านการตรวจสอบ`);

    return {
      ok,
      backupId: id,
      stagedDatabase,
      stagedStorageName,
      targetProvider,
      restoredObjects,
      verifiedObjects,
      reconciliation,
      problems,
    };
  } finally {
    await distributed.release();
    release();
  }
}

/**
 * กระทบยอด metadata กับไฟล์
 *
 * ตรวจสองทิศทาง: ทุกแถวต้องมีไฟล์ และทุกไฟล์ต้องมีแถวที่อ้างถึง
 * การตรวจทางเดียวจับ "ไฟล์หาย" ได้ แต่จับ "ไฟล์ส่วนเกินที่ไม่มีใครรู้จัก" ไม่ได้
 */
async function reconcile(
  target: ReturnType<typeof parseDatabaseUrl>,
  stagedDatabase: string,
  stageDir: string,
  manifest: BackupManifest,
  targetProvider: StorageProviderKind,
  runId: string,
): Promise<ReconciliationResult> {
  const rows = await runSql(
    target,
    'SELECT storageKey, size, checksum FROM resource_versions ORDER BY storageKey',
    stagedDatabase,
  );
  const versionRows = rows
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [storageKey, size, checksum] = line.split('\t');
      return { storageKey: storageKey ?? '', size: Number(size), checksum: checksum ?? '' };
    });

  const resourceCount = Number(
    (await runSql(target, 'SELECT COUNT(*) FROM resources', stagedDatabase)).trim() || '0',
  );

  const missingFiles: string[] = [];
  const sizeMismatches: string[] = [];
  const checksumMismatches: string[] = [];
  const expectedKeys = new Set<string>();

  /**
   * กระทบยอดกับปลายทางที่กู้จริง
   *
   * ปลายทางบนดิสก์อ่านจากโฟลเดอร์พัก ส่วนปลายทางบนที่เก็บวัตถุอ่านจากคีย์ของรอบนี้
   * การอ่านผิดที่จะทำให้การกู้คืนที่สมบูรณ์ถูกรายงานว่าไฟล์หายทั้งหมด
   */
  for (const row of versionRows) {
    expectedKeys.add(row.storageKey);
    try {
      if (targetProvider === 'LOCAL') {
        const filePath = path.join(stageDir, row.storageKey);
        const stat = await fsp.stat(filePath);
        if (stat.size !== row.size) sizeMismatches.push(row.storageKey);
        const actual = await sha256File(filePath);
        if (actual !== row.checksum) checksumMismatches.push(row.storageKey);
      } else {
        const provider = storageProviderFor(targetProvider);
        const key = stagedObjectKey(runId, row.storageKey);
        const stat = await provider.stat(key);
        if (!stat) { missingFiles.push(row.storageKey); continue; }
        if (stat.size !== row.size) sizeMismatches.push(row.storageKey);
        const hash = crypto.createHash('sha256');
        for await (const chunk of await provider.getStream(key)) hash.update(chunk as Buffer);
        if (hash.digest('hex') !== row.checksum) checksumMismatches.push(row.storageKey);
      }
    } catch {
      missingFiles.push(row.storageKey);
    }
  }

  // ไฟล์ส่วนเกิน: อยู่ในพื้นที่พักแต่ไม่มีแถวใดอ้างถึง
  const present = targetProvider === 'LOCAL'
    ? await listRelativeFiles(stageDir)
    : await listStagedObjectKeys(targetProvider, runId);
  const orphanFiles = present.filter((key) => !expectedKeys.has(key) && !manifest.storage.objects.some((o) => o.storageKey === key));

  /**
   * ไฟล์ส่วนเกินไม่ถือว่าล้มเหลว
   *
   * รายการไฟล์ถูกอ่านหลังดัมป์โดยตั้งใจ (ดู backup.service.ts) ไฟล์ที่ถูกอัปโหลด
   * ระหว่างการสำรองจึงถูกคัดลอกติดมาโดยที่ดัมป์ยังไม่มีแถวของมัน
   * นั่นคือ "มีไฟล์เกินมา" ซึ่งกู้คืนแล้วไม่มีใครอ้างถึง - เปลืองที่แต่ไม่ทำข้อมูลเสีย
   *
   * ตรงข้ามกับ "ไฟล์หาย" ที่แปลว่าข้อมูลบอกว่ามีไฟล์แต่ไฟล์ไม่อยู่ อันนั้นคือความเสียหายจริง
   */
  return {
    ok:
      missingFiles.length === 0 &&
      sizeMismatches.length === 0 &&
      checksumMismatches.length === 0,
    expectedObjects: expectedKeys.size,
    presentObjects: present.length,
    missingFiles,
    orphanFiles,
    sizeMismatches,
    checksumMismatches,
    resourceRows: resourceCount,
    versionRows: versionRows.length,
  };
}

async function listRelativeFiles(root: string, prefix = ''): Promise<string[]> {
  const entries = await fsp.readdir(path.join(root, prefix), { withFileTypes: true }).catch(() => []);
  const files: string[] = [];
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...(await listRelativeFiles(root, relative)));
    else files.push(relative);
  }
  return files;
}

/** เก็บกวาดพื้นที่พักหลังพิสูจน์เสร็จ - พื้นที่พักไม่ใช่ของที่ต้องเก็บไว้ */
export async function discardStage(id: string): Promise<void> {
  const target = parseDatabaseUrl();
  const stagedDatabase = stagedDatabaseName(id);
  await runSql(target, `DROP DATABASE IF EXISTS \`${stagedDatabase}\``).catch(() => undefined);
  await fsp.rm(path.join(env.RESTORE_STAGE_ROOT, `stage-${id}`), { recursive: true, force: true }).catch(() => undefined);
}

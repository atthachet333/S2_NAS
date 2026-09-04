import fsp from 'node:fs/promises';
import path from 'node:path';
import type { RestoreRehearsalLog } from '@prisma/client';
import { env } from '../../config/env.js';
import { AppError } from '../../core/errors.js';
import { logger } from '../../core/logger.js';
import { prisma } from '../../core/prisma.js';
import type { AuthUser } from '../auth/auth.service.js';
import { BACKUP_PATHS, backupDirectory, verifyBackupFiles } from './backup.service.js';
import { withDistributedLock } from './distributed-lock.js';
import { importDump, parseDatabaseUrl, runSql } from './mariadb-cli.js';
import { isSafeStorageKey, readManifest, sha256File } from './manifest.js';
import { getSetting } from '../system/settings.service.js';
import {
  decideRehearsalRun,
  isRehearsalStale,
  nextRehearsalAt,
  zonedDateKey,
  type RehearsalScheduleConfig,
} from './schedule-policy.js';

/**
 * การซ้อมกู้คืน
 *
 * ชุดสำรองที่ตรวจ checksum ผ่านพิสูจน์ได้แค่ว่า "ไฟล์ยังไม่เน่า" ไม่ได้พิสูจน์ว่า "กู้คืนได้จริง"
 * การซ้อมจึงนำชุดสำรองขึ้นฐานข้อมูลชั่วคราวและโฟลเดอร์ชั่วคราวจริง ๆ แล้วกระทบยอด
 *
 * ไม่มีขั้นตอนใดแตะระบบที่ใช้งานจริง และไม่มี cutover ในเส้นทางนี้เลย
 * การซ้อมที่ล้มเหลวไม่ทำให้ชุดสำรองถูกลบ - มันแปลว่าต้องไปตรวจเส้นทางกู้คืน ไม่ใช่ทิ้งหลักฐาน
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * ชื่อฐานข้อมูลของการซ้อม
 *
 * สร้างจาก id ที่ระบบออกให้เท่านั้น กรองอักขระ แล้วบังคับ prefix ที่อนุญาต
 * ชื่อฐานข้อมูลต่อเป็นสตริงใน SQL ไม่ได้เป็น parameter จึงต้องคุมที่ต้นทางให้แน่น
 */
export function rehearsalDatabaseName(rehearsalId: string): string {
  const safe = rehearsalId.replace(/[^a-zA-Z0-9_]/g, '').slice(0, 32);
  if (!safe) throw new AppError('REHEARSAL_INVALID_TARGET', 'รหัสการซ้อมไม่ถูกต้อง', 400);
  const name = `${env.S2_NAS_RESTORE_DB_PREFIX}rh_${safe}`;
  assertScratchDatabase(name);
  return name;
}

/**
 * ด่านสุดท้ายก่อนแตะฐานข้อมูลใด ๆ
 *
 * ต่อให้โค้ดข้างบนผิดพลาด ชื่อที่ไม่ได้ขึ้นต้นด้วย prefix ที่อนุญาต หรือชื่อที่ตรงกับ
 * ฐานข้อมูลจริง จะไม่มีวันถูกนำไปใช้ นี่คือบทเรียนจากเหตุการณ์ใน F5
 */
export function assertScratchDatabase(name: string): void {
  const live = parseDatabaseUrl().database;
  if (name === live) {
    throw new AppError('REHEARSAL_TARGET_IS_LIVE', 'การซ้อมกู้คืนต้องไม่ใช้ฐานข้อมูลที่ใช้งานจริง', 400);
  }
  if (!name.startsWith(env.S2_NAS_RESTORE_DB_PREFIX)) {
    throw new AppError('REHEARSAL_INVALID_TARGET', 'ฐานข้อมูลของการซ้อมต้องอยู่ใน namespace ที่อนุญาตเท่านั้น', 400);
  }
  if (!/^[a-zA-Z0-9_]+$/.test(name)) {
    throw new AppError('REHEARSAL_INVALID_TARGET', 'ชื่อฐานข้อมูลของการซ้อมไม่ถูกต้อง', 400);
  }
}

/* ------------------------------------------------------------------ */
/* เลือกชุดสำรองที่จะซ้อม                                               */
/* ------------------------------------------------------------------ */

export interface RehearsalCandidate {
  id: string;
  backupName: string;
  startedAt: Date;
}

/**
 * ชุดสำรองที่ควรนำมาซ้อม
 *
 * เลือกชุดที่ใหม่ที่สุดที่ทำสำเร็จและตรวจสอบตัวเองผ่านแล้ว
 * ถ้าชุดล่าสุดเพิ่งซ้อมผ่านไปไม่นาน ก็ไม่ต้องซ้อมซ้ำ - การซ้อมกินทรัพยากรจริง
 *
 * ไม่บังคับว่าต้องมีสำเนานอกเครื่อง เพราะนี่คือการพิสูจน์ชุดสำรองในเครื่อง
 */
export async function selectBackupForRehearsal(now: Date = new Date()): Promise<RehearsalCandidate | null> {
  const backups = await prisma.backupLog.findMany({
    where: { status: 'COMPLETED', manifestChecksum: { not: null } },
    orderBy: { startedAt: 'desc' },
    select: { id: true, backupName: true, startedAt: true },
    take: 10,
  });
  if (backups.length === 0) return null;

  const newest = backups[0]!;
  const recentPass = await prisma.restoreRehearsalLog.findFirst({
    where: {
      backupId: newest.id,
      status: 'PASSED',
      startedAt: { gte: new Date(now.getTime() - env.S2_NAS_REHEARSAL_STALE_DAYS * DAY_MS) },
    },
    select: { id: true },
  });

  // ชุดล่าสุดเพิ่งพิสูจน์ไปแล้ว ไม่ต้องซ้อมซ้ำในรอบนี้
  return recentPass ? null : newest;
}

/* ------------------------------------------------------------------ */
/* ผลการซ้อม                                                           */
/* ------------------------------------------------------------------ */

export interface RehearsalResult {
  id: string;
  backupId: string;
  status: RestoreRehearsalLog['status'];
  databaseRestored: boolean;
  storageRestored: boolean;
  resourceCount: number | null;
  versionCount: number | null;
  missingCount: number | null;
  orphanCount: number | null;
  checksumFailures: number | null;
  cleanupFailed: boolean;
  errorCode: string | null;
  errorMessage: string | null;
  durationMs: number | null;
}

export function toRehearsalDto(row: RestoreRehearsalLog): RehearsalResult {
  return {
    id: row.id,
    backupId: row.backupId,
    status: row.status,
    databaseRestored: row.databaseRestored,
    storageRestored: row.storageRestored,
    resourceCount: row.resourceCount,
    versionCount: row.versionCount,
    missingCount: row.missingCount,
    orphanCount: row.orphanCount,
    checksumFailures: row.checksumFailures,
    cleanupFailed: row.cleanupFailed,
    errorCode: row.errorCode,
    errorMessage: row.errorMessageSafe,
    durationMs: row.completedAt ? row.completedAt.getTime() - row.startedAt.getTime() : null,
  };
}

export async function listRehearsals(limit = 20): Promise<RehearsalResult[]> {
  const rows = await prisma.restoreRehearsalLog.findMany({ orderBy: { startedAt: 'desc' }, take: limit });
  return rows.map(toRehearsalDto);
}

/* ------------------------------------------------------------------ */
/* ซ้อมจริง                                                            */
/* ------------------------------------------------------------------ */

export async function runRehearsal(
  user: AuthUser,
  trigger: 'MANUAL' | 'SCHEDULED' = 'MANUAL',
  now: Date = new Date(),
): Promise<RehearsalResult | null> {
  // ใช้ล็อกตัวเดียวกับงานสำรอง - การซ้อมกิน I/O หนักและอ่านไฟล์ชุดเดียวกัน
  return withDistributedLock('REHEARSAL', () => rehearsalWork(user, trigger, now));
}

async function rehearsalWork(
  user: AuthUser,
  trigger: 'MANUAL' | 'SCHEDULED',
  now: Date,
): Promise<RehearsalResult | null> {
  const candidate = await selectBackupForRehearsal(now);
  if (!candidate) {
    logger.info('[REHEARSAL] ไม่มีชุดสำรองที่ต้องซ้อมในรอบนี้');
    return null;
  }

  const record = await prisma.restoreRehearsalLog.create({
    data: { backupId: candidate.id, status: 'RUNNING', trigger, triggeredByUserId: user.id, startedAt: now },
  });

  const database = rehearsalDatabaseName(record.id);
  const stageDir = path.join(env.REHEARSAL_STAGE_ROOT, `rehearsal-${record.id}`);
  const target = parseDatabaseUrl();

  let databaseRestored = false;
  let storageRestored = false;
  let resourceCount: number | null = null;
  let versionCount: number | null = null;
  let missingCount: number | null = null;
  let orphanCount: number | null = null;
  let checksumFailures: number | null = null;
  let failure: { code: string; message: string } | null = null;

  try {
    /* ---- 1-4. ตรวจชุดสำรองก่อน ไม่ผ่านก็ไม่ต้องกู้ ---- */
    const verification = await verifyBackupFiles(candidate.backupName);
    if (!verification.valid) {
      throw new AppError('REHEARSAL_BACKUP_INVALID', 'ไฟล์สำรองไม่ผ่านการตรวจสอบ', 409);
    }

    const backupRoot = backupDirectory(candidate.backupName);
    const manifest = await readManifest(path.join(backupRoot, BACKUP_PATHS.MANIFEST_FILE));

    /* ---- 5. นำฐานข้อมูลขึ้นพื้นที่พัก ---- */
    assertScratchDatabase(database);
    await runSql(target, `DROP DATABASE IF EXISTS \`${database}\``);
    await runSql(target, `CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    // importDump ตรวจซ้ำเองว่าปลายทางไม่ใช่ฐานข้อมูลจริง และดัมป์ไม่มีคำสั่งเปลี่ยนฐานข้อมูล
    await importDump(target, database, path.join(backupRoot, ...manifest.database.fileName.split('/')));
    databaseRestored = true;

    /* ---- 8. โครงสร้างที่กู้มาต้องใช้งานได้จริง ---- */
    const tables = await runSql(
      target,
      "SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('resources','resource_versions','users','system_settings','integration_apps')",
      database,
    );
    if (Number(tables.trim()) < 5) {
      throw new AppError('REHEARSAL_SCHEMA_MISMATCH', 'โครงสร้างฐานข้อมูลที่กู้คืนมาไม่ครบ', 409);
    }

    /* ---- 6. นำไฟล์ขึ้นพื้นที่พัก ---- */
    await fsp.rm(stageDir, { recursive: true, force: true });
    await fsp.mkdir(stageDir, { recursive: true });

    let failures = 0;
    for (const object of manifest.storage.objects) {
      if (!isSafeStorageKey(object.storageKey)) {
        throw new AppError('REHEARSAL_UNSAFE_PATH', 'manifest มีเส้นทางที่ไม่ปลอดภัย', 500);
      }
      const source = path.join(backupRoot, BACKUP_PATHS.STORAGE_DIR, object.storageKey);
      const destination = path.join(stageDir, object.storageKey);
      await fsp.mkdir(path.dirname(destination), { recursive: true });
      await fsp.copyFile(source, destination);

      /* ---- 10. เทียบทุกไบต์ ไม่ใช่แค่ขนาดไฟล์ ---- */
      if ((await sha256File(destination)) !== object.checksum) failures += 1;
    }
    storageRestored = true;
    checksumFailures = failures;
    if (failures > 0) {
      throw new AppError('REHEARSAL_CHECKSUM_MISMATCH', `Checksum ไม่ตรงกัน ${failures} ไฟล์`, 409);
    }

    /* ---- 7 & 9. กระทบยอดข้อมูลกับไฟล์ ---- */
    const rows = await runSql(target, 'SELECT storageKey, size, checksum FROM resource_versions', database);
    const versions = rows
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [storageKey, size, checksum] = line.split('\t');
        return { storageKey: storageKey ?? '', size: Number(size), checksum: checksum ?? '' };
      });

    resourceCount = Number((await runSql(target, 'SELECT COUNT(*) FROM resources', database)).trim() || '0');
    versionCount = versions.length;

    let missing = 0;
    const expected = new Set<string>();
    for (const version of versions) {
      expected.add(version.storageKey);
      try {
        const filePath = path.join(stageDir, version.storageKey);
        const stat = await fsp.stat(filePath);
        if (stat.size !== version.size || (await sha256File(filePath)) !== version.checksum) failures += 1;
      } catch {
        missing += 1;
      }
    }
    missingCount = missing;
    checksumFailures = failures;
    orphanCount = manifest.storage.objects.filter((object) => !expected.has(object.storageKey)).length;

    if (missing > 0) throw new AppError('REHEARSAL_FILES_MISSING', `ไฟล์สำรองไม่ครบ ${missing} รายการ`, 409);
    if (failures > 0) throw new AppError('REHEARSAL_CHECKSUM_MISMATCH', `Checksum ไม่ตรงกัน ${failures} ไฟล์`, 409);
  } catch (error) {
    failure = {
      code: error instanceof AppError ? error.code : 'REHEARSAL_FAILED',
      message: error instanceof AppError ? error.message : 'ทดสอบกู้คืนไม่สำเร็จ',
    };
    logger.warn(`[REHEARSAL] ไม่ผ่าน: ${failure.code}`);
  }

  /* ---- 16. เก็บกวาดเสมอ ทั้งกรณีผ่านและไม่ผ่าน ---- */
  let cleanupFailed = false;
  try {
    assertScratchDatabase(database);
    await runSql(target, `DROP DATABASE IF EXISTS \`${database}\``);
    await fsp.rm(stageDir, { recursive: true, force: true });
  } catch (error) {
    cleanupFailed = true;
    logger.error({ err: error }, '[REHEARSAL] ล้างพื้นที่พักไม่สำเร็จ');
  }

  /**
   * การซ้อมที่ผ่านแต่ล้างพื้นที่พักไม่ได้ ไม่ถือว่าผ่าน
   * ฐานข้อมูลหรือโฟลเดอร์ที่ค้างอยู่คือสถานะที่ไม่มีใครดูแล และจะโตขึ้นทุกสัปดาห์
   */
  const passed = failure === null && !cleanupFailed;
  const finalFailure =
    failure ??
    (cleanupFailed ? { code: 'REHEARSAL_CLEANUP_FAILED', message: 'ไม่สามารถล้างพื้นที่ staging ได้' } : null);

  const saved = await prisma.restoreRehearsalLog.update({
    where: { id: record.id },
    data: {
      status: passed ? 'PASSED' : 'FAILED',
      completedAt: new Date(),
      databaseRestored, storageRestored, resourceCount, versionCount,
      missingCount, orphanCount, checksumFailures, cleanupFailed,
      errorCode: finalFailure?.code ?? null,
      errorMessageSafe: finalFailure?.message ?? null,
    },
  });

  await prisma.activityLog.create({
    data: {
      userId: user.id,
      action: passed ? 'RESTORE_REHEARSAL_PASSED' : 'RESTORE_REHEARSAL_FAILED',
      metadata: { rehearsalId: record.id, backupId: candidate.id, trigger },
    },
  });

  logger.info(`[REHEARSAL] ${passed ? 'ผ่าน' : 'ไม่ผ่าน'} - ไฟล์ ${versionCount ?? 0} เวอร์ชัน`);
  return toRehearsalDto(saved);
}

/* ------------------------------------------------------------------ */
/* ตารางเวลาและสถานะของการซ้อม                                          */
/* ------------------------------------------------------------------ */

export interface RehearsalStatus {
  enabled: boolean;
  dayOfWeek: number;
  time: string;
  timezone: string;
  nextRunAt: Date | null;
  lastRehearsalAt: Date | null;
  lastRehearsalStatus: RestoreRehearsalLog['status'] | null;
  lastRehearsedBackupId: string | null;
  lastPassedAt: Date | null;
  stale: boolean;
  staleDays: number;
}

export async function rehearsalConfig(): Promise<RehearsalScheduleConfig> {
  const [enabled, dayOfWeek, time] = await Promise.all([
    getSetting('RESTORE_REHEARSAL_ENABLED'),
    getSetting('RESTORE_REHEARSAL_DAY'),
    getSetting('RESTORE_REHEARSAL_TIME'),
  ]);
  return { enabled, dayOfWeek, time, timezone: env.S2_NAS_BACKUP_TIMEZONE };
}

/** สถานะสำหรับหน้าผู้ดูแล - ไม่มี path จริงและไม่มีชื่อฐานข้อมูลพัก */
export async function rehearsalStatus(now: Date = new Date()): Promise<RehearsalStatus> {
  const config = await rehearsalConfig();
  const [latest, lastPassed] = await Promise.all([
    prisma.restoreRehearsalLog.findFirst({
      orderBy: { startedAt: 'desc' },
      select: { startedAt: true, status: true, backupId: true },
    }),
    prisma.restoreRehearsalLog.findFirst({
      where: { status: 'PASSED' },
      orderBy: { startedAt: 'desc' },
      select: { startedAt: true },
    }),
  ]);

  return {
    enabled: config.enabled,
    dayOfWeek: config.dayOfWeek,
    time: config.time,
    timezone: config.timezone,
    nextRunAt: config.enabled ? nextRehearsalAt(now, config) : null,
    lastRehearsalAt: latest?.startedAt ?? null,
    lastRehearsalStatus: latest?.status ?? null,
    lastRehearsedBackupId: latest?.backupId ?? null,
    lastPassedAt: lastPassed?.startedAt ?? null,
    stale: isRehearsalStale(lastPassed?.startedAt ?? null, now, env.S2_NAS_REHEARSAL_STALE_DAYS),
    staleDays: env.S2_NAS_REHEARSAL_STALE_DAYS,
  };
}

/** วันของการซ้อมที่ผ่านล่าสุด ใช้กันการซ้อมซ้ำในวันเดียวกันหลังรีสตาร์ท */
async function lastRehearsalDate(timezone: string): Promise<string | null> {
  const row = await prisma.restoreRehearsalLog.findFirst({
    where: { trigger: 'SCHEDULED' },
    orderBy: { startedAt: 'desc' },
    select: { startedAt: true },
  });
  return row ? zonedDateKey(row.startedAt, timezone) : null;
}

/**
 * หนึ่งรอบของตัวจับเวลาการซ้อม
 * ใช้ตัวจับเวลาเดียวกับงานสำรอง ไม่สร้างเครื่องมือตั้งเวลาชุดที่สอง
 */
export async function runRehearsalTick(
  user: AuthUser,
  now: Date = new Date(),
): Promise<{ ran: boolean; reason: string; result?: RehearsalResult | null }> {
  const config = await rehearsalConfig();
  const state = { lastRehearsalDate: await lastRehearsalDate(config.timezone) };
  const decision = decideRehearsalRun(now, config, state, env.S2_NAS_BACKUP_CATCHUP_GRACE_HOURS);

  if (decision.action === 'SKIP') return { ran: false, reason: decision.reason };

  const result = await runRehearsal(user, 'SCHEDULED', now);
  return { ran: result !== null, reason: decision.reason, result };
}

import fsp from 'node:fs/promises';
import { env } from '../../config/env.js';
import { AppError, notFound } from '../../core/errors.js';
import { logger } from '../../core/logger.js';
import { prisma } from '../../core/prisma.js';
import type { AuthUser } from '../auth/auth.service.js';
import { getSetting } from '../system/settings.service.js';
import { backupDirectory, createBackup, deleteBackup } from './backup.service.js';
import { offsiteProvider } from './offsite.js';
import { currentOperation } from './operation-lock.js';
import { planRetention } from './retention-policy.js';
import { withDistributedLock } from './distributed-lock.js';
import { runRehearsalTick } from './rehearsal.service.js';
import {
  decideScheduledRun,
  isBackupStale,
  nextRunAt,
  zonedDateKey,
  type ScheduleConfig,
} from './schedule-policy.js';

/**
 * งานสำรองข้อมูลตามตารางเวลา
 *
 * ประกอบ policy ที่พิสูจน์แล้ว (schedule-policy, retention-policy) เข้ากับ service ของ F5
 * โดยไม่ทำซ้ำตรรกะการสำรอง การตรวจสอบ หรือการลบไฟล์แม้แต่บรรทัดเดียว
 */

/** ตรวจทุกนาที - ละเอียดพอให้ตรงเวลา และเบาพอที่จะไม่มีผลต่อระบบ */
const TICK_MS = 60_000;
const STARTUP_DELAY_MS = 20_000;

export async function scheduleConfig(): Promise<ScheduleConfig> {
  const [enabled, time] = await Promise.all([getSetting('BACKUP_ENABLED'), getSetting('BACKUP_TIME')]);
  return { enabled, time, timezone: env.S2_NAS_BACKUP_TIMEZONE };
}

/** วันของงานตามตารางที่สำเร็จล่าสุด ใช้กันการทำซ้ำหลังรีสตาร์ท */
async function lastScheduledRunDate(timezone: string): Promise<string | null> {
  const row = await prisma.backupLog.findFirst({
    where: { trigger: 'SCHEDULED', status: 'COMPLETED' },
    orderBy: { startedAt: 'desc' },
    select: { startedAt: true },
  });
  return row ? zonedDateKey(row.startedAt, timezone) : null;
}

/* ------------------------------------------------------------------ */
/* สถานะสำหรับหน้าผู้ดูแล                                              */
/* ------------------------------------------------------------------ */

export interface ScheduleStatus {
  enabled: boolean;
  time: string;
  timezone: string;
  nextRunAt: Date | null;
  lastScheduledRunAt: Date | null;
  lastScheduledBackupStatus: string | null;
  lastSuccessfulBackupAt: Date | null;
  retentionDays: number;
  minimumKeepCount: number;
  offsiteEnabled: boolean;
  offsiteConfigured: boolean;
  offsiteReachable: boolean;
  lastOffsiteVerifiedAt: Date | null;
  verifiedBackupCount: number;
  stale: boolean;
  staleHours: number;
}

/** สถานะทั้งหมดที่หน้าจอต้องใช้ - ไม่มี path จริงและไม่มีความลับ */
export async function scheduleStatus(now: Date = new Date()): Promise<ScheduleStatus> {
  const config = await scheduleConfig();
  const [retentionDays, minimumKeepCount, offsiteEnabled] = await Promise.all([
    getSetting('BACKUP_RETENTION_DAYS'),
    getSetting('BACKUP_MIN_KEEP_COUNT'),
    getSetting('OFFSITE_COPY_ENABLED'),
  ]);

  const [lastScheduled, lastSuccess, lastOffsite, verifiedCount, health] = await Promise.all([
    prisma.backupLog.findFirst({
      where: { trigger: 'SCHEDULED' },
      orderBy: { startedAt: 'desc' },
      select: { startedAt: true, status: true },
    }),
    prisma.backupLog.findFirst({
      where: { status: 'COMPLETED' },
      orderBy: { startedAt: 'desc' },
      select: { startedAt: true },
    }),
    prisma.backupLog.findFirst({
      where: { offsiteState: 'VERIFIED' },
      orderBy: { offsiteVerifiedAt: 'desc' },
      select: { offsiteVerifiedAt: true },
    }),
    prisma.backupLog.count({ where: { status: 'COMPLETED' } }),
    offsiteProvider().healthCheck(),
  ]);

  return {
    enabled: config.enabled,
    time: config.time,
    timezone: config.timezone,
    nextRunAt: config.enabled ? nextRunAt(now, config) : null,
    lastScheduledRunAt: lastScheduled?.startedAt ?? null,
    lastScheduledBackupStatus: lastScheduled?.status ?? null,
    lastSuccessfulBackupAt: lastSuccess?.startedAt ?? null,
    retentionDays,
    minimumKeepCount,
    offsiteEnabled,
    offsiteConfigured: health.configured,
    offsiteReachable: health.reachable,
    lastOffsiteVerifiedAt: lastOffsite?.offsiteVerifiedAt ?? null,
    verifiedBackupCount: verifiedCount,
    stale: isBackupStale(lastSuccess?.startedAt ?? null, now, env.S2_NAS_BACKUP_STALE_HOURS),
    staleHours: env.S2_NAS_BACKUP_STALE_HOURS,
  };
}

/* ------------------------------------------------------------------ */
/* นโยบายเก็บชุดสำรอง                                                  */
/* ------------------------------------------------------------------ */

export interface RetentionResult {
  examined: number;
  deleted: number;
  failed: number;
  keptForMinimum: number;
}

/**
 * ลบชุดสำรองเก่าตามนโยบาย
 *
 * ใช้ deleteBackup ของ F5 ทั้งหมด ไม่มีการลบไฟล์เองที่นี่
 * ความล้มเหลวของรายการหนึ่งต้องไม่หยุดการเก็บกวาดรายการอื่น และต้องคงระเบียนไว้เสมอ
 * มิฉะนั้นจะเหลือไฟล์กำพร้าที่ไม่มีใครรู้ว่ามีอยู่
 */
export async function runRetention(user: AuthUser, now: Date = new Date()): Promise<RetentionResult> {
  // การลบชุดสำรองต้องไม่ทับกับการสำรองหรือการซ้อมกู้คืนที่กำลังอ่านไฟล์ชุดเดียวกันอยู่
  return withDistributedLock('RETENTION', () => retentionWork(user, now));
}

async function retentionWork(user: AuthUser, now: Date): Promise<RetentionResult> {
  const [retentionDays, minimumKeepCount] = await Promise.all([
    getSetting('BACKUP_RETENTION_DAYS'),
    getSetting('BACKUP_MIN_KEEP_COUNT'),
  ]);

  const backups = await prisma.backupLog.findMany({ select: { id: true, status: true, startedAt: true } });
  const plan = planRetention(backups, { retentionDays, minimumKeepCount }, now);

  let deleted = 0;
  let failed = 0;

  for (const id of plan.deletable) {
    try {
      await deleteBackup(id, user);
      deleted += 1;
      await prisma.activityLog.create({
        data: { userId: user.id, action: 'BACKUP_RETENTION_DELETED', metadata: { backupId: id, retentionDays } },
      });
    } catch (error) {
      failed += 1;
      logger.error({ err: error }, `[BACKUP] ลบชุดสำรองตามนโยบายไม่สำเร็จ: ${id}`);
      await prisma.activityLog.create({
        data: {
          userId: user.id,
          action: 'BACKUP_RETENTION_FAILED',
          metadata: { backupId: id, code: error instanceof AppError ? error.code : 'UNKNOWN' },
        },
      });
    }
  }

  if (plan.deletable.length > 0 || plan.keptForMinimum > 0) {
    logger.info(`[BACKUP] เก็บกวาดชุดสำรอง: ลบ ${deleted}, ล้มเหลว ${failed}, คงไว้ตามขั้นต่ำ ${plan.keptForMinimum}`);
  }
  return { examined: plan.eligibleCount, deleted, failed, keptForMinimum: plan.keptForMinimum };
}

/* ------------------------------------------------------------------ */
/* สำเนานอกเครื่อง                                                     */
/* ------------------------------------------------------------------ */

/**
 * คัดลอกชุดสำรองออกไปนอกเครื่องแล้วตรวจสอบที่ปลายทาง
 *
 * ความล้มเหลวที่นี่ไม่ทำให้ชุดสำรองในเครื่องเสียสถานะ - ชุดที่ตรวจผ่านแล้วยังใช้ได้
 * สถานะสำเนานอกเครื่องจึงแยกฟิลด์ต่างหาก ไม่ปนกับ BackupStatus
 */
export async function copyOffsite(backupId: string, user: AuthUser): Promise<{ ok: boolean; problems: string[] }> {
  const row = await prisma.backupLog.findUnique({ where: { id: backupId } });
  if (!row) throw notFound('BACKUP_NOT_FOUND', 'ไม่พบชุดสำรองข้อมูล');
  if (row.status !== 'COMPLETED') {
    throw new AppError('BACKUP_NOT_COMPLETED', 'คัดลอกออกนอกเครื่องได้เฉพาะชุดสำรองที่ทำสำเร็จแล้ว', 409);
  }

  const provider = offsiteProvider();
  const health = await provider.healthCheck();
  if (!health.configured) {
    await prisma.backupLog.update({ where: { id: backupId }, data: { offsiteState: 'NOT_CONFIGURED' } });
    return { ok: false, problems: ['ยังไม่ได้ตั้งค่าปลายทางนอกเครื่อง'] };
  }

  const maxAttempts = env.S2_NAS_OFFSITE_MAX_ATTEMPTS;
  if (row.offsiteAttempts >= maxAttempts) {
    return { ok: false, problems: [`พยายามคัดลอกครบ ${maxAttempts} ครั้งแล้ว ต้องสั่งลองใหม่ด้วยตนเอง`] };
  }

  await prisma.backupLog.update({
    where: { id: backupId },
    data: { offsiteState: 'COPYING', offsiteAttempts: { increment: 1 } },
  });
  await prisma.activityLog.create({
    data: { userId: user.id, action: 'BACKUP_OFFSITE_COPY_STARTED', metadata: { backupId } },
  });

  try {
    const result = await provider.uploadBackup(row.backupName, backupId);
    if (result.ok) {
      await prisma.backupLog.update({
        where: { id: backupId },
        data: { offsiteState: 'VERIFIED', offsiteVerifiedAt: new Date(), offsiteErrorSafe: null },
      });
      await prisma.activityLog.create({
        data: {
          userId: user.id,
          action: 'BACKUP_OFFSITE_COPY_VERIFIED',
          metadata: { backupId, objects: result.verifiedObjects },
        },
      });
      logger.info(`[OFFSITE] ตรวจสอบสำเนานอกเครื่องผ่าน: ${result.verifiedObjects} ไฟล์`);
      return { ok: true, problems: [] };
    }

    // ข้อความที่เก็บต้องสั้นและปลอดภัย ไม่ใส่ path หรือรายชื่อไฟล์ทั้งหมด
    const summary = `ตรวจสอบที่ปลายทางไม่ผ่าน (${result.problems.length} ปัญหา)`;
    await failOffsite(backupId, user, summary);
    return { ok: false, problems: result.problems };
  } catch (error) {
    const summary = error instanceof AppError ? error.message : 'คัดลอกออกนอกเครื่องไม่สำเร็จ';
    await failOffsite(backupId, user, summary);
    return { ok: false, problems: [summary] };
  }
}

async function failOffsite(backupId: string, user: AuthUser, summary: string): Promise<void> {
  await prisma.backupLog.update({
    where: { id: backupId },
    data: { offsiteState: 'FAILED', offsiteErrorSafe: summary.slice(0, 500) },
  });
  await prisma.activityLog.create({
    data: { userId: user.id, action: 'BACKUP_OFFSITE_COPY_FAILED', metadata: { backupId } },
  });
  logger.warn(`[OFFSITE] สำเนานอกเครื่องล้มเหลว: ${summary}`);
}

/** สั่งลองคัดลอกใหม่ - ล้างตัวนับความพยายามเพราะเป็นการตัดสินใจของผู้ดูแล */
export async function retryOffsite(backupId: string, user: AuthUser): Promise<{ ok: boolean; problems: string[] }> {
  await prisma.backupLog.updateMany({
    where: { id: backupId },
    data: { offsiteAttempts: 0, offsiteErrorSafe: null },
  });
  return copyOffsite(backupId, user);
}

/* ------------------------------------------------------------------ */
/* ตัวจับเวลา                                                          */
/* ------------------------------------------------------------------ */

/** พื้นที่ว่างพอสำหรับชุดสำรองชุดถัดไปหรือไม่ - ประเมินจากชุดล่าสุดแบบเผื่อไว้ */
async function hasEnoughSpace(): Promise<{ ok: boolean; reason?: string }> {
  try {
    await fsp.mkdir(env.BACKUP_ROOT, { recursive: true });
    const stat = await fsp.statfs(env.BACKUP_ROOT);
    const free = Number(stat.bsize) * Number(stat.bavail);
    const last = await prisma.backupLog.findFirst({
      where: { status: 'COMPLETED', totalBytes: { not: null } },
      orderBy: { startedAt: 'desc' },
      select: { totalBytes: true },
    });
    // เผื่อสองเท่าของชุดล่าสุด ข้อมูลโตขึ้นได้และการเดาต่ำเกินไปแย่กว่าการเดาสูงเกินไป
    const required = last?.totalBytes ? Number(last.totalBytes) * 2 : 0;
    if (required > 0 && free < required) return { ok: false, reason: 'พื้นที่ดิสก์สำหรับชุดสำรองไม่เพียงพอ' };
    return { ok: true };
  } catch {
    // ระบบไฟล์ที่ไม่รายงานพื้นที่ว่างไม่ควรบล็อกการสำรอง แต่ต้องไม่แกล้งว่าตรวจแล้ว
    return { ok: true };
  }
}

export interface ScheduledRunOutcome {
  ran: boolean;
  reason: string;
  backupId?: string;
  retention?: RetentionResult;
  offsite?: { ok: boolean; problems: string[] };
}

/**
 * หนึ่งรอบของตัวจับเวลา
 *
 * รับเวลาเข้ามาเพื่อให้ทดสอบได้ และตรวจล็อกของ F5 ก่อนเสมอ
 * งานสำรองที่สั่งเองอยู่จึงไม่ถูกงานตามตารางแทรก และในทางกลับกันก็เช่นกัน
 */
export async function runScheduledTick(user: AuthUser, now: Date = new Date()): Promise<ScheduledRunOutcome> {
  const config = await scheduleConfig();
  const state = { lastScheduledRunDate: await lastScheduledRunDate(config.timezone) };
  const decision = decideScheduledRun(now, config, state, env.S2_NAS_BACKUP_CATCHUP_GRACE_HOURS);

  if (decision.action === 'SKIP') return { ran: false, reason: decision.reason };

  // งานอื่นถืออยู่ - ข้ามรอบนี้ไปเงียบ ๆ แล้วรอบหน้าค่อยว่ากัน ดีกว่าไปแย่งล็อก
  if (currentOperation()) return { ran: false, reason: 'BUSY' };

  const space = await hasEnoughSpace();
  if (!space.ok) {
    logger.warn(`[BACKUP] ข้ามงานตามตาราง: ${space.reason}`);
    return { ran: false, reason: 'INSUFFICIENT_SPACE' };
  }

  await prisma.activityLog.create({
    data: { userId: user.id, action: 'BACKUP_SCHEDULED_STARTED', metadata: { forDate: decision.forDate, reason: decision.reason } },
  });

  const { backup } = await createBackup(user, {}, 'SCHEDULED');

  await prisma.activityLog.create({
    data: {
      userId: user.id,
      action: 'BACKUP_SCHEDULED_COMPLETED',
      metadata: { backupId: backup.id, status: backup.status },
    },
  });

  // เก็บกวาดหลังสำรองสำเร็จเท่านั้น มิฉะนั้นอาจลบของเก่าทิ้งโดยที่ยังไม่มีของใหม่มาแทน
  const retention = await runRetention(user, now);

  let offsite: { ok: boolean; problems: string[] } | undefined;
  if (await getSetting('OFFSITE_COPY_ENABLED')) {
    offsite = await copyOffsite(backup.id, user);
  }

  return { ran: true, reason: decision.reason, backupId: backup.id, retention, offsite };
}

/**
 * เริ่มตัวจับเวลา
 *
 * เริ่มหลังระบบพร้อมแล้วเท่านั้น (ฐานข้อมูลต่อได้ storage พร้อม backup root เขียนได้)
 * ตัวจับเวลาเดียวสำหรับทั้ง process จึงไม่มีทางเกิดงานซ้อนจากตัวจับเวลาเอง
 */
export function startBackupScheduler(resolveOperator: () => Promise<AuthUser | null>): { stop: () => void } {
  /**
   * ตัวจับเวลาเดียวส่งงานให้ทั้งสองตาราง ไม่สร้างเครื่องมือตั้งเวลาชุดที่สอง
   * ทั้งสองงานใช้ล็อกข้ามอินสแตนซ์ตัวเดียวกัน จึงไม่มีทางทำงานทับกัน
   */
  const tick = (): void => {
    void (async () => {
      const operator = await resolveOperator().catch(() => null);
      if (!operator) return;

      try {
        await runScheduledTick(operator);
      } catch (error) {
        logger.error({ err: error }, '[BACKUP] รอบตรวจตารางเวลาล้มเหลว');
      }

      // การซ้อมที่ล้มเหลวต้องไม่ทำให้รอบสำรองข้อมูลเสียหาย จึงแยก try กัน
      try {
        await runRehearsalTick(operator);
      } catch (error) {
        logger.error({ err: error }, '[REHEARSAL] รอบตรวจตารางซ้อมกู้คืนล้มเหลว');
      }
    })();
  };

  const first = setTimeout(tick, STARTUP_DELAY_MS);
  const timer = setInterval(tick, TICK_MS);
  first.unref?.();
  timer.unref?.();

  logger.info('[BACKUP] เปิดตัวจับเวลาสำรองข้อมูลตามตาราง');
  return {
    stop: () => {
      clearTimeout(first);
      clearInterval(timer);
    },
  };
}

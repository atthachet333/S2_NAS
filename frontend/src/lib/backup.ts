/**
 * ชนิดข้อมูลและข้อความของงานสำรอง/กู้คืน ฝั่งหน้าจอ
 *
 * DTO จากเซิร์ฟเวอร์ไม่มี path จริงและไม่มีชื่อโฟลเดอร์ของชุดสำรองโดยเจตนา
 * หน้าจอจึงไม่ต้อง (และต้องไม่) แสดงตำแหน่งบนดิสก์ให้ผู้ใช้เห็น
 */
export type BackupStatus = 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED';

export type BackupTrigger = 'MANUAL' | 'SCHEDULED';
export type OffsiteState = 'NOT_CONFIGURED' | 'PENDING' | 'COPYING' | 'VERIFIED' | 'FAILED';

export interface ScheduleStatus {
  enabled: boolean;
  time: string;
  timezone: string;
  nextRunAt: string | null;
  lastScheduledRunAt: string | null;
  lastScheduledBackupStatus: BackupStatus | null;
  lastSuccessfulBackupAt: string | null;
  retentionDays: number;
  minimumKeepCount: number;
  offsiteEnabled: boolean;
  offsiteConfigured: boolean;
  offsiteReachable: boolean;
  lastOffsiteVerifiedAt: string | null;
  verifiedBackupCount: number;
  stale: boolean;
  staleHours: number;
}

export type RehearsalStatusValue = 'RUNNING' | 'PASSED' | 'FAILED';

export interface RehearsalSchedule {
  enabled: boolean;
  dayOfWeek: number;
  time: string;
  timezone: string;
  nextRunAt: string | null;
  lastRehearsalAt: string | null;
  lastRehearsalStatus: RehearsalStatusValue | null;
  lastRehearsedBackupId: string | null;
  lastPassedAt: string | null;
  stale: boolean;
  staleDays: number;
}

export interface RehearsalResult {
  id: string;
  backupId: string;
  status: RehearsalStatusValue;
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

export interface LockStatus {
  name: string;
  held: boolean;
  heldByThisProcess: boolean;
}

export const REHEARSAL_STATUS_LABEL: Record<RehearsalStatusValue, string> = {
  RUNNING: 'กำลังทดสอบ…',
  PASSED: 'ผ่าน',
  FAILED: 'ไม่ผ่าน',
};

export const REHEARSAL_STATUS_TONE: Record<RehearsalStatusValue, 'neutral' | 'info' | 'success' | 'danger'> = {
  RUNNING: 'info',
  PASSED: 'success',
  FAILED: 'danger',
};

export const WEEKDAY_LABEL = ['อาทิตย์', 'จันทร์', 'อังคาร', 'พุธ', 'พฤหัสบดี', 'ศุกร์', 'เสาร์'];

/** คำเตือนเมื่อไม่ได้ทดสอบกู้คืนมานาน - คืน null เมื่อปกติ */
export function rehearsalStaleWarning(status: RehearsalSchedule | undefined): string | null {
  if (!status?.stale) return null;
  return status.lastPassedAt
    ? `ไม่มีการทดสอบกู้คืนสำเร็จเกิน ${status.staleDays} วัน`
    : 'ยังไม่เคยทดสอบกู้คืนสำเร็จ';
}

/** วันในสัปดาห์ต้องอยู่ในช่วง 0-6 - 0 เป็นค่าที่ถูกต้อง ไม่ใช่ค่าว่าง */
export function validateRehearsalDay(day: number): string | null {
  if (!Number.isInteger(day) || day < 0 || day > 6) return 'ต้องเป็นวันในสัปดาห์ (0-6)';
  return null;
}

export interface RetentionRunResult {
  examined: number;
  deleted: number;
  failed: number;
  keptForMinimum: number;
}

export const OFFSITE_STATE_LABEL: Record<OffsiteState, string> = {
  NOT_CONFIGURED: 'ยังไม่ได้ตั้งค่า',
  PENDING: 'รอคัดลอก',
  COPYING: 'กำลังคัดลอก',
  VERIFIED: 'ตรวจสอบแล้ว',
  FAILED: 'ล้มเหลว',
};

export const OFFSITE_STATE_TONE: Record<OffsiteState, 'neutral' | 'info' | 'success' | 'danger'> = {
  NOT_CONFIGURED: 'neutral',
  PENDING: 'neutral',
  COPYING: 'info',
  VERIFIED: 'success',
  FAILED: 'danger',
};

export const TRIGGER_LABEL: Record<BackupTrigger, string> = {
  MANUAL: 'สั่งเอง',
  SCHEDULED: 'ตามตาราง',
};

/** ข้อความเตือนเมื่อชุดสำรองล่าสุดเก่าเกินไป - คืน null เมื่อปกติ */
export function staleWarning(status: ScheduleStatus | undefined): string | null {
  if (!status?.stale) return null;
  return status.lastSuccessfulBackupAt
    ? `ไม่มี Backup สำเร็จเกิน ${status.staleHours} ชั่วโมง`
    : 'ยังไม่เคยสำรองข้อมูลสำเร็จ';
}

/** ตรวจค่าตารางเวลาก่อนส่ง - backend ตรวจซ้ำเสมอ ที่นี่แค่บอกผู้ใช้ก่อนกด */
export function validateScheduleTime(value: string): string | null {
  if (!value.trim()) return 'กรุณากรอกเวลา';
  return /^([01]\d|2[0-3]):([0-5]\d)$/.test(value.trim()) ? null : 'ต้องเป็นเวลา HH:mm แบบ 24 ชั่วโมง';
}

export function validateRetention(days: number, minimumKeep: number): string | null {
  if (!Number.isInteger(days) || days < 1) return 'จำนวนวันต้องเป็นจำนวนเต็มมากกว่า 0';
  if (!Number.isInteger(minimumKeep) || minimumKeep < 1) return 'จำนวนขั้นต่ำต้องเป็นจำนวนเต็มมากกว่า 0';
  return null;
}

export interface BackupDto {
  id: string;
  status: BackupStatus;
  type: 'FULL';
  trigger: BackupTrigger;
  offsiteState: OffsiteState;
  offsiteVerifiedAt: string | null;
  offsiteError: string | null;
  startedAt: string;
  completedAt: string | null;
  databaseBytes: number | null;
  storageBytes: number | null;
  totalBytes: number | null;
  fileCount: number | null;
  createdBy: { id: string; displayName: string; email: string } | null;
  errorCode: string | null;
  errorMessage: string | null;
  durationMs: number | null;
}

export interface BackupReadiness {
  toolingAvailable: boolean;
  toolingReason: string | null;
  busy: boolean;
  busyOperation: 'BACKUP' | 'RESTORE' | null;
}

export interface VerificationResult {
  valid: boolean;
  summary: string;
  checkedObjects: number;
  missingObjects: string[];
  checksumMismatches: string[];
  databaseChecksumValid: boolean;
  manifestChecksumValid: boolean;
}

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
  stagedDatabase: string;
  stagedStorageName: string;
  restoredObjects: number;
  verifiedObjects: number;
  problems: string[];
  reconciliation: {
    ok: boolean;
    expectedObjects: number;
    presentObjects: number;
    missingFiles: string[];
    orphanFiles: string[];
    sizeMismatches: string[];
    checksumMismatches: string[];
    resourceRows: number;
    versionRows: number;
  };
}

export const BACKUP_STATUS_LABEL: Record<BackupStatus, string> = {
  PENDING: 'รอเริ่ม',
  RUNNING: 'กำลังสำรองข้อมูล…',
  COMPLETED: 'สำเร็จ',
  FAILED: 'ล้มเหลว',
};

export const BACKUP_STATUS_TONE: Record<BackupStatus, 'neutral' | 'info' | 'success' | 'danger'> = {
  PENDING: 'neutral',
  RUNNING: 'info',
  COMPLETED: 'success',
  FAILED: 'danger',
};

/**
 * ขั้นตอนของการเตรียมกู้คืน
 *
 * แยกเป็นขั้นเพื่อให้ผู้ใช้เห็นว่าระบบตรวจอะไรไปแล้วบ้างก่อนถึงขั้นที่แตะข้อมูลจริง
 * และเพื่อให้ชัดว่าการ cutover ไม่ได้เกิดขึ้นเองจากหน้าจอนี้
 */
export const RESTORE_STEPS = [
  { key: 'verify', label: 'ตรวจสอบ Backup' },
  { key: 'checksum', label: 'ตรวจสอบไฟล์และ checksum' },
  { key: 'stage', label: 'เตรียมพื้นที่ Restore' },
  { key: 'confirm', label: 'ยืนยันการดำเนินการ' },
] as const;

/** วลีที่ผู้ใช้ต้องพิมพ์เองก่อนเตรียมกู้คืน - กันการกดผ่านโดยไม่ได้อ่าน */
export const RESTORE_CONFIRM_PHRASE = 'RESTORE';

export function formatBackupBytes(value: number | null): string {
  if (value === null) return '—';
  if (value === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  const size = value / 1024 ** index;
  return `${size.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

export function formatDuration(ms: number | null): string {
  if (ms === null) return '—';
  if (ms < 1000) return `${ms} มิลลิวินาที`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} วินาที`;
  return `${Math.floor(seconds / 60)} นาที ${seconds % 60} วินาที`;
}

/**
 * เหตุผลที่ยังสร้างชุดสำรองไม่ได้ - คืน null เมื่อพร้อม
 * บอกเหตุผลเสมอ ดีกว่าปุ่มที่กดไม่ได้โดยไม่อธิบายอะไรเลย
 */
export function backupBlockedReason(readiness: BackupReadiness | undefined): string | null {
  if (!readiness) return null;
  if (!readiness.toolingAvailable) {
    return readiness.toolingReason ?? 'ยังไม่พร้อมสำรองข้อมูล: ไม่พบเครื่องมือของฐานข้อมูล';
  }
  if (readiness.busy) {
    return readiness.busyOperation === 'RESTORE'
      ? 'กำลังเตรียมกู้คืนอยู่ กรุณารอให้เสร็จก่อน'
      : 'กำลังสำรองข้อมูลอยู่';
  }
  return null;
}

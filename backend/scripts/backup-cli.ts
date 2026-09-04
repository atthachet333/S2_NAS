import { prisma } from '../src/core/prisma.js';
import type { AuthUser } from '../src/modules/auth/auth.service.js';
import { createBackup, listBackups, verifyBackup } from '../src/modules/backup/backup.service.js';
import { discardStage, stageRestore } from '../src/modules/backup/restore.service.js';
import { copyOffsite, runRetention, scheduleStatus } from '../src/modules/backup/schedule.service.js';
import { listRehearsals, rehearsalStatus, runRehearsal } from '../src/modules/backup/rehearsal.service.js';
import { lockStatus } from '../src/modules/backup/distributed-lock.js';

/**
 * เครื่องมือบรรทัดคำสั่งสำหรับงานปฏิบัติการ
 *
 * ใช้ service ชุดเดียวกับ API ทั้งหมด ไม่มีตรรกะการสำรองซ้ำอยู่ที่นี่
 * มิฉะนั้นวันหนึ่ง CLI กับ API จะสำรองไม่เหมือนกัน และไม่มีใครรู้ว่าอันไหนถูก
 */

/** ผู้ลงมือเมื่อสั่งจากเครื่อง - ต้องเป็นผู้ใช้จริงที่มีสิทธิ์ เพื่อให้ audit ชี้ตัวได้ */
async function operator(): Promise<AuthUser> {
  const email = process.env.S2_NAS_BACKUP_OPERATOR?.trim().toLowerCase();
  const user = await prisma.user.findFirst({
    where: {
      status: 'ACTIVE',
      ...(email ? { email } : {}),
      roles: { some: { role: { permissions: { some: { permission: { code: 'system:backup:manage' } } } } } },
    },
    include: { roles: { include: { role: { include: { permissions: { include: { permission: true } } } } } } },
    orderBy: { createdAt: 'asc' },
  });

  if (!user) {
    throw new Error(
      'ไม่พบผู้ใช้ที่มีสิทธิ์ system:backup:manage - รัน npm run rbac:sync ก่อน หรือระบุ S2_NAS_BACKUP_OPERATOR',
    );
  }

  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    status: user.status,
    mustChangePassword: user.mustChangePassword,
    roles: user.roles.map((link) => link.role.code),
    permissions: [
      ...new Set(user.roles.flatMap((link) => link.role.permissions.map((row) => row.permission.code))),
    ],
  };
}

function formatBytes(value: number | null): string {
  if (value === null) return '-';
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit += 1; }
  return `${size.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

async function main(): Promise<void> {
  const [command, argument] = process.argv.slice(2);

  switch (command) {
    case 'create': {
      const user = await operator();
      console.log('[BACKUP] เริ่มสำรองข้อมูล…');
      const { backup } = await createBackup(user);
      console.log(`[BACKUP] ${backup.status} id=${backup.id}`);
      console.log(`         ไฟล์ ${backup.fileCount ?? 0} รายการ · ฐานข้อมูล ${formatBytes(backup.databaseBytes)} · รวม ${formatBytes(backup.totalBytes)}`);
      break;
    }

    case 'list': {
      const rows = await listBackups(20);
      if (rows.length === 0) { console.log('[BACKUP] ยังไม่มีชุดสำรอง'); break; }
      for (const row of rows) {
        console.log(
          `${row.startedAt.toISOString()}  ${row.status.padEnd(9)}  ${String(row.fileCount ?? '-').padStart(5)} ไฟล์  ${formatBytes(row.totalBytes).padStart(9)}  ${row.id}`,
        );
      }
      break;
    }

    case 'verify': {
      if (!argument) throw new Error('ต้องระบุรหัสชุดสำรอง: npm run backup:verify -- <backupId>');
      const result = await verifyBackup(argument);
      console.log(`[VERIFY] ${result.valid ? 'ผ่าน' : 'ไม่ผ่าน'} - ${result.summary}`);
      if (!result.valid) process.exitCode = 1;
      break;
    }

    case 'stage-restore': {
      if (!argument) throw new Error('ต้องระบุรหัสชุดสำรอง: npm run backup:stage-restore -- <backupId>');
      const user = await operator();
      console.log('[RESTORE] กำลังเตรียมพื้นที่พัก (ไม่แตะระบบที่ใช้งานจริง)…');
      const result = await stageRestore(argument, user);
      console.log(`[RESTORE] ${result.ok ? 'พร้อมกู้คืน' : 'ไม่ผ่าน'}`);
      console.log(`          ฐานข้อมูลพัก: ${result.stagedDatabase}`);
      console.log(`          ไฟล์ที่ตรวจผ่าน: ${result.verifiedObjects}/${result.restoredObjects}`);
      console.log(`          กระทบยอด: resources=${result.reconciliation.resourceRows} versions=${result.reconciliation.versionRows} missing=${result.reconciliation.missingFiles.length} orphan=${result.reconciliation.orphanFiles.length}`);
      for (const problem of result.problems) console.log(`          ! ${problem}`);
      if (!result.ok) process.exitCode = 1;
      break;
    }

    case 'schedule-status': {
      const status = await scheduleStatus();
      console.log(`[SCHEDULE] ${status.enabled ? 'เปิดใช้งาน' : 'ปิดอยู่'} เวลา ${status.time} (${status.timezone})`);
      console.log(`           รอบถัดไป: ${status.nextRunAt ? status.nextRunAt.toISOString() : '-'}`);
      console.log(`           สำรองสำเร็จล่าสุด: ${status.lastSuccessfulBackupAt?.toISOString() ?? 'ยังไม่เคย'}`);
      console.log(`           เก็บ ${status.retentionDays} วัน / อย่างน้อย ${status.minimumKeepCount} ชุด`);
      console.log(`           ชุดที่ตรวจสอบแล้ว: ${status.verifiedBackupCount}`);
      console.log(
        `           นอกเครื่อง: ${status.offsiteEnabled ? 'เปิด' : 'ปิด'} · ตั้งค่าแล้ว ${status.offsiteConfigured} · เข้าถึงได้ ${status.offsiteReachable}`,
      );
      if (status.stale) console.log(`           ! ไม่มี Backup สำเร็จเกิน ${status.staleHours} ชั่วโมง`);
      break;
    }

    case 'retention': {
      const user = await operator();
      const result = await runRetention(user);
      console.log(`[RETENTION] เข้าเกณฑ์ ${result.examined} · ลบ ${result.deleted} · ล้มเหลว ${result.failed} · คงไว้ตามขั้นต่ำ ${result.keptForMinimum}`);
      if (result.failed > 0) process.exitCode = 1;
      break;
    }

    case 'offsite': {
      if (!argument) throw new Error('ต้องระบุรหัสชุดสำรอง: npm run backup:offsite -- <backupId>');
      const user = await operator();
      const result = await copyOffsite(argument, user);
      console.log(`[OFFSITE] ${result.ok ? 'ตรวจสอบที่ปลายทางผ่าน' : 'ไม่สำเร็จ'}`);
      for (const problem of result.problems) console.log(`          ! ${problem}`);
      if (!result.ok) process.exitCode = 1;
      break;
    }

    case 'lock-status': {
      const lock = await lockStatus();
      console.log(`[LOCK] ${lock.name}: ${lock.held ? 'ถูกถืออยู่' : 'ว่าง'}`);
      break;
    }

    case 'rehearsal': {
      const user = await operator();
      console.log('[REHEARSAL] เริ่มซ้อมกู้คืน (พื้นที่พักเท่านั้น ไม่แตะระบบจริง)…');
      const result = await runRehearsal(user, 'MANUAL');
      if (!result) {
        console.log('[REHEARSAL] ไม่มีชุดสำรองที่ต้องซ้อมในรอบนี้');
        break;
      }
      console.log(`[REHEARSAL] ${result.status} backup=${result.backupId}`);
      console.log(
        `            resources=${result.resourceCount} versions=${result.versionCount} ` +
          `missing=${result.missingCount} orphan=${result.orphanCount} checksumFailures=${result.checksumFailures}`,
      );
      if (result.cleanupFailed) console.log('            ! ล้างพื้นที่พักไม่สำเร็จ');
      if (result.errorMessage) console.log(`            ! ${result.errorMessage}`);
      if (result.status !== 'PASSED') process.exitCode = 1;
      break;
    }

    case 'rehearsal-status': {
      const status = await rehearsalStatus();
      const days = ['อาทิตย์', 'จันทร์', 'อังคาร', 'พุธ', 'พฤหัสบดี', 'ศุกร์', 'เสาร์'];
      console.log(
        `[REHEARSAL] ${status.enabled ? 'เปิดใช้งาน' : 'ปิดอยู่'} · ทุกวัน${days[status.dayOfWeek] ?? '?'} ` +
          `${status.time} (${status.timezone})`,
      );
      console.log(`            รอบถัดไป: ${status.nextRunAt?.toISOString() ?? '-'}`);
      console.log(
        `            ครั้งล่าสุด: ${status.lastRehearsalAt?.toISOString() ?? 'ยังไม่เคย'} ` +
          `(${status.lastRehearsalStatus ?? '-'})`,
      );
      if (status.stale) {
        console.log(`            ! ไม่มีการทดสอบกู้คืนสำเร็จเกิน ${status.staleDays} วัน`);
      }
      for (const row of await listRehearsals(5)) {
        console.log(`            ${row.status.padEnd(7)} ${row.backupId}`);
      }
      break;
    }

    case 'discard-stage': {
      if (!argument) throw new Error('ต้องระบุรหัสชุดสำรอง');
      await discardStage(argument);
      console.log('[RESTORE] เก็บกวาดพื้นที่พักแล้ว');
      break;
    }

    default:
      console.log(
        'ใช้: backup-cli <create|list|verify|stage-restore|discard-stage|schedule-status|retention|offsite|lock-status|rehearsal|rehearsal-status> [backupId]',
      );
      process.exitCode = 1;
  }
}

main()
  .catch((error: unknown) => {
    console.error('[BACKUP-CLI]', error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

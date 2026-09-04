import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../core/prisma.js';
import { requirePermission } from '../auth/auth.guard.js';
import { createBackup, deleteBackup, getBackup, listBackups, verifyBackup } from './backup.service.js';
import { checkTooling } from './mariadb-cli.js';
import { currentOperation } from './operation-lock.js';
import { discardStage, restorePrecheck, stageRestore } from './restore.service.js';
import { copyOffsite, retryOffsite, runRetention, scheduleStatus } from './schedule.service.js';
import { listRehearsals, rehearsalStatus, runRehearsal } from './rehearsal.service.js';
import { lockStatus } from './distributed-lock.js';
import { getSetting, updateSettings } from '../system/settings.service.js';

/** สิทธิ์เฉพาะของงานสำรอง/กู้คืน แยกจากค่าตั้งค่าระบบ เพราะผลกระทบคนละแบบ */
export const MANAGE_BACKUP_PERMISSION = 'system:backup:manage';

const idParams = z.object({ id: z.string().min(1) });
const audit = (request: FastifyRequest) => ({
  ipAddress: request.ip,
  userAgent: request.headers['user-agent'],
});

export async function backupRoutes(app: FastifyInstance): Promise<void> {
  const guard = { preHandler: requirePermission(MANAGE_BACKUP_PERMISSION) };

  /** สถานะความพร้อมของระบบสำรอง - ให้หน้าจอบอกได้ว่าทำไมปุ่มถึงกดไม่ได้ */
  app.get('/admin/backups/readiness', guard, async () => {
    const tooling = await checkTooling();
    const running = currentOperation();
    return {
      success: true,
      data: {
        toolingAvailable: tooling.available,
        toolingReason: tooling.reason ?? null,
        busy: running !== null,
        busyOperation: running?.operation ?? null,
      },
    };
  });

  /* ---------------- ตารางเวลาและนโยบายเก็บ ---------------- */

  app.get('/admin/backups/schedule', guard, async () => ({ success: true, data: await scheduleStatus() }));

  /**
   * แก้ตารางเวลาและนโยบายเก็บ
   *
   * ค่าทั้งหมดเป็นค่าตั้งค่าของ F4 อยู่แล้ว จึงส่งต่อไปยัง updateSettings
   * เพื่อให้การตรวจค่า การบันทึก audit และการล้างแคชเป็นเส้นทางเดียวกับหน้าตั้งค่า
   */
  app.patch('/admin/backups/schedule', guard, async (request) => {
    const input = z
      .object({
        BACKUP_ENABLED: z.boolean().optional(),
        BACKUP_TIME: z.string().optional(),
        BACKUP_RETENTION_DAYS: z.number().optional(),
        BACKUP_MIN_KEEP_COUNT: z.number().optional(),
        OFFSITE_COPY_ENABLED: z.boolean().optional(),
      })
      .strict()
      .parse(request.body);

    const updates = Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
    if (Object.keys(updates).length === 0) {
      return { success: true, data: await scheduleStatus() };
    }

    const wasEnabled = await getSetting('BACKUP_ENABLED');
    await updateSettings(request.authUser!, updates, audit(request));

    // การเปิด/ปิดตารางเวลามีผลต่อความปลอดภัยของข้อมูล จึงบันทึกแยกให้เห็นชัดใน audit
    if (input.BACKUP_ENABLED !== undefined && input.BACKUP_ENABLED !== wasEnabled) {
      await prisma.activityLog.create({
        data: {
          userId: request.authUser!.id,
          action: input.BACKUP_ENABLED ? 'BACKUP_SCHEDULE_ENABLED' : 'BACKUP_SCHEDULE_DISABLED',
        },
      });
    }
    await prisma.activityLog.create({
      data: {
        userId: request.authUser!.id,
        action: 'BACKUP_SCHEDULE_UPDATED',
        metadata: { keys: Object.keys(updates) },
      },
    });

    return { success: true, data: await scheduleStatus() };
  });

  app.post('/admin/backups/retention', guard, async (request) => ({
    success: true,
    data: await runRetention(request.authUser!),
  }));

  /* ---------------- การซ้อมกู้คืน ---------------- */

  app.get('/admin/backups/rehearsal', guard, async () => ({ success: true, data: await rehearsalStatus() }));

  app.patch('/admin/backups/rehearsal', guard, async (request) => {
    const input = z
      .object({
        RESTORE_REHEARSAL_ENABLED: z.boolean().optional(),
        RESTORE_REHEARSAL_DAY: z.number().optional(),
        RESTORE_REHEARSAL_TIME: z.string().optional(),
      })
      .strict()
      .parse(request.body);

    const updates = Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
    if (Object.keys(updates).length > 0) {
      await updateSettings(request.authUser!, updates, audit(request));
      await prisma.activityLog.create({
        data: {
          userId: request.authUser!.id,
          action: 'RESTORE_REHEARSAL_SCHEDULE_UPDATED',
          metadata: { keys: Object.keys(updates) },
        },
      });
    }
    return { success: true, data: await rehearsalStatus() };
  });

  /** ซ้อมกู้คืนเดี๋ยวนี้ - ทำในพื้นที่พักเสมอ ไม่มีการนำขึ้นใช้งานจริง */
  app.post('/admin/backups/rehearsal/run-now', guard, async (request) => ({
    success: true,
    data: await runRehearsal(request.authUser!, 'MANUAL'),
  }));

  app.get('/admin/backups/rehearsals', guard, async () => ({ success: true, data: await listRehearsals() }));

  /** สถานะล็อกข้ามอินสแตนซ์ - ใช้ตรวจว่ามีงานค้างอยู่หรือไม่ */
  app.get('/admin/backups/lock', guard, async () => ({ success: true, data: await lockStatus() }));

  app.get('/admin/backups', guard, async () => ({ success: true, data: await listBackups() }));

  app.get('/admin/backups/:id', guard, async (request) => ({
    success: true,
    data: await getBackup(idParams.parse(request.params).id),
  }));

  app.post('/admin/backups', guard, async (request, reply) => {
    const result = await createBackup(request.authUser!, audit(request));
    return reply.status(201).send({ success: true, data: result.backup });
  });

  /** สั่งสำรองเดี๋ยวนี้ - เป็นการสั่งเอง ไม่นับเป็นงานตามตาราง */
  app.post('/admin/backups/run-now', guard, async (request, reply) => {
    const result = await createBackup(request.authUser!, audit(request), 'MANUAL');
    return reply.status(201).send({ success: true, data: result.backup });
  });

  app.post('/admin/backups/:id/offsite', guard, async (request) => ({
    success: true,
    data: await copyOffsite(idParams.parse(request.params).id, request.authUser!),
  }));

  app.post('/admin/backups/:id/offsite-retry', guard, async (request) => ({
    success: true,
    data: await retryOffsite(idParams.parse(request.params).id, request.authUser!),
  }));

  app.post('/admin/backups/:id/verify', guard, async (request) => ({
    success: true,
    data: await verifyBackup(idParams.parse(request.params).id),
  }));

  app.post('/admin/backups/:id/restore-precheck', guard, async (request) => ({
    success: true,
    data: await restorePrecheck(idParams.parse(request.params).id, request.authUser!, audit(request)),
  }));

  /**
   * เตรียมพื้นที่พักสำหรับกู้คืน - ไม่แตะระบบที่ใช้งานจริง
   * การ cutover จริงเป็นขั้นตอนที่ผู้ดูแลลงมือเองตาม docs/RESTORE.md
   */
  app.post('/admin/backups/:id/restore-stage', guard, async (request) => ({
    success: true,
    data: await stageRestore(idParams.parse(request.params).id, request.authUser!, audit(request)),
  }));

  app.delete('/admin/backups/:id/restore-stage', guard, async (request) => {
    await discardStage(idParams.parse(request.params).id);
    return { success: true, data: { discarded: true } };
  });

  app.delete('/admin/backups/:id', guard, async (request) => ({
    success: true,
    data: await deleteBackup(idParams.parse(request.params).id, request.authUser!, audit(request)),
  }));
}

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { prisma } from '../../core/prisma.js';
import type { AuthUser } from '../auth/auth.service.js';
import { createFolder } from '../resources/resource.service.js';
import { trashResource } from './trash.service.js';
import { findExpiredTrashRoots, retentionCutoff, runTrashRetention } from './trash-retention.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * ถังขยะหมดอายุ "รายรายการ" ไม่ใช่ล้างทั้งใบตามรอบ
 * ผู้ใช้ที่ลบไฟล์วันนี้จึงต้องมีเวลากู้คืนครบตามจำนวนวันเสมอ
 */
describe('การเก็บกวาดถังขยะตามอายุ', () => {
  const prefix = `retention-test-${process.pid}`;
  const audit = {};
  let userId = '';
  let user: AuthUser;
  const created: string[] = [];

  const trashedAt = async (id: string, daysAgo: number): Promise<void> => {
    await prisma.resource.update({ where: { id }, data: { deletedAt: new Date(Date.now() - daysAgo * DAY_MS) } });
  };

  before(async () => {
    const row = await prisma.user.create({ data: { email: `${prefix}@example.invalid`, displayName: 'Retention', status: 'ACTIVE' } });
    userId = row.id;
    user = { id: userId, email: row.email, displayName: 'Retention', status: 'ACTIVE', mustChangePassword: false, roles: ['SUPER_ADMIN'], permissions: ['resources:read', 'resources:write', 'resources:delete'] };
  });

  after(async () => {
    await prisma.activityLog.deleteMany({ where: { userId } });
    await prisma.activityLog.deleteMany({ where: { resourceId: { in: created } } });
    for (const id of [...created].reverse()) await prisma.resource.deleteMany({ where: { id } });
    await prisma.user.deleteMany({ where: { email: { startsWith: prefix } } });
  });

  test('เส้นแบ่งอายุคำนวณจากวันที่ลบของแต่ละรายการ', () => {
    const now = new Date('2026-09-03T00:00:00.000Z');
    assert.equal(retentionCutoff(now, 14).toISOString(), '2026-08-20T00:00:00.000Z');
  });

  test('รายการที่ยังไม่ครบกำหนดต้องไม่ถูกเลือก และรายการที่ครบแล้วต้องถูกเลือก', async () => {
    const fresh = await createFolder(user, { name: `${prefix}-fresh` }, audit);
    const stale = await createFolder(user, { name: `${prefix}-stale` }, audit);
    created.push(fresh.id, stale.id);

    await trashResource(fresh.id, user, audit);
    await trashResource(stale.id, user, audit);
    await trashedAt(fresh.id, 13);
    await trashedAt(stale.id, 15);

    const expired = await findExpiredTrashRoots(retentionCutoff(new Date(), 14));
    const ids = expired.map((row) => row.id);
    assert.ok(ids.includes(stale.id), 'รายการที่เกิน 14 วันต้องหมดอายุ');
    assert.ok(!ids.includes(fresh.id), 'รายการที่ยังไม่ครบ 14 วันต้องยังอยู่');
  });

  test('รายการที่ถูกล็อกจะถูกข้าม ไม่ใช่ปลดล็อกให้เอง และไม่ทำให้ทั้งรอบล้ม', async () => {
    const locked = await createFolder(user, { name: `${prefix}-locked` }, audit);
    created.push(locked.id);
    await trashResource(locked.id, user, audit);
    await prisma.resource.update({ where: { id: locked.id }, data: { isLocked: true, lockReason: 'ตรวจสอบภายใน' } });
    await trashedAt(locked.id, 20);

    const result = await runTrashRetention();
    assert.ok(result.skipped >= 1, 'ต้องมีรายการที่ถูกข้ามเพราะล็อก');

    const still = await prisma.resource.findFirst({ where: { id: locked.id }, select: { id: true } });
    assert.ok(still, 'รายการที่ถูกล็อกต้องยังอยู่');
  });

  test('รายการที่หมดอายุถูกลบถาวรจริง และบันทึก audit ในนามระบบ', async () => {
    const gone = await prisma.resource.findFirst({ where: { name: `${prefix}-stale` }, select: { id: true } });
    assert.equal(gone, null, 'รายการที่หมดอายุต้องถูกลบถาวรไปแล้วจากรอบก่อนหน้า');

    const log = await prisma.activityLog.findFirst({
      where: { action: 'RESOURCE_PERMANENTLY_DELETED', userId: null },
      orderBy: { createdAt: 'desc' },
    });
    assert.ok(log, 'ต้องมี audit ของการลบถาวรโดยระบบ');
    assert.equal((log?.metadata as { reason?: string } | null)?.reason, 'RETENTION');
  });

  test('รายการที่ยังไม่ครบกำหนดยังอยู่หลังรันงานเก็บกวาด', async () => {
    const fresh = await prisma.resource.findFirst({ where: { name: `${prefix}-fresh` }, select: { id: true } });
    assert.ok(fresh, 'ถังขยะต้องไม่ถูกล้างทั้งใบ');
  });
});

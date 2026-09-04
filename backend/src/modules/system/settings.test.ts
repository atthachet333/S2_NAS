import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { SignJWT } from 'jose';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app.js';
import { prisma } from '../../core/prisma.js';
import { env } from '../../config/env.js';
import type { AuthUser } from '../auth/auth.service.js';
import {
  SETTING_KEYS,
  getSetting,
  invalidateSettingsCache,
  listSettings,
  resetSetting,
  updateSettings,
} from './settings.service.js';
import { effectiveUploadBytes } from '../files/file.service.js';
import { effectiveZipLimits } from '../files/zip.service.js';
import { runTrashRetention } from '../files/trash-retention.js';

/**
 * ค่าตั้งค่าการทำงานของระบบ
 *
 * สิ่งที่ต้องพิสูจน์คือ "ค่าที่มีผลจริง" ไม่ใช่แค่บันทึกลงตารางได้
 * ทุกจุดที่ใช้ค่าต้องอ่านผ่านบริการเดียวกัน และการลบค่าต้องกลับไปใช้ environment ได้จริง
 */
describe('ค่าตั้งค่าการทำงานของระบบ', () => {
  const prefix = `settings-test-${process.pid}`;
  let app: FastifyInstance;
  let adminId = '';
  let admin: AuthUser;
  /** ผู้ใช้จริงพร้อมบทบาทจริง ใช้ทดสอบด่านสิทธิ์ผ่าน HTTP */
  let managerUserId = '';
  let plainUserId = '';
  const roleCodes = [`QA_SETTINGS_${process.pid}`, `QA_PLAIN_${process.pid}`];

  /** ออก access token ให้ผู้ใช้ทดสอบ - ใช้ผู้ใช้ที่มีอยู่จริงเท่านั้น ไม่แตะรหัสผ่านใคร */
  const tokenFor = async (userId: string): Promise<string> => {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { tokenVersion: true } });
    return new SignJWT({ tokenVersion: user.tokenVersion })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(userId)
      .setIssuer('s2-nas')
      .setAudience('s2-nas-web')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(new TextEncoder().encode(env.JWT_ACCESS_SECRET));
  };

  before(async () => {
    app = await buildApp();
    await app.ready();
    const row = await prisma.user.create({
      data: { email: `${prefix}@example.invalid`, displayName: 'Settings Admin', status: 'ACTIVE' },
    });
    adminId = row.id;
    admin = {
      id: adminId, email: row.email, displayName: row.displayName, status: 'ACTIVE',
      mustChangePassword: false, roles: ['SUPER_ADMIN'],
      permissions: ['admin:access', 'system:settings:manage'],
    };

    /**
     * บทบาทเฉพาะของชุดทดสอบ ไม่แตะบทบาทจริงของระบบและไม่แตะผู้ใช้จริง
     * สิทธิ์ที่ผู้ใช้ได้รับถูกคำนวณจากบทบาทจริงในฐานข้อมูล จึงพิสูจน์ผลของการซิงก์ RBAC ได้
     */
    const managePermission = await prisma.permission.findUnique({ where: { code: 'system:settings:manage' } });
    assert.ok(managePermission, 'ต้องซิงก์สิทธิ์ system:settings:manage เข้าฐานข้อมูลก่อน (npm run rbac:sync)');
    const readPermission = await prisma.permission.findUniqueOrThrow({ where: { code: 'resources:read' } });

    const [manageRole, plainRole] = await Promise.all([
      prisma.role.create({ data: { code: roleCodes[0]!, name: 'QA settings manager' } }),
      prisma.role.create({ data: { code: roleCodes[1]!, name: 'QA plain user' } }),
    ]);
    await prisma.rolePermission.create({ data: { roleId: manageRole.id, permissionId: managePermission.id } });
    await prisma.rolePermission.create({ data: { roleId: plainRole.id, permissionId: readPermission.id } });

    const [manageUser, plainUser] = await Promise.all([
      prisma.user.create({ data: { email: `${prefix}-manager@example.invalid`, displayName: 'QA Manager', status: 'ACTIVE' } }),
      prisma.user.create({ data: { email: `${prefix}-plain@example.invalid`, displayName: 'QA Plain', status: 'ACTIVE' } }),
    ]);
    managerUserId = manageUser.id;
    plainUserId = plainUser.id;
    await prisma.userRole.create({ data: { userId: managerUserId, roleId: manageRole.id } });
    await prisma.userRole.create({ data: { userId: plainUserId, roleId: plainRole.id } });
  });

  after(async () => {
    await prisma.systemSetting.deleteMany({ where: { key: { in: [...SETTING_KEYS] } } });
    await prisma.activityLog.deleteMany({ where: { userId: { in: [adminId, managerUserId, plainUserId] } } });
    await prisma.userRole.deleteMany({ where: { userId: { in: [managerUserId, plainUserId] } } });
    await prisma.user.deleteMany({ where: { email: { startsWith: prefix } } });
    // ลบเฉพาะบทบาทที่ชุดทดสอบสร้างเอง ไม่แตะบทบาทจริงของระบบ
    const roles = await prisma.role.findMany({ where: { code: { in: roleCodes } }, select: { id: true } });
    await prisma.rolePermission.deleteMany({ where: { roleId: { in: roles.map((role) => role.id) } } });
    await prisma.role.deleteMany({ where: { code: { in: roleCodes } } });
    invalidateSettingsCache();
    await app.close();
  });

  beforeEach(async () => {
    await prisma.systemSetting.deleteMany({ where: { key: { in: [...SETTING_KEYS] } } });
    invalidateSettingsCache();
  });

  /* ---------------- การตัดสินค่า ---------------- */

  test('ไม่มีค่าที่ตั้งไว้ ต้องถอยไปใช้ค่าจาก environment', async () => {
    assert.equal(await getSetting('TRASH_RETENTION_DAYS'), env.S2_NAS_TRASH_RETENTION_DAYS);
    assert.equal(await getSetting('MAX_UPLOAD_SIZE_MB'), env.MAX_UPLOAD_SIZE_MB);
    assert.equal(await getSetting('ZIP_MAX_RESOURCES'), env.S2_NAS_ZIP_MAX_RESOURCES);
    assert.equal(await getSetting('ZIP_MAX_BYTES'), env.S2_NAS_ZIP_MAX_BYTES);

    const rows = await listSettings();
    for (const row of rows) {
      assert.notEqual(row.source, 'DATABASE', `${row.key} ต้องยังไม่ถูกตั้งค่าทับ`);
    }
  });

  test('ค่าที่บันทึกไว้มีผลเหนือ environment', async () => {
    await updateSettings(admin, { TRASH_RETENTION_DAYS: 30 });
    assert.equal(await getSetting('TRASH_RETENTION_DAYS'), 30);

    const row = (await listSettings()).find((item) => item.key === 'TRASH_RETENTION_DAYS');
    assert.equal(row?.source, 'DATABASE');
    // ค่าที่จะกลับไปใช้เมื่อรีเซ็ต ต้องยังเป็นค่าของ environment
    assert.equal(row?.defaultValue, env.S2_NAS_TRASH_RETENTION_DAYS);
  });

  test('ลบค่าที่ตั้งไว้แล้วกลับไปใช้ environment และไม่มีแถวค้างในฐานข้อมูล', async () => {
    await updateSettings(admin, { ZIP_MAX_RESOURCES: 42 });
    assert.equal(await getSetting('ZIP_MAX_RESOURCES'), 42);

    await resetSetting(admin, 'ZIP_MAX_RESOURCES');
    assert.equal(await getSetting('ZIP_MAX_RESOURCES'), env.S2_NAS_ZIP_MAX_RESOURCES);

    const stored = await prisma.systemSetting.findFirst({ where: { key: 'ZIP_MAX_RESOURCES' } });
    assert.equal(stored, null, 'ต้องลบแถวทิ้งจริง ไม่ใช่เขียนค่าจาก environment ทับลงไป');
  });

  test('รีเซ็ตค่าที่ไม่เคยถูกตั้งทับ ต้องบอกตรง ๆ ไม่ใช่เงียบ', async () => {
    await assert.rejects(
      () => resetSetting(admin, 'ZIP_MAX_BYTES'),
      (error: { code?: string }) => error.code === 'SETTING_NOT_OVERRIDDEN',
    );
  });

  /* ---------------- การตรวจค่า ---------------- */

  test('คีย์ที่ไม่รู้จักถูกปฏิเสธ ไม่ถูกเขียนลงฐานข้อมูล', async () => {
    for (const key of ['DATABASE_URL', 'JWT_ACCESS_SECRET', 'S2_NAS_STORAGE_ROOT', 'ANYTHING']) {
      await assert.rejects(
        () => updateSettings(admin, { [key]: 1 }),
        (error: { code?: string }) => error.code === 'SETTING_KEY_UNKNOWN',
        `${key} ต้องถูกปฏิเสธ`,
      );
    }
    assert.equal(await prisma.systemSetting.count(), 0);
  });

  test('ค่าที่ไม่ถูกต้องถูกปฏิเสธทุกแบบ', async () => {
    const invalid: Array<[string, unknown]> = [
      ['ติดลบ', -1],
      ['ศูนย์', 0],
      ['ทศนิยม', 1.5],
      ['สตริง', '30'],
      ['สตริงขยะ', 'abc'],
      ['NaN', Number.NaN],
      ['Infinity', Number.POSITIVE_INFINITY],
      ['เกินช่วงที่ปลอดภัย', Number.MAX_SAFE_INTEGER + 2],
      ['เกินเพดานที่กำหนด', 100_000],
      ['null', null],
    ];

    for (const [label, value] of invalid) {
      await assert.rejects(
        () => updateSettings(admin, { TRASH_RETENTION_DAYS: value }),
        (error: { code?: string }) => error.code === 'SETTING_VALUE_INVALID',
        `${label} ต้องถูกปฏิเสธ`,
      );
    }
    assert.equal(await prisma.systemSetting.count(), 0, 'ค่าที่ผิดต้องไม่ถูกเขียนลงฐานข้อมูล');
  });

  test('ค่าหนึ่งผิด ต้องไม่บันทึกค่าอื่นในชุดเดียวกัน', async () => {
    await assert.rejects(() => updateSettings(admin, { ZIP_MAX_RESOURCES: 50, TRASH_RETENTION_DAYS: -5 }));
    assert.equal(await prisma.systemSetting.count(), 0, 'ต้องไม่เหลือสถานะครึ่ง ๆ กลาง ๆ');
  });

  test('ค่าที่บันทึกไว้แต่ใช้ไม่ได้ ต้องถอยไปใช้ environment แทนที่จะทำระบบพัง', async () => {
    await prisma.systemSetting.create({ data: { key: 'TRASH_RETENTION_DAYS', value: 'ไม่ใช่ตัวเลข' } });
    invalidateSettingsCache();
    assert.equal(await getSetting('TRASH_RETENTION_DAYS'), env.S2_NAS_TRASH_RETENTION_DAYS);
  });

  /* ---------------- สิทธิ์ ---------------- */

  test('ผู้ที่ไม่ได้เข้าสู่ระบบเข้าถึงค่าตั้งค่าไม่ได้', async () => {
    for (const [method, url] of [['GET', '/api/admin/settings'], ['PATCH', '/api/admin/settings']] as const) {
      const response = await app.inject({ method, url, payload: method === 'PATCH' ? {} : undefined });
      assert.ok([401, 403].includes(response.statusCode), `${method} ${url} ต้องถูกปฏิเสธ`);
    }
  });

  test('เส้นทางเขียนค่าไม่เปิดให้ผู้ใช้ทั่วไป', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/admin/settings',
      headers: { authorization: 'Bearer not-a-real-token' },
      payload: { TRASH_RETENTION_DAYS: 1 },
    });
    assert.ok([401, 403].includes(response.statusCode));
    assert.equal(await prisma.systemSetting.count(), 0);
  });

  /**
   * ตารางสิทธิ์แบบ end-to-end ผ่านเส้นทาง HTTP จริง
   *
   * สิทธิ์ถูกคำนวณจากบทบาทของผู้ใช้ในฐานข้อมูล ไม่ใช่จาก object ที่เทสประกอบขึ้นเอง
   * จึงพิสูจน์ได้ว่าการซิงก์ RBAC มีผลจริง
   */
  test('401 เมื่อไม่ได้เข้าสู่ระบบ, 403 เมื่อไม่มีสิทธิ์, 200 เมื่อมีสิทธิ์', async () => {
    const anonymous = await app.inject({ method: 'GET', url: '/api/admin/settings' });
    assert.equal(anonymous.statusCode, 401, 'ผู้ที่ไม่ได้เข้าสู่ระบบต้องได้ 401');

    const denied = await app.inject({
      method: 'GET',
      url: '/api/admin/settings',
      headers: { authorization: `Bearer ${await tokenFor(plainUserId)}` },
    });
    assert.equal(denied.statusCode, 403, 'ผู้ใช้ที่ไม่มีสิทธิ์ต้องได้ 403 ไม่ใช่ 401');

    const allowed = await app.inject({
      method: 'GET',
      url: '/api/admin/settings',
      headers: { authorization: `Bearer ${await tokenFor(managerUserId)}` },
    });
    assert.equal(allowed.statusCode, 200, 'ผู้ที่มีสิทธิ์ต้องเข้าถึงได้');

    const rows = allowed.json().data as Array<{ key: string; source: string; value: unknown; defaultValue: unknown; hotReload: string }>;
    // ค่าการทำงานหลักต้องอยู่ครบเสมอ ส่วนรายการอาจยาวขึ้นเมื่อระบบมีค่าตั้งค่าใหม่
    for (const key of ['MAX_UPLOAD_SIZE_MB', 'TRASH_RETENTION_DAYS', 'ZIP_MAX_BYTES', 'ZIP_MAX_RESOURCES']) {
      assert.ok(rows.some((row) => row.key === key), `ต้องมีค่าตั้งค่า ${key}`);
    }
    for (const row of rows) {
      assert.ok(['DATABASE', 'ENVIRONMENT', 'DEFAULT'].includes(row.source));
      assert.ok(['number', 'boolean', 'string'].includes(typeof row.value));
      assert.equal(typeof row.defaultValue, typeof row.value);
      assert.ok(['FULL', 'LOWER_ONLY'].includes(row.hotReload));
    }
  });

  test('ผู้ใช้ที่ไม่มีสิทธิ์เขียนค่าไม่ได้ และไม่มีอะไรถูกบันทึก', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/admin/settings',
      headers: { authorization: `Bearer ${await tokenFor(plainUserId)}` },
      payload: { ZIP_MAX_RESOURCES: 3 },
    });
    assert.equal(response.statusCode, 403);
    assert.equal(await prisma.systemSetting.count(), 0);
  });

  /* ---------------- การใช้งานจริงของค่า ---------------- */

  test('เพดานขนาดอัปโหลดอ่านจากค่าที่มีผลจริง', async () => {
    await updateSettings(admin, { MAX_UPLOAD_SIZE_MB: 7 });
    assert.equal(await effectiveUploadBytes(), 7 * 1024 * 1024);

    await resetSetting(admin, 'MAX_UPLOAD_SIZE_MB');
    assert.equal(await effectiveUploadBytes(), env.MAX_UPLOAD_SIZE_MB * 1024 * 1024);
  });

  test('ขีดจำกัด ZIP อ่านจากค่าที่มีผลจริง', async () => {
    await updateSettings(admin, { ZIP_MAX_RESOURCES: 5, ZIP_MAX_BYTES: 1024 });
    assert.deepEqual(await effectiveZipLimits(), { maxResources: 5, maxBytes: 1024 });
  });

  test('งานเก็บกวาดถังขยะอ่านค่าที่มีผลจริงในแต่ละรอบ ไม่ใช่ตอนเริ่มระบบ', async () => {
    // 365 วัน = ไม่มีรายการใดหมดอายุ จึงไม่แตะข้อมูลจริงระหว่างทดสอบ
    await updateSettings(admin, { TRASH_RETENTION_DAYS: 365 });
    const result = await runTrashRetention();
    assert.equal(result.purged, 0);
    assert.equal(result.failed, 0);
  });

  test('แคชถูกล้างทันทีที่บันทึก ค่าถัดไปต้องไม่ค้างของเดิม', async () => {
    assert.equal(await getSetting('ZIP_MAX_RESOURCES'), env.S2_NAS_ZIP_MAX_RESOURCES);
    await updateSettings(admin, { ZIP_MAX_RESOURCES: 11 });
    assert.equal(await getSetting('ZIP_MAX_RESOURCES'), 11, 'ต้องไม่อ่านค่าค้างจากแคช');
    await updateSettings(admin, { ZIP_MAX_RESOURCES: 12 });
    assert.equal(await getSetting('ZIP_MAX_RESOURCES'), 12);
  });

  /* ---------------- audit ---------------- */

  test('บันทึก audit ของการแก้และการรีเซ็ต พร้อมค่าเดิมและค่าใหม่', async () => {
    await updateSettings(admin, { TRASH_RETENTION_DAYS: 20 });
    const updated = await prisma.activityLog.findFirst({
      where: { userId: adminId, action: 'SYSTEM_SETTING_UPDATED' },
      orderBy: { createdAt: 'desc' },
    });
    const updatedMeta = updated?.metadata as { key?: string; oldValue?: number; newValue?: number } | null;
    assert.equal(updatedMeta?.key, 'TRASH_RETENTION_DAYS');
    assert.equal(updatedMeta?.oldValue, env.S2_NAS_TRASH_RETENTION_DAYS);
    assert.equal(updatedMeta?.newValue, 20);

    await resetSetting(admin, 'TRASH_RETENTION_DAYS');
    const reset = await prisma.activityLog.findFirst({
      where: { userId: adminId, action: 'SYSTEM_SETTING_RESET' },
      orderBy: { createdAt: 'desc' },
    });
    const resetMeta = reset?.metadata as { key?: string; oldValue?: number } | null;
    assert.equal(resetMeta?.key, 'TRASH_RETENTION_DAYS');
    assert.equal(resetMeta?.oldValue, 20);
  });

  test('audit เก็บเฉพาะค่าการทำงาน ไม่มีความลับปนมา', async () => {
    await updateSettings(admin, { MAX_UPLOAD_SIZE_MB: 55 });
    const logs = await prisma.activityLog.findMany({ where: { userId: adminId } });
    const dump = JSON.stringify(logs);

    for (const secret of ['DATABASE_URL', 'JWT', 'password', 'secret', 'mysql://']) {
      assert.ok(!dump.toLowerCase().includes(secret.toLowerCase()), `audit ต้องไม่มี ${secret}`);
    }
  });

  /* ---------------- ขอบเขตของรายการที่แก้ได้ ---------------- */

  test('รายการที่แก้ได้มีเฉพาะค่าการทำงาน ไม่มีความลับหรือค่าระบุตัวตนของระบบ', async () => {
    const keys: string[] = [...SETTING_KEYS];
    for (const forbidden of [
      'DATABASE_URL', 'JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET',
      'S2_NAS_STORAGE_ROOT', 'BACKEND_PORT', 'CORS_ORIGIN', 'SEED_ADMIN_PASSWORD',
    ]) {
      assert.ok(!keys.includes(forbidden), `${forbidden} ต้องไม่อยู่ในรายการที่แก้ได้`);
    }
    // ไม่ผูกกับจำนวนที่แน่นอน - รายการโตได้ตามฟีเจอร์ สิ่งที่ต้องคงที่คือ "ไม่มีความลับอยู่ในนั้น"
    assert.ok(keys.length >= 4);
  });

  test('ทุกค่าที่เปิดให้แก้ต้องบอกได้ว่ามีผลทันทีหรือไม่', async () => {
    for (const row of await listSettings()) {
      assert.ok(['FULL', 'LOWER_ONLY'].includes(row.hotReload));
      // ค่าที่ไม่มีผลทันทีทั้งหมด ต้องมีคำอธิบายให้ผู้ดูแลอ่าน
      if (row.hotReload !== 'FULL') assert.ok(row.restartNote, `${row.key} ต้องอธิบายข้อจำกัด`);
    }
  });
});

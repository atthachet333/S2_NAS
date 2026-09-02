import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { after, before, describe, test } from 'node:test';
import bcrypt from 'bcryptjs';
import { prisma } from '../../core/prisma.js';
import { createFolder } from '../resources/resource.service.js';
import { uploadFile } from '../files/file.service.js';
import { bulkTransferOwnership } from '../workspace/handover.service.js';
import { grantAccess } from '../workspace/sharing.service.js';
import { checkPasswordStrength } from '../auth/password-policy.js';
import {
  activateUser,
  changeUserRoles,
  listUsers,
  resetTemporaryPassword,
  setUserStatus,
} from './user.service.js';
import type { AuthUser } from '../auth/auth.service.js';

const stream = (text: string) => Readable.from([Buffer.from(text)]);

/** รหัสทดสอบที่ผ่านนโยบายจริง ไม่ใช่รหัสของบัญชีจริงใด ๆ ในระบบ */
const STRONG = 'Qx7-marble-River-42';
const STRONG_ALT = 'Zk9-copper-Lantern-83';

describe('Phase F1 user management', () => {
  const prefix = `um-test-${process.pid}`;
  const audit = {};

  let invitedId = '';
  let ownerId = '';
  let successorId = '';
  let superAdminId = '';
  let otherSuperAdminId = '';

  let admin: AuthUser;
  let owner: AuthUser;

  let superAdminRoleId = '';
  let memberRoleId = '';

  const auth = (id: string, permissions: string[], roles: string[] = ['MEMBER']): AuthUser => ({
    id,
    email: `${id}@test.invalid`,
    displayName: id,
    status: 'ACTIVE',
    mustChangePassword: false,
    permissions,
    roles,
  });

  before(async () => {
    const [superAdminRole, memberRole] = await Promise.all([
      prisma.role.findUnique({ where: { code: 'SUPER_ADMIN' }, select: { id: true } }),
      prisma.role.findUnique({ where: { code: 'MEMBER' }, select: { id: true } }),
    ]);
    superAdminRoleId = superAdminRole!.id;
    memberRoleId = memberRole!.id;

    const users = await Promise.all([
      prisma.user.create({ data: { email: `${prefix}-invited@example.invalid`, displayName: 'Invited One', status: 'INVITED' } }),
      prisma.user.create({ data: { email: `${prefix}-owner@example.invalid`, displayName: 'Folder Owner', status: 'ACTIVE' } }),
      prisma.user.create({ data: { email: `${prefix}-successor@example.invalid`, displayName: 'Successor', status: 'ACTIVE' } }),
      prisma.user.create({
        data: {
          email: `${prefix}-super@example.invalid`,
          displayName: 'Super One',
          status: 'ACTIVE',
          roles: { create: [{ roleId: superAdminRole!.id }] },
        },
      }),
      prisma.user.create({
        data: {
          email: `${prefix}-super2@example.invalid`,
          displayName: 'Super Two',
          status: 'ACTIVE',
          roles: { create: [{ roleId: superAdminRole!.id }] },
        },
      }),
    ]);
    [invitedId, ownerId, successorId, superAdminId, otherSuperAdminId] = users.map((u) => u.id) as [
      string, string, string, string, string,
    ];

    admin = auth(successorId, ['users:read', 'users:manage', 'resources:owner:manage'], ['SUPER_ADMIN']);
    owner = auth(ownerId, ['resources:read', 'resources:write', 'resources:delete']);
  });

  after(async () => {
    const userIds = [invitedId, ownerId, successorId, superAdminId, otherSuperAdminId];
    const { deleteStoredFile, removeResourceDirectory } = await import('../../core/file-storage.js');
    const versions = await prisma.resourceVersion.findMany({
      where: { createdById: { in: userIds } },
      select: { storageKey: true, resourceId: true },
    });
    for (const version of versions) await deleteStoredFile(version.storageKey);
    for (const id of new Set(versions.map((v) => v.resourceId))) await removeResourceDirectory(id);

    await prisma.resourceAccess.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.resourceVersion.deleteMany({ where: { createdById: { in: userIds } } });
    await prisma.activityLog.deleteMany({ where: { userId: { in: userIds } } });
    const rows = await prisma.resource.findMany({ where: { createdById: { in: userIds } }, orderBy: { createdAt: 'desc' } });
    for (const row of rows) await prisma.resource.deleteMany({ where: { id: row.id } });
    await prisma.refreshToken.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.userRole.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { email: { startsWith: prefix } } });
  });

  /* ---------------- นโยบายรหัสผ่าน ---------------- */

  describe('นโยบายรหัสผ่าน', () => {
    test('รหัสสั้นเกินไปไม่ผ่าน', () => {
      assert.equal(checkPasswordStrength('Ab1-short').ok, false);
    });

    test('รหัสยาวแต่มีอักขระประเภทเดียวไม่ผ่าน', () => {
      assert.equal(checkPasswordStrength('abcdefghijklmnop').ok, false);
    });

    test('รหัสที่เดาง่ายไม่ผ่านแม้จะยาวพอ', () => {
      assert.equal(checkPasswordStrength('S2NAS-password-2568').ok, false);
      assert.equal(checkPasswordStrength('aaaaaaaaaaaaaaaa').ok, false);
    });

    test('รหัสที่แข็งแรงพอผ่าน', () => {
      assert.equal(checkPasswordStrength(STRONG).ok, true);
    });
  });

  /* ---------------- เปิดใช้งานบัญชี ---------------- */

  describe('เปิดใช้งานบัญชีที่ถูกเชิญ', () => {
    test('เปิดใช้งานแล้วต้องบังคับเปลี่ยนรหัสผ่านทันที', async () => {
      const user = await activateUser(invitedId, STRONG, admin, audit);
      assert.equal(user.status, 'ACTIVE');
      assert.equal(user.mustChangePassword, true, 'รหัสชั่วคราวต้องใช้ได้ครั้งเดียว');
    });

    test('เก็บเฉพาะ hash ในฐานข้อมูล ไม่เก็บรหัสจริง', async () => {
      const row = await prisma.user.findUnique({ where: { id: invitedId }, select: { passwordHash: true } });
      assert.ok(row?.passwordHash, 'ต้องมี hash');
      assert.notEqual(row!.passwordHash, STRONG, 'ห้ามเก็บรหัสตรง ๆ');
      assert.ok(await bcrypt.compare(STRONG, row!.passwordHash!), 'hash ต้องตรงกับรหัสที่ตั้ง');
    });

    test('ไม่คืนรหัสผ่านหรือ hash กลับไปกับผลลัพธ์', async () => {
      const user = await activateUser(
        (await prisma.user.create({ data: { email: `${prefix}-x@example.invalid`, displayName: 'X', status: 'INVITED' } })).id,
        STRONG_ALT,
        admin,
        audit,
      );
      const serialized = JSON.stringify(user);
      assert.ok(!serialized.includes(STRONG_ALT), 'ห้ามคืนรหัสผ่าน');
      assert.ok(!('passwordHash' in user), 'ห้ามคืน hash');
      await prisma.user.deleteMany({ where: { email: `${prefix}-x@example.invalid` } });
    });

    test('รหัสชั่วคราวที่อ่อนเกินไปถูกปฏิเสธ', async () => {
      const weak = await prisma.user.create({
        data: { email: `${prefix}-weak@example.invalid`, displayName: 'Weak', status: 'INVITED' },
      });
      await assert.rejects(
        activateUser(weak.id, 'short', admin, audit),
        (error: unknown) => (error as { code?: string }).code === 'WEAK_PASSWORD',
      );
      const row = await prisma.user.findUnique({ where: { id: weak.id }, select: { status: true } });
      assert.equal(row?.status, 'INVITED', 'ต้องไม่เปิดใช้งานเมื่อรหัสไม่ผ่าน');
      await prisma.user.delete({ where: { id: weak.id } });
    });

    test('เปิดใช้งานบัญชีที่เปิดอยู่แล้วถูกปฏิเสธ', async () => {
      await assert.rejects(
        activateUser(invitedId, STRONG_ALT, admin, audit),
        (error: unknown) => (error as { code?: string }).code === 'USER_ALREADY_ACTIVE',
      );
    });

    test('บันทึกเหตุการณ์ USER_ACTIVATED โดยไม่มีรหัสผ่านใน metadata', async () => {
      const log = await prisma.activityLog.findFirst({
        where: { action: 'USER_ACTIVATED', userId: admin.id },
        orderBy: { createdAt: 'desc' },
      });
      assert.ok(log, 'ต้องมีบันทึกการเปิดใช้งาน');
      const raw = JSON.stringify(log!.metadata);
      assert.ok(!raw.includes(STRONG) && !raw.includes('$2'), 'ห้ามบันทึกรหัสผ่านหรือ hash');
    });
  });

  /* ---------------- ผู้ใช้ที่ยังไม่เปิดใช้งานกับการแชร์ ---------------- */

  describe('การแชร์กับสถานะบัญชี', () => {
    test('แชร์ให้บัญชีที่ยังไม่เปิดใช้งานไม่ได้ แต่เปิดใช้งานแล้วทำได้', async () => {
      const pending = await prisma.user.create({
        data: { email: `${prefix}-pending@example.invalid`, displayName: 'Pending', status: 'INVITED' },
      });
      const folder = await createFolder(owner, { name: `${prefix} Share Target` }, audit);

      await assert.rejects(
        grantAccess(folder.id, { userId: pending.id, accessLevel: 'VIEWER', allowDownload: true }, owner, audit),
        (error: unknown) => (error as { code?: string }).code === 'SHARE_TARGET_INACTIVE',
      );

      await activateUser(pending.id, STRONG_ALT, admin, audit);
      const result = await grantAccess(
        folder.id,
        { userId: pending.id, accessLevel: 'VIEWER', allowDownload: true },
        owner,
        audit,
      );
      assert.ok(result.grants.some((grant) => grant.userId === pending.id));

      await prisma.resourceAccess.deleteMany({ where: { userId: pending.id } });
      await prisma.activityLog.deleteMany({ where: { userId: pending.id } });
      await prisma.user.delete({ where: { id: pending.id } });
    });
  });

  /* ---------------- บทบาท ---------------- */

  describe('การเปลี่ยนบทบาท', () => {
    test('เปลี่ยนบทบาทได้เฉพาะบทบาทที่มีอยู่จริง', async () => {
      const user = await changeUserRoles(invitedId, ['MEMBER'], admin, audit);
      assert.deepEqual(user.roles.map((link) => link.role.code), ['MEMBER']);

      await assert.rejects(
        changeUserRoles(invitedId, ['ROLE_THAT_DOES_NOT_EXIST'], admin, audit),
        (error: unknown) => (error as { code?: string }).code === 'ROLE_NOT_FOUND',
      );
    });

    test('เปลี่ยนบทบาทแล้วต้องตัด session เดิม เพราะสิทธิ์ใน token ไม่ตรงแล้ว', async () => {
      const before = await prisma.user.findUnique({ where: { id: invitedId }, select: { tokenVersion: true } });
      await changeUserRoles(invitedId, ['VIEWER'], admin, audit);
      const after = await prisma.user.findUnique({ where: { id: invitedId }, select: { tokenVersion: true } });
      assert.ok(after!.tokenVersion > before!.tokenVersion, 'tokenVersion ต้องเพิ่ม');
    });

    test('บันทึกเหตุการณ์ USER_ROLE_CHANGED', async () => {
      const log = await prisma.activityLog.findFirst({
        where: { action: 'USER_ROLE_CHANGED', userId: admin.id },
        orderBy: { createdAt: 'desc' },
      });
      assert.ok(log);
      assert.equal((log!.metadata as { targetUserId?: string }).targetUserId, invitedId);
    });
  });

  /* ---------------- ผู้ดูแลสูงสุดคนสุดท้าย ---------------- */

  describe('ป้องกันผู้ดูแลสูงสุดคนสุดท้าย', () => {
    test('ถอดบทบาท SUPER_ADMIN ออกได้ ตราบใดที่ยังเหลืออีกคน', async () => {
      const user = await changeUserRoles(otherSuperAdminId, ['MEMBER'], admin, audit);
      assert.deepEqual(user.roles.map((link) => link.role.code), ['MEMBER']);
    });

    test('ถอดบทบาทของผู้ดูแลสูงสุดคนสุดท้ายไม่ได้', async () => {
      // ให้เหลือ SUPER_ADMIN ที่ ACTIVE เพียงคนเดียวในระบบทั้งหมด
      const others = await prisma.user.findMany({
        where: {
          id: { not: superAdminId },
          status: 'ACTIVE',
          roles: { some: { role: { code: 'SUPER_ADMIN' } } },
        },
        select: { id: true },
      });
      const parked = others.map((row) => row.id);
      await prisma.userRole.deleteMany({ where: { userId: { in: parked }, roleId: superAdminRoleId } });

      await assert.rejects(
        changeUserRoles(superAdminId, ['MEMBER'], admin, audit),
        (error: unknown) => (error as { code?: string }).code === 'LAST_SUPER_ADMIN',
      );

      await assert.rejects(
        setUserStatus(superAdminId, 'DISABLED', {}, admin, audit),
        (error: unknown) => (error as { code?: string }).code === 'LAST_SUPER_ADMIN',
      );

      // ยังต้องถือบทบาทเดิมอยู่ครบ
      const still = await prisma.userRole.count({ where: { userId: superAdminId, roleId: superAdminRoleId } });
      assert.equal(still, 1);

      // คืนบทบาทให้ผู้ใช้เดิมทุกคน เพื่อไม่ให้กระทบข้อมูลจริง
      for (const id of parked) {
        await prisma.userRole.create({ data: { userId: id, roleId: superAdminRoleId } });
      }
    });

    test('ปิดบัญชีตัวเองไม่ได้', async () => {
      await assert.rejects(
        setUserStatus(admin.id, 'DISABLED', {}, admin, audit),
        (error: unknown) => (error as { code?: string }).code === 'CANNOT_DISABLE_SELF',
      );
    });
  });

  /* ---------------- ปิดบัญชีกับความรับผิดชอบ ---------------- */

  describe('ปิดบัญชีที่ยังดูแลทรัพยากร', () => {
    test('ปิดไม่ได้ถ้ายังถือทรัพยากรและยังไม่ยืนยัน', async () => {
      const folder = await createFolder(owner, { name: `${prefix} Owned Folder` }, audit);
      await uploadFile(owner, stream('body'), { parentId: folder.id, fileName: `${prefix}-doc.pdf` }, audit);

      await assert.rejects(setUserStatus(ownerId, 'DISABLED', {}, admin, audit), (error: unknown) => {
        const failure = error as { code?: string; details?: { ownedTotal?: number } };
        return failure.code === 'USER_STILL_OWNS_RESOURCES' && (failure.details?.ownedTotal ?? 0) >= 2;
      });

      const row = await prisma.user.findUnique({ where: { id: ownerId }, select: { status: true } });
      assert.equal(row?.status, 'ACTIVE', 'ต้องไม่ถูกปิดเมื่อยังมีของค้าง');
    });

    test('ยืนยันรับทราบแล้วปิดได้ แม้ยังถือทรัพยากรอยู่', async () => {
      const user = await setUserStatus(ownerId, 'DISABLED', { acknowledgeHandover: true }, admin, audit);
      assert.equal(user.status, 'DISABLED');
      await setUserStatus(ownerId, 'ACTIVE', {}, admin, audit);
    });

    test('ส่งมอบความรับผิดชอบแล้วปิดได้โดยไม่ต้องยืนยัน', async () => {
      await bulkTransferOwnership(ownerId, successorId, admin, audit);
      const user = await setUserStatus(ownerId, 'DISABLED', {}, admin, audit);
      assert.equal(user.status, 'DISABLED');
    });

    test('ปิดบัญชีแล้วต้องตัด session และบันทึก USER_DISABLED', async () => {
      const row = await prisma.user.findUnique({ where: { id: ownerId }, select: { tokenVersion: true } });
      assert.ok(row!.tokenVersion > 0, 'tokenVersion ต้องถูกเพิ่มเพื่อยกเลิก token เดิม');

      const active = await prisma.refreshToken.count({ where: { userId: ownerId, revokedAt: null } });
      assert.equal(active, 0, 'ต้องไม่เหลือ refresh token ที่ยังใช้ได้');

      const log = await prisma.activityLog.findFirst({
        where: { action: 'USER_DISABLED', userId: admin.id },
        orderBy: { createdAt: 'desc' },
      });
      assert.ok(log, 'ต้องมีบันทึกการปิดบัญชี');
    });
  });

  /* ---------------- ตั้งรหัสผ่านชั่วคราวใหม่ ---------------- */

  describe('ตั้งรหัสผ่านชั่วคราวใหม่', () => {
    test('รีเซ็ตแล้วบังคับเปลี่ยนรหัส ตัด session และเปลี่ยน hash', async () => {
      const before = await prisma.user.findUnique({
        where: { id: invitedId },
        select: { passwordHash: true, tokenVersion: true },
      });

      const user = await resetTemporaryPassword(invitedId, STRONG_ALT, admin, audit);
      assert.equal(user.mustChangePassword, true);

      const after = await prisma.user.findUnique({
        where: { id: invitedId },
        select: { passwordHash: true, tokenVersion: true },
      });
      assert.notEqual(after!.passwordHash, before!.passwordHash, 'hash ต้องเปลี่ยน');
      assert.ok(after!.tokenVersion > before!.tokenVersion, 'ต้องตัด session เดิม');
      assert.ok(await bcrypt.compare(STRONG_ALT, after!.passwordHash!));
      assert.equal(await bcrypt.compare(STRONG, after!.passwordHash!), false, 'รหัสเดิมต้องใช้ไม่ได้อีก');
    });

    test('บันทึกเหตุการณ์ USER_TEMP_PASSWORD_RESET โดยไม่มีรหัสผ่าน', async () => {
      const log = await prisma.activityLog.findFirst({
        where: { action: 'USER_TEMP_PASSWORD_RESET', userId: admin.id },
        orderBy: { createdAt: 'desc' },
      });
      assert.ok(log);
      const raw = JSON.stringify(log!.metadata);
      assert.ok(!raw.includes(STRONG_ALT) && !raw.includes('$2'), 'ห้ามบันทึกรหัสผ่านหรือ hash');
    });
  });

  /* ---------------- รายชื่อและตัวกรอง ---------------- */

  describe('รายชื่อผู้ใช้', () => {
    test('กรองตามสถานะและค้นหาจากชื่อหรืออีเมลได้', async () => {
      const byStatus = await listUsers({ status: 'DISABLED', limit: 100 });
      assert.ok(byStatus.items.every((user) => user.status === 'DISABLED'));

      const byName = await listUsers({ q: 'Folder Owner', limit: 100 });
      assert.ok(byName.items.some((user) => user.id === ownerId));

      const byEmail = await listUsers({ q: `${prefix}-successor`, limit: 100 });
      assert.deepEqual(byEmail.items.map((user) => user.id), [successorId]);
    });

    test('กรองตามบทบาทได้', async () => {
      const superAdmins = await listUsers({ roleCode: 'SUPER_ADMIN', limit: 100 });
      assert.ok(superAdmins.items.some((user) => user.id === superAdminId));
      assert.ok(superAdmins.items.every((user) => user.roles.some((link) => link.role.code === 'SUPER_ADMIN')));
    });

    test('แบ่งหน้าด้วย cursor ไม่ซ้ำรายการ', async () => {
      const first = await listUsers({ limit: 1 });
      assert.equal(first.items.length, 1);
      assert.ok(first.nextCursor);
      const second = await listUsers({ limit: 1, cursor: first.nextCursor! });
      assert.notEqual(second.items[0]?.id, first.items[0]?.id);
      assert.ok(first.total > 1);
    });

    test('รายชื่อไม่เปิดเผย hash รหัสผ่าน', async () => {
      const result = await listUsers({ limit: 100 });
      assert.ok(!JSON.stringify(result.items).includes('passwordHash'));
      assert.ok(result.items.every((user) => !('passwordHash' in user)));
    });

    test('บทบาทที่คืนมามีรหัสจริงจากฐานข้อมูล', async () => {
      const result = await listUsers({ q: `${prefix}-super@`, limit: 10 });
      const found = result.items[0];
      assert.ok(found?.roles.some((link) => link.role.id === superAdminRoleId));
      assert.notEqual(memberRoleId, '');
    });
  });
});

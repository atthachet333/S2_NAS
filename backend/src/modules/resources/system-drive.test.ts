import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { prisma } from '../../core/prisma.js';
import type { AuthUser } from '../auth/auth.service.js';
import { createFolder, getResource, listResources, moveResource, updateResource } from './resource.service.js';
import { siblingKey } from './sibling-key.js';
import { canCreateInSystemDrive, canViewSystemDrive } from './system-drive.js';

/**
 * ไดร์ฟของระบบเป็นไดร์ฟกลางขององค์กร: ทุกคนอ่านได้ แต่เขียนไม่ได้โดยปริยาย
 * ชุดทดสอบนี้ยืนยันว่าด่านสิทธิ์อยู่ที่ backend จริง ไม่ใช่แค่ซ่อนปุ่มบนหน้าจอ
 */
describe('ไดร์ฟของระบบ', () => {
  const prefix = `sysdrive-test-${process.pid}`;
  const audit = {};
  const auth = (id: string, permissions: string[], roles: string[] = ['MEMBER']): AuthUser => ({
    id, email: `${id}@test.invalid`, displayName: id, status: 'ACTIVE', mustChangePassword: false, permissions, roles,
  });

  /** ผู้ใช้ทั่วไปที่ถือ permission กว้าง ๆ ครบ - ในไดร์ฟของฉันทำได้ แต่ในไดร์ฟของระบบต้องทำไม่ได้ */
  const WIDE = ['resources:read', 'resources:write', 'resources:delete', 'resources:share', 'resources:lock', 'resources:owner:manage'];

  let adminId = '';
  let memberId = '';
  let admin: AuthUser;
  let member: AuthUser;
  let systemFolderId = '';
  let myFolderId = '';

  before(async () => {
    const users = await Promise.all([
      prisma.user.create({ data: { email: `${prefix}-admin@example.invalid`, displayName: 'Admin', status: 'ACTIVE' } }),
      prisma.user.create({ data: { email: `${prefix}-member@example.invalid`, displayName: 'Member', status: 'ACTIVE' } }),
    ]);
    adminId = users[0]!.id;
    memberId = users[1]!.id;
    admin = auth(adminId, [...WIDE, 'admin:access'], ['SUPER_ADMIN']);
    member = auth(memberId, WIDE);
  });

  after(async () => {
    await prisma.activityLog.deleteMany({ where: { userId: { in: [adminId, memberId] } } });
    const rows = await prisma.resource.findMany({ where: { createdById: { in: [adminId, memberId] } }, orderBy: { createdAt: 'desc' } });
    for (const row of rows) await prisma.resource.delete({ where: { id: row.id } });
    await prisma.user.deleteMany({ where: { email: { startsWith: prefix } } });
  });

  test('ผู้ใช้ภายในที่อ่านทรัพยากรได้ ย่อมเห็นไดร์ฟของระบบ แต่ไม่ได้แปลว่าสร้างได้', () => {
    assert.equal(canViewSystemDrive(member), true);
    assert.equal(canCreateInSystemDrive(member), false);
    assert.equal(canCreateInSystemDrive(admin), true);
  });

  test('ผู้ใช้ทั่วไปสร้างที่รากไดร์ฟของระบบไม่ได้ แม้มีสิทธิ์เขียน', async () => {
    await assert.rejects(
      () => createFolder(member, { name: 'คู่มือบริษัท', driveScope: 'SYSTEM_DRIVE' }, audit),
      (error: { code?: string }) => error.code === 'SYSTEM_DRIVE_WRITE_DENIED',
    );
  });

  test('ผู้ดูแลระบบสร้างที่รากไดร์ฟของระบบได้', async () => {
    const folder = await createFolder(admin, { name: 'คู่มือบริษัท', driveScope: 'SYSTEM_DRIVE' }, audit);
    systemFolderId = folder.id;
    assert.equal(folder.driveScope, 'SYSTEM_DRIVE');
  });

  test('ชื่อเดียวกันที่รากของสองไดร์ฟอยู่ร่วมกันได้', async () => {
    const folder = await createFolder(member, { name: 'คู่มือบริษัท' }, audit);
    myFolderId = folder.id;
    assert.equal(folder.driveScope, 'MY_DRIVE');
    assert.notEqual(
      siblingKey(null, 'คู่มือบริษัท', 'MY_DRIVE'),
      siblingKey(null, 'คู่มือบริษัท', 'SYSTEM_DRIVE'),
    );
  });

  test('ผู้ใช้ทั่วไปเห็นและเปิดดูได้ แต่แก้ไข/แชร์/ล็อก/โอนเจ้าของไม่ได้', async () => {
    const dto = await getResource(systemFolderId, member);
    assert.equal(dto.capabilities.canView, true);
    assert.equal(dto.capabilities.canEdit, false);
    assert.equal(dto.capabilities.canRename, false);
    assert.equal(dto.capabilities.canMove, false);
    assert.equal(dto.capabilities.canDelete, false);
    assert.equal(dto.capabilities.canShare, false);
    assert.equal(dto.capabilities.canLock, false);
    assert.equal(dto.capabilities.canTransferOwner, false);
  });

  test('permission กว้าง ๆ ชุดเดียวกันยังใช้ได้ตามปกติในไดร์ฟของฉัน', async () => {
    const dto = await getResource(myFolderId, member);
    assert.equal(dto.capabilities.canEdit, true);
    assert.equal(dto.capabilities.canShare, true);
    assert.equal(dto.capabilities.canLock, true);
  });

  test('การเปลี่ยนชื่อในไดร์ฟของระบบถูกปฏิเสธที่ backend', async () => {
    await assert.rejects(
      () => updateResource(systemFolderId, member, { name: 'คู่มือใหม่' }, audit),
      (error: { code?: string }) => error.code === 'RESOURCE_ACCESS_DENIED',
    );
  });

  test('ย้ายข้ามไดร์ฟสงวนไว้ให้ผู้ดูแลระบบ', async () => {
    await assert.rejects(
      () => moveResource(myFolderId, member, null, audit, 'SYSTEM_DRIVE'),
      (error: { code?: string }) => error.code === 'CROSS_DRIVE_MOVE_DENIED',
    );
  });

  test('รายการที่รากแยกตามไดร์ฟ ไม่ปนกัน', async () => {
    const listing = await listResources(member, { parentId: null, sort: 'name', direction: 'asc', limit: 50, driveScope: 'SYSTEM_DRIVE' });
    const ids = listing.items.map((item) => item.id);
    assert.ok(ids.includes(systemFolderId));
    assert.ok(!ids.includes(myFolderId));

    const mine = await listResources(member, { parentId: null, sort: 'name', direction: 'asc', limit: 50 });
    assert.ok(mine.items.map((item) => item.id).includes(myFolderId));
    assert.ok(!mine.items.map((item) => item.id).includes(systemFolderId));
  });
});

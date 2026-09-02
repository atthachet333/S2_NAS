import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { prisma } from '../../core/prisma.js';
import type { AuthUser } from '../auth/auth.service.js';
import { breadcrumb, createFolder, getResource, listResources, moveResource, softDeleteResource, transferOwner, updateResource } from './resource.service.js';

describe('Phase C resource domain', () => {
  const prefix = `resource-test-${process.pid}`;
  let ownerId = '';
  let secondId = '';
  let inactiveId = '';
  let rootId = '';
  let childId = '';
  const audit = {};
  const auth = (id: string, permissions: string[], roles: string[] = ['MEMBER']): AuthUser => ({ id, email: `${id}@test.invalid`, displayName: id, status: 'ACTIVE', mustChangePassword: false, permissions, roles });
  let owner: AuthUser;
  let admin: AuthUser;
  let viewer: AuthUser;

  before(async () => {
    const users = await Promise.all([
      prisma.user.create({ data: { email: `${prefix}-owner@example.invalid`, displayName: 'Owner', status: 'ACTIVE' } }),
      prisma.user.create({ data: { email: `${prefix}-second@example.invalid`, displayName: 'Second', status: 'ACTIVE' } }),
      prisma.user.create({ data: { email: `${prefix}-inactive@example.invalid`, displayName: 'Inactive', status: 'DISABLED' } }),
    ]);
    ownerId = users[0]!.id; secondId = users[1]!.id; inactiveId = users[2]!.id;
    owner = auth(ownerId, ['resources:read','resources:write','resources:delete']);
    admin = auth(secondId, ['resources:read','resources:write','resources:delete','resources:owner:manage','admin:access'], ['SUPER_ADMIN']);
    viewer = auth(secondId, ['resources:read'], ['VIEWER']);
  });

  after(async () => {
    await prisma.resourceAccess.deleteMany({ where: { resource: { createdBy: { email: { startsWith: prefix } } } } });
    await prisma.activityLog.deleteMany({ where: { userId: { in: [ownerId, secondId, inactiveId] } } });
    const rows = await prisma.resource.findMany({ where: { createdById: { in: [ownerId, secondId, inactiveId] } }, orderBy: { createdAt: 'desc' } });
    for (const row of rows) await prisma.resource.delete({ where: { id: row.id } });
    await prisma.user.deleteMany({ where: { email: { startsWith: prefix } } });
  });

  test('Create root folder และ owner เป็น current user', async () => {
    const folder = await createFolder(owner, { name: 'ทดสอบ S2 NAS' }, audit);
    rootId = folder.id;
    assert.equal(folder.type, 'FOLDER'); assert.equal(folder.owner.id, ownerId);
  });

  test('Create nested folder และรองรับชื่อภาษาไทย', async () => {
    const folder = await createFolder(owner, { name: 'เอกสาร ภาษี', parentId: rootId }, audit);
    childId = folder.id; assert.equal(folder.parentId, rootId); assert.equal(folder.name, 'เอกสาร ภาษี');
  });

  test('Admin assign owner ได้', async () => {
    const folder = await createFolder(admin, { name: 'Admin Assigned', ownerId }, audit);
    assert.equal(folder.owner.id, ownerId);
  });

  test('Viewer สร้างโฟลเดอร์ไม่ได้', async () => {
    await assert.rejects(() => createFolder(viewer, { name: 'Denied' }, audit), (error: { statusCode?: number }) => error.statusCode === 403);
  });

  test('Duplicate sibling folder ถูกบล็อกแบบ case-insensitive', async () => {
    await createFolder(owner, { name: 'บัญชี', parentId: rootId }, audit);
    await assert.rejects(() => createFolder(owner, { name: 'บัญชี', parentId: rootId }, audit), (error: { code?: string }) => error.code === 'FOLDER_NAME_EXISTS');
  });

  test('Rename success', async () => {
    const updated = await updateResource(childId, owner, { name: 'เอกสารสำคัญ' }, audit);
    assert.equal(updated.name, 'เอกสารสำคัญ');
  });

  test('Rename duplicate blocked', async () => {
    await assert.rejects(() => updateResource(childId, owner, { name: 'บัญชี' }, audit), (error: { code?: string }) => error.code === 'FOLDER_NAME_EXISTS');
  });

  test('Move success', async () => {
    const destination = await createFolder(owner, { name: 'ปลายทาง' }, audit);
    const moved = await moveResource(childId, owner, destination.id, audit);
    assert.equal(moved.parentId, destination.id);
    await moveResource(childId, owner, rootId, audit);
  });

  test('Move into itself blocked', async () => {
    await assert.rejects(() => moveResource(rootId, owner, rootId, audit), (error: { code?: string }) => error.code === 'INVALID_MOVE');
  });

  test('Move parent into descendant blocked', async () => {
    await assert.rejects(() => moveResource(rootId, owner, childId, audit), (error: { code?: string }) => error.code === 'INVALID_MOVE');
  });

  test('Transfer owner success', async () => {
    const transferred = await transferOwner(childId, owner, secondId, audit);
    assert.equal(transferred.owner.id, secondId);
    await transferOwner(childId, admin, ownerId, audit);
  });

  test('Unauthorized ownership transfer blocked', async () => {
    await assert.rejects(() => transferOwner(rootId, viewer, secondId, audit), (error: { code?: string }) => error.code === 'OWNER_TRANSFER_DENIED');
  });

  test('Inactive owner rejected', async () => {
    await assert.rejects(() => transferOwner(rootId, owner, inactiveId, audit), (error: { code?: string }) => error.code === 'OWNER_NOT_FOUND');
  });

  test('Resource list respects read permission', async () => {
    const page = await listResources(viewer, { parentId: null, sort: 'name', direction: 'asc', limit: 50 });
    assert.ok(page.items.some((item) => item.id === rootId));
    await assert.rejects(() => listResources(auth(secondId, []), { parentId: null, sort: 'name', direction: 'asc', limit: 50 }), (error: { statusCode?: number }) => error.statusCode === 403);
  });

  test('RESTRICTED metadata is hidden from unrelated viewers and inherited by child folders', async () => {
    await prisma.resource.update({ where: { id: rootId }, data: { visibility: 'RESTRICTED' } });
    const restrictedChild = await createFolder(owner, { name: 'Restricted Child', parentId: rootId }, audit);
    assert.equal(restrictedChild.visibility, 'RESTRICTED');
    await assert.rejects(
      getResource(rootId, viewer),
      (error: unknown) => (error as { code?: string }).code === 'RESOURCE_ACCESS_DENIED',
    );
    const listing = await listResources(viewer, { parentId: null, sort: 'name', direction: 'asc', limit: 100 });
    assert.ok(!listing.items.some((item) => item.id === rootId));
    await prisma.resource.updateMany({ where: { id: { in: [rootId, restrictedChild.id] } }, data: { visibility: 'ORGANIZATION' } });
  });

  test('Breadcrumb correct', async () => {
    const nodes = await breadcrumb(childId, viewer);
    assert.deepEqual(nodes.map((node) => node.id), [rootId, childId]);
  });

  test('Deleted resources excluded และลบได้เฉพาะโฟลเดอร์ว่าง', async () => {
    const empty = await createFolder(owner, { name: 'ลบฉัน' }, audit);
    await softDeleteResource(empty.id, owner, audit);
    const page = await listResources(owner, { parentId: null, sort: 'name', direction: 'asc', limit: 100 });
    assert.equal(page.items.some((item) => item.id === empty.id), false);
    await assert.rejects(() => softDeleteResource(rootId, owner, audit), (error: { code?: string }) => error.code === 'FOLDER_NOT_EMPTY');
  });

  test('Physical path และ storageKey ไม่ถูกเปิดเผย', async () => {
    const dto = await getResource(rootId, owner) as unknown as Record<string, unknown>;
    assert.equal('storageKey' in dto, false); assert.equal('physicalPath' in dto, false);
  });
});

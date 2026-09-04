import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { after, before, describe, test } from 'node:test';
import { prisma } from '../../core/prisma.js';
import type { AuthUser } from '../auth/auth.service.js';
import { createExternalResource, createFolder, getResource } from './resource.service.js';
import { uploadFile } from '../files/file.service.js';

/**
 * ปลายทางของการสร้างทรัพยากรในไดร์ฟของระบบ
 *
 * สิ่งที่ต้องพิสูจน์: ทุกชนิดของทรัพยากรที่สร้างจากไดร์ฟของระบบต้องอยู่ในไดร์ฟของระบบจริง
 * และไคลเอนต์ต้องปลอมไดร์ฟเพื่อหนีนโยบายไม่ได้
 */
describe('การสร้างทรัพยากรในไดร์ฟของระบบ', () => {
  const prefix = `sd-create-${process.pid}`;
  const audit = {};
  const auth = (id: string, permissions: string[], roles: string[] = ['MEMBER']): AuthUser => ({
    id, email: `${id}@test.invalid`, displayName: id, status: 'ACTIVE', mustChangePassword: false, permissions, roles,
  });

  let adminId = '';
  let memberId = '';
  let admin: AuthUser;
  let member: AuthUser;
  let systemFolderId = '';
  const created: string[] = [];

  before(async () => {
    const rows = await Promise.all([
      prisma.user.create({ data: { email: `${prefix}-admin@example.invalid`, displayName: 'Admin', status: 'ACTIVE' } }),
      prisma.user.create({ data: { email: `${prefix}-member@example.invalid`, displayName: 'Member', status: 'ACTIVE' } }),
    ]);
    adminId = rows[0]!.id;
    memberId = rows[1]!.id;
    admin = auth(adminId, ['resources:read', 'resources:write', 'resources:delete', 'admin:access'], ['SUPER_ADMIN']);
    member = auth(memberId, ['resources:read', 'resources:write', 'resources:delete']);
  });

  after(async () => {
    await prisma.resourceVersion.deleteMany({ where: { resourceId: { in: created } } });
    await prisma.activityLog.deleteMany({ where: { userId: { in: [adminId, memberId] } } });
    for (const id of [...created].reverse()) await prisma.resource.deleteMany({ where: { id } });
    await prisma.user.deleteMany({ where: { email: { startsWith: prefix } } });
  });

  const track = <T extends { id: string }>(row: T): T => {
    created.push(row.id);
    return row;
  };

  /* ---------------- โฟลเดอร์ ---------------- */

  test('สร้างโฟลเดอร์ที่รากไดร์ฟของระบบ ได้ SYSTEM_DRIVE', async () => {
    const folder = track(await createFolder(admin, { name: `${prefix}-root`, driveScope: 'SYSTEM_DRIVE' }, audit));
    assert.equal(folder.driveScope, 'SYSTEM_DRIVE');
    systemFolderId = folder.id;
  });

  test('โฟลเดอร์ย่อยสืบทอดไดร์ฟจากโฟลเดอร์แม่', async () => {
    const child = track(await createFolder(admin, { name: `${prefix}-child`, parentId: systemFolderId }, audit));
    assert.equal(child.driveScope, 'SYSTEM_DRIVE');
  });

  test('ไคลเอนต์ปลอม driveScope ในโฟลเดอร์ของไดร์ฟของระบบไม่ได้', async () => {
    // ส่ง MY_DRIVE มาทั้งที่แม่อยู่ในไดร์ฟของระบบ - โฟลเดอร์แม่ต้องชนะเสมอ
    const child = track(
      await createFolder(admin, { name: `${prefix}-spoof`, parentId: systemFolderId, driveScope: 'MY_DRIVE' }, audit),
    );
    assert.equal(child.driveScope, 'SYSTEM_DRIVE', 'โฟลเดอร์แม่เป็นผู้กำหนดไดร์ฟ ไม่ใช่ไคลเอนต์');
  });

  /* ---------------- ทรัพยากรภายนอก ---------------- */

  test('ทรัพยากรภายนอกทุกชนิดสร้างที่รากไดร์ฟของระบบได้', async () => {
    const cases = [
      ['GOOGLE_SHEET', 'https://docs.google.com/spreadsheets/d/abc/edit'],
      ['GOOGLE_DOC', 'https://docs.google.com/document/d/abc/edit'],
      ['GOOGLE_DRIVE', 'https://drive.google.com/drive/folders/abc'],
      ['WEB_LINK', 'https://example.test/handbook'],
    ] as const;

    for (const [type, url] of cases) {
      const row = track(
        await createExternalResource(admin, { type, name: `${prefix}-${type}`, url, driveScope: 'SYSTEM_DRIVE' }, audit),
      );
      assert.equal(row.driveScope, 'SYSTEM_DRIVE', `${type} ต้องอยู่ในไดร์ฟของระบบ`);
      assert.equal(row.type, type);
    }
  });

  test('ทรัพยากรภายนอกในโฟลเดอร์สืบทอดไดร์ฟจากแม่ และปลอมไม่ได้', async () => {
    const row = track(
      await createExternalResource(
        admin,
        {
          type: 'WEB_LINK', name: `${prefix}-nested-link`, url: 'https://example.test/nested',
          parentId: systemFolderId, driveScope: 'MY_DRIVE',
        },
        audit,
      ),
    );
    assert.equal(row.driveScope, 'SYSTEM_DRIVE');
  });

  /* ---------------- อัปโหลดไฟล์ ---------------- */

  test('อัปโหลดไฟล์ที่รากไดร์ฟของระบบ ได้ SYSTEM_DRIVE', async () => {
    const result = await uploadFile(
      admin,
      Readable.from([Buffer.from('system drive root file')]),
      { parentId: null, driveScope: 'SYSTEM_DRIVE', fileName: `${prefix}-root.txt`, declaredMime: 'text/plain' },
      audit,
    );
    track(result.resource);
    assert.equal(result.resource.driveScope, 'SYSTEM_DRIVE');
  });

  test('อัปโหลดไฟล์ในโฟลเดอร์สืบทอดไดร์ฟจากแม่ และปลอมไม่ได้', async () => {
    const result = await uploadFile(
      admin,
      Readable.from([Buffer.from('nested system file')]),
      {
        parentId: systemFolderId, driveScope: 'MY_DRIVE',
        fileName: `${prefix}-nested.txt`, declaredMime: 'text/plain',
      },
      audit,
    );
    track(result.resource);
    assert.equal(result.resource.driveScope, 'SYSTEM_DRIVE', 'โฟลเดอร์แม่เป็นผู้กำหนดไดร์ฟ');
  });

  /* ---------------- สิทธิ์ ---------------- */

  test('ผู้ใช้ทั่วไปสร้างทรัพยากรทุกชนิดที่รากไดร์ฟของระบบไม่ได้', async () => {
    await assert.rejects(
      () => createFolder(member, { name: `${prefix}-denied`, driveScope: 'SYSTEM_DRIVE' }, audit),
      (error: { code?: string }) => error.code === 'SYSTEM_DRIVE_WRITE_DENIED',
    );

    await assert.rejects(
      () =>
        createExternalResource(
          member,
          { type: 'WEB_LINK', name: `${prefix}-denied-link`, url: 'https://example.test/x', driveScope: 'SYSTEM_DRIVE' },
          audit,
        ),
      (error: { code?: string }) => error.code === 'SYSTEM_DRIVE_WRITE_DENIED',
    );

    await assert.rejects(
      () =>
        uploadFile(
          member,
          Readable.from([Buffer.from('denied')]),
          { parentId: null, driveScope: 'SYSTEM_DRIVE', fileName: `${prefix}-denied.txt`, declaredMime: 'text/plain' },
          audit,
        ),
      (error: { code?: string }) => error.code === 'SYSTEM_DRIVE_WRITE_DENIED',
    );
  });

  test('ผู้ใช้ทั่วไปสร้างในโฟลเดอร์ของไดร์ฟของระบบไม่ได้เช่นกัน', async () => {
    await assert.rejects(
      () => createFolder(member, { name: `${prefix}-denied-nested`, parentId: systemFolderId }, audit),
      (error: { code?: string }) => error.code === 'SYSTEM_DRIVE_WRITE_DENIED',
    );
  });

  test('ผู้ใช้ทั่วไปยังสร้างในไดร์ฟของฉันได้ตามปกติ', async () => {
    const folder = track(await createFolder(member, { name: `${prefix}-my-drive` }, audit));
    assert.equal(folder.driveScope, 'MY_DRIVE', 'ค่าปริยายต้องเป็นไดร์ฟของฉัน');
  });

  /* ---------------- ปลายทางที่ผู้ใช้เห็น ---------------- */

  test('ทรัพยากรในไดร์ฟของระบบรายงาน driveScope ออกมาให้หน้าจอใช้ได้', async () => {
    const dto = await getResource(systemFolderId, admin);
    assert.equal(dto.driveScope, 'SYSTEM_DRIVE');
    // DTO ต้องไม่มี storageKey หรือ path จริงหลุดออกไป
    const serialized = JSON.stringify(dto);
    assert.ok(!serialized.includes('storageKey'));
    assert.ok(!serialized.includes('/storage'));
  });
});

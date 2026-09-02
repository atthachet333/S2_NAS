import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { after, before, describe, test } from 'node:test';
import * as unzipper from 'unzipper';
import { prisma } from '../../core/prisma.js';
import { resolveInsideStorage } from '../../core/storage.js';
import { createFolder } from '../resources/resource.service.js';
import { sanitizeFileName, resolveMimeType } from './file-security.js';
import {
  getManagedStorageBytes,
  listVersions,
  resolveContent,
  uploadFile,
  uploadVersion,
} from './file.service.js';
import {
  describePermanentDelete,
  listTrash,
  permanentlyDelete,
  restoreResource,
  trashResource,
} from './trash.service.js';
import type { AuthUser } from '../auth/auth.service.js';
import { createZipPlan, createZipStream } from './zip.service.js';

const PDF_BYTES = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.from('phase-d-test-content')]);
const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('fake-png-body'),
]);

const stream = (buffer: Buffer) => Readable.from([buffer]);
const sha256 = (buffer: Buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

describe('Phase D file operations', () => {
  const prefix = `file-test-${process.pid}`;
  const audit = {};

  let uploaderId = '';
  let folderOwnerId = '';
  let newOwnerId = '';
  let outsiderId = '';

  let uploader: AuthUser;
  let folderOwner: AuthUser;
  let admin: AuthUser;
  let viewerOnly: AuthUser;

  let folderId = '';
  let fileId = '';

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
    const users = await Promise.all([
      prisma.user.create({ data: { email: `${prefix}-uploader@example.invalid`, displayName: 'Uploader Win', status: 'ACTIVE' } }),
      prisma.user.create({ data: { email: `${prefix}-owner@example.invalid`, displayName: 'Folder Owner Pueng', status: 'ACTIVE' } }),
      prisma.user.create({ data: { email: `${prefix}-newowner@example.invalid`, displayName: 'New Owner', status: 'ACTIVE' } }),
      prisma.user.create({ data: { email: `${prefix}-outsider@example.invalid`, displayName: 'Outsider', status: 'ACTIVE' } }),
    ]);
    uploaderId = users[0]!.id;
    folderOwnerId = users[1]!.id;
    newOwnerId = users[2]!.id;
    outsiderId = users[3]!.id;

    uploader = auth(uploaderId, ['resources:read', 'resources:write', 'resources:delete']);
    folderOwner = auth(folderOwnerId, ['resources:read', 'resources:write', 'resources:delete']);
    admin = auth(newOwnerId, ['resources:read', 'resources:write', 'resources:delete', 'admin:access'], ['SUPER_ADMIN']);
    viewerOnly = auth(outsiderId, ['resources:read'], ['VIEWER']);

    const folder = await createFolder(folderOwner, { name: `${prefix} Accounting` }, audit);
    folderId = folder.id;
  });

  after(async () => {
    const userIds = [uploaderId, folderOwnerId, newOwnerId, outsiderId];

    // ลบไฟล์จริงของทุกเวอร์ชันที่การทดสอบสร้างขึ้น ไม่ให้เหลือขยะค้างใน storage
    const { deleteStoredFile, removeResourceDirectory } = await import('../../core/file-storage.js');
    const testVersions = await prisma.resourceVersion.findMany({
      where: { createdById: { in: userIds } },
      select: { storageKey: true, resourceId: true },
    });
    for (const version of testVersions) await deleteStoredFile(version.storageKey);
    for (const resourceId of new Set(testVersions.map((v) => v.resourceId))) {
      await removeResourceDirectory(resourceId);
    }

    await prisma.resourceVersion.deleteMany({ where: { createdById: { in: userIds } } });
    await prisma.activityLog.deleteMany({ where: { userId: { in: userIds } } });
    const rows = await prisma.resource.findMany({
      where: { createdById: { in: userIds } },
      orderBy: { createdAt: 'desc' },
    });
    for (const row of rows) await prisma.resource.deleteMany({ where: { id: row.id } });
    await prisma.user.deleteMany({ where: { email: { startsWith: prefix } } });
  });

  /* ---------------- ความปลอดภัยของชื่อไฟล์และชนิด ---------------- */

  describe('ความปลอดภัยของชื่อและชนิดไฟล์', () => {
    test('ชื่อไฟล์ภาษาไทยใช้งานได้', () => {
      const result = sanitizeFileName('ใบแจ้งหนี้ ๒๕๖๙.pdf');
      assert.equal(result.name, 'ใบแจ้งหนี้ ๒๕๖๙.pdf');
      assert.equal(result.extension, 'pdf');
    });

    test('ชื่อไฟล์ที่พยายามไต่ไดเรกทอรีถูกปฏิเสธ', () => {
      for (const unsafe of ['../../secret.pdf', 'a/b.pdf', 'a\\b.pdf', '..', '.']) {
        assert.throws(() => sanitizeFileName(unsafe), /INVALID_RESOURCE_NAME|ชื่อไฟล์/);
      }
    });

    test('ชื่อสงวนของระบบถูกปฏิเสธ', () => {
      assert.throws(() => sanitizeFileName('CON.txt'));
    });

    test('ตรวจชนิดไฟล์จากลายเซ็นจริง ไม่เชื่อค่าที่เบราว์เซอร์ส่งมา', () => {
      const asPdf = resolveMimeType(PDF_BYTES, 'pdf', 'text/plain');
      assert.equal(asPdf.mimeType, 'application/pdf');
      assert.equal(asPdf.confidence, 'VERIFIED');
    });

    test('ชนิดที่ไม่รู้จักถูกเก็บเป็น binary และไม่อ้างว่าตรวจสอบแล้ว', () => {
      const unknown = resolveMimeType(Buffer.from('random-bytes'), 'weirdext', 'application/x-made-up');
      assert.equal(unknown.mimeType, 'application/octet-stream');
      assert.equal(unknown.confidence, 'UNKNOWN');
    });
  });

  /* ---------------- อัปโหลด ---------------- */

  describe('อัปโหลดไฟล์', () => {
    test('อัปโหลดสำเร็จ พร้อม checksum และเวอร์ชันแรก', async () => {
      const result = await uploadFile(
        uploader,
        stream(PDF_BYTES),
        { parentId: folderId, fileName: 'report.pdf' },
        audit,
      );
      fileId = result.resource.id;

      assert.equal(result.status, 'CREATED');
      assert.equal(result.resource.type, 'FILE');
      assert.equal(result.resource.size, PDF_BYTES.length);
      assert.equal(result.resource.mimeType, 'application/pdf');
      assert.equal(result.resource.currentVersion, 1);

      const row = await prisma.resource.findFirstOrThrow({ where: { id: fileId } });
      assert.equal(row.checksum, sha256(PDF_BYTES), 'checksum ต้องตรงกับเนื้อหาจริง');

      const versions = await listVersions(fileId, uploader);
      assert.equal(versions.length, 1);
      assert.equal(versions[0]!.versionNumber, 1);
      assert.equal(versions[0]!.isCurrent, true);
    });

    test('ไฟล์เป็นของพื้นที่องค์กร ไม่ใช่ของผู้อัปโหลด', async () => {
      const row = await prisma.resource.findFirstOrThrow({ where: { id: fileId } });
      assert.equal(row.ownerId, folderOwnerId, 'ผู้ดูแลไฟล์ต้องเป็นผู้ดูแลโฟลเดอร์');
      assert.equal(row.createdById, uploaderId, 'ผู้อัปโหลดถูกบันทึกแยกไว้ตามประวัติ');
    });

    test('ไฟล์สืบทอดการมองเห็นจากโฟลเดอร์แม่', async () => {
      const row = await prisma.resource.findFirstOrThrow({ where: { id: fileId } });
      assert.equal(row.visibility, 'ORGANIZATION');
    });

    test('ไฟล์ว่างเปล่าถูกปฏิเสธ', async () => {
      await assert.rejects(
        uploadFile(uploader, stream(Buffer.alloc(0)), { parentId: folderId, fileName: 'empty.txt' }, audit),
        /FILE_EMPTY|ว่างเปล่า/,
      );
    });

    test('ไฟล์ใหญ่เกินกำหนดถูกปฏิเสธและไม่เหลือไฟล์ค้าง', async () => {
      const { stageUpload } = await import('../../core/file-storage.js');
      await assert.rejects(
        stageUpload(stream(Buffer.alloc(2048)), { maxBytes: 1024 }),
        /FILE_TOO_LARGE|ขนาดเกิน/,
      );
    });

    test('โฟลเดอร์ปลายทางที่ไม่มีอยู่ถูกปฏิเสธ', async () => {
      await assert.rejects(
        uploadFile(uploader, stream(PDF_BYTES), { parentId: 'ไม่มีจริง', fileName: 'x.pdf' }, audit),
        /RESOURCE_NOT_FOUND|ไม่พบ/,
      );
    });

    test('ผู้ใช้ที่ไม่มีสิทธิ์เขียนอัปโหลดไม่ได้', async () => {
      await assert.rejects(
        uploadFile(viewerOnly, stream(PDF_BYTES), { parentId: folderId, fileName: 'denied.pdf' }, audit),
        /RESOURCE_ACCESS_DENIED|ไม่มีสิทธิ์/,
      );
    });

    test('เนื้อหาซ้ำถูกตรวจพบและแจ้งให้ผู้ใช้ตัดสินใจ', async () => {
      await assert.rejects(
        uploadFile(uploader, stream(PDF_BYTES), { parentId: folderId, fileName: 'copy.pdf' }, audit),
        (error: unknown) => (error as { code?: string }).code === 'DUPLICATE_CONTENT',
      );
    });

    test('ยืนยันแล้วอัปโหลดเนื้อหาซ้ำได้ และไม่ลบไฟล์เดิม', async () => {
      const result = await uploadFile(
        uploader,
        stream(PDF_BYTES),
        { parentId: folderId, fileName: 'copy.pdf', allowDuplicateContent: true },
        audit,
      );
      assert.equal(result.status, 'CREATED');
      assert.ok(result.duplicateOf, 'ต้องแจ้งว่าซ้ำกับไฟล์ใด');
      const original = await prisma.resource.findFirst({ where: { id: fileId, deletedAt: null } });
      assert.ok(original, 'ไฟล์เดิมต้องยังอยู่');
    });

    test('ชื่อซ้ำถูกบล็อกโดยค่าเริ่มต้น', async () => {
      await assert.rejects(
        uploadFile(
          uploader,
          stream(Buffer.from('different-content-1')),
          { parentId: folderId, fileName: 'report.pdf', allowDuplicateContent: true },
          audit,
        ),
        (error: unknown) => (error as { code?: string }).code === 'FILE_NAME_EXISTS',
      );
    });

    test('เลือกเก็บทั้งสองไฟล์ได้ โดยระบบตั้งชื่อใหม่ให้', async () => {
      const result = await uploadFile(
        uploader,
        stream(Buffer.from('different-content-2')),
        { parentId: folderId, fileName: 'report.pdf', onNameConflict: 'KEEP_BOTH', allowDuplicateContent: true },
        audit,
      );
      assert.equal(result.status, 'CREATED');
      assert.equal(result.resource.name, 'report (2).pdf');
    });
  });

  /* ---------------- เวอร์ชัน ---------------- */

  describe('เวอร์ชันของไฟล์', () => {
    test('อัปโหลดชื่อเดิมเป็นเวอร์ชันใหม่ได้', async () => {
      const result = await uploadFile(
        uploader,
        stream(Buffer.from('version-two-content')),
        { parentId: folderId, fileName: 'report.pdf', onNameConflict: 'NEW_VERSION', allowDuplicateContent: true },
        audit,
      );
      assert.equal(result.status, 'VERSION_ADDED');
      assert.equal(result.resource.id, fileId, 'Resource id ต้องไม่เปลี่ยน');
      assert.equal(result.resource.currentVersion, 2);
    });

    test('อัปโหลดเวอร์ชันผ่าน endpoint เฉพาะได้ และเลขเวอร์ชันเดินหน้า', async () => {
      const dto = await uploadVersion(
        uploader,
        fileId,
        stream(Buffer.from('version-three-content')),
        { remark: 'แก้ตัวเลขไตรมาส 3' },
        audit,
      );
      assert.equal(dto.currentVersion, 3);

      const versions = await listVersions(fileId, uploader);
      assert.deepEqual(versions.map((v) => v.versionNumber), [3, 2, 1]);
      assert.equal(versions[0]!.isCurrent, true);
      assert.equal(versions[0]!.remark, 'แก้ตัวเลขไตรมาส 3');
    });

    test('เวอร์ชันเก่ายังเปิดได้และเนื้อหาตรงกับตอนอัปโหลด', async () => {
      const v1 = await resolveContent(fileId, uploader, { versionNumber: 1 });
      assert.equal(v1.size, PDF_BYTES.length);

      const { createStoredFileStream } = await import('../../core/file-storage.js');
      const chunks: Buffer[] = [];
      for await (const chunk of createStoredFileStream(v1.storageKey)) chunks.push(chunk as Buffer);
      const restored = Buffer.concat(chunks);

      assert.equal(sha256(restored), sha256(PDF_BYTES), 'ไบต์ต้องตรงกันทุกประการ');
      assert.ok(restored.equals(PDF_BYTES));
    });

    test('แต่ละเวอร์ชันมีไฟล์จริงแยกกัน ไม่ทับกัน', async () => {
      const versions = await prisma.resourceVersion.findMany({ where: { resourceId: fileId } });
      const keys = new Set(versions.map((version) => version.storageKey));
      assert.equal(keys.size, versions.length, 'storage key ต้องไม่ซ้ำกัน');
    });

    test('ผู้ไม่มีสิทธิ์เขียนอัปโหลดเวอร์ชันใหม่ไม่ได้', async () => {
      await assert.rejects(
        uploadVersion(viewerOnly, fileId, stream(Buffer.from('nope')), {}, audit),
        /RESOURCE_ACCESS_DENIED|ไม่มีสิทธิ์/,
      );
    });
  });

  /* ---------------- การเข้าถึงเนื้อหา ---------------- */

  describe('การเข้าถึงเนื้อหา', () => {
    test('ผู้ใช้ในองค์กรเปิดและดาวน์โหลดไฟล์ที่มองเห็นได้', async () => {
      const content = await resolveContent(fileId, viewerOnly, {});
      assert.ok(content.storageKey);
      assert.equal(content.fileName, 'report.pdf');
    });

    test('ไฟล์ RESTRICTED ปิดกั้นผู้ที่ไม่ได้รับสิทธิ์', async () => {
      await prisma.resource.update({ where: { id: fileId }, data: { visibility: 'RESTRICTED' } });
      await assert.rejects(resolveContent(fileId, viewerOnly, {}), /ไม่มีสิทธิ์|FORBIDDEN/);

      // ผู้ดูแลระบบยังเข้าถึงได้
      const asAdmin = await resolveContent(fileId, admin, {});
      assert.ok(asAdmin.storageKey);

      await prisma.resource.update({ where: { id: fileId }, data: { visibility: 'ORGANIZATION' } });
    });

    test('เปิดเนื้อหาของโฟลเดอร์ไม่ได้', async () => {
      await assert.rejects(resolveContent(folderId, uploader, {}), /INVALID_RESOURCE_TYPE|ไม่ใช่ไฟล์/);
    });

    test('DTO ไม่เปิดเผย storageKey หรือเส้นทางจริงบนเซิร์ฟเวอร์', async () => {
      const versions = await listVersions(fileId, uploader);
      const payload = JSON.stringify(versions);
      assert.ok(!payload.includes('storageKey'));
      assert.ok(!payload.includes(resolveInsideStorage()));
      assert.ok(!/[A-Za-z]:\\\\/.test(payload));
    });
  });

  /* ---------------- ZIP ---------------- */

  describe('ZIP โฟลเดอร์และหลายรายการ', () => {
    let zipFolderId = '';
    let nestedFolderId = '';
    let zipFileId = '';
    const ZIP_BYTES = Buffer.from('zip-byte-identity-content');

    test('สร้างแผน ZIP แบบซ้อนชั้นและรองรับชื่อไทย', async () => {
      const root = await createFolder(folderOwner, { name: 'เอกสาร ZIP ภาษาไทย', parentId: folderId }, audit);
      zipFolderId = root.id;
      const nested = await createFolder(folderOwner, { name: 'บัญชี', parentId: root.id }, audit);
      nestedFolderId = nested.id;
      const uploaded = await uploadFile(
        uploader,
        stream(ZIP_BYTES),
        { parentId: nested.id, fileName: 'รายงาน.txt' },
        audit,
      );
      zipFileId = uploaded.resource.id;

      const plan = await createZipPlan([zipFolderId], uploader, true);
      assert.equal(plan.fileName, 'เอกสาร ZIP ภาษาไทย.zip');
      assert.ok(plan.entries.some((item) => item.archivePath === 'เอกสาร ZIP ภาษาไทย/บัญชี/รายงาน.txt'));
      assert.equal(plan.totalBytes, ZIP_BYTES.length);
    });

    test('mixed selection removes nested duplicates', async () => {
      const plan = await createZipPlan([zipFolderId, nestedFolderId, zipFileId, zipFileId], uploader);
      assert.deepEqual(plan.resourceIds, [zipFolderId]);
      assert.equal(plan.entries.filter((item) => item.resourceId === zipFileId).length, 1);
      assert.equal(new Set(plan.entries.map((item) => item.archivePath)).size, plan.entries.length);
    });

    test('generated ZIP opens, has safe relative paths, and preserves file SHA-256', async () => {
      const plan = await createZipPlan([zipFolderId], uploader, true);
      const archive = await createZipStream(plan);
      const chunks: Buffer[] = [];
      archive.on('data', (chunk: Buffer) => chunks.push(chunk));
      const ended = new Promise<void>((resolve, reject) => archive.once('end', resolve).once('error', reject));
      await archive.finalize();
      await ended;

      const opened = await unzipper.Open.buffer(Buffer.concat(chunks));
      const paths = opened.files.map((item) => item.path);
      assert.ok(paths.every((item) => !item.startsWith('/') && !/^[A-Za-z]:/.test(item) && !item.split('/').includes('..')));
      assert.equal(new Set(paths).size, paths.length);
      const file = opened.files.find((item) => item.path === 'เอกสาร ZIP ภาษาไทย/บัญชี/รายงาน.txt');
      assert.ok(file);
      assert.equal(sha256(await file.buffer()), sha256(ZIP_BYTES));
    });

    test('unauthorized restrictive descendant fails the whole ZIP', async () => {
      await prisma.resource.update({ where: { id: zipFileId }, data: { visibility: 'RESTRICTED' } });
      await assert.rejects(
        createZipPlan([zipFolderId], viewerOnly, true),
        (error: unknown) => (error as { code?: string }).code === 'RESOURCE_ACCESS_DENIED',
      );
      await prisma.resource.update({ where: { id: zipFileId }, data: { visibility: 'ORGANIZATION' } });
    });
  });

  /* ---------------- ถังขยะ ---------------- */

  describe('ถังขยะ กู้คืน และลบถาวร', () => {
    let trashFileId = '';
    let trashFolderId = '';

    test('ย้ายไฟล์ไปถังขยะแล้วหายจากรายการปกติ', async () => {
      const uploaded = await uploadFile(
        uploader,
        stream(Buffer.from('to-be-trashed')),
        { parentId: folderId, fileName: 'trash-me.txt' },
        audit,
      );
      trashFileId = uploaded.resource.id;

      const result = await trashResource(trashFileId, folderOwner, audit);
      assert.equal(result.trashed, true);

      const row = await prisma.resource.findFirstOrThrow({ where: { id: trashFileId } });
      assert.ok(row.deletedAt, 'ต้องมี deletedAt');
      assert.equal(row.deletedById, folderOwnerId);

      const active = await prisma.resource.findFirst({ where: { id: trashFileId, deletedAt: null } });
      assert.equal(active, null);
    });

    test('ไฟล์ที่ถูกลบยังมีไฟล์จริงอยู่ ไม่ถูกลบทันที', async () => {
      const versions = await prisma.resourceVersion.findMany({ where: { resourceId: trashFileId } });
      const { statStoredFile } = await import('../../core/file-storage.js');
      for (const version of versions) {
        assert.ok(await statStoredFile(version.storageKey), 'ไฟล์จริงต้องยังอยู่');
      }
    });

    test('ถังขยะแสดงรายการพร้อมตำแหน่งเดิมและผู้ลบ', async () => {
      const items = await listTrash(folderOwner);
      const entry = items.find((item) => item.id === trashFileId);
      assert.ok(entry, 'ต้องพบรายการในถังขยะ');
      assert.equal(entry.deletedBy?.id, folderOwnerId);
      assert.ok(entry.originalLocation.includes('Accounting'));
    });

    test('กู้คืนไฟล์กลับตำแหน่งเดิมได้', async () => {
      const restored = await restoreResource(trashFileId, folderOwner, {}, audit);
      assert.equal(restored.parentId, folderId);
      const row = await prisma.resource.findFirstOrThrow({ where: { id: trashFileId } });
      assert.equal(row.deletedAt, null);
    });

    test('กู้คืนแล้วชื่อชนกันต้องแจ้งเตือน ไม่เขียนทับ', async () => {
      await trashResource(trashFileId, folderOwner, audit);
      // สร้างไฟล์ชื่อเดียวกันขึ้นมาใหม่ในตำแหน่งเดิม
      const blocker = await uploadFile(
        uploader,
        stream(Buffer.from('blocking-content')),
        { parentId: folderId, fileName: 'trash-me.txt' },
        audit,
      );

      await assert.rejects(
        restoreResource(trashFileId, folderOwner, {}, audit),
        (error: unknown) => (error as { code?: string }).code === 'TRASH_RESTORE_CONFLICT',
      );

      // ตั้งชื่อใหม่แล้วกู้คืนได้
      const restored = await restoreResource(trashFileId, folderOwner, { newName: 'trash-me (restored).txt' }, audit);
      assert.equal(restored.name, 'trash-me (restored).txt');

      await trashResource(blocker.resource.id, folderOwner, audit);
    });

    test('ลบโฟลเดอร์พาลูกหลานไปถังขยะด้วยกัน', async () => {
      const folder = await createFolder(folderOwner, { name: `${prefix} Archive`, parentId: folderId }, audit);
      trashFolderId = folder.id;
      const child = await uploadFile(
        uploader,
        stream(Buffer.from('nested-file-content')),
        { parentId: trashFolderId, fileName: 'nested.txt' },
        audit,
      );

      const result = await trashResource(trashFolderId, folderOwner, audit);
      assert.equal(result.affected, 2, 'ต้องลบทั้งโฟลเดอร์และไฟล์ข้างใน');

      const childRow = await prisma.resource.findFirstOrThrow({ where: { id: child.resource.id } });
      assert.ok(childRow.deletedAt, 'ไฟล์ลูกต้องถูกลบไปด้วย');
    });

    test('กู้คืนโฟลเดอร์คืนลูกหลานทั้งหมด', async () => {
      await restoreResource(trashFolderId, folderOwner, {}, audit);
      const children = await prisma.resource.findMany({ where: { parentId: trashFolderId, deletedAt: null } });
      assert.equal(children.length, 1);
    });

    test('ลบถาวรต้องอยู่ในถังขยะก่อน', async () => {
      await assert.rejects(
        permanentlyDelete(trashFolderId, folderOwner, audit),
        /RESOURCE_NOT_TRASHED|ถังขยะ/,
      );
    });

    test('สรุปก่อนลบถาวรบอกจำนวนจริง', async () => {
      await trashResource(trashFolderId, folderOwner, audit);
      const preview = await describePermanentDelete(trashFolderId, folderOwner);
      assert.equal(preview.resourceCount, 2);
      assert.equal(preview.fileCount, 1);
      assert.equal(preview.versionCount, 1);
    });

    test('ลบถาวรลบทั้ง metadata และไฟล์จริง', async () => {
      const versions = await prisma.resourceVersion.findMany({
        where: { resource: { OR: [{ id: trashFolderId }, { parentId: trashFolderId }] } },
        select: { storageKey: true },
      });
      assert.ok(versions.length > 0);

      const result = await permanentlyDelete(trashFolderId, folderOwner, audit);
      assert.equal(result.deleted, true);

      const { statStoredFile } = await import('../../core/file-storage.js');
      for (const version of versions) {
        assert.equal(await statStoredFile(version.storageKey), null, 'ไฟล์จริงต้องถูกลบ');
      }
      const row = await prisma.resource.findFirst({ where: { id: trashFolderId } });
      assert.equal(row, null, 'metadata ต้องถูกลบ');
    });
  });

  /* ---------------- ความต่อเนื่องขององค์กร ---------------- */

  describe('ความต่อเนื่องขององค์กรเมื่อเปลี่ยนผู้ดูแล', () => {
    test('เปลี่ยนผู้ดูแลโฟลเดอร์แล้วไฟล์ยังอยู่ที่เดิมและประวัติผู้อัปโหลดไม่เปลี่ยน', async () => {
      const before = await prisma.resource.findFirstOrThrow({ where: { id: fileId } });
      const beforeKey = before.storageKey;

      const { transferOwner } = await import('../resources/resource.service.js');
      await transferOwner(folderId, admin, newOwnerId, audit);

      const after = await prisma.resource.findFirstOrThrow({ where: { id: fileId } });
      assert.equal(after.id, before.id, 'Resource id ต้องไม่เปลี่ยน');
      assert.equal(after.createdById, uploaderId, 'ผู้อัปโหลดเดิมต้องคงอยู่');
      assert.equal(after.storageKey, beforeKey, 'ไม่ต้องย้ายไฟล์จริง');

      const folder = await prisma.resource.findFirstOrThrow({ where: { id: folderId } });
      assert.equal(folder.ownerId, newOwnerId, 'ความรับผิดชอบของพื้นที่ย้ายไปผู้ดูแลใหม่');

      // ไฟล์ยังเปิดได้ตามสิทธิ์ของโฟลเดอร์
      const content = await resolveContent(fileId, viewerOnly, {});
      assert.ok(content.storageKey);
    });
  });

  /* ---------------- ตัวเลขพื้นที่ ---------------- */

  describe('พื้นที่ที่ S2 NAS ดูแล', () => {
    test('รวมขนาดจาก metadata ไม่ใช่การสแกนดิสก์', async () => {
      const managed = await getManagedStorageBytes();
      const sum = await prisma.resource.aggregate({
        where: { type: 'FILE', deletedAt: null },
        _sum: { size: true },
      });
      assert.equal(managed, Number(sum._sum.size ?? 0));
    });
  });

  /* ---------------- บันทึกกิจกรรม ---------------- */

  describe('บันทึกกิจกรรม', () => {
    test('เหตุการณ์สำคัญของ Phase D ถูกบันทึกจริง', async () => {
      const actions = await prisma.activityLog.findMany({
        where: { userId: { in: [uploaderId, folderOwnerId] } },
        select: { action: true },
      });
      const seen = new Set(actions.map((row) => row.action));

      for (const expected of [
        'RESOURCE_UPLOADED',
        'RESOURCE_VERSION_CREATED',
        'RESOURCE_TRASHED',
        'RESOURCE_RESTORED',
        'RESOURCE_PERMANENTLY_DELETED',
      ]) {
        assert.ok(seen.has(expected), `ต้องมีเหตุการณ์ ${expected}`);
      }
    });
  });
});

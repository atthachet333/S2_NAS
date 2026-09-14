import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { after, before, beforeEach, describe, test } from 'node:test';
import type { S3Client } from '@aws-sdk/client-s3';
import { prisma } from '../../core/prisma.js';
import { AppError } from '../../core/errors.js';
import { createStoredFileStream, statStoredFile } from '../../core/file-storage.js';
import { FakeS3Client } from '../../core/storage/fake-s3-client.js';
import { LocalStorageProvider } from '../../core/storage/local.provider.js';
import { S3StorageProvider } from '../../core/storage/s3.provider.js';
import {
  setStorageProviderForTesting, setWriteProviderForTesting, storageProviderDiagnostics,
} from '../../core/storage/index.js';
import { withLocalMaterialization } from '../../core/storage/materialize.js';
import { removeQaUsers } from '../assistant/qa-fixture.js';
import { collectManifestObjects } from '../backup/backup.service.js';
import { extractFromStorage } from '../search/extract/index.js';
import { uploadFile, uploadVersion, resolveContent } from './file.service.js';
import { permanentlyDelete, trashResource } from './trash.service.js';
import { createZipPlan, createZipStream } from './zip.service.js';
import type { AuthUser } from '../auth/auth.service.js';

/**
 * ชุดตรวจการจัดเก็บแบบผสมผู้ให้บริการ (F23-D)
 *
 * **สิ่งที่ต้องพิสูจน์เหนือสิ่งอื่นใด:** การอ่านทุกครั้งใช้ผู้ให้บริการที่บันทึกไว้กับแถวนั้น
 * ไม่ใช่ค่าตั้งปัจจุบันของระบบ ถ้าข้อนี้ผิด การสลับค่าตั้งจะทำให้เอกสารเก่าทั้งคลัง
 * "หายไป" พร้อมกันทันที ทั้งที่ไม่มีไฟล์ไหนขยับเลย
 *
 * **ของปลอมอยู่ที่ชั้นขนส่งเท่านั้น** เส้นทางที่ถูกทดสอบคือ บริการธุรกิจ -> ทะเบียน
 * -> S3StorageProvider ตัวจริง -> ชั้นขนส่งจำลอง โค้ดที่ทำงานจริงในการผลิตจึงถูกรัน
 * ทั้งหมด ยกเว้นการคุยกับบริการปลายทางจริงซึ่งยังไม่เคยถูกทดสอบในเฟสนี้
 */

const prefix = `f23d-${process.pid}-${Date.now()}`;
let fake: FakeS3Client;
let owner: AuthUser;
let folderId = '';
const createdResources: string[] = [];

const auth = (id: string, email: string): AuthUser => ({
  id, email, displayName: email, type: 'INTERNAL', status: 'ACTIVE', mustChangePassword: false,
  roles: ['MEMBER'], permissions: ['resources:read', 'resources:write', 'resources:delete'],
});

const audit = {};

async function uploadTo(kind: 'LOCAL' | 'S3', name: string, body: string) {
  setWriteProviderForTesting(kind);
  const result = await uploadFile(owner, Readable.from(Buffer.from(body, 'utf8')), {
    fileName: `${prefix}-${name}`, parentId: folderId, declaredMime: 'text/plain',
  }, audit);
  setWriteProviderForTesting('LOCAL');
  if (result.status !== 'CREATED') throw new Error(`อัปโหลดไม่สำเร็จ: ${result.status}`);
  createdResources.push(result.resource.id);
  return result.resource.id;
}

async function collect(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

describe('F23-D mixed storage providers', { concurrency: 1 }, () => {
  before(async () => {
    const user = await prisma.user.create({ data: {
      email: `${prefix}@example.invalid`, displayName: 'F23 mixed provider', type: 'INTERNAL', status: 'ACTIVE' } });
    owner = auth(user.id, user.email);

    const id = crypto.randomUUID();
    await prisma.resource.create({ data: { id, type: 'FOLDER', name: `${prefix} folder`,
      normalizedName: `${prefix} folder`, siblingKey: `${prefix}:${id}`,
      ownerId: user.id, createdById: user.id, visibility: 'ORGANIZATION', currentVersion: null } });
    folderId = id;
  });

  beforeEach(() => {
    // ชั้นขนส่งใหม่ทุกกรณีทดสอบ เพื่อให้ความล้มเหลวที่ฉีดไว้ไม่รั่วข้ามกรณี
    fake = new FakeS3Client();
    setStorageProviderForTesting('S3', new S3StorageProvider({
      region: 'auto', bucket: 'f23d-bucket', accessKeyId: 'id', secretAccessKey: 'secret',
      forcePathStyle: true, prefix: 'nas',
    }, fake as unknown as S3Client));
    setWriteProviderForTesting('LOCAL');
  });

  after(async () => {
    for (const id of createdResources) {
      await prisma.resourceVersion.deleteMany({ where: { resourceId: id } });
      await prisma.resource.deleteMany({ where: { id } });
      // ลบวัตถุบนดิสก์ด้วย มิฉะนั้นทุกครั้งที่รันจะทิ้งไฟล์กำพร้าไว้เพิ่มขึ้นเรื่อย ๆ
      await new LocalStorageProvider().removeResourceScope(id);
    }
    await prisma.resource.deleteMany({ where: { id: folderId } });
    await removeQaUsers([owner.id]);
    setStorageProviderForTesting('S3', null);
    setWriteProviderForTesting('LOCAL');
  });

  /* ---------------- การเขียนใหม่ ---------------- */

  /** อัปโหลดตามค่าตั้ง LOCAL ต้องบันทึกผู้ให้บริการเป็น LOCAL และไม่แตะ S3 เลย */
  test('an upload with the local default records LOCAL and never touches S3', async () => {
    const id = await uploadTo('LOCAL', 'local-upload.txt', 'local content');
    const row = await prisma.resource.findUniqueOrThrow({ where: { id },
      select: { storageProvider: true, versions: { select: { storageProvider: true } } } });

    assert.equal(row.storageProvider, 'LOCAL');
    assert.equal(row.versions[0]?.storageProvider, 'LOCAL');
    assert.equal(fake.commands.length, 0, 'ไม่ควรมีคำสั่งใดถูกส่งไปยังที่เก็บวัตถุ');
  });

  /** อัปโหลดตามค่าตั้ง S3 ต้องบันทึก S3 และไบต์ต้องไปอยู่ที่นั่นจริง */
  test('an upload with the S3 default records S3 and stores the bytes there', async () => {
    const id = await uploadTo('S3', 's3-upload.txt', 's3 content');
    const row = await prisma.resource.findUniqueOrThrow({ where: { id },
      select: { storageKey: true, storageProvider: true, versions: { select: { storageProvider: true } } } });

    assert.equal(row.storageProvider, 'S3');
    assert.equal(row.versions[0]?.storageProvider, 'S3');
    assert.ok(fake.objects.has(`nas/${row.storageKey}`), 'วัตถุต้องอยู่ในที่เก็บวัตถุจริง');
  });

  /* ---------------- การอ่าน ---------------- */

  /** ดาวน์โหลดต้องใช้ผู้ให้บริการของแถว และได้เนื้อหาเดิมครบ */
  test('downloads read through the provider recorded on the row', async () => {
    const localId = await uploadTo('LOCAL', 'read-local.txt', 'local payload');
    const s3Id = await uploadTo('S3', 'read-s3.txt', 's3 payload');

    const localContent = await resolveContent(localId, owner);
    const s3Content = await resolveContent(s3Id, owner);
    assert.equal(localContent.storageProvider, 'LOCAL');
    assert.equal(s3Content.storageProvider, 'S3');

    const localBytes = await collect(await createStoredFileStream(
      localContent.storageKey, undefined, localContent.storageProvider));
    const s3Bytes = await collect(await createStoredFileStream(
      s3Content.storageKey, undefined, s3Content.storageProvider));
    assert.equal(localBytes.toString(), 'local payload');
    assert.equal(s3Bytes.toString(), 's3 payload');
  });

  /** ช่วงไบต์ต้องทำงานเหมือนกันทั้งสองผู้ให้บริการ */
  test('range reads behave identically on both providers', async () => {
    // เนื้อหาต้องต่างกันจริง มิฉะนั้นด่านตรวจเนื้อหาซ้ำของระบบจะปฏิเสธไฟล์ที่สอง
    const cases = [
      { id: await uploadTo('LOCAL', 'range-local.txt', '0123456789'), expected: '3456' },
      { id: await uploadTo('S3', 'range-s3.txt', 'abcdefghij'), expected: 'defg' },
    ];

    for (const item of cases) {
      const content = await resolveContent(item.id, owner);
      const stat = await statStoredFile(content.storageKey, content.storageProvider);
      assert.equal(stat?.size, 10);
      const slice = await collect(await createStoredFileStream(
        content.storageKey, { start: 3, end: 6 }, content.storageProvider));
      assert.equal(slice.toString(), item.expected, `ช่วงไบต์ของ ${content.storageProvider} ต้องตรงกัน`);
    }
  });

  /* ---------------- เวอร์ชัน ---------------- */

  /**
   * เวอร์ชันใหม่ข้ามผู้ให้บริการ
   *
   * นี่คือสถานะที่การย้ายระบบจริงจะสร้างขึ้น เวอร์ชันเก่าต้องอ่านได้เหมือนเดิม
   * และวัตถุเก่าต้องไม่ถูกแตะต้องเลย
   */
  test('a new version may land on another provider while history stays put', async () => {
    const id = await uploadTo('LOCAL', 'versioned.txt', 'version one');
    const first = await prisma.resourceVersion.findFirstOrThrow({ where: { resourceId: id } });

    setWriteProviderForTesting('S3');
    await uploadVersion(owner, id, Readable.from(Buffer.from('version two', 'utf8')), { declaredMime: 'text/plain' }, audit);
    setWriteProviderForTesting('LOCAL');

    const resource = await prisma.resource.findUniqueOrThrow({ where: { id },
      select: { storageKey: true, storageProvider: true, currentVersion: true } });
    const versions = await prisma.resourceVersion.findMany({ where: { resourceId: id }, orderBy: { versionNumber: 'asc' } });

    assert.equal(versions.length, 2);
    assert.equal(versions[0]?.storageProvider, 'LOCAL', 'เวอร์ชันเก่าต้องยังเป็นของเดิม');
    assert.equal(versions[1]?.storageProvider, 'S3');
    assert.equal(resource.storageProvider, 'S3', 'Resource ต้องสะท้อนเวอร์ชันปัจจุบัน');
    assert.equal(resource.storageKey, versions[1]?.storageKey);
    assert.equal(versions[0]?.storageKey, first.storageKey, 'คีย์ของเวอร์ชันเก่าต้องไม่เปลี่ยน');

    // ทั้งสองเวอร์ชันต้องอ่านได้พร้อมกัน
    const old = await resolveContent(id, owner, { versionNumber: 1 });
    const current = await resolveContent(id, owner, { versionNumber: 2 });
    assert.equal((await collect(await createStoredFileStream(old.storageKey, undefined, old.storageProvider))).toString(), 'version one');
    assert.equal((await collect(await createStoredFileStream(current.storageKey, undefined, current.storageProvider))).toString(), 'version two');
  });

  /** Resource กับเวอร์ชันปัจจุบันต้องไม่ขัดกันเลย ไม่ว่าจะอัปโหลดกี่รอบ */
  test('Resource and its current version never disagree about storage', async () => {
    const id = await uploadTo('S3', 'consistency.txt', 'one');
    setWriteProviderForTesting('LOCAL');
    await uploadVersion(owner, id, Readable.from(Buffer.from('two', 'utf8')), { declaredMime: 'text/plain' }, audit);
    setWriteProviderForTesting('S3');
    await uploadVersion(owner, id, Readable.from(Buffer.from('three', 'utf8')), { declaredMime: 'text/plain' }, audit);
    setWriteProviderForTesting('LOCAL');

    const resource = await prisma.resource.findUniqueOrThrow({ where: { id } });
    const current = await prisma.resourceVersion.findFirstOrThrow({
      where: { resourceId: id, versionNumber: resource.currentVersion ?? 0 } });

    assert.equal(resource.storageProvider, current.storageProvider);
    assert.equal(resource.storageKey, current.storageKey);
    assert.equal(resource.checksum, current.checksum);
  });

  /* ---------------- ZIP ---------------- */

  /** ชุดบีบอัดเดียวที่มีไฟล์จากทั้งสองผู้ให้บริการต้องได้ครบทุกไฟล์ */
  test('a ZIP spanning both providers streams every entry', async () => {
    const localId = await uploadTo('LOCAL', 'zip-local.txt', 'zip local bytes');
    const s3Id = await uploadTo('S3', 'zip-s3.txt', 'zip s3 bytes');

    const plan = await createZipPlan([localId, s3Id], owner);
    const providers = plan.entries.filter((entry) => !entry.directory).map((entry) => entry.storageProvider).sort();
    assert.deepEqual(providers, ['LOCAL', 'S3']);

    const archive = await createZipStream(plan);
    const chunks: Buffer[] = [];
    archive.on('data', (chunk: Buffer) => chunks.push(chunk));
    await archive.finalize();
    const bytes = Buffer.concat(chunks);
    assert.ok(bytes.byteLength > 0, 'ชุดบีบอัดต้องมีเนื้อหา');
  });

  /* ---------------- การสกัดข้อความ ---------------- */

  /** เอกสารบน S3 ต้องสกัดข้อความได้เหมือนบนดิสก์ */
  test('text extraction works for an S3-backed version', async () => {
    const id = await uploadTo('S3', 'extract.txt', 'ใบกำกับภาษี ทดสอบการสกัดข้อความจากที่เก็บวัตถุ');
    const version = await prisma.resourceVersion.findFirstOrThrow({ where: { resourceId: id } });

    const outcome = await extractFromStorage({
      storageKey: version.storageKey, storageProvider: version.storageProvider,
      extension: 'txt', mimeType: 'text/plain',
    });
    assert.equal(outcome.kind, 'TEXT');
    if (outcome.kind === 'TEXT') assert.match(outcome.text, /ใบกำกับภาษี/u);
  });

  /** การทำให้เป็นไฟล์ชั่วคราวต้องลบไฟล์ทิ้งเสมอ ทั้งตอนสำเร็จและตอนล้มเหลว */
  test('materialization leaves no temp file behind, success or failure', async () => {
    const id = await uploadTo('S3', 'materialize.txt', 'materialize me');
    const version = await prisma.resourceVersion.findFirstOrThrow({ where: { resourceId: id } });
    const target = { storageKey: version.storageKey, storageProvider: version.storageProvider, expectedSize: Number(version.size) };

    let seen = '';
    const value = await withLocalMaterialization(target, async (localPath) => {
      seen = localPath;
      const { readFile } = await import('node:fs/promises');
      return (await readFile(localPath)).toString();
    });
    assert.equal(value, 'materialize me');

    const { access } = await import('node:fs/promises');
    await assert.rejects(access(seen), 'ไฟล์ชั่วคราวต้องถูกลบหลังใช้เสร็จ');

    let failedPath = '';
    await assert.rejects(withLocalMaterialization(target, async (localPath) => {
      failedPath = localPath;
      throw new Error('งานข้างในล้มเหลว');
    }));
    await assert.rejects(access(failedPath), 'ไฟล์ชั่วคราวต้องถูกลบแม้งานล้มเหลว');
  });

  /** ไฟล์บนดิสก์ต้องไม่ถูกคัดลอกโดยไม่จำเป็น */
  test('a local version is materialized in place without copying', async () => {
    const id = await uploadTo('LOCAL', 'inplace.txt', 'no copy needed');
    const version = await prisma.resourceVersion.findFirstOrThrow({ where: { resourceId: id } });

    const used = await withLocalMaterialization(
      { storageKey: version.storageKey, storageProvider: 'LOCAL' }, async (localPath) => localPath);
    assert.ok(used.includes('resources'), 'ต้องใช้ไฟล์เดิมในที่ของมัน ไม่ใช่สำเนาในพื้นที่ชั่วคราว');
    assert.equal(used.includes('temp'), false);
  });

  /* ---------------- ความไม่สอดคล้องและการถอยกลับ ---------------- */

  /**
   * ห้ามถอยไปหาผู้ให้บริการอื่นเด็ดขาด
   *
   * คีย์เดียวกันถูกวางไว้บนดิสก์ด้วย แต่แถวบอกว่าอยู่บน S3 การอ่านต้องล้มเหลว
   * ไม่ใช่ไปหยิบของจากดิสก์มาแทน เพราะนั่นคือการกลบความไม่สอดคล้องที่กำลังเกิดขึ้น
   */
  test('a missing S3 object fails loudly and never falls back to local', async () => {
    const id = await uploadTo('S3', 'vanishing.txt', 'about to vanish');
    const version = await prisma.resourceVersion.findFirstOrThrow({ where: { resourceId: id } });

    // วางไฟล์ชื่อเดียวกันไว้บนดิสก์ แล้วลบวัตถุออกจากที่เก็บวัตถุ
    const local = new LocalStorageProvider();
    await local.prepare(id);
    await local.put(version.storageKey, Readable.from(Buffer.from('IMPOSTER', 'utf8')));
    fake.objects.clear();

    const content = await resolveContent(id, owner);
    assert.equal(content.storageProvider, 'S3');
    await assert.rejects(createStoredFileStream(content.storageKey, undefined, content.storageProvider),
      (error: unknown) => error instanceof AppError && error.code === 'STORAGE_OBJECT_NOT_FOUND');
    assert.equal(await statStoredFile(content.storageKey, content.storageProvider), null);

    await local.delete(version.storageKey);
  });

  /** แถวบอก LOCAL ต้องอ่านจากดิสก์ แม้คีย์เดียวกันจะมีอยู่บน S3 ด้วย */
  test('a row marked LOCAL reads local even when the same key exists in S3', async () => {
    const id = await uploadTo('LOCAL', 'authoritative.txt', 'LOCAL IS TRUTH');
    const version = await prisma.resourceVersion.findFirstOrThrow({ where: { resourceId: id } });
    fake.objects.set(`nas/${version.storageKey}`, { body: Buffer.from('S3 IMPOSTER'), lastModified: new Date() });

    const content = await resolveContent(id, owner);
    const bytes = await collect(await createStoredFileStream(content.storageKey, undefined, content.storageProvider));
    assert.equal(bytes.toString(), 'LOCAL IS TRUTH');
  });

  /** อัปโหลดที่ล้มเหลวก่อนถึงฐานข้อมูล ต้องไม่ทิ้งแถวไว้เลย */
  test('an S3 upload failure leaves no row behind', async () => {
    fake.failureMode = 'UNREACHABLE';
    setWriteProviderForTesting('S3');
    const name = `${prefix}-never-created.txt`;
    await assert.rejects(uploadFile(owner, Readable.from(Buffer.from('never lands', 'utf8')), {
      fileName: name, parentId: folderId, declaredMime: 'text/plain',
    }, audit));
    setWriteProviderForTesting('LOCAL');

    assert.equal(await prisma.resource.count({ where: { name } }), 0);
  });

  /* ---------------- การลบถาวร ---------------- */

  /** ลบถาวรต้องเก็บกวาดวัตถุจากทุกผู้ให้บริการที่เกี่ยวข้อง */
  test('purging a mixed-provider resource clears objects from both providers', async () => {
    const id = await uploadTo('LOCAL', 'purge-mixed.txt', 'first on disk');
    setWriteProviderForTesting('S3');
    await uploadVersion(owner, id, Readable.from(Buffer.from('then on object storage', 'utf8')), { declaredMime: 'text/plain' }, audit);
    setWriteProviderForTesting('LOCAL');

    const versions = await prisma.resourceVersion.findMany({ where: { resourceId: id } });
    const localVersion = versions.find((version) => version.storageProvider === 'LOCAL')!;
    const s3Version = versions.find((version) => version.storageProvider === 'S3')!;
    assert.ok(fake.objects.has(`nas/${s3Version.storageKey}`));

    await trashResource(id, owner, audit);
    await permanentlyDelete(id, owner, audit);

    assert.equal(await statStoredFile(localVersion.storageKey, 'LOCAL'), null, 'วัตถุบนดิสก์ต้องถูกลบ');
    assert.equal(fake.objects.has(`nas/${s3Version.storageKey}`), false, 'วัตถุบนที่เก็บวัตถุต้องถูกลบ');
    assert.equal(await prisma.resource.count({ where: { id } }), 0);
    createdResources.splice(createdResources.indexOf(id), 1);
  });

  /* ---------------- ค่าตั้งและสุขภาพ ---------------- */

  /** การสลับค่าตั้งมีผลกับการเขียนใหม่เท่านั้น ไม่ตีความแถวเดิมใหม่ */
  test('switching the configured provider only affects new writes', async () => {
    const before = await uploadTo('LOCAL', 'before-switch.txt', 'written before');
    setWriteProviderForTesting('S3');
    const after = await uploadTo('S3', 'after-switch.txt', 'written after');

    const beforeRow = await prisma.resource.findUniqueOrThrow({ where: { id: before }, select: { storageProvider: true } });
    const afterRow = await prisma.resource.findUniqueOrThrow({ where: { id: after }, select: { storageProvider: true } });
    assert.equal(beforeRow.storageProvider, 'LOCAL', 'แถวเดิมต้องไม่ถูกตีความใหม่');
    assert.equal(afterRow.storageProvider, 'S3');

    const content = await resolveContent(before, owner);
    assert.equal((await collect(await createStoredFileStream(
      content.storageKey, undefined, content.storageProvider))).toString(), 'written before');
    setWriteProviderForTesting('LOCAL');
  });

  /** หน้าตรวจสุขภาพต้องบอกสถานะของแต่ละผู้ให้บริการโดยไม่เปิดเผยค่าตั้ง */
  test('health diagnostics report provider states without leaking configuration', async () => {
    const diagnostics = await storageProviderDiagnostics();
    assert.equal(diagnostics.defaultProvider, 'LOCAL');
    assert.equal(diagnostics.providers.LOCAL, 'READY');
    assert.equal(diagnostics.providers.S3, 'READY');

    const serialized = JSON.stringify(diagnostics);
    for (const forbidden of ['f23d-bucket', 'secret', 'nas/', 'auto']) {
      assert.equal(serialized.includes(forbidden), false, `ต้องไม่มี "${forbidden}"`);
    }
  });

  /** ที่เก็บวัตถุล่มต้องไม่ทำให้การอ่านเอกสารบนดิสก์พัง */
  test('an unavailable object store does not break local reads', async () => {
    const id = await uploadTo('LOCAL', 'survives-outage.txt', 'still readable');
    fake.failureMode = 'UNREACHABLE';

    const content = await resolveContent(id, owner);
    const bytes = await collect(await createStoredFileStream(content.storageKey, undefined, content.storageProvider));
    assert.equal(bytes.toString(), 'still readable');

    const diagnostics = await storageProviderDiagnostics();
    assert.equal(diagnostics.providers.LOCAL, 'READY');
    assert.equal(diagnostics.providers.S3, 'UNAVAILABLE');
  });

  /* ---------------- การสำรองข้อมูลข้ามผู้ให้บริการ ---------------- */

  /**
   * เวอร์ชันที่อยู่บนที่เก็บวัตถุต้องเข้าชุดสำรองตามปกติ (F23-F)
   *
   * ก่อนหน้านี้มีด่านกันชั่วคราวที่ปฏิเสธชุดข้อมูลซึ่งมีเวอร์ชันบน S3 เพราะตัวแพ็ก
   * อ่านได้เฉพาะดิสก์ ตอนนี้ตัวแพ็กอ่านจากผู้ให้บริการของแต่ละแถวแล้ว ด่านนั้นจึงถูกถอด
   * และสิ่งที่ต้องพิสูจน์แทนคือ "แถวบน S3 อยู่ในรายการของชุดสำรองจริง"
   */
  test('an S3-backed version is included in the backup manifest', async () => {
    const id = await uploadTo('S3', 'included-in-backup.txt', 'now portable');
    const version = await prisma.resourceVersion.findFirstOrThrow({ where: { resourceId: id } });

    const { objects } = await collectManifestObjects();
    const mine = objects.find((object) => object.storageKey === version.storageKey);
    assert.ok(mine, 'เวอร์ชันบนที่เก็บวัตถุต้องอยู่ในรายการของชุดสำรอง');
    assert.equal(mine?.originalProvider, 'S3', 'manifest ต้องบันทึกผู้ให้บริการเดิมไว้');
    assert.equal(mine?.resourceVersionId, version.id);
  });
});

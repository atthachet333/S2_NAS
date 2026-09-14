import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { after, before, beforeEach, describe, test } from 'node:test';
import type { S3Client } from '@aws-sdk/client-s3';
import { prisma } from '../../core/prisma.js';
import { FakeS3Client } from '../../core/storage/fake-s3-client.js';
import { LocalStorageProvider } from '../../core/storage/local.provider.js';
import { S3StorageProvider } from '../../core/storage/s3.provider.js';
import { setStorageProviderForTesting, setWriteProviderForTesting } from '../../core/storage/index.js';
import { removeQaUsers } from '../assistant/qa-fixture.js';
import { uploadFile, uploadVersion } from '../files/file.service.js';
import { collectManifestObjects, packageObjectsForTesting } from './backup.service.js';
import type { AuthUser } from '../auth/auth.service.js';

/**
 * ชุดตรวจการแพ็กไบต์จากทุกผู้ให้บริการเข้าชุดสำรอง (F23-F)
 *
 * **สิ่งที่ต้องพิสูจน์ก่อนถอดด่านกัน:** ไบต์ของเวอร์ชันที่อยู่บนที่เก็บวัตถุ ต้องอยู่ใน
 * ชุดสำรองจริง ๆ ไม่ใช่แค่ "โค้ดคอมไพล์ผ่าน" การถอดด่านโดยไม่มีหลักฐานข้อนี้
 * เท่ากับเปลี่ยนชุดสำรองที่ปฏิเสธอย่างซื่อสัตย์ ให้กลายเป็นชุดสำรองที่โกหก
 *
 * ของทดสอบทั้งหมดเป็นแถวใช้แล้วทิ้งของชุดนี้เอง และถูกเก็บกวาดเมื่อจบ
 */

const prefix = `f23pkg-${process.pid}-${Date.now()}`;
const packageDir = path.join(os.tmpdir(), `${prefix}-package`);
let fake: FakeS3Client;
let local: LocalStorageProvider;
let owner: AuthUser;
let folderId = '';
const created: string[] = [];

const auth = (id: string, email: string): AuthUser => ({
  id, email, displayName: email, type: 'INTERNAL', status: 'ACTIVE', mustChangePassword: false,
  roles: ['MEMBER'], permissions: ['resources:read', 'resources:write', 'resources:delete'],
});

async function upload(kind: 'LOCAL' | 'S3', name: string, body: string): Promise<string> {
  setWriteProviderForTesting(kind);
  const result = await uploadFile(owner, Readable.from(Buffer.from(body, 'utf8')), {
    fileName: `${prefix}-${name}`, parentId: folderId, declaredMime: 'text/plain',
  }, {});
  setWriteProviderForTesting('LOCAL');
  if (result.status !== 'CREATED') throw new Error('อัปโหลดไม่สำเร็จ');
  created.push(result.resource.id);
  return result.resource.id;
}

/**
 * แพ็กเฉพาะวัตถุของทรัพยากรที่ระบุ
 *
 * ระบุรายตัวเสมอ ไม่ใช้รายการสะสมของทั้งชุดทดสอบ มิฉะนั้นกรณีทดสอบหลัง ๆ
 * จะนับของที่กรณีก่อนหน้าสร้างไว้ติดมาด้วย และไม่มีทางแตะแถวของผู้ใช้จริงได้เลย
 */
async function packageObjectsOf(resourceIds: string[]) {
  const { objects } = await collectManifestObjects();
  const mine = objects.filter((object) => resourceIds.includes(object.resourceId));
  return { mine, result: await packageObjectsForTesting(mine, packageDir) };
}

describe('F23-F portable packaging across providers', { concurrency: 1 }, () => {
  before(async () => {
    const user = await prisma.user.create({ data: {
      email: `${prefix}@example.invalid`, displayName: 'F23-F packaging', type: 'INTERNAL', status: 'ACTIVE' } });
    owner = auth(user.id, user.email);
    const id = crypto.randomUUID();
    await prisma.resource.create({ data: { id, type: 'FOLDER', name: `${prefix} folder`,
      normalizedName: `${prefix} folder`, siblingKey: `${prefix}:${id}`,
      ownerId: user.id, createdById: user.id, visibility: 'ORGANIZATION', currentVersion: null } });
    folderId = id;
  });

  beforeEach(async () => {
    fake = new FakeS3Client();
    local = new LocalStorageProvider();
    setStorageProviderForTesting('S3', new S3StorageProvider({
      region: 'auto', bucket: 'f23pkg-bucket', accessKeyId: 'id', secretAccessKey: 'secret',
      forcePathStyle: true, prefix: 'nas',
    }, fake as unknown as S3Client));
    setWriteProviderForTesting('LOCAL');
    await fsp.rm(packageDir, { recursive: true, force: true });
  });

  after(async () => {
    for (const id of created) {
      await prisma.resourceSearchIndex.deleteMany({ where: { resourceId: id } });
      await prisma.resourceVersion.deleteMany({ where: { resourceId: id } });
      await prisma.resource.deleteMany({ where: { id } });
      await local.removeResourceScope(id);
    }
    await prisma.resource.deleteMany({ where: { id: folderId } });
    await removeQaUsers([owner.id]);
    await fsp.rm(packageDir, { recursive: true, force: true });
    setStorageProviderForTesting('S3', null);
    setWriteProviderForTesting('LOCAL');
  });

  /**
   * หลักฐานที่ต้องมีก่อนถอดด่าน BACKUP_PROVIDER_UNSUPPORTED
   *
   * เอกสารที่อยู่บนที่เก็บวัตถุ ต้องมีไบต์ครบอยู่ในชุดสำรองและ checksum ต้องตรง
   */
  test('an S3-backed version has its real bytes inside the package', async () => {
    const body = 'ใบกำกับภาษี เก็บอยู่บนที่เก็บวัตถุ ต้องอยู่ในชุดสำรองด้วย';
    const resourceId = await upload('S3', 's3-backed.txt', body);
    const scope = [resourceId];
    const version = await prisma.resourceVersion.findFirstOrThrow({ where: { resourceId } });
    assert.equal(version.storageProvider, 'S3');

    const { result } = await packageObjectsOf(scope);
    assert.deepEqual(result.missing, []);
    assert.deepEqual(result.corrupt, []);

    const packaged = await fsp.readFile(path.join(packageDir, version.storageKey));
    assert.equal(packaged.toString('utf8'), body, 'ไบต์ในชุดสำรองต้องเหมือนต้นฉบับทุกไบต์');
    assert.equal(crypto.createHash('sha256').update(packaged).digest('hex'), version.checksum);
  });

  /** ชุดข้อมูลผสมต้องได้ครบทุกชิ้น โดยอ่านจากผู้ให้บริการของแต่ละแถว */
  test('a mixed dataset is packaged completely from each row own provider', async () => {
    const localId = await upload('LOCAL', 'mixed-local.txt', 'บนดิสก์ของเครื่อง');
    const s3Id = await upload('S3', 'mixed-s3.txt', 'บนที่เก็บวัตถุ');
    const scope = [localId, s3Id];

    const { mine, result } = await packageObjectsOf(scope);
    assert.equal(mine.length, 2);
    assert.equal(result.copied.length, 2);
    assert.deepEqual(result.missing, []);

    const providers = mine.map((object) => object.originalProvider).sort();
    assert.deepEqual(providers, ['LOCAL', 'S3'], 'manifest ต้องบันทึกผู้ให้บริการเดิมของแต่ละชิ้น');

    for (const object of mine) {
      const packaged = await fsp.readFile(path.join(packageDir, object.storageKey));
      assert.equal(crypto.createHash('sha256').update(packaged).digest('hex'), object.checksum);
    }
    assert.ok(localId && s3Id);
  });

  /** ประวัติเวอร์ชันข้ามผู้ให้บริการต้องอยู่ในชุดสำรองครบทุกเวอร์ชัน */
  test('version history spanning providers is packaged in full', async () => {
    const resourceId = await upload('LOCAL', 'history.txt', 'เวอร์ชันที่หนึ่ง บนดิสก์');
    const scope = [resourceId];
    setWriteProviderForTesting('S3');
    await uploadVersion(owner, resourceId, Readable.from(Buffer.from('เวอร์ชันที่สอง บนที่เก็บวัตถุ', 'utf8')),
      { declaredMime: 'text/plain' }, {});
    setWriteProviderForTesting('LOCAL');

    const versions = await prisma.resourceVersion.findMany({ where: { resourceId }, orderBy: { versionNumber: 'asc' } });
    assert.equal(versions.length, 2);
    assert.equal(versions[0]?.storageProvider, 'LOCAL');
    assert.equal(versions[1]?.storageProvider, 'S3');

    const { result } = await packageObjectsOf(scope);
    assert.equal(result.copied.length, 2, 'ต้องได้ทั้งสองเวอร์ชัน');
    for (const version of versions) {
      const packaged = await fsp.readFile(path.join(packageDir, version.storageKey));
      assert.equal(crypto.createHash('sha256').update(packaged).digest('hex'), version.checksum);
    }
  });

  /* ---------------- ความล้มเหลวระหว่างแพ็ก ---------------- */

  /** วัตถุบนที่เก็บวัตถุหายไป ต้องถูกรายงานว่าไม่ครบ ไม่ใช่ข้ามเงียบ ๆ */
  test('a missing S3 object makes the package incomplete', async () => {
    const scope = [await upload('S3', 'vanished.txt', 'จะถูกลบออกจากที่เก็บวัตถุ')];
    fake.objects.clear();

    const { result } = await packageObjectsOf(scope);
    assert.equal(result.missing.length, 1);
    assert.equal(result.copied.length, 0);
  });

  /** วัตถุบนดิสก์หายไป ต้องถูกรายงานเช่นกัน */
  test('a missing local object makes the package incomplete', async () => {
    const resourceId = await upload('LOCAL', 'deleted.txt', 'จะถูกลบออกจากดิสก์');
    const scope = [resourceId];
    const version = await prisma.resourceVersion.findFirstOrThrow({ where: { resourceId } });
    await local.delete(version.storageKey);

    const { result } = await packageObjectsOf(scope);
    assert.equal(result.missing.length, 1);
  });

  /**
   * ไบต์ที่อ่านได้ไม่ตรงกับ checksum ที่บันทึกไว้
   *
   * ต้องถูกรายงานเป็นความเสียหาย ไม่ใช่ถูกบันทึกเป็น checksum ใหม่ที่ตรงกับตัวเอง
   * มิฉะนั้นชุดสำรองจะกลายเป็นสำเนาของความเสียหายที่ผ่านการตรวจของตัวเองได้
   */
  test('a corrupted object is reported instead of being re-checksummed', async () => {
    const resourceId = await upload('LOCAL', 'silent-corruption.txt', 'เนื้อหาของจริงยาวเท่านี้');
    const scope = [resourceId];
    const version = await prisma.resourceVersion.findFirstOrThrow({ where: { resourceId } });
    const tampered = Buffer.alloc(Number(version.size), 0x58);
    await local.put(version.storageKey, Readable.from(tampered));

    const { result } = await packageObjectsOf(scope);
    assert.equal(result.corrupt.length, 1, 'ต้องรายงานว่าเสียหาย');
    assert.equal(result.copied.length, 0, 'ต้องไม่ถูกนับว่าแพ็กสำเร็จ');

    const written = await fsp.stat(path.join(packageDir, version.storageKey)).catch(() => null);
    assert.equal(written, null, 'ไฟล์ที่เสียหายต้องไม่ถูกทิ้งไว้ในชุดสำรอง');
  });

  /** ที่เก็บวัตถุล่ม ต้องถูกรายงานว่าไม่ครบ ไม่ใช่แพ็กเฉพาะของที่อ่านได้แล้วบอกว่าสำเร็จ */
  test('an unavailable provider makes the package incomplete', async () => {
    const scope = [await upload('S3', 'provider-down.txt', 'บริการจะล่ม')];
    fake.failureMode = 'UNREACHABLE';

    const { result } = await packageObjectsOf(scope);
    assert.equal(result.missing.length, 1);
    assert.equal(result.copied.length, 0);
  });

  /** วัตถุกำพร้าบนดิสก์ต้องไม่เข้าชุดสำรอง เพราะไม่มีแถวใดอ้างถึง */
  test('unreferenced objects never enter the package', async () => {
    const strayResource = crypto.randomUUID();
    const strayKey = `resources/${strayResource}/${crypto.randomUUID()}`;
    await local.prepare(strayResource);
    await local.put(strayKey, Readable.from(Buffer.from('ไม่มีแถวใดอ้างถึงไฟล์นี้', 'utf8')));

    try {
      const { objects } = await collectManifestObjects();
      assert.equal(objects.some((object) => object.storageKey === strayKey), false,
        'วัตถุกำพร้าต้องไม่อยู่ในรายการของชุดสำรอง');
    } finally {
      await local.removeResourceScope(strayResource);
    }
  });
});

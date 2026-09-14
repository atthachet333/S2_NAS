import assert from 'node:assert/strict';
import crypto from 'node:crypto';
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
import { migrateStorage, migrateVersion } from './migration.service.js';
import type { AuthUser } from '../auth/auth.service.js';

/**
 * ชุดตรวจเครื่องมือย้ายพื้นที่จัดเก็บ (F23-E)
 *
 * **สิ่งที่ต้องจริงในทุกกรณีความล้มเหลว:** ต้นทางไม่ถูกลบ และแถวไม่เคยชี้ไปยังวัตถุ
 * ที่ยังพิสูจน์ไม่ได้ว่าครบถ้วน ทุกกรณีในชุดนี้จึงตรวจสองข้อนี้ซ้ำเสมอ
 *
 * ของปลอมอยู่ที่ชั้นขนส่งของ S3 เท่านั้น ผู้ให้บริการทั้งสองรายเป็นโค้ดจริง
 */

const prefix = `f23e-${process.pid}-${Date.now()}`;
let fake: FakeS3Client;
let local: LocalStorageProvider;
let owner: AuthUser;
let folderId = '';
const created: string[] = [];

const auth = (id: string, email: string): AuthUser => ({
  id, email, displayName: email, type: 'INTERNAL', status: 'ACTIVE', mustChangePassword: false,
  roles: ['MEMBER'], permissions: ['resources:read', 'resources:write', 'resources:delete'],
});

async function makeLocalFile(name: string, body: string): Promise<{ resourceId: string; versionId: string }> {
  setWriteProviderForTesting('LOCAL');
  const result = await uploadFile(owner, Readable.from(Buffer.from(body, 'utf8')), {
    fileName: `${prefix}-${name}`, parentId: folderId, declaredMime: 'text/plain',
  }, {});
  if (result.status !== 'CREATED') throw new Error('อัปโหลดไม่สำเร็จ');
  created.push(result.resource.id);
  const version = await prisma.resourceVersion.findFirstOrThrow({ where: { resourceId: result.resource.id } });
  return { resourceId: result.resource.id, versionId: version.id };
}

const migrateOne = (versionId: string, dryRun = false) =>
  migrateVersion(versionId, { from: 'LOCAL', to: 'S3', dryRun });

describe('F23-E storage migration', { concurrency: 1 }, () => {
  before(async () => {
    const user = await prisma.user.create({ data: {
      email: `${prefix}@example.invalid`, displayName: 'F23-E migration', type: 'INTERNAL', status: 'ACTIVE' } });
    owner = auth(user.id, user.email);
    const id = crypto.randomUUID();
    await prisma.resource.create({ data: { id, type: 'FOLDER', name: `${prefix} folder`,
      normalizedName: `${prefix} folder`, siblingKey: `${prefix}:${id}`,
      ownerId: user.id, createdById: user.id, visibility: 'ORGANIZATION', currentVersion: null } });
    folderId = id;
  });

  beforeEach(() => {
    fake = new FakeS3Client();
    local = new LocalStorageProvider();
    setStorageProviderForTesting('S3', new S3StorageProvider({
      region: 'auto', bucket: 'f23e-bucket', accessKeyId: 'id', secretAccessKey: 'secret',
      forcePathStyle: true, prefix: 'nas',
    }, fake as unknown as S3Client));
    setWriteProviderForTesting('LOCAL');
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
    setStorageProviderForTesting('S3', null);
    setWriteProviderForTesting('LOCAL');
  });

  /* ---------------- เส้นทางปกติ ---------------- */

  /** ย้ายสำเร็จ: ปลายทางมีไบต์ครบ แถวสลับแล้ว และต้นทางยังอยู่ */
  test('a successful migration copies, verifies, switches and keeps the source', async () => {
    const { resourceId, versionId } = await makeLocalFile('happy.txt', 'migrate me safely');
    const before = await prisma.resourceVersion.findUniqueOrThrow({ where: { id: versionId } });

    const result = await migrateOne(versionId);
    assert.equal(result.outcome, 'MIGRATED');

    const after = await prisma.resourceVersion.findUniqueOrThrow({ where: { id: versionId } });
    assert.equal(after.storageProvider, 'S3');
    assert.equal(after.storageKey, before.storageKey, 'คีย์เชิงตรรกะต้องไม่เปลี่ยน');
    assert.ok(fake.objects.has(`nas/${before.storageKey}`), 'ปลายทางต้องมีวัตถุ');
    assert.ok(await local.exists(before.storageKey), 'ต้นทางต้องยังอยู่ - เฟสนี้ไม่คืนพื้นที่');

    const resource = await prisma.resource.findUniqueOrThrow({ where: { id: resourceId } });
    assert.equal(resource.storageProvider, 'S3', 'เวอร์ชันปัจจุบันย้าย Resource ต้องตามไปด้วย');
  });

  /** โหมดตรวจอย่างเดียวต้องไม่เขียนและไม่สลับอะไรเลย */
  test('a dry run writes nothing and switches nothing', async () => {
    const { versionId } = await makeLocalFile('dry.txt', 'dry run content');
    const result = await migrateOne(versionId, true);

    assert.equal(result.outcome, 'DRY_RUN');
    assert.equal((await prisma.resourceVersion.findUniqueOrThrow({ where: { id: versionId } })).storageProvider, 'LOCAL');
    assert.equal(fake.objects.size, 0, 'ต้องไม่มีวัตถุใดถูกเขียนที่ปลายทาง');
  });

  /* ---------------- Resource denormalization ---------------- */

  /** ย้ายเวอร์ชันเก่า ต้องไม่แตะแถว Resource */
  test('migrating a historical version leaves Resource untouched', async () => {
    const { resourceId, versionId: firstId } = await makeLocalFile('historical.txt', 'old version');
    await uploadVersion(owner, resourceId, Readable.from(Buffer.from('new version', 'utf8')),
      { declaredMime: 'text/plain' }, {});

    const before = await prisma.resource.findUniqueOrThrow({ where: { id: resourceId } });
    const result = await migrateOne(firstId);
    assert.equal(result.outcome, 'MIGRATED');

    const after = await prisma.resource.findUniqueOrThrow({ where: { id: resourceId } });
    assert.equal(after.storageProvider, 'LOCAL', 'Resource ต้องยังสะท้อนเวอร์ชันปัจจุบัน');
    assert.equal(after.storageKey, before.storageKey);
    assert.equal((await prisma.resourceVersion.findUniqueOrThrow({ where: { id: firstId } })).storageProvider, 'S3');
  });

  /* ---------------- ความสามารถในการรันซ้ำ ---------------- */

  /** รันซ้ำแถวที่ย้ายแล้วต้องข้าม ไม่คัดลอกใหม่ */
  test('re-running on an already migrated row skips without copying', async () => {
    const { versionId } = await makeLocalFile('idempotent.txt', 'run me twice');
    await migrateOne(versionId);
    const commandsAfterFirst = fake.commands.filter((c) => c.name === 'PutObjectCommand').length;

    const second = await migrateOne(versionId);
    assert.equal(second.outcome, 'SKIP_ALREADY_MIGRATED');
    assert.equal(fake.commands.filter((c) => c.name === 'PutObjectCommand').length, commandsAfterFirst,
      'ต้องไม่คัดลอกซ้ำ');
  });

  /** แถวที่อยู่บนผู้ให้บริการอื่นอยู่แล้วต้องถูกข้ามอย่างชัดเจน */
  test('a row on a third state is skipped rather than forced', async () => {
    const { versionId } = await makeLocalFile('not-source.txt', 'already elsewhere');
    await migrateOne(versionId);
    const result = await migrateVersion(versionId, { from: 'S3', to: 'LOCAL', dryRun: true });
    // ย้ายกลับได้ตามปกติ เพราะแถวอยู่ต้นทางของรอบนี้จริง
    assert.equal(result.outcome, 'DRY_RUN');

    const reverse = await migrateVersion(versionId, { from: 'LOCAL', to: 'S3', dryRun: true });
    assert.equal(reverse.outcome, 'SKIP_ALREADY_MIGRATED');
  });

  /* ---------------- การขัดจังหวะ ---------------- */

  /**
   * ตายหลังคัดลอกแต่ก่อนสลับ metadata
   *
   * สภาพที่เหลือคือสำเนาที่ถูกต้องอยู่ปลายทาง แต่แถวยังชี้ต้นทาง การรันใหม่ต้อง
   * ตรวจสำเนานั้นแล้วใช้ต่อได้เลย ไม่ต้องคัดลอกซ้ำ และต้องไม่ถือว่าเป็นความขัดแย้ง
   */
  test('resuming after a copy-but-no-switch interruption reuses the verified target', async () => {
    const { versionId } = await makeLocalFile('interrupted.txt', 'copied but not switched');
    const version = await prisma.resourceVersion.findUniqueOrThrow({ where: { id: versionId } });

    // จำลองการคัดลอกที่สำเร็จไปแล้วก่อนกระบวนการตาย
    const s3 = new S3StorageProvider({ region: 'auto', bucket: 'f23e-bucket', accessKeyId: 'id',
      secretAccessKey: 'secret', forcePathStyle: true, prefix: 'nas' }, fake as unknown as S3Client);
    await s3.put(version.storageKey, await local.getStream(version.storageKey));
    const putsBefore = fake.commands.filter((c) => c.name === 'PutObjectCommand').length;

    const result = await migrateOne(versionId);
    assert.equal(result.outcome, 'MIGRATED');
    assert.equal(result.reusedExistingTarget, true, 'ต้องใช้สำเนาที่มีอยู่แล้ว');
    assert.equal(fake.commands.filter((c) => c.name === 'PutObjectCommand').length, putsBefore,
      'ต้องไม่คัดลอกซ้ำเมื่อสำเนาที่มีอยู่ถูกต้อง');
    assert.equal((await prisma.resourceVersion.findUniqueOrThrow({ where: { id: versionId } })).storageProvider, 'S3');
    assert.ok(await local.exists(version.storageKey), 'ต้นทางต้องยังอยู่');
  });

  /** ตายหลังสลับ metadata แล้ว - รันใหม่ต้องรายงานว่าเสร็จแล้ว ไม่คัดลอกอะไรอีก */
  test('resuming after the switch reports already migrated and copies nothing', async () => {
    const { versionId } = await makeLocalFile('after-switch.txt', 'switch completed');
    await migrateOne(versionId);
    const version = await prisma.resourceVersion.findUniqueOrThrow({ where: { id: versionId } });

    const summary = await migrateStorage({ from: 'LOCAL', to: 'S3', dryRun: false,
      resourceVersionId: versionId });
    assert.equal(summary.alreadyMigrated, 1);
    assert.equal(summary.copied, 0);
    assert.ok(await local.exists(version.storageKey), 'สำเนาต้นทางต้องยังอยู่');
  });

  /* ---------------- ความล้มเหลว ---------------- */

  /** ต้นทางหาย ต้องล้มเหลวอย่างชัดเจนและไม่แตะปลายทางเลย */
  test('a missing source fails loudly and writes nothing', async () => {
    const { versionId } = await makeLocalFile('source-gone.txt', 'about to disappear');
    const version = await prisma.resourceVersion.findUniqueOrThrow({ where: { id: versionId } });
    await local.delete(version.storageKey);

    const result = await migrateOne(versionId);
    assert.equal(result.outcome, 'SOURCE_MISSING');
    assert.equal(fake.objects.size, 0);
    assert.equal((await prisma.resourceVersion.findUniqueOrThrow({ where: { id: versionId } })).storageProvider, 'LOCAL');
  });

  /** ต้นทางเสียหายอยู่ก่อนแล้ว ต้องไม่ทำสำเนาของความเสียหาย */
  test('a corrupted source is never copied', async () => {
    const { versionId } = await makeLocalFile('corrupt.txt', 'original content here');
    const version = await prisma.resourceVersion.findUniqueOrThrow({ where: { id: versionId } });
    // เขียนทับด้วยเนื้อหาที่ยาวเท่ากันเป๊ะ (21 ไบต์) ขนาดจึงยังตรง แต่ checksum ไม่ตรง
    const corrupted = Buffer.from('CORRUPTED content!!!!', 'utf8');
    assert.equal(corrupted.byteLength, Number(version.size), 'ของทดสอบต้องยาวเท่าเดิมพอดี');
    await local.put(version.storageKey, Readable.from(corrupted));

    const result = await migrateOne(versionId);
    assert.equal(result.outcome, 'SOURCE_CHECKSUM_MISMATCH');
    assert.equal(fake.objects.size, 0, 'ต้องไม่คัดลอกไบต์ที่พิสูจน์แล้วว่าเสียหาย');
    assert.equal((await prisma.resourceVersion.findUniqueOrThrow({ where: { id: versionId } })).storageProvider, 'LOCAL');
  });

  /** ขนาดไม่ตรงกับฐานข้อมูล ต้องหยุดก่อนคัดลอก */
  test('a source whose size disagrees with metadata stops before copying', async () => {
    const { versionId } = await makeLocalFile('short.txt', 'full length content');
    const version = await prisma.resourceVersion.findUniqueOrThrow({ where: { id: versionId } });
    await local.put(version.storageKey, Readable.from(Buffer.from('short', 'utf8')));

    const result = await migrateOne(versionId);
    assert.equal(result.outcome, 'SOURCE_SIZE_MISMATCH');
    assert.equal(fake.objects.size, 0);
  });

  /** ปลายทางมีวัตถุคนละเนื้อหาอยู่ ห้ามเขียนทับและห้ามสลับ metadata */
  test('a conflicting target is never overwritten', async () => {
    const { versionId } = await makeLocalFile('conflict.txt', 'the real content');
    const version = await prisma.resourceVersion.findUniqueOrThrow({ where: { id: versionId } });
    fake.objects.set(`nas/${version.storageKey}`, { body: Buffer.from('SOMETHING ELSE'), lastModified: new Date() });

    const result = await migrateOne(versionId);
    assert.equal(result.outcome, 'TARGET_CONFLICT');
    assert.equal(fake.objects.get(`nas/${version.storageKey}`)?.body.toString(), 'SOMETHING ELSE',
      'วัตถุที่มีอยู่ต้องไม่ถูกเขียนทับ');
    assert.equal((await prisma.resourceVersion.findUniqueOrThrow({ where: { id: versionId } })).storageProvider, 'LOCAL');
    assert.ok(await local.exists(version.storageKey));
  });

  /** ปลายทางล่มระหว่างคัดลอก ต้องล้มเหลวและไม่สลับ metadata */
  test('a target write failure leaves the row on the source', async () => {
    const { versionId } = await makeLocalFile('target-fails.txt', 'cannot be written');
    fake.failureMode = 'UNREACHABLE';

    const summary = await migrateStorage({ from: 'LOCAL', to: 'S3', dryRun: false, resourceVersionId: versionId });
    assert.equal(summary.switched, 0);
    assert.equal(summary.failed, 1);
    assert.equal((await prisma.resourceVersion.findUniqueOrThrow({ where: { id: versionId } })).storageProvider, 'LOCAL');
  });

  /** ผู้ให้บริการไม่พร้อมตั้งแต่ต้น ต้องหยุดทั้งรอบ ไม่ใช่ไล่ล้มทีละแถว */
  test('an unavailable provider aborts the run before touching any row', async () => {
    const { versionId } = await makeLocalFile('outage.txt', 'provider down');
    fake.failureMode = 'ACCESS_DENIED';

    const summary = await migrateStorage({ from: 'LOCAL', to: 'S3', dryRun: false, resourceIds: created });
    assert.equal(summary.items[0]?.outcome, 'PROVIDER_UNAVAILABLE');
    assert.equal(summary.scanned, 0, 'ต้องไม่เริ่มไล่แถวเลย');
    assert.equal((await prisma.resourceVersion.findUniqueOrThrow({ where: { id: versionId } })).storageProvider, 'LOCAL');
  });

  /** ปลายทางเขียนแล้วแต่ไบต์ไม่ครบ ต้องไม่สลับ metadata */
  test('a target that verifies short does not get the metadata switch', async () => {
    const { versionId } = await makeLocalFile('short-target.txt', 'complete payload here');
    const version = await prisma.resourceVersion.findUniqueOrThrow({ where: { id: versionId } });

    /**
     * ชั้นขนส่งที่เขียนไม่ครบ - จำลองการคัดลอกที่ขาดกลางคันแต่ไม่โยนข้อผิดพลาด
     * ซึ่งเป็นความล้มเหลวที่อันตรายที่สุด เพราะดูเหมือนสำเร็จทุกประการ
     */
    const truncating = new FakeS3Client();
    const originalSend = truncating.send.bind(truncating);
    truncating.send = async (command) => {
      if (command.constructor.name === 'PutObjectCommand') {
        return originalSend({ ...command, constructor: command.constructor,
          input: { ...command.input, Body: Readable.from(Buffer.from('short', 'utf8')) } } as never);
      }
      return originalSend(command);
    };
    setStorageProviderForTesting('S3', new S3StorageProvider({ region: 'auto', bucket: 'f23e-bucket',
      accessKeyId: 'id', secretAccessKey: 'secret', forcePathStyle: true, prefix: 'nas' },
      truncating as unknown as S3Client));

    const result = await migrateOne(versionId);
    assert.equal(result.outcome, 'TARGET_VERIFY_FAILED');
    assert.equal((await prisma.resourceVersion.findUniqueOrThrow({ where: { id: versionId } })).storageProvider, 'LOCAL');
    assert.ok(await local.exists(version.storageKey), 'ต้นทางต้องยังอยู่');
  });

  /* ---------------- การทำงานเป็นชุด ---------------- */

  /** จำกัดจำนวนได้ และรายงานยอดรวมตามจริง */
  test('a limited batch migrates only that many rows and reports honestly', async () => {
    await makeLocalFile('batch-a.txt', 'batch content a');
    await makeLocalFile('batch-b.txt', 'batch content b');
    await makeLocalFile('batch-c.txt', 'batch content c');

    // จำกัดขอบเขตไว้ที่ของทดสอบของชุดนี้เท่านั้น ฐานข้อมูลเดียวกันมีข้อมูลจริงอยู่ด้วย
    const summary = await migrateStorage({ from: 'LOCAL', to: 'S3', dryRun: false, limit: 2,
      resourceIds: created });
    assert.equal(summary.scanned, 2);
    assert.equal(summary.switched, 2);
    assert.equal(summary.copied, 2);
    assert.equal(summary.failed, 0);
    assert.ok(summary.bytes > 0);
  });
});

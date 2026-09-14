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
import { uploadFile } from '../files/file.service.js';
import { auditStorage, type AuditFindingKind } from './audit.service.js';
import { migrateVersion } from './migration.service.js';
import type { AuthUser } from '../auth/auth.service.js';

/**
 * ชุดตรวจเครื่องมือตรวจสอบพื้นที่จัดเก็บ (F23-E)
 *
 * **สิ่งที่ต้องไม่เกิดขึ้นเด็ดขาด:** รายงานว่าไฟล์หายทั้งที่บริการแค่ล่มชั่วคราว
 * และรายงานว่าวัตถุของเวอร์ชันเก่าเป็นขยะทั้งที่ยังถูกอ้างถึงอยู่ ทั้งสองอย่าง
 * นำไปสู่การลบของที่ยังใช้งานอยู่ จึงมีกรณีทดสอบกำกับทั้งคู่
 *
 * ของทดสอบทุกชิ้นอยู่ใต้รหัสทรัพยากรของตัวเอง ชุดนี้จึงรันพร้อมข้อมูลจริงบนเครื่อง
 * เดียวกันได้โดยไม่รบกวนกัน
 */

const prefix = `f23a-${process.pid}-${Date.now()}`;
let fake: FakeS3Client;
let local: LocalStorageProvider;
let owner: AuthUser;
let folderId = '';
const created: string[] = [];

const auth = (id: string, email: string): AuthUser => ({
  id, email, displayName: email, type: 'INTERNAL', status: 'ACTIVE', mustChangePassword: false,
  roles: ['MEMBER'], permissions: ['resources:read', 'resources:write', 'resources:delete'],
});

async function makeFile(name: string, body: string): Promise<{ resourceId: string; versionId: string }> {
  const result = await uploadFile(owner, Readable.from(Buffer.from(body, 'utf8')), {
    fileName: `${prefix}-${name}`, parentId: folderId, declaredMime: 'text/plain',
  }, {});
  if (result.status !== 'CREATED') throw new Error('อัปโหลดไม่สำเร็จ');
  created.push(result.resource.id);
  const version = await prisma.resourceVersion.findFirstOrThrow({ where: { resourceId: result.resource.id } });
  return { resourceId: result.resource.id, versionId: version.id };
}

/** ค้นเฉพาะสิ่งที่เกี่ยวกับแถวของชุดนี้ - ฐานข้อมูลเดียวกันมีข้อมูลจริงอยู่ด้วย */
const findingsFor = (
  report: Awaited<ReturnType<typeof auditStorage>>, kind: AuditFindingKind, id: string,
) => report.findings.filter((finding) =>
  finding.kind === kind && (finding.resourceVersionId === id || finding.resourceId === id));

describe('F23-E storage audit', { concurrency: 1 }, () => {
  before(async () => {
    const user = await prisma.user.create({ data: {
      email: `${prefix}@example.invalid`, displayName: 'F23-E audit', type: 'INTERNAL', status: 'ACTIVE' } });
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
      region: 'auto', bucket: 'f23a-bucket', accessKeyId: 'id', secretAccessKey: 'secret',
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

  /* ---------------- ชุดข้อมูลที่สมบูรณ์ ---------------- */

  /** ข้อมูลผสมที่ครบถ้วนต้องไม่มีรายงานใดเกี่ยวกับแถวของชุดนี้ */
  test('a clean mixed dataset produces no findings for its rows', async () => {
    const localFile = await makeFile('clean-local.txt', 'clean local content');
    const s3File = await makeFile('clean-s3.txt', 'clean s3 content');
    await migrateVersion(s3File.versionId, { from: 'LOCAL', to: 'S3', dryRun: false });

    const report = await auditStorage({ checksum: true });
    for (const id of [localFile.versionId, s3File.versionId, localFile.resourceId, s3File.resourceId]) {
      const related = report.findings.filter((finding) =>
        finding.resourceVersionId === id || finding.resourceId === id);
      assert.deepEqual(related, [], `ต้องไม่มีรายงานสำหรับ ${id}`);
    }
    assert.equal(report.checksumVerified, true);
    assert.ok(report.bytesRead > 0, 'โหมด checksum ต้องอ่านไบต์จริง');
  });

  /** โหมดปกติต้องไม่อ่านไบต์เลย และต้องบอกตามตรงว่าไม่ได้ตรวจ checksum */
  test('the default mode reads no bytes and says so', async () => {
    await makeFile('metadata-only.txt', 'metadata only check');
    const report = await auditStorage({});
    assert.equal(report.checksumVerified, false);
    assert.equal(report.bytesRead, 0);
  });

  /* ---------------- วัตถุหายและไม่ตรง ---------------- */

  /** วัตถุบนดิสก์หายต้องถูกรายงานว่าหาย */
  test('a missing local object is reported', async () => {
    const { versionId } = await makeFile('missing-local.txt', 'will be deleted');
    const version = await prisma.resourceVersion.findUniqueOrThrow({ where: { id: versionId } });
    await local.delete(version.storageKey);

    const report = await auditStorage({});
    assert.equal(findingsFor(report, 'OBJECT_MISSING', versionId).length, 1);
  });

  /** วัตถุบนที่เก็บวัตถุหายต้องถูกรายงานเช่นกัน */
  test('a missing S3 object is reported', async () => {
    const { versionId } = await makeFile('missing-s3.txt', 'will vanish from the store');
    await migrateVersion(versionId, { from: 'LOCAL', to: 'S3', dryRun: false });
    fake.objects.clear();

    const report = await auditStorage({});
    const finding = findingsFor(report, 'OBJECT_MISSING', versionId)[0];
    assert.ok(finding, 'ต้องรายงานว่าวัตถุหาย');
    assert.equal(finding?.provider, 'S3');
  });

  /** ขนาดไม่ตรงต้องถูกจับได้โดยไม่ต้องอ่านไบต์ */
  test('a size mismatch is caught without reading bytes', async () => {
    const { versionId } = await makeFile('size-drift.txt', 'the original length');
    const version = await prisma.resourceVersion.findUniqueOrThrow({ where: { id: versionId } });
    await local.put(version.storageKey, Readable.from(Buffer.from('shorter', 'utf8')));

    const report = await auditStorage({});
    assert.equal(findingsFor(report, 'SIZE_MISMATCH', versionId).length, 1);
    assert.equal(report.bytesRead, 0);
  });

  /** เนื้อหาเปลี่ยนแต่ขนาดเท่าเดิม จับได้เฉพาะเมื่อเปิดโหมด checksum */
  test('a same-size content change is only caught in checksum mode', async () => {
    const { versionId } = await makeFile('silent-drift.txt', 'authentic content!!');
    const version = await prisma.resourceVersion.findUniqueOrThrow({ where: { id: versionId } });
    const tampered = Buffer.from('TAMPERED content!!!', 'utf8');
    assert.equal(tampered.byteLength, Number(version.size), 'ของทดสอบต้องยาวเท่าเดิมพอดี');
    await local.put(version.storageKey, Readable.from(tampered));

    const quick = await auditStorage({});
    assert.equal(findingsFor(quick, 'CHECKSUM_MISMATCH', versionId).length, 0,
      'โหมดปกติจับไม่ได้ - และต้องไม่แกล้งว่าจับได้');

    const deep = await auditStorage({ checksum: true });
    assert.equal(findingsFor(deep, 'CHECKSUM_MISMATCH', versionId).length, 1);
  });

  /* ---------------- บริการล่ม ---------------- */

  /**
   * บริการล่มต้องไม่ถูกรายงานว่าไฟล์หายทุกไฟล์
   *
   * นี่คือกรณีที่การรายงานผิดอันตรายที่สุด เพราะจะทำให้คนเชื่อว่าข้อมูลหายไปแล้ว
   * และอาจตัดสินใจกู้คืนทับของที่ยังดีอยู่
   */
  test('an unavailable provider is reported as unavailable, not as missing objects', async () => {
    const { versionId } = await makeFile('outage.txt', 'still on the store');
    await migrateVersion(versionId, { from: 'LOCAL', to: 'S3', dryRun: false });
    fake.failureMode = 'UNREACHABLE';

    const report = await auditStorage({});
    assert.equal(findingsFor(report, 'OBJECT_MISSING', versionId).length, 0,
      'ต้องไม่ป้ายว่าไฟล์หายเพราะบริการล่ม');
    assert.ok(report.findings.some((finding) =>
      finding.kind === 'PROVIDER_UNAVAILABLE' && finding.provider === 'S3'));
    assert.equal(report.providerStatus.S3, 'UNAVAILABLE');
  });

  /* ---------------- ความสอดคล้องของ Resource ---------------- */

  /** Resource ที่ไม่ตรงกับเวอร์ชันปัจจุบันต้องถูกรายงาน */
  test('a Resource disagreeing with its current version is reported', async () => {
    const { resourceId, versionId } = await makeFile('denorm-drift.txt', 'denormalization drift');
    // ทำให้แถว Resource ผิดโดยตรง เลียนแบบข้อมูลที่เพี้ยนจากเหตุอื่น
    await prisma.resource.update({ where: { id: resourceId }, data: { storageProvider: 'S3' } });

    const report = await auditStorage({});
    assert.equal(findingsFor(report, 'RESOURCE_PROVIDER_MISMATCH', resourceId).length, 1);

    await prisma.resource.update({ where: { id: resourceId }, data: { storageProvider: 'LOCAL' } });
    const clean = await auditStorage({});
    assert.equal(findingsFor(clean, 'RESOURCE_PROVIDER_MISMATCH', resourceId).length, 0);
    assert.ok(versionId);
  });

  /** checksum ของ Resource ที่ไม่ตรงกับเวอร์ชันปัจจุบันต้องถูกรายงาน */
  test('a Resource checksum drifting from its current version is reported', async () => {
    const { resourceId } = await makeFile('checksum-denorm.txt', 'checksum denormalization');
    await prisma.resource.update({ where: { id: resourceId }, data: { checksum: 'deadbeef' } });

    const report = await auditStorage({});
    assert.equal(findingsFor(report, 'RESOURCE_CHECKSUM_MISMATCH', resourceId).length, 1);
  });

  /* ---------------- วัตถุกำพร้า ---------------- */

  /** วัตถุบนดิสก์ที่ไม่มีแถวใดอ้างถึงต้องถูกรายงาน แต่ไม่ถูกลบ */
  test('an unreferenced local object is reported and never deleted', async () => {
    const strayResource = crypto.randomUUID();
    const strayKey = `resources/${strayResource}/${crypto.randomUUID()}`;
    await local.prepare(strayResource);
    await local.put(strayKey, Readable.from(Buffer.from('nobody references me', 'utf8')));

    const report = await auditStorage({ orphans: true });
    assert.ok(report.findings.some((finding) =>
      finding.kind === 'ORPHAN_OBJECT' && finding.provider === 'LOCAL' && finding.detail === strayKey));
    assert.equal(await local.exists(strayKey), true, 'เครื่องมือตรวจต้องไม่ลบอะไรเลย');

    await local.removeResourceScope(strayResource);
  });

  /** วัตถุบนที่เก็บวัตถุที่ไม่มีแถวใดอ้างถึงต้องถูกรายงาน */
  test('an unreferenced S3 object is reported', async () => {
    const strayKey = `resources/${crypto.randomUUID()}/${crypto.randomUUID()}`;
    fake.objects.set(`nas/${strayKey}`, { body: Buffer.from('stray object'), lastModified: new Date() });

    const report = await auditStorage({ orphans: true });
    assert.ok(report.findings.some((finding) =>
      finding.kind === 'ORPHAN_OBJECT' && finding.provider === 'S3' && finding.detail === strayKey));
    assert.equal(fake.objects.has(`nas/${strayKey}`), true, 'ต้องไม่ลบ');
  });

  /**
   * วัตถุของเวอร์ชันเก่าไม่ใช่ขยะ
   *
   * เวอร์ชันเก่ายังถูกอ้างถึงโดยแถว ResourceVersion ของมันเอง แม้ Resource จะชี้ไปที่
   * เวอร์ชันใหม่แล้วก็ตาม การป้ายว่าเป็นขยะคือคำแนะนำให้ลบประวัติเวอร์ชันทั้งระบบ
   */
  test('historical version objects are never called orphans', async () => {
    const { resourceId, versionId } = await makeFile('history-kept.txt', 'first revision');
    const { uploadVersion } = await import('../files/file.service.js');
    await uploadVersion(owner, resourceId, Readable.from(Buffer.from('second revision', 'utf8')),
      { declaredMime: 'text/plain' }, {});

    const first = await prisma.resourceVersion.findUniqueOrThrow({ where: { id: versionId } });
    const report = await auditStorage({ orphans: true });

    assert.equal(report.findings.some((finding) =>
      finding.kind === 'ORPHAN_OBJECT' && finding.detail === first.storageKey), false,
      'วัตถุของเวอร์ชันเก่าต้องไม่ถูกป้ายว่าเป็นขยะ');
  });

  /** วัตถุใต้ temp/ ไม่ใช่วัตถุของเวอร์ชัน จึงต้องไม่ถูกนับเป็นขยะของทรัพยากร */
  test('files outside resources/ are not classified as resource orphans', async () => {
    const { resolveInsideStorage } = await import('../../core/storage.js');
    const fsp = await import('node:fs/promises');
    const tempName = `audit-probe-${crypto.randomUUID()}`;
    const tempPath = resolveInsideStorage('temp', tempName);
    await fsp.mkdir(resolveInsideStorage('temp'), { recursive: true });
    await fsp.writeFile(tempPath, 'temporary file, not a version object');

    try {
      const report = await auditStorage({ orphans: true });
      assert.equal(report.findings.some((finding) =>
        finding.kind === 'ORPHAN_OBJECT' && (finding.detail ?? '').includes(tempName)), false);
    } finally {
      await fsp.rm(tempPath, { force: true });
    }
  });
});

describe('F23-G restore-stage residue', { concurrency: 1 }, () => {
  /**
   * การกู้คืนที่ถูกขัดจังหวะทิ้งวัตถุไว้ในพื้นที่พัก
   *
   * ต้องถูกรายงานแยกจากวัตถุกำพร้าทั่วไป เพราะวิธีจัดการต่างกัน และเพราะการปนกัน
   * จะทำให้ตัวเลขวัตถุกำพร้าพุ่งขึ้นทุกครั้งที่การกู้คืนล้ม จนไม่มีใครเชื่อรายงานนั้นอีก
   */
  test('abandoned restore-stage objects are reported separately from orphans', async () => {
    const fake2 = new FakeS3Client();
    setStorageProviderForTesting('S3', new S3StorageProvider({
      region: 'auto', bucket: 'f23a-bucket', accessKeyId: 'id', secretAccessKey: 'secret',
      forcePathStyle: true, prefix: 'nas',
    }, fake2 as unknown as S3Client));

    fake2.objects.set('nas/restore-stage/run-abandoned/resources/a/b',
      { body: Buffer.from('left behind'), lastModified: new Date() });
    fake2.objects.set('nas/restore-stage/run-abandoned/resources/a/c',
      { body: Buffer.from('also left behind'), lastModified: new Date() });

    const report = await auditStorage({ orphans: true });
    const residue = report.findings.filter((finding) => finding.kind === 'RESTORE_STAGE_RESIDUE');
    assert.equal(residue.length, 1, 'ต้องรายงานเป็นรายรอบ ไม่ใช่รายวัตถุ');
    assert.match(residue[0]?.detail ?? '', /run-abandoned/u);
    assert.match(residue[0]?.detail ?? '', /2/u);

    // ต้องไม่ถูกนับปนกับวัตถุกำพร้าทั่วไป
    assert.equal(report.findings.some((finding) =>
      finding.kind === 'ORPHAN_OBJECT' && (finding.detail ?? '').includes('restore-stage')), false);
    assert.equal(fake2.objects.size, 2, 'เครื่องมือตรวจต้องไม่ลบอะไรเลย');
  });
});

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { after, before, beforeEach, describe, test } from 'node:test';
import type { S3Client } from '@aws-sdk/client-s3';
import { FakeS3Client } from '../../core/storage/fake-s3-client.js';
import { LocalStorageProvider } from '../../core/storage/local.provider.js';
import { S3StorageProvider } from '../../core/storage/s3.provider.js';
import { setStorageProviderForTesting } from '../../core/storage/index.js';
import { MANIFEST_VERSION, type ManifestObject } from './manifest.js';
import {
  cleanupStagedObjects, listStagedObjectKeys, restoreObjectsToTarget, stagedObjectKey,
} from './restore-target.js';

/**
 * ชุดตรวจชุดสำรองแบบพกพาข้ามผู้ให้บริการ (F23-F)
 *
 * **ทำไมไม่แตะข้อมูลจริงเลย** ชุดนี้สร้างวัตถุของตัวเองทั้งหมดในโฟลเดอร์ชั่วคราวและ
 * ในที่เก็บวัตถุจำลอง ไม่มีคำสั่งใดที่เลือกแถวจากฐานข้อมูลจริง บทเรียนจาก F23-E คือ
 * เครื่องมือที่เลือกข้อมูลเองโดยไม่มีขอบเขต จะเลือกข้อมูลของผู้ใช้จริงสักวันหนึ่ง
 *
 * ของปลอมอยู่ที่ชั้นขนส่งของ S3 เท่านั้น ตัวผู้ให้บริการทั้งสองรายเป็นโค้ดจริง
 */

const runRoot = path.join(os.tmpdir(), `s2nas-f23f-${process.pid}-${Date.now()}`);
const backupStorageDir = path.join(runRoot, 'backup', 'storage');
let fake: FakeS3Client;
let local: LocalStorageProvider;

interface Fixture {
  object: ManifestObject;
  body: Buffer;
}

/** สร้างวัตถุหนึ่งชิ้นในชุดสำรองจำลอง พร้อมรายการ manifest ที่ตรงกับไบต์จริง */
async function packagedObject(name: string, body: string, originalProvider: 'LOCAL' | 'S3'): Promise<Fixture> {
  const bytes = Buffer.from(body, 'utf8');
  const storageKey = `resources/${crypto.randomUUID()}/${crypto.randomUUID()}`;
  const target = path.join(backupStorageDir, storageKey);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.writeFile(target, bytes);

  return {
    body: bytes,
    object: {
      storageKey,
      size: bytes.byteLength,
      checksum: crypto.createHash('sha256').update(bytes).digest('hex'),
      resourceId: crypto.randomUUID(),
      versionNumber: 1,
      resourceVersionId: crypto.randomUUID(),
      originalProvider,
    },
  };
}

const localStageDir = (label: string) => path.join(runRoot, 'stage', label);

async function readLocal(stageDir: string, key: string): Promise<Buffer> {
  return fsp.readFile(path.join(stageDir, key));
}

async function readS3(runId: string, key: string): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const provider = new S3StorageProvider({ region: 'auto', bucket: 'f23f-bucket', accessKeyId: 'id',
    secretAccessKey: 'secret', forcePathStyle: true, prefix: 'nas' }, fake as unknown as S3Client);
  for await (const chunk of await provider.getStream(stagedObjectKey(runId, key))) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

describe('F23-F portable cross-provider restore', { concurrency: 1 }, () => {
  before(async () => {
    await fsp.mkdir(backupStorageDir, { recursive: true });
  });

  beforeEach(() => {
    fake = new FakeS3Client();
    local = new LocalStorageProvider();
    setStorageProviderForTesting('S3', new S3StorageProvider({
      region: 'auto', bucket: 'f23f-bucket', accessKeyId: 'id', secretAccessKey: 'secret',
      forcePathStyle: true, prefix: 'nas',
    }, fake as unknown as S3Client));
  });

  after(async () => {
    await fsp.rm(runRoot, { recursive: true, force: true });
    setStorageProviderForTesting('S3', null);
  });

  /* ---------------- เมทริกซ์การกู้คืนข้ามผู้ให้บริการ ---------------- */

  /** A. ชุดสำรองจากดิสก์ -> กู้ลงดิสก์ */
  test('A. a LOCAL-origin package restores to LOCAL byte for byte', async () => {
    const fixture = await packagedObject('a', 'local origin to local target', 'LOCAL');
    const stageDir = localStageDir('a');
    const result = await restoreObjectsToTarget([fixture.object], backupStorageDir,
      { provider: 'LOCAL', localStageDir: stageDir, runId: 'run-a' });

    assert.deepEqual(result.problems, []);
    assert.equal(result.restored, 1);
    assert.equal(result.verified, 1);
    assert.deepEqual(await readLocal(stageDir, fixture.object.storageKey), fixture.body);
  });

  /** B. ชุดสำรองจากดิสก์ -> กู้ขึ้นที่เก็บวัตถุ */
  test('B. a LOCAL-origin package restores to S3 byte for byte', async () => {
    const fixture = await packagedObject('b', 'local origin to object storage', 'LOCAL');
    const result = await restoreObjectsToTarget([fixture.object], backupStorageDir,
      { provider: 'S3', localStageDir: localStageDir('b'), runId: 'run-b' });

    assert.deepEqual(result.problems, []);
    assert.equal(result.verified, 1);
    assert.deepEqual(await readS3('run-b', fixture.object.storageKey), fixture.body);
  });

  /** C. ชุดสำรองที่มาจากที่เก็บวัตถุ -> กู้ลงดิสก์ */
  test('C. an S3-origin package restores to LOCAL', async () => {
    const fixture = await packagedObject('c', 'object origin to local disk', 'S3');
    const stageDir = localStageDir('c');
    const result = await restoreObjectsToTarget([fixture.object], backupStorageDir,
      { provider: 'LOCAL', localStageDir: stageDir, runId: 'run-c' });

    assert.deepEqual(result.problems, []);
    assert.deepEqual(await readLocal(stageDir, fixture.object.storageKey), fixture.body);
  });

  /** D. ชุดสำรองที่มาจากที่เก็บวัตถุ -> กู้ขึ้นที่เก็บวัตถุ */
  test('D. an S3-origin package restores to S3', async () => {
    const fixture = await packagedObject('d', 'object origin to object storage', 'S3');
    const result = await restoreObjectsToTarget([fixture.object], backupStorageDir,
      { provider: 'S3', localStageDir: localStageDir('d'), runId: 'run-d' });

    assert.deepEqual(result.problems, []);
    assert.deepEqual(await readS3('run-d', fixture.object.storageKey), fixture.body);
  });

  /** E/F. ชุดสำรองที่มีทั้งสองผู้ให้บริการปนกัน -> กู้ลงปลายทางเดียวได้ทั้งชุด */
  test('E/F. a mixed-origin package restores wholly to either target', async () => {
    const fromLocal = await packagedObject('mix-local', 'mixed package local part', 'LOCAL');
    const fromS3 = await packagedObject('mix-s3', 'mixed package object part', 'S3');
    const objects = [fromLocal.object, fromS3.object];

    const toLocalDir = localStageDir('mixed-local');
    const toLocal = await restoreObjectsToTarget(objects, backupStorageDir,
      { provider: 'LOCAL', localStageDir: toLocalDir, runId: 'run-e' });
    assert.deepEqual(toLocal.problems, []);
    assert.equal(toLocal.verified, 2);
    assert.deepEqual(await readLocal(toLocalDir, fromLocal.object.storageKey), fromLocal.body);
    assert.deepEqual(await readLocal(toLocalDir, fromS3.object.storageKey), fromS3.body);

    const toS3 = await restoreObjectsToTarget(objects, backupStorageDir,
      { provider: 'S3', localStageDir: localStageDir('mixed-s3'), runId: 'run-f' });
    assert.deepEqual(toS3.problems, []);
    assert.equal(toS3.verified, 2);
    assert.deepEqual(await readS3('run-f', fromLocal.object.storageKey), fromLocal.body);
    assert.deepEqual(await readS3('run-f', fromS3.object.storageKey), fromS3.body);
  });

  /** ปลายทางมาจากคำสั่งเสมอ ไม่ใช่จาก originalProvider ที่บันทึกไว้ */
  test('the recorded origin never decides the restore destination', async () => {
    const fixture = await packagedObject('origin-ignored', 'origin says S3', 'S3');
    const stageDir = localStageDir('origin-ignored');
    await restoreObjectsToTarget([fixture.object], backupStorageDir,
      { provider: 'LOCAL', localStageDir: stageDir, runId: 'run-origin' });

    assert.ok(fs.existsSync(path.join(stageDir, fixture.object.storageKey)),
      'ไบต์ต้องไปอยู่ที่ปลายทางที่สั่ง ไม่ใช่ที่ผู้ให้บริการเดิม');
    assert.equal(fake.objects.size, 0, 'ต้องไม่แตะที่เก็บวัตถุเลยเมื่อสั่งกู้ลงดิสก์');
  });

  /* ---------------- ประวัติเวอร์ชัน ---------------- */

  /** ทุกเวอร์ชันต้องถูกกู้ครบ ไม่ใช่เฉพาะเวอร์ชันปัจจุบัน */
  test('every version in the package is restored, not only the current one', async () => {
    const v1 = await packagedObject('v1', 'revision one content', 'LOCAL');
    const v2 = await packagedObject('v2', 'revision two content', 'LOCAL');
    const v3 = await packagedObject('v3', 'revision three content', 'S3');

    const result = await restoreObjectsToTarget([v1.object, v2.object, v3.object], backupStorageDir,
      { provider: 'S3', localStageDir: localStageDir('history'), runId: 'run-history' });

    assert.equal(result.verified, 3);
    for (const fixture of [v1, v2, v3]) {
      assert.deepEqual(await readS3('run-history', fixture.object.storageKey), fixture.body);
    }
  });

  /* ---------------- ความล้มเหลว ---------------- */

  /** ไฟล์ในชุดสำรองหาย ต้องรายงานและไม่นับว่ากู้สำเร็จ */
  test('a missing packaged object is reported and never counted as restored', async () => {
    const fixture = await packagedObject('missing', 'about to be removed', 'LOCAL');
    await fsp.rm(path.join(backupStorageDir, fixture.object.storageKey), { force: true });

    const result = await restoreObjectsToTarget([fixture.object], backupStorageDir,
      { provider: 'LOCAL', localStageDir: localStageDir('missing'), runId: 'run-missing' });

    assert.equal(result.restored, 0);
    assert.equal(result.verified, 0);
    assert.equal(result.problems.length, 1);
  });

  /**
   * ไฟล์ในชุดสำรองเสียหาย ต้องถูกจับก่อนเขียนลงปลายทาง
   *
   * ถ้าปล่อยผ่าน ระบบที่กู้คืนแล้วจะมีไฟล์เสียที่ผ่านการตรวจของตัวเอง เพราะทุกอย่าง
   * ตรงกับตัวมันเอง ความเสียหายแบบนั้นเงียบและค้นหาไม่เจอ
   */
  test('a corrupted packaged object is caught before it reaches the target', async () => {
    const fixture = await packagedObject('corrupt', 'authentic content!!', 'LOCAL');
    const tampered = Buffer.from('TAMPERED content!!!', 'utf8');
    assert.equal(tampered.byteLength, fixture.object.size, 'ของทดสอบต้องยาวเท่าเดิมพอดี');
    await fsp.writeFile(path.join(backupStorageDir, fixture.object.storageKey), tampered);

    const result = await restoreObjectsToTarget([fixture.object], backupStorageDir,
      { provider: 'S3', localStageDir: localStageDir('corrupt'), runId: 'run-corrupt' });

    assert.equal(result.restored, 0);
    assert.equal(fake.objects.size, 0, 'ไบต์ที่เสียหายต้องไม่ถูกเขียนลงปลายทางเลย');
    assert.match(result.problems[0] ?? '', /ไม่ตรงกับ manifest/u);
  });

  /** ปลายทางล่ม ต้องรายงานและไม่นับว่าสำเร็จ */
  test('an unavailable restore target is reported', async () => {
    const fixture = await packagedObject('target-down', 'target will be down', 'LOCAL');
    fake.failureMode = 'UNREACHABLE';

    const result = await restoreObjectsToTarget([fixture.object], backupStorageDir,
      { provider: 'S3', localStageDir: localStageDir('target-down'), runId: 'run-down' });

    assert.equal(result.restored, 0);
    assert.equal(result.verified, 0);
    assert.match(result.problems[0] ?? '', /เขียนลงปลายทางไม่สำเร็จ/u);
  });

  /**
   * ปลายทางรับไบต์ไม่ครบ ต้องถูกจับตอนอ่านกลับ
   *
   * นี่คือความล้มเหลวที่อันตรายที่สุด เพราะการเขียนสำเร็จโดยไม่มีข้อผิดพลาดใด ๆ
   */
  test('a target that silently truncates is caught on read-back', async () => {
    const fixture = await packagedObject('truncating', 'full payload for target', 'LOCAL');

    const truncating = new FakeS3Client();
    const original = truncating.send.bind(truncating);
    truncating.send = async (command) => {
      if (command.constructor.name === 'PutObjectCommand') {
        return original({ ...command, constructor: command.constructor,
          input: { ...command.input, Body: Readable.from(Buffer.from('cut', 'utf8')) } } as never);
      }
      return original(command);
    };
    setStorageProviderForTesting('S3', new S3StorageProvider({ region: 'auto', bucket: 'f23f-bucket',
      accessKeyId: 'id', secretAccessKey: 'secret', forcePathStyle: true, prefix: 'nas' },
      truncating as unknown as S3Client));

    const result = await restoreObjectsToTarget([fixture.object], backupStorageDir,
      { provider: 'S3', localStageDir: localStageDir('truncating'), runId: 'run-trunc' });

    assert.equal(result.restored, 1, 'การเขียนดูเหมือนสำเร็จ');
    assert.equal(result.verified, 0, 'แต่การอ่านกลับต้องจับได้ว่าไม่ครบ');
    assert.match(result.problems[0] ?? '', /ไม่ตรงกับ manifest/u);
  });

  /** ชุดที่มีวัตถุเสียหายหนึ่งชิ้น ต้องไม่ทำให้ทั้งชุดถูกรายงานว่าสำเร็จ */
  test('one bad object in a mixed package fails only that object and is reported', async () => {
    const good = await packagedObject('good', 'this one is fine', 'LOCAL');
    const bad = await packagedObject('bad', 'this one is broken', 'S3');
    await fsp.writeFile(path.join(backupStorageDir, bad.object.storageKey), Buffer.from('different bytes!!!!'));

    const stageDir = localStageDir('one-bad');
    const result = await restoreObjectsToTarget([good.object, bad.object], backupStorageDir,
      { provider: 'LOCAL', localStageDir: stageDir, runId: 'run-one-bad' });

    assert.equal(result.restored, 1, 'เขียนเฉพาะชิ้นที่ผ่านการตรวจ');
    assert.equal(result.verified, 1);
    assert.equal(result.problems.length, 1, 'ชิ้นที่เสียหายต้องถูกรายงานหนึ่งรายการ');
    assert.ok(fs.existsSync(path.join(stageDir, good.object.storageKey)), 'ชิ้นที่ดีต้องถูกกู้');
    assert.equal(fs.existsSync(path.join(stageDir, bad.object.storageKey)), false,
      'ชิ้นที่เสียหายต้องไม่ถูกเขียนลงปลายทาง');
  });

  /* ---------------- ความปลอดภัยของพื้นที่พัก ---------------- */

  /** การกู้คืนขึ้นที่เก็บวัตถุต้องอยู่ใต้คำนำหน้าของการกู้คืนเท่านั้น */
  test('restored objects live under the restore-stage prefix, never over live keys', async () => {
    const fixture = await packagedObject('isolation', 'must not overwrite live data', 'LOCAL');
    // วัตถุที่ "ใช้งานอยู่" ใช้คีย์เดียวกัน แต่ไม่มีคำนำหน้าของการกู้คืน
    fake.objects.set(`nas/${fixture.object.storageKey}`, {
      body: Buffer.from('LIVE DATA'), lastModified: new Date() });

    await restoreObjectsToTarget([fixture.object], backupStorageDir,
      { provider: 'S3', localStageDir: localStageDir('isolation'), runId: 'run-isolation' });

    assert.equal(fake.objects.get(`nas/${fixture.object.storageKey}`)?.body.toString(), 'LIVE DATA',
      'วัตถุที่ใช้งานอยู่ต้องไม่ถูกเขียนทับจากการกู้คืน');
    assert.ok(fake.objects.has(`nas/${stagedObjectKey('run-isolation', fixture.object.storageKey)}`));
  });

  /** พื้นที่พักบนที่เก็บวัตถุต้องเก็บกวาดได้หมด */
  test('staged restore objects can be listed and cleaned up completely', async () => {
    const first = await packagedObject('cleanup-1', 'cleanup content one', 'LOCAL');
    const second = await packagedObject('cleanup-2', 'cleanup content two', 'LOCAL');
    await restoreObjectsToTarget([first.object, second.object], backupStorageDir,
      { provider: 'S3', localStageDir: localStageDir('cleanup'), runId: 'run-cleanup' });

    const staged = await listStagedObjectKeys('S3', 'run-cleanup');
    assert.equal(staged.length, 2);

    const removed = await cleanupStagedObjects('S3', 'run-cleanup');
    assert.equal(removed, 2);
    assert.equal((await listStagedObjectKeys('S3', 'run-cleanup')).length, 0);
  });

  /** manifest รุ่นปัจจุบันต้องพกข้อมูลที่ทำให้ไม่ผูกกับผู้ให้บริการต้นทาง */
  test('the manifest records provider-neutral identity without leaking configuration', async () => {
    const fixture = await packagedObject('manifest', 'manifest shape check', 'S3');
    assert.equal(MANIFEST_VERSION, 2);
    assert.equal(fixture.object.originalProvider, 'S3');
    assert.ok(fixture.object.resourceVersionId);

    const serialized = JSON.stringify(fixture.object);
    for (const forbidden of ['f23f-bucket', 'secret', 'http', os.tmpdir()]) {
      assert.equal(serialized.includes(forbidden), false, `manifest ต้องไม่มี "${forbidden}"`);
    }
  });
});

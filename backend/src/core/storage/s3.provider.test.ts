import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { Readable } from 'node:stream';
import type { S3Client } from '@aws-sdk/client-s3';
import { AppError } from '../errors.js';
import { FakeS3Client, type FakeS3FailureMode } from './fake-s3-client.js';
import { S3StorageProvider, classifyS3Error } from './s3.provider.js';

/**
 * ชุดตรวจระดับคำสั่งของผู้ให้บริการ S3 (F23-C)
 *
 * **สิ่งที่ชุดนี้พิสูจน์:** คำสั่งที่ถูกประกอบขึ้นถูกต้อง คำนำหน้าถูกเติมที่เดียว
 * ความล้มเหลวแต่ละชนิดถูกแปลเป็นความหมายที่ต่างกัน และไม่มีคำสั่งใดตั้งค่าที่ทำให้
 * วัตถุเป็นสาธารณะ
 *
 * **สิ่งที่ชุดนี้ไม่พิสูจน์:** ความเข้ากันได้กับบริการจริง ชุดนี้คุยกับบริการจำลอง
 * ในหน่วยความจำ ไม่ใช่ปลายทาง S3 จริง
 */

const PREFIX = 's2-nas/prod';

function subject(prefix = PREFIX): { provider: S3StorageProvider; fake: FakeS3Client } {
  const fake = new FakeS3Client();
  const provider = new S3StorageProvider({
    region: 'auto', bucket: 'nas-bucket', accessKeyId: 'id', secretAccessKey: 'secret',
    forcePathStyle: true, prefix,
  }, fake as unknown as S3Client);
  return { provider, fake };
}

const lastOf = (fake: FakeS3Client, name: string) =>
  [...fake.commands].reverse().find((command) => command.name === name);

describe('F23-C S3 provider commands', { concurrency: 1 }, () => {
  const resourceId = crypto.randomUUID();

  /** คำสั่งเขียนต้องชี้ถังและคีย์ที่เติมคำนำหน้าแล้ว และต้องไม่มีการตั้ง ACL */
  test('put issues PutObject against the prefixed key with no ACL', async () => {
    const { provider, fake } = subject();
    const key = provider.createStorageKey(resourceId);
    const stored = await provider.put(key, Readable.from(Buffer.from('hello')));

    const command = lastOf(fake, 'PutObjectCommand');
    assert.equal(command?.input.Bucket, 'nas-bucket');
    assert.equal(command?.input.Key, `${PREFIX}/${key}`);
    assert.equal(command?.input.ACL, undefined, 'ห้ามตั้ง ACL ถังต้องเป็นแบบส่วนตัวเสมอ');
    assert.equal(stored.size, 5);
    assert.equal(stored.checksum, crypto.createHash('sha256').update('hello').digest('hex'));
  });

  /** การอ่านช่วงไบต์ต้องส่งหัวข้อ Range ไม่ใช่ดึงทั้งก้อนแล้วค่อยตัด */
  test('range reads send a bytes= header instead of fetching the whole object', async () => {
    const { provider, fake } = subject();
    const key = provider.createStorageKey(resourceId);
    await provider.put(key, Readable.from(Buffer.from('0123456789')));
    await provider.getRangeStream(key, 2, 5);

    const command = lastOf(fake, 'GetObjectCommand');
    assert.equal(command?.input.Range, 'bytes=2-5');
    assert.equal(command?.input.Key, `${PREFIX}/${key}`);
  });

  /** การอ่านทั้งก้อนต้องไม่ส่ง Range ติดไปด้วย */
  test('a full read sends no range header', async () => {
    const { provider, fake } = subject();
    const key = provider.createStorageKey(resourceId);
    await provider.put(key, Readable.from(Buffer.from('x')));
    await provider.getStream(key);
    assert.equal(lastOf(fake, 'GetObjectCommand')?.input.Range, undefined);
  });

  /** ข้อมูลของวัตถุมาจาก HeadObject ไม่ใช่การดาวน์โหลดมาวัดเอง */
  test('stat uses HeadObject', async () => {
    const { provider, fake } = subject();
    const key = provider.createStorageKey(resourceId);
    await provider.put(key, Readable.from(Buffer.from('12345')));
    const stat = await provider.stat(key);

    assert.equal(stat?.size, 5);
    assert.equal(lastOf(fake, 'HeadObjectCommand')?.input.Key, `${PREFIX}/${key}`);
    assert.equal(fake.commands.filter((c) => c.name === 'GetObjectCommand').length, 0);
  });

  /** ลบและคัดลอกต้องใช้คำสั่งของฝั่งบริการ ไม่ดึงลงมาแล้วส่งกลับขึ้นไป */
  test('delete and copy use server-side commands', async () => {
    const { provider, fake } = subject();
    const from = provider.createStorageKey(resourceId);
    const to = provider.createStorageKey(resourceId);
    await provider.put(from, Readable.from(Buffer.from('payload')));

    await provider.copy(from, to);
    const copy = lastOf(fake, 'CopyObjectCommand');
    assert.equal(copy?.input.CopySource, `nas-bucket/${PREFIX}/${from}`);
    assert.equal(copy?.input.Key, `${PREFIX}/${to}`);

    assert.equal(await provider.delete(to), true);
    assert.equal(lastOf(fake, 'DeleteObjectCommand')?.input.Key, `${PREFIX}/${to}`);
  });

  /**
   * การเก็บกวาดตามทรัพยากรต้องแบ่งหน้าจนครบ
   *
   * ถังจริงมีวัตถุเกินหนึ่งหน้าได้ง่าย การอ่านหน้าเดียวแล้วหยุดจะทิ้งวัตถุค้างไว้
   * โดยที่ระบบรายงานว่าเก็บกวาดเรียบร้อยแล้ว
   */
  test('removeResourceScope paginates until every object is deleted', async () => {
    const { provider, fake } = subject();
    fake.listPageSize = 2;
    const keys = await Promise.all(Array.from({ length: 7 }, async () => {
      const key = provider.createStorageKey(resourceId);
      await provider.put(key, Readable.from(Buffer.from('x')));
      return key;
    }));

    await provider.removeResourceScope(resourceId);

    for (const key of keys) assert.equal(await provider.exists(key), false);
    assert.ok(fake.commands.filter((c) => c.name === 'ListObjectsV2Command').length >= 4,
      'ต้องเรียกแจกแจงหลายหน้า ไม่ใช่หน้าเดียวแล้วจบ');
  });

  /** การแจกแจงต้องจำกัดอยู่ใต้คำนำหน้าของทรัพยากรนั้นเท่านั้น */
  test('removeResourceScope never lists outside its own resource prefix', async () => {
    const { provider, fake } = subject();
    await provider.removeResourceScope(resourceId);
    const list = lastOf(fake, 'ListObjectsV2Command');
    assert.equal(list?.input.Prefix, `${PREFIX}/resources/${resourceId}/`);
  });

  /** วัตถุของระบบอื่นในถังเดียวกันต้องไม่ถูกแตะ */
  test('objects outside the configured prefix are never touched', async () => {
    const { provider, fake } = subject();
    fake.objects.set('someone-else/important.dat', { body: Buffer.from('theirs'), lastModified: new Date() });
    const key = provider.createStorageKey(resourceId);
    await provider.put(key, Readable.from(Buffer.from('ours')));

    await provider.removeResourceScope(resourceId);
    assert.ok(fake.objects.has('someone-else/important.dat'), 'ข้อมูลของระบบอื่นต้องยังอยู่');
  });

  /** ไม่มีคำนำหน้า ก็ต้องไม่มี / นำหน้าติดมา */
  test('an empty prefix produces bare logical keys', async () => {
    const { provider, fake } = subject('');
    const key = provider.createStorageKey(resourceId);
    await provider.put(key, Readable.from(Buffer.from('x')));
    assert.equal(lastOf(fake, 'PutObjectCommand')?.input.Key, key);
  });

  /** คำนำหน้าต้องถูกเติมครั้งเดียว แม้เรียกซ้ำหลายรอบ */
  test('the prefix is applied exactly once per operation', async () => {
    const { provider, fake } = subject();
    const key = provider.createStorageKey(resourceId);
    await provider.put(key, Readable.from(Buffer.from('x')));
    await provider.stat(key);
    await provider.getStream(key);

    for (const command of fake.commands) {
      const physical = command.input.Key;
      if (typeof physical !== 'string') continue;
      assert.equal(physical.startsWith(`${PREFIX}/${PREFIX}`), false, 'คำนำหน้าซ้อนกัน');
      assert.equal(physical.startsWith(`${PREFIX}/`), true);
    }
  });

  /** localPathFor ต้องบอกตามตรงว่าไม่มีไฟล์บนดิสก์ */
  test('localPathFor reports honestly that there is no filesystem path', () => {
    const { provider } = subject();
    assert.equal(provider.localPathFor(), null);
  });
});

describe('F23-C S3 staged upload', { concurrency: 1 }, () => {
  const temp = path.join(os.tmpdir(), `s2nas-f23c-${process.pid}`);
  after(async () => { await fsp.rm(temp, { recursive: true, force: true }); });

  /** ไฟล์ที่พักไว้ต้องถูกสตรีมขึ้นไป พร้อมความยาวที่รู้อยู่แล้ว */
  test('commitStaged streams the staged file and declares its length', async () => {
    await fsp.mkdir(temp, { recursive: true });
    const stagedPath = path.join(temp, 'staged.bin');
    const body = Buffer.from('staged payload ที่ยาวพอสมควร', 'utf8');
    await fsp.writeFile(stagedPath, body);

    const { provider, fake } = subject();
    const key = provider.createStorageKey(crypto.randomUUID());
    await provider.commitStaged(key, {
      path: stagedPath, size: body.byteLength,
      checksum: crypto.createHash('sha256').update(body).digest('hex'),
    });

    const command = lastOf(fake, 'PutObjectCommand');
    assert.equal(command?.input.ContentLength, body.byteLength);
    assert.equal(command?.input.Key, `${PREFIX}/${key}`);
    assert.deepEqual(fake.objects.get(`${PREFIX}/${key}`)?.body, body);
  });

  /** ไฟล์ที่พักไว้ต้องยังอยู่หลังอัปโหลด - การเก็บกวาดเป็นหน้าที่ของชั้นที่สร้างมัน */
  test('commitStaged leaves the staged file for its owner to clean up', async () => {
    await fsp.mkdir(temp, { recursive: true });
    const stagedPath = path.join(temp, 'kept.bin');
    await fsp.writeFile(stagedPath, Buffer.from('keep me'));

    const { provider } = subject();
    await provider.commitStaged(provider.createStorageKey(crypto.randomUUID()), {
      path: stagedPath, size: 7, checksum: 'unused',
    });
    assert.ok(await fsp.stat(stagedPath), 'ไฟล์ที่พักไว้ต้องยังอยู่');
  });

  /** อัปโหลดล้มเหลวต้องโยนข้อผิดพลาดออกมา ไม่ใช่เงียบแล้วปล่อยให้บันทึกแถวต่อ */
  test('a failed staged upload throws so no live metadata can follow', async () => {
    await fsp.mkdir(temp, { recursive: true });
    const stagedPath = path.join(temp, 'fails.bin');
    await fsp.writeFile(stagedPath, Buffer.from('boom'));

    const { provider, fake } = subject();
    fake.failNextOnce = 'UNREACHABLE';
    await assert.rejects(
      provider.commitStaged(provider.createStorageKey(crypto.randomUUID()), {
        path: stagedPath, size: 4, checksum: 'unused',
      }),
      (error: unknown) => error instanceof AppError && error.code === 'STORAGE_UNAVAILABLE');
  });
});

describe('F23-C S3 failure mapping', { concurrency: 1 }, () => {
  const resourceId = crypto.randomUUID();

  /**
   * ความล้มเหลวของโครงสร้างพื้นฐานต้องไม่ถูกยุบเป็น "ไม่พบไฟล์"
   *
   * ถ้ายุบ ผู้ดูแลระบบจะไปไล่หาไฟล์ที่ไม่เคยหาย แทนที่จะไปแก้สิทธิ์หรือเครือข่าย
   */
  const cases: Array<[FakeS3FailureMode, string]> = [
    ['UNREACHABLE', 'STORAGE_UNAVAILABLE'],
    ['TIMEOUT', 'STORAGE_UNAVAILABLE'],
    ['ACCESS_DENIED', 'STORAGE_ACCESS_DENIED'],
    ['BUCKET_MISSING', 'STORAGE_BUCKET_MISSING'],
  ];

  for (const [mode, expected] of cases) {
    test(`${mode} surfaces as ${expected} on read`, async () => {
      const { provider, fake } = subject();
      fake.failureMode = mode;
      await assert.rejects(provider.getStream('resources/x/y'),
        (error: unknown) => error instanceof AppError && error.code === expected);
    });

    test(`${mode} surfaces as ${expected} on stat, never as absent`, async () => {
      const { provider, fake } = subject();
      fake.failureMode = mode;
      await assert.rejects(provider.stat('resources/x/y'),
        (error: unknown) => error instanceof AppError && error.code === expected);
    });
  }

  /** วัตถุที่ไม่มีอยู่จริงเป็นคนละเรื่อง - stat คืน null และการอ่านล้มเหลวแบบ 404 */
  test('a genuinely missing object reports absence, not infrastructure failure', async () => {
    const { provider } = subject();
    assert.equal(await provider.stat('resources/none/none'), null);
    assert.equal(await provider.exists('resources/none/none'), false);
    await assert.rejects(provider.getStream('resources/none/none'),
      (error: unknown) => error instanceof AppError && error.code === 'STORAGE_OBJECT_NOT_FOUND');
  });

  /** ช่วงไบต์ของวัตถุที่หายไปต้องล้มเหลวเหมือนกัน ไม่ใช่คืนช่วงว่าง */
  test('a range read on a missing object fails', async () => {
    const { provider } = subject();
    await assert.rejects(provider.getRangeStream('resources/none/none', 0, 10),
      (error: unknown) => error instanceof AppError && error.code === 'STORAGE_OBJECT_NOT_FOUND');
  });

  /** ลบไม่สำเร็จต้องคืน false ไม่ใช่แกล้งว่าสำเร็จ */
  test('a failed delete returns false rather than pretending to succeed', async () => {
    const { provider, fake } = subject();
    fake.failureMode = 'ACCESS_DENIED';
    assert.equal(await provider.delete('resources/x/y'), false);
  });

  /** ลบคีย์ที่ไม่มีอยู่ยังถือว่าสำเร็จ เพราะปลายทางที่ต้องการเป็นจริงอยู่แล้ว */
  test('deleting a missing key still counts as success', async () => {
    const { provider } = subject();
    assert.equal(await provider.delete('resources/none/none'), true);
  });

  /** คัดลอกล้มเหลวต้องโยนต่อ ไม่ใช่เงียบ */
  test('a failed copy throws', async () => {
    const { provider, fake } = subject();
    fake.failureMode = 'ACCESS_DENIED';
    await assert.rejects(provider.copy('resources/a/b', 'resources/a/c'),
      (error: unknown) => error instanceof AppError && error.code === 'STORAGE_ACCESS_DENIED');
  });

  /** เก็บกวาดล้มเหลวต้องไม่ทำให้งานหลักพัง - เหมือนผู้ให้บริการบนดิสก์ */
  test('a failed scope cleanup does not throw into the caller', async () => {
    const { provider, fake } = subject();
    fake.failureMode = 'ACCESS_DENIED';
    await provider.removeResourceScope(resourceId);
  });

  /** เขียนล้มเหลวกลางงานต้องโยนออกมา */
  test('a mid-operation put failure is reported', async () => {
    const { provider, fake } = subject();
    fake.failNextOnce = 'TIMEOUT';
    await assert.rejects(provider.put(provider.createStorageKey(resourceId), Readable.from(Buffer.from('x'))),
      (error: unknown) => error instanceof AppError && error.code === 'STORAGE_UNAVAILABLE');
  });
});

describe('F23-C S3 health', { concurrency: 1 }, () => {
  /** ถังเข้าถึงได้ = พร้อมใช้งาน และตรวจด้วยสิทธิ์ที่น้อยที่สุดที่ยืนยันได้ */
  test('an accessible bucket is READY and checked with HeadBucket only', async () => {
    const { provider, fake } = subject();
    assert.equal((await provider.health()).status, 'READY');
    assert.equal(lastOf(fake, 'HeadBucketCommand')?.input.Bucket, 'nas-bucket');
    assert.equal(fake.commands.filter((c) => c.name === 'ListObjectsV2Command').length, 0,
      'การตรวจสุขภาพต้องไม่ต้องการสิทธิ์แจกแจงวัตถุ');
  });

  const states: Array<[FakeS3FailureMode, string]> = [
    ['BUCKET_MISSING', 'UNAVAILABLE'],
    ['UNREACHABLE', 'UNAVAILABLE'],
    ['TIMEOUT', 'UNAVAILABLE'],
    ['ACCESS_DENIED', 'DEGRADED'],
  ];
  for (const [mode, expected] of states) {
    test(`${mode} reports ${expected}`, async () => {
      const { provider, fake } = subject();
      fake.failureMode = mode;
      assert.equal((await provider.health()).status, expected);
    });
  }

  /** ข้อความสถานะต้องไม่มีความลับหรือค่าตั้งที่อ่อนไหว */
  test('health detail never contains credentials or endpoint secrets', async () => {
    const { provider, fake } = subject();
    for (const mode of ['ACCESS_DENIED', 'UNREACHABLE', 'BUCKET_MISSING'] as FakeS3FailureMode[]) {
      fake.failureMode = mode;
      const serialized = JSON.stringify(await provider.health());
      for (const forbidden of ['secret', 'accessKeyId', 'nas-bucket', 's2-nas/prod', 'auto']) {
        assert.equal(serialized.includes(forbidden), false, `สถานะต้องไม่มี "${forbidden}"`);
      }
    }
  });
});

describe('F23-C S3 security posture', { concurrency: 1 }, () => {
  /**
   * ไม่มีคำสั่งใดทำให้วัตถุเป็นสาธารณะ
   *
   * ตรวจทุกคำสั่งที่ผู้ให้บริการส่งออกไปตลอดวงจรชีวิตของวัตถุหนึ่งชิ้น ไม่ใช่เฉพาะ
   * คำสั่งเขียน เพราะการเปิดสิทธิ์สาธารณะเผลอใส่ได้ในหลายคำสั่ง
   */
  test('no command ever requests public access', async () => {
    const { provider, fake } = subject();
    const resourceId = crypto.randomUUID();
    const key = provider.createStorageKey(resourceId);
    await provider.put(key, Readable.from(Buffer.from('x')));
    await provider.stat(key);
    await provider.getStream(key);
    await provider.getRangeStream(key, 0, 0);
    await provider.copy(key, provider.createStorageKey(resourceId));
    await provider.delete(key);
    await provider.removeResourceScope(resourceId);
    await provider.health();

    for (const command of fake.commands) {
      const serialized = JSON.stringify(command.input);
      assert.doesNotMatch(serialized, /public-read|AuthenticatedUsers|AllUsers/u);
      assert.equal((command.input as { ACL?: unknown }).ACL, undefined);
    }
  });

  /** ความลับต้องไม่ถูกใส่ลงในคำสั่งที่บันทึกหรือส่งต่อได้ */
  test('credentials never travel inside command inputs', async () => {
    const { provider, fake } = subject();
    await provider.put(provider.createStorageKey(crypto.randomUUID()), Readable.from(Buffer.from('x')));
    for (const command of fake.commands) {
      const serialized = JSON.stringify(command.input);
      assert.equal(serialized.includes('secret'), false);
      assert.equal(serialized.includes('accessKeyId'), false);
    }
  });
});

describe('F23-G real-world error shapes', { concurrency: 1 }, () => {
  /**
   * ข้อผิดพลาดของซ็อกเก็ตจริงไม่ได้ใส่ชื่อไว้ใน name
   *
   * **พบจากการยิงไปยังปลายทางที่ติดต่อไม่ได้จริง** ไม่ใช่จากชั้นขนส่งจำลอง
   * ตัวจำลองโยน name = 'NetworkingError' ซึ่งจำแนกถูกอยู่แล้ว แต่ของจริงโยน
   * name = 'Error' พร้อม code = 'ECONNREFUSED' ซึ่งเคยถูกจำแนกเป็น "ไม่ทราบสาเหตุ"
   * แล้วรายงานเป็น 502 แทนที่จะเป็น 503 - ชี้ให้คนไปไล่หาสาเหตุผิดที่
   */
  const networkShapes: Array<[string, Record<string, unknown>]> = [
    ['ECONNREFUSED from a closed port', { name: 'Error', code: 'ECONNREFUSED' }],
    ['ENOTFOUND from a bad hostname', { name: 'Error', code: 'ENOTFOUND' }],
    ['ETIMEDOUT from a black hole', { name: 'Error', code: 'ETIMEDOUT' }],
    ['ECONNRESET mid-transfer', { name: 'Error', code: 'ECONNRESET' }],
    ['a wrapped cause', { name: 'Error', cause: { code: 'ECONNREFUSED' } }],
  ];

  for (const [label, shape] of networkShapes) {
    test(`${label} classifies as UNREACHABLE`, () => {
      assert.equal(classifyS3Error(Object.assign(new Error('socket failure'), shape)), 'UNREACHABLE');
    });
  }

  /** ความล้มเหลวฝั่งบริการ (5xx) คือปลายทางมีปัญหา ไม่ใช่คำขอของเราผิด */
  test('a 5xx from the service classifies as UNREACHABLE', () => {
    const error = Object.assign(new Error('internal'), { name: 'InternalError', $metadata: { httpStatusCode: 503 } });
    assert.equal(classifyS3Error(error), 'UNREACHABLE');
  });

  /** ถังที่ไม่มีอยู่ตอบ 404 เหมือนวัตถุที่ไม่มีอยู่ แต่ต้องแยกออกจากกันให้ได้ */
  test('a missing bucket is not mistaken for a missing object', () => {
    const error = Object.assign(new Error('no bucket'), { name: 'NoSuchBucket', $metadata: { httpStatusCode: 404 } });
    assert.equal(classifyS3Error(error), 'BUCKET_MISSING');
  });

  /** ปัญหาเรื่องสิทธิ์ต้องไม่ถูกเหมารวมกับปัญหาเครือข่าย */
  test('credential problems classify as ACCESS_DENIED', () => {
    for (const name of ['InvalidAccessKeyId', 'SignatureDoesNotMatch', 'CredentialsProviderError']) {
      assert.equal(classifyS3Error(Object.assign(new Error('auth'), { name })), 'ACCESS_DENIED');
    }
  });
});

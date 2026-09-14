import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, test } from 'node:test';
import type { S3Client } from '@aws-sdk/client-s3';
import { logger } from '../logger.js';
import { FakeS3Client } from './fake-s3-client.js';
import { LocalStorageProvider } from './local.provider.js';
import { S3StorageProvider } from './s3.provider.js';
import {
  setStorageProviderForTesting, setWriteProviderForTesting, storageProviderDiagnostics, storageProviderFor,
} from './index.js';

/**
 * การทำให้แข็งแรงขั้นสุดท้าย (F23-G)
 *
 * ชุดนี้ตรวจสามเรื่องที่พิสูจน์ด้วยชุดอื่นได้ยาก: สถานะสุขภาพครบทุกแบบ
 * การไม่บัฟเฟอร์ทั้งไฟล์ในหน่วยความจำ และการที่ปลายทางหนึ่งล่มต้องไม่ลากอีกปลายทางลงไปด้วย
 */

const s3Of = (fake: FakeS3Client) => new S3StorageProvider({
  region: 'auto', bucket: 'hardening-bucket', accessKeyId: 'id', secretAccessKey: 'secret',
  forcePathStyle: true, prefix: 'nas',
}, fake as unknown as S3Client);

describe('F23-G health state matrix', { concurrency: 1 }, () => {
  afterEach(() => {
    setStorageProviderForTesting('S3', null);
    setWriteProviderForTesting('LOCAL');
  });

  /** ดิสก์พร้อม และยังไม่ได้ตั้งค่าที่เก็บวัตถุ - สถานะปกติของระบบที่ยังไม่ใช้ S3 */
  test('LOCAL READY with S3 NOT_CONFIGURED is the normal default posture', async () => {
    setStorageProviderForTesting('S3', null);
    const diagnostics = await storageProviderDiagnostics();
    assert.equal(diagnostics.defaultProvider, 'LOCAL');
    assert.equal(diagnostics.providers.LOCAL, 'READY');
    assert.equal(diagnostics.providers.S3, 'NOT_CONFIGURED');
  });

  /** ตั้งค่าแล้วและติดต่อได้ */
  test('a configured and reachable S3 reports READY', async () => {
    setStorageProviderForTesting('S3', s3Of(new FakeS3Client()));
    assert.equal((await storageProviderDiagnostics()).providers.S3, 'READY');
  });

  /** ตั้งค่าแล้วแต่สิทธิ์ไม่พอ - ต่างจากยังไม่ได้ตั้งค่า และต่างจากติดต่อไม่ได้ */
  test('a configured S3 with insufficient permissions reports DEGRADED', async () => {
    const fake = new FakeS3Client();
    fake.failureMode = 'ACCESS_DENIED';
    setStorageProviderForTesting('S3', s3Of(fake));
    assert.equal((await storageProviderDiagnostics()).providers.S3, 'DEGRADED');
  });

  /** ติดต่อไม่ได้ */
  test('an unreachable S3 reports UNAVAILABLE', async () => {
    const fake = new FakeS3Client();
    fake.failureMode = 'UNREACHABLE';
    setStorageProviderForTesting('S3', s3Of(fake));
    assert.equal((await storageProviderDiagnostics()).providers.S3, 'UNAVAILABLE');
  });

  /** ถังหายไปก็ใช้งานไม่ได้เช่นกัน */
  test('a missing bucket reports UNAVAILABLE', async () => {
    const fake = new FakeS3Client();
    fake.failureMode = 'BUCKET_MISSING';
    setStorageProviderForTesting('S3', s3Of(fake));
    assert.equal((await storageProviderDiagnostics()).providers.S3, 'UNAVAILABLE');
  });

  /**
   * ผู้ให้บริการที่ไม่ใช่ค่าเริ่มต้นล่ม ต้องไม่ทำให้การอ่านของอีกฝั่งพัง
   *
   * ระบบที่เก็บทุกอย่างบนดิสก์ ต้องทำงานต่อได้ตามปกติแม้ตั้งค่า S3 ไว้แล้วมันล่ม
   */
  test('an outage on the non-default provider never blocks local reads', async () => {
    const fake = new FakeS3Client();
    fake.failureMode = 'UNREACHABLE';
    setStorageProviderForTesting('S3', s3Of(fake));

    const local = new LocalStorageProvider();
    const resourceId = crypto.randomUUID();
    await local.prepare(resourceId);
    const key = local.createStorageKey(resourceId);
    try {
      await local.put(key, Readable.from(Buffer.from('still readable during an outage', 'utf8')));
      const chunks: Buffer[] = [];
      for await (const chunk of await local.getStream(key)) chunks.push(chunk as Buffer);
      assert.equal(Buffer.concat(chunks).toString(), 'still readable during an outage');

      const diagnostics = await storageProviderDiagnostics();
      assert.equal(diagnostics.providers.LOCAL, 'READY');
      assert.equal(diagnostics.providers.S3, 'UNAVAILABLE');
    } finally {
      await local.removeResourceScope(resourceId);
    }
  });

  /** สถานะที่รายงานออกไปต้องไม่มีค่าตั้งหรือความลับใด ๆ */
  test('diagnostics never expose endpoint, bucket, region or credentials', async () => {
    setStorageProviderForTesting('S3', s3Of(new FakeS3Client()));
    const serialized = JSON.stringify(await storageProviderDiagnostics());
    for (const forbidden of ['hardening-bucket', 'secret', 'auto', 'nas/', 'http']) {
      assert.equal(serialized.includes(forbidden), false, `ต้องไม่มี "${forbidden}"`);
    }
  });
});

describe('F23-G streaming memory behaviour', { concurrency: 1 }, () => {
  let local: LocalStorageProvider;
  let resourceId = '';

  beforeEach(async () => {
    local = new LocalStorageProvider();
    resourceId = crypto.randomUUID();
    await local.prepare(resourceId);
  });

  afterEach(async () => {
    await local.removeResourceScope(resourceId);
  });

  /**
   * เขียนไฟล์ 64 MB โดยหน่วยความจำต้องไม่โตตามขนาดไฟล์
   *
   * **ทำไมวัดแบบนี้:** ถ้าที่ไหนสักแห่งบัฟเฟอร์ทั้งไฟล์ หน่วยความจำที่ใช้จะโตขึ้น
   * อย่างน้อยเท่าขนาดไฟล์ การตั้งเพดานไว้ต่ำกว่าขนาดไฟล์มากจึงจับพฤติกรรมนั้นได้
   * โดยไม่ต้องพึ่งตัวเลขที่เปราะบางของเครื่องแต่ละเครื่อง
   */
  test('a 64 MB write does not grow heap anywhere near the file size', async () => {
    const chunk = Buffer.alloc(1024 * 1024, 0x41);
    const total = 64;

    global.gc?.();
    const before = process.memoryUsage().heapUsed;

    const key = local.createStorageKey(resourceId);
    const stored = await local.put(key, Readable.from((function* () {
      for (let index = 0; index < total; index += 1) yield chunk;
    })()));

    const afterWrite = process.memoryUsage().heapUsed;
    assert.equal(stored.size, total * chunk.byteLength);

    // อ่านกลับทั้งไฟล์แบบสตรีม โดยไม่เก็บสะสมไว้
    let readBytes = 0;
    for await (const piece of await local.getStream(key)) readBytes += (piece as Buffer).length;
    const afterRead = process.memoryUsage().heapUsed;

    assert.equal(readBytes, total * chunk.byteLength);

    const budget = 24 * 1024 * 1024; // น้อยกว่าขนาดไฟล์มาก
    assert.ok(afterWrite - before < budget,
      `หน่วยความจำโตขึ้น ${Math.round((afterWrite - before) / 1024 / 1024)} MB ระหว่างเขียน 64 MB`);
    assert.ok(afterRead - before < budget,
      `หน่วยความจำโตขึ้น ${Math.round((afterRead - before) / 1024 / 1024)} MB ระหว่างอ่าน 64 MB`);
  });

  /** การอ่านช่วงไบต์ต้องอ่านเฉพาะช่วงนั้น ไม่ใช่ทั้งไฟล์แล้วค่อยตัด */
  test('a range read transfers only the requested window', async () => {
    const body = Buffer.alloc(8 * 1024 * 1024, 0x42);
    const key = local.createStorageKey(resourceId);
    await local.put(key, Readable.from(body));

    let transferred = 0;
    for await (const piece of await local.getRangeStream(key, 1024, 2047)) {
      transferred += (piece as Buffer).length;
    }
    assert.equal(transferred, 1024, 'ต้องได้เฉพาะช่วงที่ขอ');
  });

  /** วัตถุบนที่เก็บวัตถุก็ต้องสตรีมเช่นกัน ไม่ใช่ดึงลงมาทั้งก้อนก่อน */
  test('object-store reads stream rather than materialise first', async () => {
    const fake = new FakeS3Client();
    const provider = s3Of(fake);
    const key = provider.createStorageKey(resourceId);
    await provider.put(key, Readable.from(Buffer.alloc(4 * 1024 * 1024, 0x43)));

    let transferred = 0;
    for await (const piece of await provider.getRangeStream(key, 0, 65535)) {
      transferred += (piece as Buffer).length;
    }
    assert.equal(transferred, 65536);
    // คำสั่งที่ถูกส่งต้องมี Range ไม่ใช่การดึงทั้งวัตถุ
    const last = [...fake.commands].reverse().find((command) => command.name === 'GetObjectCommand');
    assert.equal(last?.input.Range, 'bytes=0-65535');
  });
});

describe('F23-G storage observability', { concurrency: 1 }, () => {
  const captured: Array<{ level: string; fields: Record<string, unknown> }> = [];
  let restore: (() => void) | null = null;

  beforeEach(() => {
    captured.length = 0;
    const original = { debug: logger.debug, warn: logger.warn };
    // แทนที่เมท็อดบนตัวปูมโดยตรง เพื่อเก็บสิ่งที่ถูกบันทึกโดยไม่ขึ้นกับระดับปูมของเครื่อง
    logger.debug = ((fields: Record<string, unknown>) => {
      captured.push({ level: 'debug', fields });
    }) as typeof logger.debug;
    logger.warn = ((fields: Record<string, unknown>) => {
      captured.push({ level: 'warn', fields });
    }) as typeof logger.warn;
    restore = () => { logger.debug = original.debug; logger.warn = original.warn; };
  });

  afterEach(() => {
    restore?.();
    setStorageProviderForTesting('S3', null);
  });

  /** ปฏิบัติการที่สำเร็จต้องรายงานครบทั้งห้าอย่างที่ใช้ไล่ปัญหาได้จริง */
  test('a successful operation records provider, operation, duration, bytes and outcome', async () => {
    const local = new LocalStorageProvider();
    const resourceId = crypto.randomUUID();
    setStorageProviderForTesting('LOCAL', local);
    try {
      const observed = storageProviderFor('LOCAL');
      await observed.prepare(resourceId);
      const key = observed.createStorageKey(resourceId);
      await observed.put(key, Readable.from(Buffer.from('observable bytes', 'utf8')));

      const write = captured.find((entry) => entry.fields.operation === 'put');
      assert.ok(write, 'ต้องมีการบันทึกของ put');
      assert.equal(write.fields.provider, 'LOCAL');
      assert.equal(write.fields.outcome, 'SUCCESS');
      assert.equal(write.fields.bytes, 16);
      assert.equal(typeof write.fields.durationMs, 'number');
    } finally {
      await local.removeResourceScope(resourceId);
      setStorageProviderForTesting('LOCAL', null);
    }
  });

  /** ความล้มเหลวต้องถูกมองเห็น ไม่ใช่เงียบหายไปกับข้อยกเว้น */
  test('a failing operation is recorded as FAILURE and still throws', async () => {
    const fake = new FakeS3Client();
    fake.failureMode = 'UNREACHABLE';
    setStorageProviderForTesting('S3', s3Of(fake));

    await assert.rejects(() => storageProviderFor('S3').stat('resources/x/y'));
    const failure = captured.find((entry) => entry.fields.outcome === 'FAILURE');
    assert.ok(failure, 'ต้องมีการบันทึกความล้มเหลว');
    assert.equal(failure.fields.provider, 'S3');
    assert.equal(failure.fields.operation, 'stat');
    assert.equal(failure.level, 'warn');
  });

  /**
   * ปูมต้องไม่มีคีย์ เส้นทาง ชื่อถัง หรือกุญแจ
   *
   * คีย์มีรหัสทรัพยากรอยู่ข้างใน และปูมมักไหลไปยังระบบที่มีคนเข้าถึงได้กว้างกว่า
   */
  test('logs never contain object keys, paths, bucket names or credentials', async () => {
    const fake = new FakeS3Client();
    const provider = s3Of(fake);
    setStorageProviderForTesting('S3', provider);
    const resourceId = crypto.randomUUID();
    const observed = storageProviderFor('S3');
    const key = observed.createStorageKey(resourceId);
    await observed.put(key, Readable.from(Buffer.from('secret document content', 'utf8')));
    await observed.stat(key);

    assert.ok(captured.length > 0, 'ต้องมีการบันทึกเกิดขึ้นจริงก่อนจึงจะตรวจได้');
    const serialized = JSON.stringify(captured);
    for (const forbidden of [
      key, resourceId, 'hardening-bucket', 'secret', 'nas/', 'resources/',
      'secret document content', 'http',
    ]) {
      assert.equal(serialized.includes(forbidden), false, `ปูมต้องไม่มี "${forbidden}"`);
    }
  });
});

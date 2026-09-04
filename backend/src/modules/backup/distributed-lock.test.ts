import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { PrismaClient } from '@prisma/client';
import { env } from '../../config/env.js';
import {
  BACKUP_LOCK_NAME,
  acquireDistributedLock,
  disconnectLockClient,
  lockStatus,
  withDistributedLock,
} from './distributed-lock.ts';

/**
 * ล็อกข้ามอินสแตนซ์
 *
 * ทดสอบด้วยคอนเนกชันฐานข้อมูลแยกกันจริง ไม่ใช่ mutex ใน JS ตัวเดียวกัน
 * เพราะสิ่งที่ต้องพิสูจน์คือสองอินสแตนซ์ที่ไม่รู้จักกันเลยยังกันกันเองได้
 */
describe('ล็อกงานสำรองข้ามอินสแตนซ์', () => {
  /** จำลองอินสแตนซ์อิสระ - คนละ PrismaClient คนละคอนเนกชัน เหมือนคนละ process */
  const instance = (): PrismaClient => {
    const url = new URL(env.DATABASE_URL!);
    url.searchParams.set('connection_limit', '1');
    return new PrismaClient({ datasources: { db: { url: url.toString() } } });
  };

  const clients: PrismaClient[] = [];
  const newInstance = (): PrismaClient => {
    const client = instance();
    clients.push(client);
    return client;
  };

  after(async () => {
    for (const client of clients) await client.$disconnect();
    await disconnectLockClient();
  });

  test('สองอินสแตนซ์ใช้คนละคอนเนกชันจริง', async () => {
    const a = newInstance();
    const b = newInstance();
    const idOf = async (client: PrismaClient) => {
      const rows = await client.$queryRawUnsafe<Array<Record<string, unknown>>>('SELECT CONNECTION_ID() AS id');
      return String(rows[0]!.id);
    };
    assert.notEqual(await idOf(a), await idOf(b), 'ต้องเป็นคนละคอนเนกชัน มิฉะนั้นการทดสอบไม่มีความหมาย');
  });

  test('อินสแตนซ์ที่สองเริ่มงานที่ชนกันไม่ได้ จนกว่าตัวแรกจะปล่อย', async () => {
    const a = newInstance();
    const b = newInstance();

    const held = await acquireDistributedLock('BACKUP', 1, a);
    try {
      // ตัวที่สองต้องถูกปฏิเสธอย่างสุภาพ ไม่ใช่ค้างรอ
      await assert.rejects(
        () => acquireDistributedLock('BACKUP', 1, b),
        (error: { code?: string; statusCode?: number }) =>
          error.code === 'BACKUP_OPERATION_BUSY' && error.statusCode === 409,
      );
    } finally {
      await held.release();
    }

    // ปล่อยแล้วตัวที่สองต้องทำงานได้ทันที
    const second = await acquireDistributedLock('BACKUP', 2, b);
    await second.release();
  });

  test('งานคนละชนิดก็ยังกันกัน - สำรอง กู้คืน ซ้อม และเก็บกวาดใช้ล็อกเดียวกัน', async () => {
    const a = newInstance();
    const b = newInstance();

    for (const [first, second] of [
      ['BACKUP', 'REHEARSAL'],
      ['RETENTION', 'REHEARSAL'],
      ['RESTORE_STAGE', 'BACKUP'],
      ['REHEARSAL', 'RETENTION'],
    ] as const) {
      const held = await acquireDistributedLock(first, 1, a);
      try {
        await assert.rejects(
          () => acquireDistributedLock(second, 1, b),
          (error: { code?: string }) => error.code === 'BACKUP_OPERATION_BUSY',
          `${first} ต้องกัน ${second}`,
        );
      } finally {
        await held.release();
      }
    }
  });

  test('ปลดล็อกใน finally เสมอ แม้งานจะโยน error', async () => {
    const a = newInstance();
    const b = newInstance();

    await assert.rejects(() =>
      withDistributedLock('BACKUP', async () => {
        throw new Error('งานล้มเหลวกลางคัน');
      }),
    );

    // ถ้าล็อกค้าง ตัวนี้จะขอไม่ได้
    const after = await acquireDistributedLock('BACKUP', 2, b);
    await after.release();
    await a.$disconnect();
  });

  test('ปล่อยซ้ำต้องไม่พังและไม่ปลดล็อกของคนอื่น', async () => {
    const a = newInstance();
    const b = newInstance();

    const held = await acquireDistributedLock('BACKUP', 1, a);
    await held.release();
    await held.release(); // ครั้งที่สองต้องเป็น no-op

    const other = await acquireDistributedLock('BACKUP', 2, b);
    try {
      // การเรียก release ของ handle เดิมอีกครั้ง ต้องไม่ไปแตะล็อกที่ b ถืออยู่
      await held.release();
      const status = await lockStatus(b);
      assert.equal(status.held, true, 'ล็อกของอินสแตนซ์อื่นต้องยังอยู่');
    } finally {
      await other.release();
    }
  });

  /**
   * คุณสมบัติสำคัญ: advisory lock ผูกกับคอนเนกชัน
   * process ที่ตายไปทำให้คอนเนกชันปิด และฐานข้อมูลปลดล็อกให้เองโดยไม่ต้องมีใครมาเก็บกวาด
   */
  test('คอนเนกชันปิดแล้วล็อกถูกปลดเอง - กันล็อกค้างเมื่อ process ตาย', async () => {
    const dying = instance();
    const survivor = newInstance();

    await acquireDistributedLock('BACKUP', 1, dying);
    await assert.rejects(
      () => acquireDistributedLock('BACKUP', 1, survivor),
      (error: { code?: string }) => error.code === 'BACKUP_OPERATION_BUSY',
    );

    // จำลอง process ตาย: ปิดคอนเนกชันโดยไม่เรียก RELEASE_LOCK
    await dying.$disconnect();

    const recovered = await acquireDistributedLock('BACKUP', 5, survivor);
    await recovered.release();
  });

  test('สถานะล็อกอ่านได้และบอกได้ว่าใครถือ', async () => {
    const a = newInstance();

    const idle = await lockStatus(a);
    assert.equal(idle.name, BACKUP_LOCK_NAME);
    assert.equal(idle.held, false);

    const held = await acquireDistributedLock('BACKUP', 1, a);
    try {
      const busy = await lockStatus(a);
      assert.equal(busy.held, true);
      assert.equal(busy.heldByThisProcess, true);
    } finally {
      await held.release();
    }
  });
});

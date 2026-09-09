import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { InferenceQueueFullError, PriorityInferenceQueue } from './inference-queue.js';

/**
 * การอดตายของคำค้นผู้ใช้ (F20)
 *
 * พบจาก live QA จริง: ระหว่างไล่ทำดัชนีเบื้องหลัง คำค้นและแม้แต่ /api/health
 * รอจนหมดเวลาเป็นนาที เพราะการอนุมานทั้งหมดต่อคิวแบบมาก่อนได้ก่อน
 */

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
};

describe('คิวจัดลำดับความสำคัญของการอนุมาน', () => {
  test('คำค้นของผู้ใช้ได้ช่องถัดไป แซงงานเบื้องหลังที่รออยู่ก่อน', async () => {
    const queue = new PriorityInferenceQueue(16);
    const order: string[] = [];
    const gate = deferred();

    // งานที่กำลังรันอยู่ - ต้องไม่ถูกตัดกลางคัน
    const running = queue.submit('BACKGROUND', async () => { await gate.promise; order.push('running'); });
    // งานเบื้องหลังที่เข้าคิวไว้ก่อนคำค้น
    const queued = [1, 2, 3].map((n) => queue.submit('BACKGROUND', async () => { order.push(`bg${n}`); }));
    // คำค้นมาทีหลังสุด แต่ต้องได้ก่อน
    const interactive = queue.submit('INTERACTIVE', async () => { order.push('query'); });

    gate.resolve();
    await Promise.all([running, ...queued, interactive]);

    assert.equal(order[0], 'running', 'งานที่รันอยู่ต้องจบก่อน ไม่ถูกยกเลิก');
    assert.equal(order[1], 'query', 'คำค้นต้องได้ช่องถัดไปทันทีหลังงานที่รันอยู่จบ');
    assert.deepEqual(order.slice(2), ['bg1', 'bg2', 'bg3'], 'งานเบื้องหลังทำต่อตามลำดับเดิม');
  });

  test('คำค้นหลายรายการเรียงแบบมาก่อนได้ก่อนในระดับเดียวกัน', async () => {
    const queue = new PriorityInferenceQueue(16);
    const order: string[] = [];
    const gate = deferred();
    const running = queue.submit('BACKGROUND', async () => { await gate.promise; });
    const jobs = [
      queue.submit('BACKGROUND', async () => { order.push('bg'); }),
      queue.submit('INTERACTIVE', async () => { order.push('q1'); }),
      queue.submit('INTERACTIVE', async () => { order.push('q2'); }),
      queue.submit('FOREGROUND', async () => { order.push('fg'); }),
    ];
    gate.resolve();
    await Promise.all([running, ...jobs]);
    assert.deepEqual(order, ['q1', 'q2', 'fg', 'bg'], 'INTERACTIVE > FOREGROUND > BACKGROUND, FIFO ภายในระดับเดียวกัน');
  });

  test('งานเบื้องหลังยังได้ทำต่อเมื่อไม่มีคำค้นค้างอยู่', async () => {
    const queue = new PriorityInferenceQueue(16);
    const done: string[] = [];
    await Promise.all([1, 2, 3].map((n) => queue.submit('BACKGROUND', async () => { done.push(`bg${n}`); })));
    assert.deepEqual(done, ['bg1', 'bg2', 'bg3'], 'ไม่มีการอดตายของงานเบื้องหลัง');
  });

  test('คิวมีเพดาน ไม่โตไม่จำกัด', async () => {
    const queue = new PriorityInferenceQueue(3);
    const gate = deferred();
    const running = queue.submit('BACKGROUND', async () => { await gate.promise; });
    const accepted = [1, 2, 3].map(() => queue.submit('BACKGROUND', async () => {}));
    await assert.rejects(
      () => queue.submit('BACKGROUND', async () => {}),
      (error: unknown) => error instanceof InferenceQueueFullError && error.code === 'SEMANTIC_QUEUE_FULL',
    );
    gate.resolve();
    await Promise.all([running, ...accepted]);
    // มีที่ว่างแล้วต้องรับงานใหม่ได้อีก
    await queue.submit('BACKGROUND', async () => {});
    assert.equal(queue.stats().waiting, 0);
  });

  test('งานที่ล้มเหลวไม่ทำให้คิวค้างถาวร', async () => {
    const queue = new PriorityInferenceQueue(8);
    const gate = deferred();
    const running = queue.submit('BACKGROUND', async () => { await gate.promise; });
    const failing = queue.submit('BACKGROUND', async () => { throw new Error('provider พัง'); });
    const after = queue.submit('INTERACTIVE', async () => 'ok');
    gate.resolve();
    await assert.rejects(() => failing, /provider พัง/);
    assert.equal(await after, 'ok', 'คิวต้องเดินต่อหลังงานล้มเหลว');
    await running;
    assert.equal(queue.stats().running, false);
  });

  test('รายงานสถานะคิวแยกตามระดับความสำคัญ', async () => {
    const queue = new PriorityInferenceQueue(8);
    const gate = deferred();
    const running = queue.submit('BACKGROUND', async () => { await gate.promise; });
    const waiting = [
      queue.submit('BACKGROUND', async () => {}),
      queue.submit('INTERACTIVE', async () => {}),
    ];
    const stats = queue.stats();
    assert.equal(stats.running, true);
    assert.equal(stats.waiting, 2);
    assert.equal(stats.waitingByPriority.INTERACTIVE, 1);
    assert.equal(stats.waitingByPriority.BACKGROUND, 1);
    gate.resolve();
    await Promise.all([running, ...waiting]);
  });
});

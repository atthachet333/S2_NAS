import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { describe, test } from 'node:test';
import { Readable } from 'node:stream';
import type { StorageProvider } from './provider.js';

/**
 * ชุดตรวจสัญญาของผู้ให้บริการพื้นที่จัดเก็บ (F23-C)
 *
 * **ทำไมต้องเป็นชุดเดียวกัน:** ถ้าแต่ละผู้ให้บริการมีชุดทดสอบของตัวเอง ความต่างของ
 * พฤติกรรมจะถูกเขียนลงไปในชุดทดสอบเองโดยไม่มีใครสังเกต แล้วชั้นธุรกิจที่เขียนโดย
 * สมมติว่าทุกผู้ให้บริการเหมือนกันจะพังเฉพาะกับบางผู้ให้บริการ ชุดนี้จึงรันด้วยข้อความ
 * ยืนยันชุดเดียวกันทุกราย สิ่งที่ต่างกันได้มีแค่การนำไปใช้ ไม่ใช่ความหมาย
 *
 * ผู้เรียกส่งฟังก์ชันสร้างผู้ให้บริการเข้ามา และชุดนี้ใช้คีย์ที่ไม่ซ้ำกับใครเสมอ
 * จึงรันพร้อมกับของจริงบนเครื่องเดียวกันได้โดยไม่แตะข้อมูลของใคร
 */

export interface ContractSubject {
  name: string;
  create(): Promise<{ provider: StorageProvider; cleanup: () => Promise<void> }>;
}

async function collect(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

const sha256 = (data: Buffer): string => crypto.createHash('sha256').update(data).digest('hex');

export function runStorageProviderContract(subject: ContractSubject): void {
  describe(`storage provider contract: ${subject.name}`, { concurrency: 1 }, () => {
    const resourceId = crypto.randomUUID();
    const keyFor = (provider: StorageProvider) => provider.createStorageKey(resourceId);

    /** 1/14. เขียนไฟล์เล็กแล้วอ่านกลับมาได้เท่าเดิม และ checksum ตรงกับที่คำนวณเอง */
    test('a small object round-trips with a matching checksum', async () => {
      const { provider, cleanup } = await subject.create();
      try {
        const body = Buffer.from('สวัสดี S2 NAS storage contract', 'utf8');
        const key = keyFor(provider);
        await provider.prepare(resourceId);
        const stored = await provider.put(key, Readable.from(body));

        assert.equal(stored.size, body.byteLength);
        assert.equal(stored.checksum, sha256(body));
        assert.deepEqual(await collect(await provider.getStream(key)), body);
      } finally { await cleanup(); }
    });

    /**
     * 2. ไฟล์ศูนย์ไบต์
     *
     * ชั้นอัปโหลดของ NAS ปฏิเสธไฟล์ว่างก่อนถึงผู้ให้บริการอยู่แล้ว แต่สัญญาต้องนิยาม
     * พฤติกรรมไว้ให้ตรงกัน มิฉะนั้นเครื่องมือย้ายข้อมูลจะเจอความต่างในวันที่เจอไฟล์แบบนี้
     */
    test('a zero-byte object is stored and read back as empty', async () => {
      const { provider, cleanup } = await subject.create();
      try {
        const key = keyFor(provider);
        const stored = await provider.put(key, Readable.from(Buffer.alloc(0)));
        assert.equal(stored.size, 0);
        assert.equal(stored.checksum, sha256(Buffer.alloc(0)));
        assert.equal((await collect(await provider.getStream(key))).byteLength, 0);
        assert.equal((await provider.stat(key))?.size, 0);
      } finally { await cleanup(); }
    });

    /** 4/5/6. ช่วงไบต์ต้นทาง กลางทาง และปลายทาง ต้องรวมปลายทั้งสองด้านเสมอ */
    test('ranges are inclusive at the start, middle and end', async () => {
      const { provider, cleanup } = await subject.create();
      try {
        const body = Buffer.from('0123456789abcdef', 'utf8');
        const key = keyFor(provider);
        await provider.put(key, Readable.from(body));

        assert.equal((await collect(await provider.getRangeStream(key, 0, 3))).toString(), '0123');
        assert.equal((await collect(await provider.getRangeStream(key, 4, 7))).toString(), '4567');
        assert.equal((await collect(await provider.getRangeStream(key, 10, 15))).toString(), 'abcdef');
        // ปลายทางเลยขนาดจริง: ได้เท่าที่มี ไม่ใช่ข้อผิดพลาด - ตรงกับความหมายของ HTTP
        assert.equal((await collect(await provider.getRangeStream(key, 12, 999))).toString(), 'cdef');
      } finally { await cleanup(); }
    });

    /** 8/9/10. ข้อมูลของวัตถุ และการมีอยู่จริง */
    test('stat and exists report presence truthfully', async () => {
      const { provider, cleanup } = await subject.create();
      try {
        const body = Buffer.from('stat me', 'utf8');
        const key = keyFor(provider);
        await provider.put(key, Readable.from(body));

        const stat = await provider.stat(key);
        assert.equal(stat?.size, body.byteLength);
        assert.ok(stat?.mtime instanceof Date);
        assert.equal(await provider.exists(key), true);

        const absent = keyFor(provider);
        assert.equal(await provider.stat(absent), null);
        assert.equal(await provider.exists(absent), false);
      } finally { await cleanup(); }
    });

    /** 11/12. ลบแล้วต้องหายจริง และลบสิ่งที่ไม่มีอยู่ต้องไม่ใช่ความล้มเหลว */
    test('delete removes the object and is idempotent', async () => {
      const { provider, cleanup } = await subject.create();
      try {
        const key = keyFor(provider);
        await provider.put(key, Readable.from(Buffer.from('bye')));
        assert.equal(await provider.delete(key), true);
        assert.equal(await provider.exists(key), false);
        // ลบซ้ำ: ปลายทางที่ผู้เรียกต้องการคือ "ไม่มีวัตถุนี้แล้ว" ซึ่งเป็นจริงอยู่
        assert.equal(await provider.delete(key), true);
        assert.equal(await provider.delete(keyFor(provider)), true);
      } finally { await cleanup(); }
    });

    /** 13. เขียนทับคีย์เดิมต้องได้เนื้อหาใหม่ทั้งหมด ไม่ใช่เนื้อหาผสม */
    test('writing the same key twice replaces the content entirely', async () => {
      const { provider, cleanup } = await subject.create();
      try {
        const key = keyFor(provider);
        await provider.put(key, Readable.from(Buffer.from('first content that is long')));
        await provider.put(key, Readable.from(Buffer.from('second')));
        const read = await collect(await provider.getStream(key));
        assert.equal(read.toString(), 'second');
        assert.equal((await provider.stat(key))?.size, 6);
      } finally { await cleanup(); }
    });

    /**
     * 15. ชื่อไฟล์ที่ผู้ใช้ตั้งไม่เกี่ยวกับคีย์
     *
     * คีย์ถูกสร้างจากรหัสทรัพยากรเท่านั้น ชื่อไฟล์ภาษาไทยหรืออีโมจิจึงไม่มีทาง
     * ทำให้คีย์ผิดรูป และการเปลี่ยนชื่อไฟล์ไม่ทำให้ต้องย้ายวัตถุ
     */
    test('object keys are independent of user-facing filenames', async () => {
      const { provider, cleanup } = await subject.create();
      try {
        const key = keyFor(provider);
        assert.match(key, /^resources\/[0-9a-f-]{36}\/[0-9a-f-]{36}$/u);
        const body = Buffer.from('ใบกำกับภาษี 🧾 ปี 2569', 'utf8');
        await provider.put(key, Readable.from(body));
        assert.deepEqual(await collect(await provider.getStream(key)), body);
      } finally { await cleanup(); }
    });

    /** 16. วัตถุขนาดใหญ่ต้องผ่านแบบสตรีม และ checksum ต้องยังตรง */
    test('a large streamed object keeps its size and checksum', async () => {
      const { provider, cleanup } = await subject.create();
      try {
        const chunk = Buffer.alloc(64 * 1024, 0x41);
        const total = 64; // 4 MB
        const hash = crypto.createHash('sha256');
        for (let i = 0; i < total; i += 1) hash.update(chunk);

        const key = keyFor(provider);
        const source = Readable.from((function* () {
          for (let i = 0; i < total; i += 1) yield chunk;
        })());
        const stored = await provider.put(key, source);

        assert.equal(stored.size, chunk.byteLength * total);
        assert.equal(stored.checksum, hash.digest('hex'));
        assert.equal((await provider.stat(key))?.size, chunk.byteLength * total);
      } finally { await cleanup(); }
    });

    /** 17. อ่านวัตถุที่ไม่มีอยู่ต้องล้มเหลวอย่างชัดเจน ไม่ใช่คืนสตรีมว่าง */
    test('reading a missing object fails instead of yielding empty content', async () => {
      const { provider, cleanup } = await subject.create();
      try {
        const missing = keyFor(provider);
        await assert.rejects(async () => collect(await provider.getStream(missing)));
        await assert.rejects(async () => collect(await provider.getRangeStream(missing, 0, 10)));
      } finally { await cleanup(); }
    });

    /** 18. ต้นทางที่พังกลางคัน ต้องไม่จบลงด้วยวัตถุที่ดูเหมือนสมบูรณ์ */
    test('a source that fails mid-stream does not leave a complete object', async () => {
      const { provider, cleanup } = await subject.create();
      try {
        const key = keyFor(provider);
        const failing = Readable.from((function* () {
          yield Buffer.alloc(1024, 0x42);
          throw new Error('ต้นทางขาดกลางคัน');
        })());

        await assert.rejects(provider.put(key, failing));
        const stat = await provider.stat(key);
        // อาจเหลือวัตถุบางส่วนหรือไม่มีเลย แต่ต้องไม่ใช่ขนาดเต็มที่ตั้งใจเขียน
        if (stat) assert.notEqual(stat.size, 2048);
      } finally { await cleanup(); }
    });

    /** 19. อ่านพร้อมกันหลายเส้นต้องได้เนื้อหาเดียวกันครบทุกเส้น */
    test('concurrent reads of one object all return the same content', async () => {
      const { provider, cleanup } = await subject.create();
      try {
        const body = Buffer.from('concurrent-read-payload'.repeat(64), 'utf8');
        const key = keyFor(provider);
        await provider.put(key, Readable.from(body));

        const reads = await Promise.all(Array.from({ length: 8 }, async () =>
          collect(await provider.getStream(key))));
        for (const read of reads) assert.deepEqual(read, body);
      } finally { await cleanup(); }
    });

    /** 20. เขียนคีย์ที่ไม่ซ้ำกันพร้อมกัน ต้องไม่กวนกันเอง */
    test('concurrent writes to unique keys stay independent', async () => {
      const { provider, cleanup } = await subject.create();
      try {
        const items = Array.from({ length: 8 }, (_, index) => ({
          key: keyFor(provider),
          body: Buffer.from(`payload-${index}-`.repeat(32), 'utf8'),
        }));
        await Promise.all(items.map((item) => provider.put(item.key, Readable.from(item.body))));
        for (const item of items) {
          assert.deepEqual(await collect(await provider.getStream(item.key)), item.body);
        }
      } finally { await cleanup(); }
    });

    /** เก็บกวาดตามขอบเขตของทรัพยากร ต้องไม่แตะวัตถุของทรัพยากรอื่น */
    test('removing a resource scope leaves other resources untouched', async () => {
      const { provider, cleanup } = await subject.create();
      try {
        const mineKey = provider.createStorageKey(resourceId);
        const otherResource = crypto.randomUUID();
        const otherKey = provider.createStorageKey(otherResource);
        await provider.put(mineKey, Readable.from(Buffer.from('mine')));
        await provider.put(otherKey, Readable.from(Buffer.from('theirs')));

        await provider.removeResourceScope(resourceId);
        assert.equal(await provider.exists(mineKey), false);
        assert.equal(await provider.exists(otherKey), true, 'ทรัพยากรอื่นต้องไม่ถูกลบตามไปด้วย');
        await provider.removeResourceScope(otherResource);
      } finally { await cleanup(); }
    });

    /** คัดลอกต้องได้เนื้อหาเท่ากันและต้นทางต้องยังอยู่ */
    test('copy duplicates content without disturbing the source', async () => {
      const { provider, cleanup } = await subject.create();
      try {
        const from = keyFor(provider);
        const to = keyFor(provider);
        const body = Buffer.from('copy-me', 'utf8');
        await provider.put(from, Readable.from(body));
        await provider.copy(from, to);
        assert.deepEqual(await collect(await provider.getStream(to)), body);
        assert.deepEqual(await collect(await provider.getStream(from)), body);
      } finally { await cleanup(); }
    });

    /** สุขภาพต้องตอบด้วยคำศัพท์ของสัญญา และต้องไม่มีความลับหลุดออกมา */
    test('health answers in contract vocabulary without leaking secrets', async () => {
      const { provider, cleanup } = await subject.create();
      try {
        const health = await provider.health();
        assert.ok(['READY', 'NOT_CONFIGURED', 'DEGRADED', 'UNAVAILABLE'].includes(health.status));
        const serialized = JSON.stringify(health);
        assert.doesNotMatch(serialized, /secret|accessKey|password|AKIA/iu);
      } finally { await cleanup(); }
    });
  });
}

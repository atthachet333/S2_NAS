import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { URGENCY_TONE, trashCountdown, urgencyForDays } from './trash-countdown.ts';

/**
 * ตัวนับเวลาที่เหลือของถังขยะ
 *
 * ค่าที่ใช้ตัดสินมาจาก expiresAt ที่ backend คำนวณไว้แล้ว หน้าจอไม่รู้จัก "14 วัน"
 * เทสจึงสร้าง expiresAt จากนโยบายสมมติหลายค่า เพื่อพิสูจน์ว่าหน้าจอตามค่าจริงเสมอ
 */
const NOW = new Date('2026-09-03T12:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

/** จำลองสิ่งที่ backend ส่งมา: deletedAt + retentionDays */
const expiresFrom = (deletedDaysAgo: number, retentionDays: number): string =>
  new Date(NOW.getTime() - deletedDaysAgo * DAY_MS + retentionDays * DAY_MS).toISOString();

describe('เกณฑ์ความเร่งด่วน', () => {
  test('เขียวเมื่อเหลือ 8 วันขึ้นไป', () => {
    for (const days of [8, 10, 14, 30, 365]) {
      assert.equal(urgencyForDays(days), 'GREEN', `${days} วันต้องเป็นเขียว`);
    }
  });

  test('เหลืองเมื่อเหลือ 3 ถึง 7 วัน', () => {
    for (const days of [3, 4, 5, 6, 7]) {
      assert.equal(urgencyForDays(days), 'YELLOW', `${days} วันต้องเป็นเหลือง`);
    }
  });

  test('แดงเมื่อเหลือ 2 วันหรือน้อยกว่า', () => {
    for (const days of [2, 1, 0]) {
      assert.equal(urgencyForDays(days), 'RED', `${days} วันต้องเป็นแดง`);
    }
  });

  test('เส้นแบ่งอยู่ตรงที่ตกลงไว้พอดี', () => {
    assert.equal(urgencyForDays(8), 'GREEN');
    assert.equal(urgencyForDays(7), 'YELLOW');
    assert.equal(urgencyForDays(3), 'YELLOW');
    assert.equal(urgencyForDays(2), 'RED');
  });
});

describe('ข้อความและระดับของแต่ละรายการ', () => {
  const at = (days: number) => trashCountdown(new Date(NOW.getTime() + days * DAY_MS).toISOString(), NOW);

  test('เหลือหลายวันแสดงจำนวนวันจริง', () => {
    assert.deepEqual(
      [at(14), at(8)].map((row) => [row!.label, row!.urgency]),
      [['เหลือ 14 วัน', 'GREEN'], ['เหลือ 8 วัน', 'GREEN']],
    );
    assert.deepEqual(
      [at(7), at(3)].map((row) => [row!.label, row!.urgency]),
      [['เหลือ 7 วัน', 'YELLOW'], ['เหลือ 3 วัน', 'YELLOW']],
    );
    assert.deepEqual(
      [at(2), at(1)].map((row) => [row!.label, row!.urgency]),
      [['เหลือ 2 วัน', 'RED'], ['เหลือ 1 วัน', 'RED']],
    );
  });

  test('เหลือไม่ถึงหนึ่งวันต้องไม่แสดง "เหลือ 0 วัน"', () => {
    const soon = at(0.5);
    assert.equal(soon!.label, 'ลบอัตโนมัติวันนี้');
    assert.equal(soon!.urgency, 'RED');
    assert.equal(soon!.expired, false);
    assert.ok(!soon!.label.includes('0 วัน'), 'ข้อความต้องไม่ทำให้เข้าใจผิดว่ายังมีเวลา');
  });

  test('เลยกำหนดแล้วแต่ยังไม่ถูกลบ ต้องบอกตามจริง', () => {
    const overdue = at(-2);
    assert.equal(overdue!.label, 'รอลบอัตโนมัติ');
    assert.equal(overdue!.urgency, 'RED');
    assert.equal(overdue!.expired, true);
    assert.equal(overdue!.remainingDays, null, 'ต้องไม่แสดงจำนวนวันติดลบ');
  });

  test('ปิดการลบอัตโนมัติแล้วต้องไม่แสดงตัวนับ', () => {
    assert.equal(trashCountdown(null, NOW), null);
  });

  test('ทุกระดับมีข้อความกำกับเสมอ ไม่สื่อด้วยสีอย่างเดียว', () => {
    for (const days of [14, 7, 2, 0.5, -1]) {
      const row = at(days);
      assert.ok(row && row.label.length > 0, `${days} ต้องมีข้อความ`);
    }
  });
});

describe('ตามค่านโยบายที่เปลี่ยนได้ ไม่ฝังจำนวนวันไว้ในหน้าจอ', () => {
  test('ลบเมื่อวานภายใต้นโยบาย 14 วัน เหลือ 13 วัน', () => {
    const row = trashCountdown(expiresFrom(1, 14), NOW);
    assert.equal(row!.label, 'เหลือ 13 วัน');
    assert.equal(row!.urgency, 'GREEN');
  });

  test('รายการเดียวกันภายใต้นโยบาย 30 วัน เหลือ 29 วัน', () => {
    const row = trashCountdown(expiresFrom(1, 30), NOW);
    assert.equal(row!.label, 'เหลือ 29 วัน');
    assert.equal(row!.urgency, 'GREEN');
  });

  test('นโยบายที่สั้นลงทำให้รายการเดิมเร่งด่วนขึ้นทันที', () => {
    // ลบไปแล้ว 12 วัน: นโยบาย 14 วันเหลือ 2 วัน (แดง) แต่ 30 วันเหลือ 18 วัน (เขียว)
    assert.equal(trashCountdown(expiresFrom(12, 14), NOW)!.urgency, 'RED');
    assert.equal(trashCountdown(expiresFrom(12, 30), NOW)!.urgency, 'GREEN');
  });

  test('ไม่มีจำนวนวันของนโยบายฝังอยู่ในโค้ดหน้าจอ', () => {
    const source = readFileSync(new URL('./trash-countdown.ts', import.meta.url), 'utf8');
    // ตรวจเฉพาะโค้ด ไม่รวมคอมเมนต์ - คอมเมนต์อธิบายนโยบายได้ แต่โค้ดต้องไม่ยึดตัวเลขไว้
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    assert.ok(!/\b14\b/.test(code), 'ห้ามฝังจำนวนวันของนโยบายไว้ในโค้ดหน้าจอ');
    assert.ok(!/\b30\b/.test(code));
  });
});

describe('โทนสีใช้ชุดเดิมของระบบ', () => {
  test('ทุกระดับมีโทนสีที่ถูกต้อง', () => {
    assert.equal(URGENCY_TONE.GREEN, 'success');
    assert.equal(URGENCY_TONE.YELLOW, 'warning');
    assert.equal(URGENCY_TONE.RED, 'danger');
  });
});

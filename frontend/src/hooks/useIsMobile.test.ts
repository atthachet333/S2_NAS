import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { COMPACT_LIST_QUERY, MOBILE_QUERY, readIsMobile } from './useIsMobile.ts';

/**
 * จุดตัดของการแสดงผล (F24-G)
 *
 * **ทำไมมีสองจุดตัด ไม่ใช่จุดเดียว:** สองคำถามนี้ไม่ใช่คำถามเดียวกัน
 * - "นี่คือโทรศัพท์ไหม" ตัดสินว่าจะใช้แถบนำทางล่างและแผ่นกระทำ
 * - "กว้างพอให้ตารางอ่านออกไหม" ตัดสินว่าจะใช้ตารางหรือการ์ด
 *
 * **หลักฐานที่ทำให้เลือก 1024px:** วัดสัดส่วนของตารางที่มองไม่เห็นและต้องเลื่อนไปหา
 * ด้วยชื่อไฟล์ภาษาไทยจริง ได้ 56% ที่ 768px · 45% ที่ 1024px · 31% ที่ 1280px
 * ที่ 768px ผู้ใช้ต้องเลื่อนเพื่อดูข้อมูลเกินครึ่ง ซึ่งแย่กว่าการ์ดที่เห็นครบในครั้งเดียว
 */
const globals = globalThis as unknown as { window?: unknown };
let saved: unknown;

/** จำลอง matchMedia ที่ตัดสินจากความกว้างที่กำหนด */
function withViewportWidth(width: number): void {
  saved = globals.window;
  globals.window = {
    matchMedia: (query: string) => {
      const max = Number(/max-width:\s*(\d+)px/.exec(query)?.[1] ?? Number.POSITIVE_INFINITY);
      return { matches: width <= max };
    },
  };
}

describe('F24-G จุดตัดของการแสดงผล', { concurrency: 1 }, () => {
  afterEach(() => { globals.window = saved; });

  test('โทรศัพท์ทุกขนาดในเมทริกซ์ถือเป็นมือถือ', () => {
    for (const width of [320, 375, 390, 430]) {
      withViewportWidth(width);
      assert.equal(readIsMobile(MOBILE_QUERY), true, `${width}px ควรเป็นมือถือ`);
      globals.window = saved;
    }
  });

  test('แท็บเล็ตและเดสก์ท็อปไม่ใช่มือถือ - ไม่ได้แถบนำทางล่าง', () => {
    for (const width of [768, 1024, 1366, 1920]) {
      withViewportWidth(width);
      assert.equal(readIsMobile(MOBILE_QUERY), false, `${width}px ไม่ควรเป็นมือถือ`);
      globals.window = saved;
    }
  });

  /** iPad แนวตั้งต้องได้การ์ด เพราะตารางซ่อนข้อมูลไป 56% ที่ความกว้างนี้ */
  test('ต่ำกว่า 1024px ใช้การ์ดแทนตาราง', () => {
    for (const width of [320, 375, 430, 768, 900, 1023]) {
      withViewportWidth(width);
      assert.equal(readIsMobile(COMPACT_LIST_QUERY), true, `${width}px ควรใช้การ์ด`);
      globals.window = saved;
    }
  });

  test('ตั้งแต่ 1024px ขึ้นไปใช้ตารางเต็มรูปแบบเหมือนเดิม', () => {
    for (const width of [1024, 1280, 1366, 1920]) {
      withViewportWidth(width);
      assert.equal(readIsMobile(COMPACT_LIST_QUERY), false, `${width}px ควรใช้ตาราง`);
      globals.window = saved;
    }
  });

  /**
   * ช่วง 768-1023px คือช่วงที่สองเกณฑ์ตอบต่างกัน
   *
   * ได้การ์ดที่อ่านง่าย แต่ยังใช้แถบนำทางบนและเมนูของเดสก์ท็อป
   * ซึ่งเป็นสิ่งที่ต้องการสำหรับแท็บเล็ตและหน้าต่างเดสก์ท็อปที่ย่อลง
   */
  test('ช่วงแท็บเล็ตได้การ์ด แต่ไม่ได้แถบนำทางของโทรศัพท์', () => {
    withViewportWidth(768);
    assert.equal(readIsMobile(COMPACT_LIST_QUERY), true, 'ใช้การ์ด');
    assert.equal(readIsMobile(MOBILE_QUERY), false, 'ไม่ใช่โทรศัพท์');
  });

  /** ไม่มี matchMedia ก็ต้องไม่พัง และไม่ควรเดาว่าเป็นจอเล็ก */
  test('สภาพแวดล้อมที่ไม่มี matchMedia ถือว่าเป็นจอกว้าง', () => {
    globals.window = undefined;
    assert.equal(readIsMobile(MOBILE_QUERY), false);
    assert.equal(readIsMobile(COMPACT_LIST_QUERY), false);
  });
});

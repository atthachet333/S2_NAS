import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { SHARE_STATUS, expiringSoon, shareExpiryText } from './public-share.ts';

/**
 * F18 - ข้อความสถานะของลิงก์แชร์ภายนอก
 *
 * ลิงก์เหล่านี้เปิดเอกสารสู่ภายนอก คนที่ดูรายการต้องอ่านสถานะออกทันที
 * ป้ายที่กำกวมหรือพึ่งสีอย่างเดียวจะทำให้ลิงก์ที่ควรถูกปิดค้างอยู่ต่อไป
 */
describe('F18 สถานะลิงก์แชร์ภายนอก', () => {
  test('ทุกสถานะมีข้อความภาษาไทย ไม่ใช่รหัสดิบ', () => {
    for (const [code, style] of Object.entries(SHARE_STATUS)) {
      assert.ok(style.label.length > 0, `${code} ต้องมีข้อความ`);
      assert.ok(!style.label.includes('_'), `${code} ต้องไม่แสดงรหัสดิบ`);
      assert.match(style.label, /[ก-๙]/, `${code} ต้องเป็นภาษาไทย`);
    }
  });

  /**
   * สีไม่ใช่ตัวบอกสถานะเพียงลำพัง
   *
   * ผู้ใช้ที่แยกสีไม่ได้ต้องรู้ว่าลิงก์ไหนยังเปิดอยู่เท่ากับทุกคน
   * มิฉะนั้นคนกลุ่มนั้นจะปิดลิงก์ผิดตัว หรือปล่อยลิงก์ที่ควรปิดไว้
   */
  test('ทุกสถานะมีทั้งข้อความและสี ไม่ใช่สีอย่างเดียว', () => {
    for (const [code, style] of Object.entries(SHARE_STATUS)) {
      assert.ok(style.className.length > 0, `${code} ต้องมีสไตล์`);
      assert.notEqual(style.label, '', `${code} ต้องไม่พึ่งสีอย่างเดียว`);
    }
  });

  test('สถานะที่ต่างกันมีข้อความต่างกัน', () => {
    const labels = Object.values(SHARE_STATUS).map((style) => style.label);
    assert.equal(new Set(labels).size, labels.length, 'สองสถานะต้องไม่ใช้ข้อความเดียวกัน');
  });
});

describe('F18 ข้อความอายุของลิงก์', () => {
  /** ตรึงเป็นเวลาต้นวันตามเขตเวลาเครื่อง เพื่อให้ "วันนี้/พรุ่งนี้" คำนวณได้แน่นอน */
  const now = new Date(2026, 8, 7, 9, 0, 0);
  const inDays = (days: number) =>
    new Date(now.getTime() + days * 86_400_000).toISOString();

  /** "ไม่หมดอายุ" ต้องอ่านแล้วสะดุด ไม่ใช่กลมกลืนไปกับตัวเลือกอื่น */
  test('ลิงก์ที่ไม่หมดอายุถูกระบุอย่างชัดเจน', () => {
    assert.equal(shareExpiryText(null, now), 'ไม่หมดอายุ');
  });

  test('บอกจำนวนวันที่เหลือเมื่อใกล้หมดอายุ', () => {
    // อีกสองชั่วโมง = ยังเป็นวันเดียวกัน ต้องไม่บอกว่า "พรุ่งนี้"
    assert.equal(shareExpiryText(new Date(now.getTime() + 2 * 3_600_000).toISOString(), now), 'หมดอายุวันนี้');
    assert.equal(shareExpiryText(inDays(1), now), 'หมดอายุพรุ่งนี้');
    assert.equal(shareExpiryText(inDays(5), now), 'หมดอายุใน 5 วัน');
  });

  test('บอกวันที่จริงเมื่อยังอีกนาน', () => {
    const text = shareExpiryText(inDays(60), now);
    assert.match(text, /^หมดอายุ /);
    assert.ok(!text.includes('ใน'), 'ระยะยาวควรบอกวันที่ ไม่ใช่จำนวนวัน');
  });

  test('ลิงก์ที่หมดอายุแล้วบอกตรง ๆ', () => {
    assert.equal(shareExpiryText(inDays(-1), now), 'หมดอายุแล้ว');
  });

  test('ลิงก์ที่ไม่หมดอายุไม่ถือว่าใกล้หมดอายุ', () => {
    assert.equal(expiringSoon(null, now), false, 'ลิงก์ถาวรต้องไม่โผล่ในรายการ "ใกล้หมดอายุ"');
    assert.equal(expiringSoon(inDays(3), now), true);
    assert.equal(expiringSoon(inDays(30), now), false);
    assert.equal(expiringSoon(inDays(-1), now), false, 'ที่หมดไปแล้วไม่ใช่ "ใกล้หมด"');
  });
});

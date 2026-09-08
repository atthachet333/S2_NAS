import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { focusDecision } from './focus-param';

describe('พารามิเตอร์ focus ในหน้าไฟล์', () => {
  test('ไม่มีพารามิเตอร์ = ไม่ต้องทำอะไร', () => {
    assert.equal(focusDecision({ focusId: null, handledId: null, entryIds: ['a'] }), 'IDLE');
  });

  test('มีพารามิเตอร์และเจอทรัพยากร = จัดการ', () => {
    assert.equal(focusDecision({ focusId: 'a', handledId: null, entryIds: ['a', 'b'] }), 'HANDLE');
  });

  /**
   * ด่านกันวงวน - ข้อที่พังจริงมาก่อน
   *
   * หลังสั่ง replace navigation แล้ว render ถัดไปยังเห็น focus=a อยู่ ถ้าไม่จำว่า
   * จัดการไปแล้ว effect จะสั่ง select/openDetails ซ้ำไม่จบ
   */
  test('id เดิมที่จัดการไปแล้ว ไม่ถูกจัดการซ้ำ', () => {
    assert.equal(focusDecision({ focusId: 'a', handledId: 'a', entryIds: ['a', 'b'] }), 'ALREADY_HANDLED');
  });

  test('รายการยังว่างอยู่ = รอ ไม่ใช่ยอมแพ้', () => {
    assert.equal(focusDecision({ focusId: 'a', handledId: null, entryIds: [] }), 'WAITING_FOR_ENTRIES');
  });

  test('โหลดเสร็จแล้วแต่ไม่มีทรัพยากรนี้ = ไม่ต้องเลือกอะไร', () => {
    assert.equal(focusDecision({ focusId: 'zz', handledId: null, entryIds: ['a', 'b'] }), 'NOT_PRESENT');
  });

  test('id ใหม่หลังจัดการ id เก่าไปแล้ว ยังถูกจัดการ', () => {
    assert.equal(focusDecision({ focusId: 'b', handledId: 'a', entryIds: ['a', 'b'] }), 'HANDLE');
  });

  test('กลับมาที่ id เดิมหลังล้างความจำแล้ว ถูกจัดการอีกครั้ง', () => {
    // ผู้ใช้กดลิงก์เดิมซ้ำ: IDLE หนึ่งรอบล้าง handledId แล้วรอบถัดไปต้องทำงาน
    assert.equal(focusDecision({ focusId: null, handledId: 'a', entryIds: ['a'] }), 'IDLE');
    assert.equal(focusDecision({ focusId: 'a', handledId: null, entryIds: ['a'] }), 'HANDLE');
  });

  test('ความจำถูกตรวจก่อนความว่างของรายการ', () => {
    // รายการว่างชั่วคราวระหว่าง refetch ต้องไม่ล้างสถานะว่าจัดการไปแล้ว
    assert.equal(focusDecision({ focusId: 'a', handledId: 'a', entryIds: [] }), 'ALREADY_HANDLED');
  });
});

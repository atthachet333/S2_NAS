import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  UPDATE_ACTION_TEXT, UPDATE_AVAILABLE_TEXT, evaluateUpdateReadiness, shouldActivateNow,
} from './pwa-update.ts';

/**
 * การอัปเดตต้องไม่ทำลายงานที่ผู้ใช้กำลังทำอยู่ (F24-B)
 *
 * **ความเสียหายที่กันไว้:** การเปลี่ยนไปใช้เวอร์ชันใหม่คือการโหลดหน้าใหม่ทั้งหน้า
 * ไฟล์ที่อัปโหลดไปได้ครึ่งทางจะหายทันทีและเริ่มใหม่หมด บนเครือข่ายมือถือที่ช้า
 * นี่อาจเป็นงานหลายนาทีที่หายไปเพราะจังหวะที่ระบบเลือกเอง ไม่ใช่เพราะผู้ใช้ทำอะไรผิด
 */
describe('F24-B จังหวะการอัปเดตแอป', { concurrency: 1 }, () => {
  test('ไม่มีอะไรค้างอยู่ ก็อัปเดตได้ทันที', () => {
    const readiness = evaluateUpdateReadiness(0);
    assert.equal(readiness.canActivate, true);
    assert.equal(readiness.message, UPDATE_AVAILABLE_TEXT);
    assert.equal(readiness.reason, undefined);
  });

  test('ระหว่างอัปโหลดต้องไม่อัปเดต และต้องบอกเหตุผล', () => {
    const readiness = evaluateUpdateReadiness(1);
    assert.equal(readiness.canActivate, false);
    assert.equal(readiness.reason, 'UPLOAD_ACTIVE');
    assert.ok(readiness.message.includes('อัปโหลด'), 'ข้อความต้องบอกว่าติดที่การอัปโหลด');
  });

  test('อัปโหลดหลายไฟล์ก็ยังถือว่าไม่ปลอดภัย', () => {
    assert.equal(evaluateUpdateReadiness(7).canActivate, false);
  });

  /** ยังไม่มีเวอร์ชันใหม่ ก็ไม่มีอะไรให้ทำ */
  test('ไม่มีเวอร์ชันใหม่ก็ไม่โหลดหน้าใหม่', () => {
    assert.equal(shouldActivateNow({ updateAvailable: false, userRequested: true, activeUploads: 0 }), false);
  });

  /** ห้ามโหลดหน้าใหม่เองโดยที่ผู้ใช้ไม่ได้สั่ง */
  test('ผู้ใช้ต้องเป็นคนสั่งเท่านั้น', () => {
    assert.equal(shouldActivateNow({ updateAvailable: true, userRequested: false, activeUploads: 0 }), false);
  });

  test('สั่งแล้วและว่างแล้ว จึงเปลี่ยนเวอร์ชัน', () => {
    assert.equal(shouldActivateNow({ updateAvailable: true, userRequested: true, activeUploads: 0 }), true);
  });

  /**
   * กดตอนที่ยังอัปโหลดอยู่ ระบบต้องจำไว้แล้วทำให้เองเมื่อเสร็จ
   *
   * ถ้าไม่จำ ผู้ใช้ที่กดไปแล้วจะเห็นว่าไม่มีอะไรเกิดขึ้น และต้องคอยกลับมากดใหม่เอง
   */
  test('เจตนาของผู้ใช้ถูกจำไว้จนกว่าจะปลอดภัย', () => {
    const intent = { updateAvailable: true, userRequested: true };
    assert.equal(shouldActivateNow({ ...intent, activeUploads: 2 }), false, 'ยังอัปโหลดอยู่');
    assert.equal(shouldActivateNow({ ...intent, activeUploads: 0 }), true, 'อัปโหลดเสร็จแล้วต้องทำให้เอง');
  });

  test('ข้อความที่แสดงตรงตามที่ตกลงไว้', () => {
    assert.equal(UPDATE_AVAILABLE_TEXT, 'มีเวอร์ชันใหม่พร้อมใช้งาน');
    assert.equal(UPDATE_ACTION_TEXT, 'อัปเดตตอนนี้');
  });
});

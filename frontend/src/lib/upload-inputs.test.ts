import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  UPLOAD_EVENTS, exceedsUploadLimit, uploadInputAttributes, uploadLimitMessage,
} from './upload-inputs.ts';

/**
 * คำใบ้ของตัวเลือกไฟล์บนมือถือ (F24-D)
 *
 * **สิ่งที่ชุดนี้พิสูจน์และไม่พิสูจน์:** พิสูจน์ว่าเราส่งคำใบ้ที่ถูกต้องให้เบราว์เซอร์
 * **ไม่ได้พิสูจน์ว่ากล้องเปิดขึ้นมาจริง** เพราะนั่นขึ้นกับระบบปฏิบัติการและรุ่นของเบราว์เซอร์
 * ซึ่งทดสอบได้ด้วยเครื่องจริงเท่านั้น การมี attribute ไม่เท่ากับการรองรับ
 */
describe('F24-D คำใบ้ของตัวเลือกไฟล์', { concurrency: 1 }, () => {
  test('ไฟล์ทั่วไปไม่จำกัดชนิด และเลือกได้หลายไฟล์', () => {
    const attributes = uploadInputAttributes('file');
    assert.equal(attributes.accept, undefined, 'ไม่ควรกรองชนิด เพราะระบบรับเอกสารทุกแบบ');
    assert.equal(attributes.capture, undefined);
    assert.equal(attributes.multiple, true);
  });

  test('รูปภาพกรองเหลือเฉพาะรูป และยังเลือกได้หลายรูป', () => {
    const attributes = uploadInputAttributes('photo');
    assert.equal(attributes.accept, 'image/*');
    assert.equal(attributes.capture, undefined, 'เลือกจากคลังภาพ ไม่ใช่เปิดกล้อง');
    assert.equal(attributes.multiple, true);
  });

  /** ถ่ายเอกสารขอกล้องหลัง เพราะเอกสารอยู่บนโต๊ะ ไม่ใช่หน้าผู้ใช้ */
  test('ถ่ายเอกสารขอกล้องหลังและได้ทีละภาพ', () => {
    const attributes = uploadInputAttributes('camera');
    assert.equal(attributes.accept, 'image/*');
    assert.equal(attributes.capture, 'environment');
    assert.equal(attributes.multiple, false, 'กล้องคืนภาพเดียวต่อการเปิดหนึ่งครั้ง');
  });

  test('ชื่อเหตุการณ์คงที่ ไม่สะกดต่างกันระหว่างผู้ส่งกับผู้รับ', () => {
    assert.equal(UPLOAD_EVENTS.file, 's2-upload-file');
    assert.equal(UPLOAD_EVENTS.photo, 's2-upload-photo');
    assert.equal(UPLOAD_EVENTS.camera, 's2-upload-camera');
  });
});

describe('F24-D ขีดจำกัดขนาดไฟล์', { concurrency: 1 }, () => {
  const LIMIT = 100 * 1024 * 1024;

  test('ไฟล์ที่ใหญ่เกินถูกปฏิเสธจากข้อมูลกำกับ ไม่ต้องอ่านเนื้อไฟล์', () => {
    assert.equal(exceedsUploadLimit(LIMIT + 1, LIMIT), true);
    assert.equal(exceedsUploadLimit(LIMIT, LIMIT), false, 'เท่ากับขีดจำกัดพอดียังรับได้');
    assert.equal(exceedsUploadLimit(1024, LIMIT), false);
  });

  /** ไม่รู้ขีดจำกัด ก็ไม่ควรปฏิเสธของที่เซิร์ฟเวอร์อาจรับได้ */
  test('ไม่มีขีดจำกัดที่เชื่อถือได้ ให้ปล่อยผ่านไปให้เซิร์ฟเวอร์ตัดสิน', () => {
    assert.equal(exceedsUploadLimit(999, 0), false);
    assert.equal(exceedsUploadLimit(999, Number.NaN), false);
  });

  test('ข้อความบอกขีดจำกัดเป็นหน่วยที่คนอ่านเข้าใจ', () => {
    assert.ok(uploadLimitMessage(100 * 1024 * 1024).includes('100 MB'));
    assert.ok(uploadLimitMessage(2 * 1024 * 1024 * 1024).includes('2 GB'));
    assert.ok(!uploadLimitMessage(LIMIT).includes('104857600'), 'ห้ามแสดงจำนวนไบต์ดิบ');
  });
});

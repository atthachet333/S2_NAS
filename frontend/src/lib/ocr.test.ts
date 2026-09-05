import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  ocrAccuracyNotice,
  ocrActionFor,
  ocrStatusLabel,
  ocrSummary,
  textSourceBadge,
  type OcrStateDto,
} from './ocr.ts';

const base: OcrStateDto = {
  eligible: true,
  reason: null,
  kind: 'SCANNED_PDF',
  status: null,
  textSource: null,
  ocrRequested: false,
  ocrCompletedAt: null,
  ocrConfidence: null,
  ocrPageCount: null,
  truncated: false,
  engineAvailable: true,
};

describe('ปุ่มที่ควรแสดง', () => {
  test('เอกสารที่ยังไม่เคยสแกน เสนอให้สแกน', () => {
    const action = ocrActionFor({ ...base, status: 'NO_TEXT' });
    assert.equal(action.kind, 'START');
    assert.equal(action.label, 'สแกนข้อความด้วย OCR');
  });

  test('เอกสารที่สแกนไปแล้ว ต้องไม่แสดงปุ่มเดิมราวกับยังไม่เคยทำอะไร', () => {
    const action = ocrActionFor({ ...base, status: 'READY', textSource: 'OCR', ocrRequested: true });
    assert.equal(action.kind, 'RETRY');
    assert.equal(action.label, 'สแกนข้อความใหม่');
  });

  test('กำลังทำงานอยู่ ปุ่มต้องบอกว่ากำลังทำ', () => {
    assert.equal(ocrActionFor({ ...base, status: 'PENDING' }).kind, 'BUSY');
    assert.equal(ocrActionFor({ ...base, status: 'PROCESSING' }).kind, 'BUSY');
  });

  test('สแกนไม่สำเร็จ เสนอให้ลองใหม่', () => {
    const action = ocrActionFor({ ...base, status: 'FAILED', ocrRequested: true });
    assert.equal(action.kind, 'RETRY');
    assert.match(action.label, /ลองสแกนอีกครั้ง/);
  });

  test('ไฟล์ที่ไม่เข้าเงื่อนไข ไม่มีปุ่ม และบอกเหตุผล', () => {
    const action = ocrActionFor({
      ...base,
      eligible: false,
      reason: 'เอกสารนี้มีข้อความอยู่แล้ว จึงค้นหาได้โดยไม่ต้องใช้ OCR',
    });
    assert.equal(action.kind, 'NONE');
    assert.match(action.label, /มีข้อความอยู่แล้ว/);
  });

  test('ไม่มีเครื่องมือในเครื่อง ต้องไม่แสดงปุ่มที่กดแล้วล้มเหลวเสมอ', () => {
    const action = ocrActionFor({ ...base, status: 'NO_TEXT', engineAvailable: false });
    assert.equal(action.kind, 'NONE');
    assert.match(action.label, /ยังไม่ได้ตั้งค่า/);
  });

  test('ไม่มีข้อมูลก็ไม่มีปุ่ม', () => {
    assert.equal(ocrActionFor(null).kind, 'NONE');
  });
});

describe('ข้อความสถานะ', () => {
  test('ครอบคลุมทุกสถานะที่ผู้ใช้เห็นได้', () => {
    assert.equal(ocrStatusLabel({ ...base, status: 'NO_TEXT' }), 'พร้อมสแกนข้อความ');
    assert.equal(ocrStatusLabel({ ...base, status: 'PENDING' }), 'รอสแกนข้อความ');
    assert.equal(ocrStatusLabel({ ...base, status: 'PROCESSING' }), 'กำลังสแกนข้อความ');
    assert.equal(
      ocrStatusLabel({ ...base, status: 'READY', textSource: 'OCR', ocrRequested: true }),
      'สแกนข้อความแล้ว',
    );
    assert.equal(
      ocrStatusLabel({ ...base, status: 'NO_TEXT', ocrRequested: true }),
      'สแกนแล้วแต่ไม่พบข้อความ',
    );
    assert.equal(ocrStatusLabel({ ...base, status: 'FAILED', ocrRequested: true }), 'สแกนไม่สำเร็จ');
  });

  test('ไฟล์ที่ไม่เข้าเงื่อนไขไม่มีสถานะให้แสดง', () => {
    assert.equal(ocrStatusLabel({ ...base, eligible: false }), null);
  });
});

describe('การไม่นำเสนอ OCR ว่าเป็นความจริงที่ยืนยันแล้ว', () => {
  test('เตือนเฉพาะข้อความที่มาจากการอ่านภาพ', () => {
    assert.match(ocrAccuracyNotice('OCR') ?? '', /อาจไม่ถูกต้องทั้งหมด/);
  });

  test('ไม่เตือนกับข้อความที่ฝังอยู่ในไฟล์จริง', () => {
    // การเตือนกับทุกอย่างเท่ากับไม่ได้เตือนอะไรเลย
    assert.equal(ocrAccuracyNotice('NATIVE_TEXT'), null);
    assert.equal(ocrAccuracyNotice(null), null);
  });

  test('ป้ายในผลการค้นหาบอกที่มาเฉพาะเมื่อมาจาก OCR', () => {
    assert.equal(textSourceBadge('OCR'), 'OCR');
    assert.equal(textSourceBadge('NATIVE_TEXT'), null);
  });

  test('สรุปผลเรียกความมั่นใจว่า "ความมั่นใจของระบบ" ไม่ใช่ "ความแม่นยำ"', () => {
    const summary = ocrSummary({ ...base, textSource: 'OCR', ocrPageCount: 3, ocrConfidence: 87.5 })!;
    assert.match(summary, /3 หน้า/);
    assert.match(summary, /ความมั่นใจของระบบ 87.5%/);
    assert.ok(!summary.includes('ความแม่นยำ'), 'ห้ามนำเสนอเป็นการรับประกันความถูกต้อง');
  });

  test('บอกตามจริงเมื่ออ่านได้ไม่ครบ', () => {
    const summary = ocrSummary({ ...base, textSource: 'OCR', truncated: true })!;
    assert.match(summary, /ไม่ครบทั้งฉบับ/);
  });

  test('ไม่มีอะไรน่าบอกก็ไม่เติมข้อความให้รก', () => {
    assert.equal(ocrSummary({ ...base, textSource: 'NATIVE_TEXT' }), null);
    assert.equal(ocrSummary(null), null);
  });
});

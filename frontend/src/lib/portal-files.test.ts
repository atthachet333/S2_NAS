import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { canPreviewInBrowser, unsupportedPreviewMessage } from './portal-files.ts';

/**
 * การเปิดดูเอกสารในพื้นที่ลูกค้า
 *
 * ลูกค้าไม่ควรต้องดาวน์โหลดรูปภาพหรือ PDF เพียงเพื่อจะดูว่ามันคืออะไร
 * แต่ก็ต้องไม่ถูกชวนให้กดสิ่งที่จบลงด้วยหน้าจอว่างเปล่า
 */
describe('ชนิดที่แสดงตัวอย่างได้', () => {
  test('รูปภาพและ PDF ดูได้ในเบราว์เซอร์', () => {
    for (const name of ['ใบเสร็จ.pdf', 'หน้าปก.png', 'รูปถ่าย.jpg', 'โลโก้.webp']) {
      assert.equal(canPreviewInBrowser(name), true, `${name} ควรดูได้`);
    }
  });

  test('ข้อความและ CSV ดูได้', () => {
    assert.equal(canPreviewInBrowser('บันทึก.txt'), true);
    assert.equal(canPreviewInBrowser('รายการ.csv'), true);
  });

  test('เอกสาร Office ยังดูในเบราว์เซอร์ไม่ได้', () => {
    for (const name of ['สัญญา.docx', 'งบ.xlsx', 'นำเสนอ.pptx']) {
      assert.equal(canPreviewInBrowser(name), false, `${name} ต้องไม่อ้างว่าดูได้`);
    }
  });

  test('ไฟล์ที่อาจมีสคริปต์ฝังอยู่ไม่ถูกเปิดในเบราว์เซอร์', () => {
    // ใช้กติกาชุดเดียวกับฝั่งภายใน - ไฟล์เหล่านี้ให้ดาวน์โหลดแทน
    assert.equal(canPreviewInBrowser('หน้าเว็บ.html'), false);
    assert.equal(canPreviewInBrowser('ไอคอน.svg'), false);
  });
});

describe('ข้อความเมื่อแสดงตัวอย่างไม่ได้', () => {
  test('บอกให้ดาวน์โหลดก็ต่อเมื่อดาวน์โหลดได้จริง', () => {
    const allowed = unsupportedPreviewMessage(true);
    assert.match(allowed, /ไม่รองรับการแสดงตัวอย่าง/);
    assert.match(allowed, /ดาวน์โหลดไฟล์เพื่อเปิดด้วยโปรแกรมที่รองรับ/);
  });

  test('ไม่ชวนให้ดาวน์โหลดเมื่อดาวน์โหลดไม่ได้ - นั่นคือการส่งผู้ใช้ไปชนกำแพง', () => {
    const denied = unsupportedPreviewMessage(false);
    assert.match(denied, /ไม่รองรับการแสดงตัวอย่าง/);
    assert.ok(!denied.includes('ดาวน์โหลดไฟล์เพื่อเปิด'));
    assert.match(denied, /ติดต่อผู้ดูแล/);
  });
});

describe('เนื้อหาไฟล์ถูกดึงพร้อมการยืนยันตัวตนเสมอ', () => {
  test('ไม่มีการเปิดลิงก์ตรงไปยัง endpoint เนื้อหา', () => {
    const source = readFileSync(new URL('./portal-files.ts', import.meta.url), 'utf8');
    assert.ok(source.includes('authorizedFetch'), 'ต้องดึงผ่านตัวที่แนบ access token');
    // window.open ใช้ได้เฉพาะกับ blob ที่ดึงมาแล้ว ไม่ใช่กับ URL ของ API โดยตรง
    assert.ok(!/window\.open\(\s*url/.test(source), 'ห้ามเปิด URL ของ API ตรง ๆ เพราะไม่มี token ติดไปด้วย');
  });
});

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import {
  indexStatusLabel,
  matchReasonLabel,
  splitSnippet,
  uploadStateTone,
} from './search-content.ts';

describe('เหตุผลที่ผลลัพธ์ตรงกับคำค้น', () => {
  test('ทุกเหตุผลมีข้อความภาษาไทยกำกับ', () => {
    assert.equal(matchReasonLabel('NAME'), 'ตรงกับชื่อไฟล์');
    assert.equal(matchReasonLabel('TAG'), 'ตรงกับแท็ก');
    assert.equal(matchReasonLabel('REMARK'), 'ตรงกับหมายเหตุ');
    assert.equal(matchReasonLabel('CONTENT'), 'ตรงกับเนื้อหาเอกสาร');
  });

  test('ค่าที่ไม่รู้จักไม่แสดงอะไรเลย แทนที่จะแสดงรหัสดิบ', () => {
    assert.equal(matchReasonLabel('SOMETHING_NEW'), null);
    assert.equal(matchReasonLabel(null), null);
  });
});

describe('การตัดตัวอย่างข้อความเพื่อเน้นคำ', () => {
  test('แยกส่วนที่ตรงกับคำค้นออกมาเป็นชิ้นของตัวเอง', () => {
    const parts = splitSnippet('รวม ภาษี ที่ต้องชำระ', 'ภาษี');
    assert.deepEqual(
      parts.map((part) => [part.text, part.highlight]),
      [['รวม ', false], ['ภาษี', true], [' ที่ต้องชำระ', false]],
    );
  });

  test('เน้นได้หลายตำแหน่งในข้อความเดียว', () => {
    const parts = splitSnippet('ภาษี และ ภาษี', 'ภาษี');
    assert.equal(parts.filter((part) => part.highlight).length, 2);
  });

  test('ไม่สนตัวพิมพ์ใหญ่เล็กของภาษาอังกฤษ', () => {
    const parts = splitSnippet('Invoice Number', 'invoice');
    assert.equal(parts[0]!.highlight, true);
    assert.equal(parts[0]!.text, 'Invoice', 'ต้องคงตัวพิมพ์เดิมของข้อความต้นฉบับไว้');
  });

  test('ไม่มีคำที่ตรงกันก็คืนข้อความทั้งก้อนเป็นชิ้นเดียว', () => {
    const parts = splitSnippet('ไม่มีคำนั้น', 'อื่น');
    assert.deepEqual(parts, [{ text: 'ไม่มีคำนั้น', highlight: false }]);
  });

  test('ข้อความประกอบกลับได้เหมือนเดิมเสมอ', () => {
    // ถ้าประกอบกลับแล้วไม่เท่าเดิม แปลว่ามีเนื้อหาหายหรือถูกเพิ่ม
    const snippet = '…เลขประจำตัวผู้เสียภาษี 0105500000000 ภ.ง.ด.53…';
    const rebuilt = splitSnippet(snippet, 'ภาษี').map((part) => part.text).join('');
    assert.equal(rebuilt, snippet);
  });

  test('แท็กที่อยู่ในเอกสารยังเป็นข้อความล้วน ไม่กลายเป็นโครงสร้าง', () => {
    const snippet = 'ก่อน <script>alert(1)</script> หลัง';
    const parts = splitSnippet(snippet, 'script');
    const rebuilt = parts.map((part) => part.text).join('');
    assert.equal(rebuilt, snippet, 'ข้อความต้องไม่ถูกแปลงเป็นอย่างอื่นระหว่างทาง');
    // ทุกชิ้นเป็นสตริงล้วน หน้าจอจะวาดเป็นโหนดข้อความ ไม่ใช่ HTML
    assert.ok(parts.every((part) => typeof part.text === 'string'));
  });

  test('คำค้นว่างไม่ทำให้วนไม่รู้จบ', () => {
    assert.deepEqual(splitSnippet('เนื้อหา', '   '), [{ text: 'เนื้อหา', highlight: false }]);
  });
});

describe('สถานะของดัชนี', () => {
  test('อธิบายจากมุมของผู้ใช้ ไม่ใช่จากมุมของระบบ', () => {
    assert.equal(indexStatusLabel('READY'), 'พร้อมค้นหาเนื้อหา');
    assert.equal(indexStatusLabel('NO_TEXT'), 'ไม่พบข้อความในไฟล์');
    assert.equal(indexStatusLabel('UNSUPPORTED'), 'ไม่รองรับการค้นหาเนื้อหา');
    assert.equal(indexStatusLabel('FAILED'), 'ประมวลผลไม่สำเร็จ');
  });

  test('ไม่มีสถานะก็ไม่แสดงอะไร', () => {
    assert.equal(indexStatusLabel(null), null);
    assert.equal(indexStatusLabel('UNKNOWN'), null);
  });
});

describe('สถานะของประวัติการอัปโหลด', () => {
  test('เอกสารที่เจ้าหน้าที่รับไปแล้วไม่ใช่ความผิดพลาด จึงไม่ใช้สีเตือน', () => {
    assert.equal(uploadStateTone('MANAGED_BY_STAFF'), 'muted');
    assert.equal(uploadStateTone('AVAILABLE'), 'success');
    assert.equal(uploadStateTone('UNAVAILABLE'), 'danger');
  });
});

describe('ความปลอดภัยของการแสดงผล', () => {
  test('ไม่มีการแทรก HTML จากเนื้อหาของเอกสารที่ใดเลย', () => {
    const files = [
      './search-content.ts',
      '../components/portal/PortalItemList.tsx',
      '../pages/portal/PortalUploadsPage.tsx',
      '../pages/SearchPage.tsx',
    ];
    for (const file of files) {
      const source = readFileSync(new URL(file, import.meta.url), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n]*/g, '');
      assert.ok(
        !source.includes('dangerouslySetInnerHTML'),
        `${file} ต้องไม่แทรก HTML ดิบ - เนื้อหาของเอกสารเป็นข้อมูลที่ไม่น่าไว้ใจ`,
      );
    }
  });
});

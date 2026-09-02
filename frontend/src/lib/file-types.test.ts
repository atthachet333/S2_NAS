import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  getExtension,
  getFileTypeStyle,
  getPreviewMode,
  isPreviewable,
} from './file-types.ts';
import { UPLOAD_ERROR_TEXT, uploadErrorText } from './error-text.ts';

describe('การเลือกชนิดไฟล์', () => {
  test('ใช้ MIME ที่เซิร์ฟเวอร์ตรวจแล้วเป็นหลัก', () => {
    // นามสกุลบอกว่า .txt แต่เซิร์ฟเวอร์ยืนยันจากลายเซ็นว่าเป็น PDF
    assert.equal(getFileTypeStyle('report.txt', 'application/pdf').kind, 'PDF');
  });

  test('ถอยไปใช้นามสกุลเมื่อเซิร์ฟเวอร์ไม่ยืนยันชนิด', () => {
    assert.equal(getFileTypeStyle('sheet.xlsx', 'application/octet-stream').kind, 'EXCEL');
    assert.equal(getFileTypeStyle('archive.zip', null).kind, 'ARCHIVE');
  });

  test('จัดกลุ่มชนิดหลักได้ครบ', () => {
    const cases: Array<[string, string | null, string]> = [
      ['a.pdf', 'application/pdf', 'PDF'],
      ['a.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'WORD'],
      ['a.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'EXCEL'],
      ['a.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation', 'POWERPOINT'],
      ['a.png', 'image/png', 'IMAGE'],
      ['a.zip', 'application/zip', 'ARCHIVE'],
      ['a.txt', 'text/plain', 'TEXT'],
      ['a.mp4', 'video/mp4', 'VIDEO'],
      ['a.mp3', 'audio/mpeg', 'AUDIO'],
      ['a.json', 'application/json', 'CODE'],
      ['a.unknownext', null, 'OTHER'],
    ];
    for (const [name, mime, expected] of cases) {
      assert.equal(getFileTypeStyle(name, mime).kind, expected, `${name} ควรเป็น ${expected}`);
    }
  });

  test('อ่านนามสกุลได้ถูกต้อง', () => {
    assert.equal(getExtension('ใบแจ้งหนี้.PDF'), 'pdf');
    assert.equal(getExtension('noextension'), '');
    assert.equal(getExtension('.hidden'), '');
  });
});

describe('การแสดงตัวอย่าง', () => {
  test('ชนิดที่รองรับเปิดตัวอย่างได้', () => {
    assert.equal(getPreviewMode('a.pdf', 'application/pdf'), 'PDF');
    assert.equal(getPreviewMode('a.png', 'image/png'), 'IMAGE');
    assert.equal(getPreviewMode('a.txt', 'text/plain'), 'TEXT');
    assert.equal(getPreviewMode('a.mp4', 'video/mp4'), 'VIDEO');
    assert.equal(getPreviewMode('a.mp3', 'audio/mpeg'), 'AUDIO');
  });

  test('Office และไฟล์บีบอัดไม่แสร้งว่าเปิดตัวอย่างได้', () => {
    assert.equal(isPreviewable('a.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'), false);
    assert.equal(isPreviewable('a.xlsx', null), false);
    assert.equal(isPreviewable('a.zip', 'application/zip'), false);
  });

  test('HTML และ SVG ถูกกันออกจากการแสดงตัวอย่างเพื่อความปลอดภัย', () => {
    assert.equal(getPreviewMode('page.html', 'text/html'), 'NONE');
    assert.equal(getPreviewMode('icon.svg', 'image/svg+xml'), 'NONE');
  });
});

describe('ข้อความข้อผิดพลาดของการอัปโหลด', () => {
  test('รหัสสำคัญมีข้อความภาษาไทยครบ', () => {
    for (const code of [
      'FILE_TOO_LARGE',
      'FILE_EMPTY',
      'FILE_UPLOAD_FAILED',
      'FILE_NAME_EXISTS',
      'DUPLICATE_CONTENT',
      'INVALID_RESOURCE_NAME',
      'RESOURCE_ACCESS_DENIED',
      'DOWNLOAD_DENIED',
      'TRASH_RESTORE_CONFLICT',
      'PERMANENT_DELETE_FAILED',
    ]) {
      assert.ok(UPLOAD_ERROR_TEXT[code], `ต้องมีข้อความของ ${code}`);
    }
  });

  test('รหัสที่ไม่รู้จักใช้ข้อความสำรอง', () => {
    assert.equal(uploadErrorText('SOMETHING_NEW', 'ข้อความจากเซิร์ฟเวอร์'), 'ข้อความจากเซิร์ฟเวอร์');
    assert.equal(uploadErrorText('SOMETHING_NEW'), 'ดำเนินการไม่สำเร็จ');
  });

  test('ข้อความของขนาดไฟล์เกินสื่อความหมายชัดเจน', () => {
    assert.match(uploadErrorText('FILE_TOO_LARGE'), /ขนาดใหญ่เกิน/);
  });
});

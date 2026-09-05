import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';
import { correctedNotice, ocrActionFor, ocrStatusLabel, textSourceBadge } from './ocr.js';
import type { OcrStateDto } from './ocr.js';

/**
 * F14 - ข้อความที่ผ่านการตรวจแก้ ฝั่งหน้าจอ
 */

const base: OcrStateDto = {
  eligible: true,
  reason: null,
  kind: 'SCANNED_PDF',
  status: 'READY',
  textSource: 'OCR',
  ocrRequested: true,
  ocrCompletedAt: null,
  ocrConfidence: null,
  ocrPageCount: null,
  truncated: false,
  engineAvailable: true,
};

const srcDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/** ตัดคอมเมนต์ออกก่อนตรวจซอร์ส เพื่อไม่ให้ข้อความอธิบายกลายเป็นผลบวกลวง */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function readSources(dir: string, acc: Array<{ file: string; text: string }> = []) {
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, item.name);
    if (item.isDirectory()) readSources(full, acc);
    else if (/\.tsx?$/.test(item.name) && !item.name.endsWith('.test.ts')) {
      acc.push({ file: full, text: fs.readFileSync(full, 'utf8') });
    }
  }
  return acc;
}

describe('F14 หน้าจอการตรวจแก้', () => {
  test('ป้ายบอกความต่างระหว่าง "ตรวจแก้แล้ว" กับ "OCR"', () => {
    assert.equal(textSourceBadge('HUMAN_CORRECTED'), 'ตรวจแก้แล้ว');
    assert.equal(textSourceBadge('OCR'), 'OCR');
    assert.equal(textSourceBadge('NATIVE_TEXT'), null);
  });

  test('บอกว่าข้อความผ่านการตรวจแก้แล้ว เฉพาะเมื่อผ่านจริง', () => {
    assert.equal(correctedNotice('HUMAN_CORRECTED'), 'ข้อความนี้ผ่านการตรวจแก้โดยผู้ใช้แล้ว');
    assert.equal(correctedNotice('OCR'), null);
    assert.equal(correctedNotice(null), null);
  });

  test('สถานะของเอกสารที่ตรวจแก้แล้วไม่แสดงว่า "สแกนข้อความแล้ว" เฉย ๆ', () => {
    assert.equal(ocrStatusLabel({ ...base, textSource: 'HUMAN_CORRECTED' }), 'ตรวจแก้แล้ว');
  });

  test('เอกสารที่ตรวจแก้แล้วยังสั่งสแกนใหม่ได้ ไม่ใช่ปุ่มสแกนครั้งแรก', () => {
    const action = ocrActionFor({ ...base, textSource: 'HUMAN_CORRECTED' });
    assert.equal(action.kind, 'RETRY');
    assert.equal(action.label, 'สแกนข้อความใหม่');
  });

  /**
   * ข้อความในเอกสารมาจากไฟล์ที่ผู้ใช้อัปโหลดเอง ซึ่งควบคุมไม่ได้ว่าข้างในมีอะไร
   * ถ้าเอกสารสแกนมีคำว่า <script> อยู่ในภาพ OCR จะอ่านมันมาเป็นข้อความตรง ๆ
   * และถ้าหน้าจอเอาไปใส่ innerHTML มันจะกลายเป็นสคริปต์ที่รันจริงในเบราว์เซอร์ของคนอื่น
   */
  test('ไม่มีที่ไหนในหน้าจอใช้ dangerouslySetInnerHTML', () => {
    const offenders = readSources(srcDir)
      .filter((entry) => withoutComments(entry.text).includes('dangerouslySetInnerHTML'))
      .map((entry) => path.relative(srcDir, entry.file));
    assert.deepEqual(offenders, [], 'ข้อความจากเอกสารต้องแสดงผ่าน value/children ของ React เท่านั้น');
  });

  test('ตัวแก้ไขข้อความเป็น textarea ธรรมดา ไม่ใช่ contentEditable', () => {
    const dialog = fs.readFileSync(
      path.join(srcDir, 'components', 'files', 'OcrReviewDialog.tsx'),
      'utf8',
    );
    const code = withoutComments(dialog);
    assert.ok(code.includes('<textarea'), 'ต้องเป็นช่องข้อความล้วน');
    assert.equal(
      code.includes('contentEditable'),
      false,
      'contentEditable เปิดทางให้ HTML หลุดเข้ามาในข้อความที่เก็บ',
    );
    assert.equal(code.includes('innerHTML'), false);
  });

  test('กล่องตรวจแก้ส่ง expectedRevision ไปด้วยเสมอ', () => {
    const dialog = fs.readFileSync(
      path.join(srcDir, 'components', 'files', 'OcrReviewDialog.tsx'),
      'utf8',
    );
    assert.match(
      withoutComments(dialog),
      /expectedRevision:\s*baseRevision/,
      'ถ้าไม่ส่งเลขรุ่นไป การบันทึกจะเขียนทับงานของคนอื่นได้เงียบ ๆ',
    );
  });
});

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  FILE_KIND_LABELS,
  OCR_STATE_LABELS,
  TEXT_SOURCE_LABELS,
  activeChips,
  filtersFromParams,
  hasActiveFilters,
  paramsFromFilters,
} from './search-filters.js';

/**
 * F15 - ตัวกรองการค้นหาฝั่งหน้าจอ
 *
 * สิ่งที่ต้องรับประกัน: ตัวกรองที่เขียนลง URL แล้วอ่านกลับมา ต้องได้ของเดิมทุกฟิลด์
 * เพราะทั้งการรีเฟรช การบุ๊กมาร์ก และชุดค้นหาที่บันทึกไว้ พึ่งพาคุณสมบัตินี้ทั้งหมด
 */
describe('F15 ตัวกรองการค้นหา', () => {
  test('เขียนลง URL แล้วอ่านกลับได้ครบทุกฟิลด์', () => {
    const filters = {
      fileKind: 'pdf',
      ocrState: 'OCR_DONE',
      textSource: 'HUMAN_CORRECTED',
      documentCategoryId: 'cat-1',
      uploadedPreset: 'thisMonth',
      hasText: true,
      untaggedOnly: true,
      sort: 'newest',
    };

    const params = paramsFromFilters('ภาษี', filters);
    assert.equal(params.get('q'), 'ภาษี');

    const restored = filtersFromParams(params);
    assert.deepEqual(restored, filters, 'ตัวกรองต้องกลับมาเหมือนเดิมทั้งชุด');
  });

  test('ค่าที่เป็นเท็จหรือว่างไม่ถูกเขียนลง URL', () => {
    const params = paramsFromFilters('', {
      hasText: false,
      untaggedOnly: false,
      fileKind: '',
      ocrState: undefined,
    });
    assert.equal(params.toString(), '', 'URL ต้องไม่มีพารามิเตอร์ที่ไม่ได้ทำอะไร');
  });

  test('คำค้นว่างไม่ถูกใส่ลง URL', () => {
    const params = paramsFromFilters('', { fileKind: 'pdf' });
    assert.equal(params.has('q'), false);
    assert.equal(params.get('fileKind'), 'pdf');
  });

  test('ค่าจริง/เท็จถูกแปลงกลับเป็น boolean ไม่ใช่ข้อความ', () => {
    const restored = filtersFromParams(new URLSearchParams('hasText=true&untaggedOnly=true'));
    assert.equal(restored.hasText, true);
    assert.equal(restored.untaggedOnly, true);
    assert.notEqual(restored.hasText as unknown, 'true');
  });

  test('ป้ายภาษาไทยไม่เปิดเผยชื่อค่าภายในของระบบ', () => {
    const chips = activeChips({
      fileKind: 'pdf',
      sourceType: 'EXTERNAL_UPLOAD',
      textSource: 'HUMAN_CORRECTED',
      ocrState: 'FAILED',
    });
    const labels = chips.map((chip) => chip.label).join(' | ');

    assert.ok(labels.includes('PDF'));
    assert.ok(labels.includes('ลูกค้าอัปโหลด'));
    assert.ok(labels.includes('ตรวจแก้แล้ว'));
    assert.ok(labels.includes('OCR ล้มเหลว'));
    // ชื่อค่าในฐานข้อมูลต้องไม่หลุดออกมาบนหน้าจอ
    assert.equal(labels.includes('EXTERNAL_UPLOAD'), false);
    assert.equal(labels.includes('HUMAN_CORRECTED'), false);
  });

  test('การเรียงลำดับไม่นับเป็นตัวกรอง', () => {
    assert.equal(hasActiveFilters({ sort: 'newest' }), false, 'การเรียงไม่ได้กรองอะไรออก');
    assert.equal(hasActiveFilters({ fileKind: 'pdf' }), true);
    assert.equal(hasActiveFilters({}), false);
  });

  test('ทุกสถานะ OCR ที่แสดงมีป้ายภาษาไทย', () => {
    for (const state of ['PENDING', 'PROCESSING', 'READY', 'NEEDS_OCR', 'OCR_DONE', 'FAILED', 'REVIEWED']) {
      assert.ok(OCR_STATE_LABELS[state], `${state} ต้องมีป้ายภาษาไทย`);
    }
  });

  test('ทุกกลุ่มชนิดไฟล์และที่มาของข้อความมีป้ายภาษาไทย', () => {
    for (const kind of ['pdf', 'image', 'word', 'excel', 'powerpoint', 'text', 'link', 'folder', 'other']) {
      assert.ok(FILE_KIND_LABELS[kind], `${kind} ต้องมีป้าย`);
    }
    for (const source of ['NATIVE_TEXT', 'OCR', 'HUMAN_CORRECTED']) {
      assert.ok(TEXT_SOURCE_LABELS[source], `${source} ต้องมีป้าย`);
    }
  });

  test('ป้ายของผู้ดูแลและแท็กแสดงชื่อ ไม่ใช่รหัส', () => {
    const chips = activeChips(
      { ownerId: 'user-1', tagId: 'tag-1', documentCategoryId: 'cat-1' },
      {
        owners: new Map([['user-1', 'สมชาย']]),
        tags: new Map([['tag-1', 'ภาษี']]),
        categories: new Map([['cat-1', 'ใบกำกับภาษี']]),
      },
    );
    const labels = chips.map((chip) => chip.label);
    assert.ok(labels.some((label) => label.includes('สมชาย')));
    assert.ok(labels.some((label) => label.includes('ภาษี')));
    assert.ok(labels.some((label) => label.includes('ใบกำกับภาษี')));
    assert.equal(labels.some((label) => label.includes('user-1')), false, 'รหัสต้องไม่โผล่บนหน้าจอ');
  });
});

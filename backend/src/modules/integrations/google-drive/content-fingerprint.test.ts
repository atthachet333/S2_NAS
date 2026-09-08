import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  contentFingerprint,
  isOoxmlExportMime,
  ooxmlContentFingerprint,
} from './content-fingerprint.js';
import { buildZip } from './zip-fixture.js';

/**
 * ลายนิ้วมือเนื้อหาของไฟล์ Google (F19 · D1)
 *
 * พบจาก live QA จริง: ส่งออกเอกสารเดิมที่ไม่มีใครแก้สองครั้ง ได้ SHA-256 ต่างกัน
 * เพราะ Google ประทับเวลาที่ส่งออกลงในหัวของทุกรายการใน ZIP ทั้งที่ทุกส่วนข้างใน
 * เหมือนกันทุกไบต์ (ยืนยันแล้ว 9/9 ส่วนใน DOCX และ 38/38 ส่วนใน PPTX)
 */

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const PPTX = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

const docParts = (body: string) => [
  { name: '[Content_Types].xml', content: '<Types/>' },
  { name: '_rels/.rels', content: '<Relationships/>' },
  { name: 'word/document.xml', content: body },
];

const sheetParts = (body: string) => [
  { name: '[Content_Types].xml', content: '<Types/>' },
  { name: 'xl/workbook.xml', content: '<workbook/>' },
  { name: 'xl/worksheets/sheet1.xml', content: body },
];

const slideParts = (body: string) => [
  { name: '[Content_Types].xml', content: '<Types/>' },
  { name: 'ppt/presentation.xml', content: '<presentation/>' },
  { name: 'ppt/slides/slide1.xml', content: body },
];

const sha = (buffer: Buffer) => createHash('sha256').update(buffer).digest('hex');

describe('ลายนิ้วมือเนื้อหาของไฟล์ Google', () => {
  describe('เวลาใน ZIP ต่างกันแต่เนื้อในเหมือนกัน', () => {
    for (const [label, parts, mime] of [
      ['DOCX', docParts('<w:document>สวัสดี</w:document>'), DOCX],
      ['XLSX', sheetParts('<worksheet>ตัวเลข</worksheet>'), XLSX],
      ['PPTX', slideParts('<p:sld>สไลด์</p:sld>'), PPTX],
    ] as const) {
      test(`${label}: ไบต์ต่างกัน แต่ลายนิ้วมือเท่ากัน`, () => {
        const first = buildZip([...parts], { dosTime: 0x6000, dosDate: 0x5900 });
        const second = buildZip([...parts], { dosTime: 0x7111, dosDate: 0x5a01 });

        assert.notEqual(sha(first), sha(second), 'ตั้งต้นต้องเป็นกรณีที่ไบต์ต่างกันจริง');
        assert.equal(contentFingerprint(first, mime), contentFingerprint(second, mime));
      });
    }
  });

  test('ลำดับรายการใน ZIP ต่างกัน แต่ลายนิ้วมือเท่ากัน', () => {
    const parts = docParts('<w:document>เนื้อหา</w:document>');
    const forward = buildZip([...parts]);
    const reversed = buildZip([...parts].reverse());

    assert.notEqual(sha(forward), sha(reversed));
    assert.equal(contentFingerprint(forward, DOCX), contentFingerprint(reversed, DOCX));
  });

  test('ระดับการบีบอัดต่างกัน แต่ลายนิ้วมือเท่ากัน', () => {
    const parts = docParts('<w:document>เนื้อหาเดียวกัน</w:document>');
    const deflated = buildZip([...parts], { store: false });
    const stored = buildZip([...parts], { store: true });

    assert.notEqual(sha(deflated), sha(stored));
    assert.equal(contentFingerprint(deflated, DOCX), contentFingerprint(stored, DOCX));
  });

  test('เนื้อในส่วนหนึ่งเปลี่ยน ลายนิ้วมือต้องเปลี่ยน', () => {
    const before = buildZip(docParts('<w:document>ฉบับแรก</w:document>'));
    const after = buildZip(docParts('<w:document>ฉบับแก้ไข</w:document>'));

    assert.notEqual(contentFingerprint(before, DOCX), contentFingerprint(after, DOCX));
  });

  test('ชื่อส่วนเปลี่ยนแม้เนื้อในเท่าเดิม ลายนิ้วมือต้องเปลี่ยน', () => {
    const a = buildZip([{ name: 'word/document.xml', content: '<x/>' }]);
    const b = buildZip([{ name: 'word/other.xml', content: '<x/>' }]);

    assert.notEqual(ooxmlContentFingerprint(a), ooxmlContentFingerprint(b));
  });

  test('โฟลเดอร์ใน ZIP ไม่มีผลต่อลายนิ้วมือ', () => {
    const parts = docParts('<w:document>เนื้อหา</w:document>');
    const withDir = buildZip([{ name: 'word/', content: '' }, ...parts]);
    const withoutDir = buildZip([...parts]);

    assert.equal(ooxmlContentFingerprint(withDir), ooxmlContentFingerprint(withoutDir));
  });


  /**
   * ความไม่นิ่งชุดที่สองที่พบจาก live QA
   *
   * ส่งออกไฟล์สไลด์เดิมที่ไม่มีใครแก้ Google สลับเนื้อหาของ theme1 กับ theme2
   * เข้าหากัน แล้วแก้ .rels ให้ชี้ตามเลขใหม่ - 33 จาก 38 ส่วนเหมือนเดิมทุกไบต์
   */
  describe('Google สลับเลขของธีมเองระหว่างส่งออก', () => {
    const themeSwapped = (first: string, second: string) => [
      { name: '[Content_Types].xml', content: '<Types/>' },
      { name: 'ppt/presentation.xml', content: '<presentation/>' },
      { name: 'ppt/slides/slide1.xml', content: '<p:sld>เนื้อหาคงเดิม</p:sld>' },
      { name: 'ppt/theme/theme1.xml', content: first },
      { name: 'ppt/theme/theme2.xml', content: second },
    ];

    const rels = (target: string) => ({
      name: 'ppt/_rels/presentation.xml.rels',
      content: `<Relationships><Relationship Target="theme/${target}"/></Relationships>`,
    });

    test('สลับเนื้อหาของ theme1 กับ theme2 แล้วลายนิ้วมือต้องเท่าเดิม', () => {
      const a = buildZip([...themeSwapped('<a:theme>ก</a:theme>', '<a:theme>ข</a:theme>'), rels('theme1.xml')]);
      const b = buildZip([...themeSwapped('<a:theme>ข</a:theme>', '<a:theme>ก</a:theme>'), rels('theme2.xml')]);

      assert.notEqual(sha(a), sha(b), 'ตั้งต้นต้องเป็นกรณีที่ไบต์ต่างกันจริง');
      assert.equal(contentFingerprint(a, PPTX), contentFingerprint(b, PPTX));
    });

    /** ต้องไม่ตาบอดต่อการแก้ธีมจริงของผู้ใช้ */
    test('เนื้อของธีมเปลี่ยนจริง ลายนิ้วมือต้องเปลี่ยน', () => {
      const before = buildZip([...themeSwapped('<a:theme>ก</a:theme>', '<a:theme>ข</a:theme>'), rels('theme1.xml')]);
      const after = buildZip([...themeSwapped('<a:theme>ก</a:theme>', '<a:theme>สีใหม่</a:theme>'), rels('theme1.xml')]);

      assert.notEqual(contentFingerprint(before, PPTX), contentFingerprint(after, PPTX));
    });

    test('เนื้อหาสไลด์เปลี่ยนพร้อมธีมสลับเลข ยังจับได้ว่าเปลี่ยน', () => {
      const a = buildZip([...themeSwapped('<a:theme>ก</a:theme>', '<a:theme>ข</a:theme>'), rels('theme1.xml')]);
      const edited = [
        { name: '[Content_Types].xml', content: '<Types/>' },
        { name: 'ppt/presentation.xml', content: '<presentation/>' },
        { name: 'ppt/slides/slide1.xml', content: '<p:sld>แก้แล้ว</p:sld>' },
        { name: 'ppt/theme/theme1.xml', content: '<a:theme>ข</a:theme>' },
        { name: 'ppt/theme/theme2.xml', content: '<a:theme>ก</a:theme>' },
      ];
      const b = buildZip([...edited, rels('theme2.xml')]);

      assert.notEqual(contentFingerprint(a, PPTX), contentFingerprint(b, PPTX));
    });
  });

  describe('ขอบเขตการใช้งาน', () => {
    test('ใช้กับสามชนิดที่ Google ส่งออกเท่านั้น', () => {
      assert.ok(isOoxmlExportMime(DOCX) && isOoxmlExportMime(XLSX) && isOoxmlExportMime(PPTX));
      assert.ok(!isOoxmlExportMime('application/pdf'));
      assert.ok(!isOoxmlExportMime('text/plain'));
      assert.ok(!isOoxmlExportMime('image/png'));
    });

    /** ไฟล์ไบนารีปกติต้องคงความหมายเดิม: SHA-256 ของไบต์จริง */
    test('ไฟล์ที่ไม่ใช่ OOXML ใช้ SHA-256 ของไบต์จริง', () => {
      const bytes = Buffer.from('เนื้อหาไบนารี');
      assert.equal(contentFingerprint(bytes, 'application/pdf'), `bytes:${sha(bytes)}`);
    });

    test('ไบต์ไบนารีต่างกันให้ลายนิ้วมือต่างกัน', () => {
      assert.notEqual(
        contentFingerprint(Buffer.from('ก'), 'image/png'),
        contentFingerprint(Buffer.from('ข'), 'image/png'),
      );
    });

    /**
     * ไฟล์ที่อ้างว่าเป็น OOXML แต่เปิดเป็น ZIP ไม่ได้ ต้องไม่ทำให้การซิงก์ล้ม
     * ถอยไปใช้ SHA-256 ของไบต์แทน ซึ่งเป็นพฤติกรรมเดิมของระบบ
     */
    test('ไฟล์ที่ไม่ใช่ ZIP ถอยไปใช้ SHA-256 ไม่ใช่โยนข้อผิดพลาด', () => {
      const junk = Buffer.from('ไม่ใช่ zip เลย');
      assert.equal(ooxmlContentFingerprint(junk), null);
      assert.equal(contentFingerprint(junk, DOCX), `bytes:${sha(junk)}`);
    });

    test('ZIP ว่างเปล่าไม่ถือเป็นลายนิ้วมือที่ใช้ได้', () => {
      assert.equal(ooxmlContentFingerprint(buildZip([])), null);
    });
  });

  test('ลายนิ้วมือมีคำนำหน้าบอกวิธีคำนวณ จึงไม่ปนกันข้ามชนิด', () => {
    const zip = buildZip(docParts('<w:document>x</w:document>'));
    assert.match(contentFingerprint(zip, DOCX), /^ooxml:[0-9a-f]{64}$/);
    assert.match(contentFingerprint(zip, 'application/pdf'), /^bytes:[0-9a-f]{64}$/);
  });
});

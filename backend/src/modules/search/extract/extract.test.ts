import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { after, before, describe, test } from 'node:test';
import { ZipArchive } from 'archiver';
import { createWriteStream } from 'node:fs';
import { cleanExtractedText, normalizeForSearch, truncateText } from './normalize.ts';
import { extractDocx, extractPptx, extractXlsx, OoxmlSafetyError, __testing as ooxml } from './ooxml.ts';
import { extractPdfText, PdfExtractError } from './pdf.ts';
import { handlerFor, isPermanentFailure } from './index.ts';

/**
 * การสกัดข้อความจากเอกสาร
 *
 * ทุกตัวอย่างในชุดทดสอบนี้ถูกสร้างขึ้นเองในเทส ไม่มีไฟล์ตัวอย่างค้างอยู่ในที่เก็บโค้ด
 * และไม่มีขั้นตอนใดที่เรียกโปรแกรมภายนอกหรือรันโค้ดที่ฝังอยู่ในเอกสาร
 */

let workDir = '';

before(async () => {
  workDir = await fsp.mkdtemp(path.join(os.tmpdir(), 's2-extract-test-'));
});

after(async () => {
  await fsp.rm(workDir, { recursive: true, force: true });
});

/** สร้างไฟล์ ZIP จริงจากรายการที่กำหนด - DOCX/XLSX/PPTX คือ ZIP ทั้งหมด */
async function makeZip(name: string, entries: Array<{ path: string; content: string }>): Promise<string> {
  const target = path.join(workDir, name);
  await new Promise<void>((resolve, reject) => {
    const output = createWriteStream(target);
    const archive = new ZipArchive({ zlib: { level: 9 } });
    output.on('close', () => resolve());
    archive.on('error', reject);
    archive.pipe(output);
    for (const entry of entries) archive.append(entry.content, { name: entry.path });
    void archive.finalize();
  });
  return target;
}

describe('การปรับรูปแบบข้อความ', () => {
  test('ยุบช่องว่างแต่ไม่ทำลายภาษาไทย', () => {
    const cleaned = cleanExtractedText('  ใบกำกับ    ภาษี \t\t เลขที่  001  ');
    assert.equal(cleaned, 'ใบกำกับ ภาษี เลขที่ 001');
  });

  test('ภาษาอังกฤษค้นแบบไม่สนตัวพิมพ์', () => {
    assert.equal(normalizeForSearch('Invoice NUMBER'), 'invoice number');
  });

  test('ภาษาไทยไม่ถูกตัดทิ้งหรือถอดวรรณยุกต์', () => {
    const value = 'ภ.ง.ด.53 ใบกำกับภาษี บริษัท เอ';
    const normalized = normalizeForSearch(value);
    assert.ok(normalized.includes('ภ.ง.ด.53'));
    assert.ok(normalized.includes('ใบกำกับภาษี'));
    // สระและวรรณยุกต์ต้องอยู่ครบ - "ภาษี" กับ "ภาษ" ไม่ใช่คำเดียวกัน
    assert.ok(normalized.includes('ภาษี'));
  });

  test('รูปแบบที่เขียนสระแยกกับรวมกันเทียบกันได้', () => {
    // NFD กับ NFC ของข้อความเดียวกันต้องได้ผลเหมือนกันหลังปรับรูปแบบ
    const composed = 'café'.normalize('NFC');
    const decomposed = 'café'.normalize('NFD');
    assert.equal(normalizeForSearch(composed), normalizeForSearch(decomposed));
  });

  test('ข้อความยาวเกินเพดานถูกตัดและบอกตามจริง', () => {
    const long = 'ก'.repeat(100);
    assert.deepEqual(truncateText(long, 100), { text: long, truncated: false });
    const cut = truncateText(long, 40);
    assert.equal(cut.text.length, 40);
    assert.equal(cut.truncated, true);
  });
});

describe('การเลือกตัวสกัดตามชนิดไฟล์', () => {
  test('ชนิดข้อความและเอกสารสำนักงานถูกรองรับ', () => {
    for (const ext of ['txt', 'csv', 'json', 'xml', 'md', 'pdf', 'docx', 'xlsx', 'pptx']) {
      assert.ok(handlerFor(ext, null), `${ext} ควรมีตัวสกัด`);
    }
  });

  test('ไฟล์ที่มีมาโครไม่ถูกรับเข้ามา', () => {
    // แกะได้ในทางเทคนิค แต่การประกาศว่ารองรับเชิญให้คนคิดว่ามันปลอดภัยกว่าที่เป็นจริง
    for (const ext of ['docm', 'xlsm', 'pptm']) {
      assert.equal(handlerFor(ext, null), null, `${ext} ต้องไม่ถูกสกัด`);
    }
  });

  test('รูปภาพและไฟล์บีบอัดไม่มีตัวสกัด', () => {
    for (const ext of ['png', 'jpg', 'zip', 'mp4', 'exe']) {
      assert.equal(handlerFor(ext, null), null);
    }
  });

  test('ไม่มีนามสกุลก็ยังใช้ชนิดที่เซิร์ฟเวอร์ยืนยันแล้วได้', () => {
    assert.equal(handlerFor(null, 'application/pdf'), 'PDF');
    assert.equal(handlerFor(null, 'text/plain'), 'TEXT');
    assert.equal(handlerFor(null, 'image/png'), null);
  });

  test('ความล้มเหลวถาวรไม่ถูกลองใหม่ไปเรื่อย ๆ', () => {
    assert.equal(isPermanentFailure('PDF_ENCRYPTED'), true);
    assert.equal(isPermanentFailure('ZIP_RATIO_SUSPICIOUS'), true);
    // ความล้มเหลวชั่วคราวต้องลองใหม่ได้
    assert.equal(isPermanentFailure('EXTRACT_ERROR'), false);
    assert.equal(isPermanentFailure(null), false);
  });
});

describe('การอ่าน XML แบบไม่ตีความโครงสร้าง', () => {
  test('ตัดแท็กออกและแปลงเอนทิตีมาตรฐาน', () => {
    const text = ooxml.stripXml('<w:t>ใบกำกับ&amp;ภาษี</w:t>');
    assert.ok(text.includes('ใบกำกับ&ภาษี'));
  });

  test('เอนทิตีซ้อนไม่ถูกแปลงผิด', () => {
    // &amp;lt; ต้องได้ &lt; ไม่ใช่ <
    assert.ok(ooxml.stripXml('<t>&amp;lt;</t>').includes('&lt;'));
  });

  test('เลขอ้างอิงอักขระของภาษาไทยถูกแปลงถูกต้อง', () => {
    // ภ = U+0E20
    assert.ok(ooxml.stripXml('<t>&#3616;</t>').includes('ภ'));
    assert.ok(ooxml.stripXml('<t>&#x0E20;</t>').includes('ภ'));
  });

  test('ความเห็นและ CDATA ถูกจัดการอย่างถูกต้อง', () => {
    assert.ok(!ooxml.stripXml('<t><!-- ซ่อน -->แสดง</t>').includes('ซ่อน'));
    assert.ok(ooxml.stripXml('<t><![CDATA[ในกรอบ]]></t>').includes('ในกรอบ'));
  });
});

describe('DOCX', () => {
  test('อ่านย่อหน้าภาษาไทยจากเอกสารได้', async () => {
    const file = await makeZip('doc.docx', [
      { path: '[Content_Types].xml', content: '<Types/>' },
      {
        path: 'word/document.xml',
        content:
          '<w:document><w:body>' +
          '<w:p><w:r><w:t>ใบกำกับภาษีอย่างย่อ</w:t></w:r></w:p>' +
          '<w:p><w:r><w:t>เลขประจำตัวผู้เสียภาษี 0105500000000</w:t></w:r></w:p>' +
          '</w:body></w:document>',
      },
    ]);

    const text = cleanExtractedText(await extractDocx(file));
    assert.ok(text.includes('ใบกำกับภาษีอย่างย่อ'));
    assert.ok(text.includes('0105500000000'));
  });

  test('ย่อหน้าคนละย่อหน้าไม่ติดกันเป็นคำเดียว', async () => {
    const file = await makeZip('doc2.docx', [
      {
        path: 'word/document.xml',
        content: '<w:body><w:p><w:r><w:t>ภาษี</w:t></w:r></w:p><w:p><w:r><w:t>อากร</w:t></w:r></w:p></w:body>',
      },
    ]);
    const text = await extractDocx(file);
    assert.ok(!text.includes('ภาษีอากร'), 'ย่อหน้าที่แยกกันต้องไม่ถูกเชื่อมเป็นคำใหม่');
  });

  test('ส่วนหัวและท้ายกระดาษถูกอ่านด้วย', async () => {
    const file = await makeZip('doc3.docx', [
      { path: 'word/document.xml', content: '<w:body><w:p><w:t>เนื้อความ</w:t></w:p></w:body>' },
      { path: 'word/header1.xml', content: '<w:hdr><w:p><w:t>บริษัท เอ จำกัด</w:t></w:p></w:hdr>' },
    ]);
    const text = await extractDocx(file);
    assert.ok(text.includes('บริษัท เอ จำกัด'));
  });
});

describe('XLSX', () => {
  test('อ่านสตริงร่วม ชื่อชีต และค่าที่คำนวณไว้แล้ว', async () => {
    const file = await makeZip('book.xlsx', [
      {
        path: 'xl/sharedStrings.xml',
        content: '<sst><si><t>ยอดยกมา</t></si><si><t>ใบกำกับภาษี</t></si></sst>',
      },
      { path: 'xl/workbook.xml', content: '<workbook><sheets><sheet name="งบทดลอง"/></sheets></workbook>' },
      {
        path: 'xl/worksheets/sheet1.xml',
        content: '<worksheet><sheetData><row><c><f>SUM(A1:A2)</f><v>1250.75</v></c></row></sheetData></worksheet>',
      },
    ]);

    const text = cleanExtractedText(await extractXlsx(file));
    assert.ok(text.includes('ยอดยกมา'));
    assert.ok(text.includes('งบทดลอง'), 'ชื่อชีตต้องค้นเจอได้');
    assert.ok(text.includes('1250.75'), 'ค่าที่คำนวณไว้แล้วต้องถูกอ่าน');
    assert.ok(!text.includes('SUM(A1:A2)'), 'สูตรดิบไม่ควรกลายเป็นเนื้อหาที่ค้นเจอ');
  });
});

describe('PPTX', () => {
  test('อ่านข้อความในสไลด์', async () => {
    const file = await makeZip('deck.pptx', [
      { path: 'ppt/slides/slide1.xml', content: '<p:sld><a:p><a:t>สรุปผลประกอบการ</a:t></a:p></p:sld>' },
      { path: 'ppt/slides/slide2.xml', content: '<p:sld><a:p><a:t>แนวโน้มไตรมาสหน้า</a:t></a:p></p:sld>' },
    ]);
    const text = cleanExtractedText(await extractPptx(file));
    assert.ok(text.includes('สรุปผลประกอบการ'));
    assert.ok(text.includes('แนวโน้มไตรมาสหน้า'));
  });
});

describe('การป้องกันระเบิดบีบอัด', () => {
  test('ไฟล์ที่มีรายการภายในมากผิดปกติถูกปฏิเสธ', async () => {
    const entries = Array.from({ length: 2100 }, (_, index) => ({
      path: `word/part${index}.xml`,
      content: '<t>x</t>',
    }));
    const file = await makeZip('bomb-entries.docx', entries);

    await assert.rejects(
      () => extractDocx(file),
      (error: unknown) =>
        error instanceof OoxmlSafetyError && error.code === 'ZIP_TOO_MANY_ENTRIES',
    );
  });

  test('รายการที่ขยายตัวผิดปกติถูกปฏิเสธ', async () => {
    // ข้อมูลซ้ำ ๆ บีบได้อัตราสูงมาก ซึ่งเป็นลายเซ็นของระเบิดบีบอัด
    const file = await makeZip('bomb-ratio.docx', [
      { path: 'word/document.xml', content: '0'.repeat(8 * 1024 * 1024) },
    ]);

    await assert.rejects(
      () => extractDocx(file),
      (error: unknown) =>
        error instanceof OoxmlSafetyError &&
        ['ZIP_RATIO_SUSPICIOUS', 'ZIP_TOO_LARGE', 'ZIP_ENTRY_TOO_LARGE'].includes(error.code),
    );
  });
});

/* ------------------------------------------------------------------ */
/* PDF                                                                */
/* ------------------------------------------------------------------ */

/** ประกอบไฟล์ PDF ขั้นต่ำที่ถูกต้องพอจะอ่านได้จริง */
function buildPdf(objects: string[]): Buffer {
  let body = '%PDF-1.4\n';
  objects.forEach((object, index) => {
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  body += 'trailer\n<< /Root 1 0 R >>\n%%EOF\n';
  return Buffer.from(body, 'latin1');
}

function contentObject(stream: string, compress: boolean): string {
  if (!compress) {
    return `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  }
  const deflated = zlib.deflateSync(Buffer.from(stream, 'latin1')).toString('latin1');
  return `<< /Length ${deflated.length} /Filter /FlateDecode >>\nstream\n${deflated}\nendstream`;
}

describe('PDF', () => {
  test('อ่านข้อความจากสตรีมที่ไม่บีบอัด', () => {
    const pdf = buildPdf([contentObject('BT (Invoice Number 2569) Tj ET', false)]);
    const text = extractPdfText(pdf);
    assert.ok(text.includes('Invoice Number 2569'));
  });

  test('อ่านข้อความจากสตรีมที่บีบด้วย FlateDecode', () => {
    const pdf = buildPdf([contentObject('BT (Compressed Content Here) Tj ET', true)]);
    assert.ok(extractPdfText(pdf).includes('Compressed Content Here'));
  });

  test('อ่านอาร์เรย์ TJ ที่ผสมข้อความกับระยะห่าง', () => {
    const pdf = buildPdf([contentObject('BT [(Tax) -250 (Invoice)] TJ ET', false)]);
    const text = extractPdfText(pdf);
    assert.ok(text.includes('Tax'));
    assert.ok(text.includes('Invoice'));
    assert.ok(!text.includes('-250'), 'ตัวเลขระยะห่างไม่ใช่ข้อความ');
  });

  test('ภาษาไทยอ่านได้เมื่อมีตาราง ToUnicode', () => {
    /**
     * PDF เก็บ "รหัสในฟอนต์" ไม่ใช่ตัวอักษร ตาราง ToUnicode คือสิ่งที่แปลกลับ
     * ที่นี่จับคู่รหัส 0001-0004 เข้ากับ ภ า ษ ี
     */
    const cmap = [
      '/CIDInit /ProcSet findresource begin',
      '4 beginbfchar',
      '<0001> <0E20>',
      '<0002> <0E32>',
      '<0003> <0E29>',
      '<0004> <0E35>',
      'endbfchar',
      'end',
    ].join('\n');

    const pdf = buildPdf([
      `<< /Type /Font /ToUnicode 2 0 R >>`,
      contentObject(cmap, false),
      contentObject('BT <0001000200030004> Tj ET', false),
    ]);

    const text = extractPdfText(pdf);
    assert.ok(text.includes('ภาษี'), `ควรอ่านได้ว่า "ภาษี" แต่ได้ ${JSON.stringify(text)}`);
  });

  test('ช่วงรหัสใน bfrange ถูกแปลงครบ', () => {
    const cmap = ['1 beginbfrange', '<0041> <0043> <0E01>', 'endbfrange'].join('\n');
    const pdf = buildPdf([
      `<< /ToUnicode 2 0 R >>`,
      contentObject(cmap, false),
      contentObject('BT <004100420043> Tj ET', false),
    ]);
    const text = extractPdfText(pdf);
    // U+0E01..U+0E03 = ก ข ฃ
    assert.ok(text.includes('กขฃ'), `ได้ ${JSON.stringify(text)}`);
  });

  test('PDF ที่ไม่มีข้อความคืนค่าว่าง ไม่ใช่ข้อความขยะ', () => {
    // เอกสารสแกนคือภาพล้วน ไม่มีตัวดำเนินการข้อความเลย
    const pdf = buildPdf(['<< /Type /XObject /Subtype /Image /Width 100 /Height 100 >>']);
    assert.equal(extractPdfText(pdf), '');
  });

  test('รหัสที่ไม่มีตารางแปลจะไม่ถูกเดา', () => {
    // ไบต์นอกช่วง ASCII ที่ไม่มี ToUnicode ต้องถูกทิ้ง ไม่ใช่แปลงมั่ว
    const pdf = buildPdf([contentObject('BT (\\xe0\\xb8\\xa0) Tj ET', false)]);
    const text = extractPdfText(pdf);
    assert.ok(!text.includes('à'), 'ต้องไม่คืนอักขระที่เดาเอาเอง');
  });

  test('ไฟล์ที่ไม่ใช่ PDF ถูกปฏิเสธอย่างชัดเจน', () => {
    assert.throws(
      () => extractPdfText(Buffer.from('นี่คือข้อความธรรมดา')),
      (error: unknown) => error instanceof PdfExtractError && error.code === 'PDF_INVALID',
    );
  });

  test('PDF ที่ใส่รหัสผ่านไว้ถูกบอกตามจริง ไม่ใช่แกล้งว่าสกัดสำเร็จ', () => {
    const pdf = Buffer.concat([
      Buffer.from('%PDF-1.4\n'),
      Buffer.from('trailer << /Encrypt 5 0 R >>\n'),
    ]);
    assert.throws(
      () => extractPdfText(pdf),
      (error: unknown) => error instanceof PdfExtractError && error.code === 'PDF_ENCRYPTED',
    );
  });

  test('ไฟล์เสียหายไม่ทำให้ตัวสกัดพัง', () => {
    // ตัวเลขความยาวผิด สตรีมไม่จบ ข้อมูลบีบอัดเสีย - ทั้งหมดต้องไม่โยน error ที่ไม่คาดคิด
    const broken = buildPdf(['<< /Length 999999 /Filter /FlateDecode >>\nstream\nไม่ใช่ข้อมูลบีบอัด\nendstream']);
    assert.doesNotThrow(() => extractPdfText(broken));
  });
});

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { enforceValueFidelity, extractValueTokens } from './fidelity.js';

describe('F21-Q2 exact-value fidelity guard', { concurrency: 1 }, () => {
  /** กรณีที่วัดได้จริงจากโมเดล - ถามอังกฤษกับเอกสารไทย โมเดลแปลงปีผิดโดยลบ 500 */
  test('repairs the measured Buddhist-era year mutation', () => {
    const evidence = ['สัญญาเลขที่ ก-2568/117 กำหนดส่งมอบงานงวดสุดท้ายภายในวันที่ 30 กันยายน 2569'];
    const result = enforceValueFidelity('The final delivery date in this contract is 30 September 2069.', evidence);
    assert.equal(result.unresolved.length, 0);
    assert.equal(result.repaired.length, 1);
    assert.match(result.answer, /30 September 2569/u);
    assert.doesNotMatch(result.answer, /2069/u);
  });

  test('repairs the measured comma-form mutation as well', () => {
    const evidence = ['ระยะเวลารับประกันผลงานสิ้นสุดวันที่ 31 ธันวาคม 2568'];
    const result = enforceValueFidelity('The warranty period ends on December 31, 2068.', evidence);
    assert.equal(result.unresolved.length, 0);
    assert.match(result.answer, /December 31, 2568/u);
  });

  /**
   * การแปลงปฏิทินที่ "ถูกต้อง" ก็ยังห้าม
   *
   * 2569 - 543 = 2026 เป็นการแปลงที่ถูกคณิตศาสตร์ แต่ผู้ใช้กดดูหลักฐานแล้วจะเห็น 2569
   * ไม่ตรงกับคำตอบ และไม่มีทางรู้ว่าระบบแปลงให้หรือเอกสารเขียนต่างออกไป
   */
  test('a mathematically correct calendar conversion is still not allowed', () => {
    const evidence = ['กำหนดส่งมอบงานภายในวันที่ 30 กันยายน 2569'];
    const result = enforceValueFidelity('Delivery is due on 30 September 2026.', evidence);
    assert.match(result.answer, /2569/u, 'ต้องคืนปีตามที่เอกสารเขียนไว้');
  });

  test('a date that matches the evidence passes through untouched', () => {
    const evidence = ['กำหนดส่งมอบงานภายในวันที่ 30 กันยายน 2569'];
    const answer = 'กำหนดส่งมอบงานงวดสุดท้ายคือวันที่ 30 กันยายน 2569';
    const result = enforceValueFidelity(answer, evidence);
    assert.equal(result.answer, answer);
    assert.equal(result.repaired.length, 0);
    assert.equal(result.unresolved.length, 0);
  });

  // ข้อ 6 - รูปแบบการเขียนต่างกันได้ถ้าค่าเท่ากันจริง
  test('formatting differences with an identical value are accepted', () => {
    const evidence = ['มูลค่าตามสัญญารวมภาษีมูลค่าเพิ่มเท่ากับ 12,450,000.00 บาท'];
    const result = enforceValueFidelity('มูลค่าตามสัญญาคือ 12,450,000 บาท', evidence);
    assert.equal(result.unresolved.length, 0);
    assert.equal(result.repaired.length, 0, 'ค่าเท่ากันจึงไม่ต้องซ่อม');
  });

  test('a changed digit in an amount is caught', () => {
    const evidence = ['มูลค่าตามสัญญาเท่ากับ 12,450,000.00 บาท'];
    const result = enforceValueFidelity('มูลค่าตามสัญญาคือ 12,540,000 บาท', evidence);
    assert.equal(result.repaired.length, 1, 'หลักฐานมีจำนวนเงินค่าเดียว จึงซ่อมได้แบบไม่กำกวม');
    assert.match(result.answer, /12,450,000/u);
  });

  /** ข้อ 9 - เมื่อกำกวมต้องไม่เดา ต้องปฏิเสธ */
  test('an ambiguous amount is refused rather than guessed', () => {
    const evidence = ['ยอดตามใบแจ้งหนี้ 85,750.50 บาท และยอดคงเหลือ 12,450,000.00 บาท'];
    const result = enforceValueFidelity('ยอดที่ต้องชำระคือ 99,999.99 บาท', evidence);
    assert.equal(result.repaired.length, 0);
    assert.equal(result.unresolved.length, 1, 'มีจำนวนเงินหลายค่าในหลักฐาน จึงห้ามเดา');
    assert.equal(result.unresolved[0]!.kind, 'MONEY');
  });

  test('percentages, durations and identifiers are checked', () => {
    const evidence = ['อัตราภาษีมูลค่าเพิ่ม 7% ชำระภายใน 30 วัน ใบแจ้งหนี้เลขที่ INV-2569-00817'];
    assert.equal(enforceValueFidelity('อัตราภาษี 7% ชำระภายใน 30 วัน ตามใบแจ้งหนี้ INV-2569-00817', evidence)
      .unresolved.length, 0);

    const wrongPercent = enforceValueFidelity('อัตราภาษีมูลค่าเพิ่มคือ 10%', evidence);
    assert.equal(wrongPercent.repaired.length, 1);
    assert.match(wrongPercent.answer, /7%/u);

    const wrongId = enforceValueFidelity('ใบแจ้งหนี้เลขที่ INV-2569-00871', evidence);
    assert.equal(wrongId.repaired.length, 1, 'สลับตัวเลขในเลขที่เอกสารต้องถูกจับได้');
    assert.match(wrongId.answer, /INV-2569-00817/u);
  });

  /** ข้อ 9 - ห้ามแก้เนื้อความทั่วไป */
  test('ordinary prose and names are left alone', () => {
    const evidence = ['ผู้ว่าจ้าง บริษัท เอสทู จำกัด ผู้รับจ้าง ห้างหุ้นส่วนจำกัด ทองชาติก่อสร้าง'];
    const answer = 'ผู้ว่าจ้างคือ บริษัท เอสทู จำกัด และผู้รับจ้างคือ ห้างหุ้นส่วนจำกัด ทองชาติก่อสร้าง';
    const result = enforceValueFidelity(answer, evidence);
    assert.equal(result.answer, answer);
    assert.equal(result.repaired.length, 0);
    assert.equal(result.unresolved.length, 0);
  });

  test('the no-evidence sentinel carries no values to check', () => {
    const result = enforceValueFidelity('ไม่พบข้อมูลนี้ในเอกสารที่คุณมีสิทธิ์เข้าถึง', ['ยอดรวม 12,500 บาท']);
    assert.equal(result.unresolved.length, 0);
    assert.equal(result.repaired.length, 0);
  });

  test('citation markers are never mistaken for values', () => {
    const evidence = ['กำหนดส่งมอบงานภายในวันที่ 30 กันยายน 2569'];
    const result = enforceValueFidelity('กำหนดส่งมอบคือ 30 กันยายน 2569 [E1]', evidence);
    assert.equal(result.unresolved.length, 0);
    assert.match(result.answer, /\[E1\]/u);
  });

  test('extraction classifies each value kind correctly', () => {
    const tokens = extractValueTokens(
      'ใบแจ้งหนี้ INV-2569-00817 ยอด 85,750.50 บาท ภาษี 7% ชำระใน 30 วัน ครบกำหนด 30 กันยายน 2569');
    const kinds = new Set(tokens.map((token) => token.kind));
    for (const kind of ['IDENTIFIER', 'MONEY', 'PERCENT', 'DURATION', 'DATE']) {
      assert.ok(kinds.has(kind as never), `ไม่พบชนิด ${kind}`);
    }
    // เลขที่เอกสารต้องไม่ถูกซอยเป็นตัวเลขย่อย
    assert.ok(tokens.some((token) => token.kind === 'IDENTIFIER' && token.raw === 'INV-2569-00817'));
  });

  /** ปีที่ยืนลำพังต้องเทียบกับปีในวันที่เต็มของหลักฐานได้ ไม่งั้นคำตอบที่ถูกจะถูกปฏิเสธ */
  test('a bare year is accepted when the evidence states it inside a full date', () => {
    const evidence = ['กำหนดส่งมอบงานภายในวันที่ 30 กันยายน 2569'];
    const result = enforceValueFidelity('สัญญาฉบับนี้มีกำหนดส่งมอบในปี 2569', evidence);
    assert.equal(result.unresolved.length, 0);
    assert.equal(result.repaired.length, 0);
  });

  test('a mutated bare year is repaired from the evidence date', () => {
    const evidence = ['กำหนดส่งมอบงานภายในวันที่ 30 กันยายน 2569'];
    const result = enforceValueFidelity('The contract runs through 2069.', evidence);
    assert.equal(result.unresolved.length, 0);
    assert.match(result.answer, /2569/u);
  });
});

import { writeFileSync } from 'node:fs';
import { LlamaCppDocumentAssistantProvider } from '../src/modules/assistant/llama-cpp.provider.js';
import type { GroundedEvidence } from '../src/modules/assistant/provider.js';
import { enforceValueFidelity } from '../src/modules/assistant/fidelity.js';

/**
 * เครื่องวัดความคงเดิมของค่าที่ต้องตรงตัว (F21-Q2)
 *
 * **ทำไมต้องวัดซ้ำหลายรอบ:** F21-Q2 ถูกพบครั้งเดียวแล้วรันซ้ำหกครั้งไม่เกิดอีก
 * ซึ่งไม่ได้แปลว่าไม่มีปัญหา แปลว่าอัตราการเกิดต่ำกว่าที่หกครั้งจะจับได้เท่านั้น
 * การสรุปว่า "แก้แล้ว" จากการรันสะอาดครั้งเดียวคือการเข้าใจผิดเรื่องความน่าจะเป็น
 *
 * สคริปต์นี้จึงรันคำถามเดิมซ้ำหลายรอบต่อหมวด แล้วรายงานอัตราการคงค่าเดิมจริง
 * ไม่ใช่ผ่าน/ไม่ผ่าน ข้อมูลที่ใช้เป็นข้อมูลสังเคราะห์แบบใช้แล้วทิ้งทั้งหมด
 * ไม่มีเลขประจำตัวผู้เสียภาษีหรือเลขบัญชีจริงของใคร
 */

interface FidelityCase {
  id: string;
  category: 'THAI_BE_DATE' | 'GREGORIAN_DATE' | 'MONEY' | 'PERCENTAGE' | 'IDENTIFIER' | 'PAYMENT_TERMS' | 'BILINGUAL_DATE';
  language: 'th' | 'en';
  question: string;
  evidence: string;
  /** ค่าที่ต้องปรากฏในคำตอบตรงตัว */
  expected: string[];
  /** ค่าที่ถือว่าเป็นการแปลงปฏิทิน/หน่วย ซึ่งห้ามเกิดขึ้นเอง */
  forbiddenConversions?: string[];
}

const CASES: FidelityCase[] = [
  // A. วันที่แบบพุทธศักราช - หมวดที่พบ F21-Q2
  { id: 'be-date-th-ask', category: 'THAI_BE_DATE', language: 'th',
    question: 'กำหนดส่งมอบงานงวดสุดท้ายวันที่เท่าไร',
    evidence: 'สัญญาเลขที่ ก-2568/117 กำหนดส่งมอบงานงวดสุดท้ายภายในวันที่ 30 กันยายน 2569',
    expected: ['2569'], forbiddenConversions: ['2026', '2069'] },
  { id: 'be-date-en-ask', category: 'THAI_BE_DATE', language: 'en',
    question: 'What is the final delivery date in this contract?',
    evidence: 'สัญญาเลขที่ ก-2568/117 กำหนดส่งมอบงานงวดสุดท้ายภายในวันที่ 30 กันยายน 2569',
    expected: ['2569'], forbiddenConversions: ['2026', '2069'] },
  { id: 'be-date-newyear', category: 'THAI_BE_DATE', language: 'th',
    question: 'สัญญาเริ่มมีผลบังคับใช้วันที่เท่าไร',
    evidence: 'สัญญาฉบับนี้เริ่มมีผลบังคับใช้ตั้งแต่วันที่ 1 มกราคม 2570 เป็นต้นไป',
    expected: ['2570'], forbiddenConversions: ['2027', '2070'] },
  { id: 'be-date-yearend', category: 'THAI_BE_DATE', language: 'en',
    question: 'When does the warranty period end?',
    evidence: 'ระยะเวลารับประกันผลงานสิ้นสุดวันที่ 31 ธันวาคม 2568',
    expected: ['2568'], forbiddenConversions: ['2025', '2068'] },

  // B. วันที่แบบคริสต์ศักราช
  { id: 'ce-date-long', category: 'GREGORIAN_DATE', language: 'en',
    question: 'When does this agreement expire?',
    evidence: 'Service Agreement SA-2026-0042. The agreement expires on 30 September 2026.',
    expected: ['2026'], forbiddenConversions: ['2569'] },
  { id: 'ce-date-iso', category: 'GREGORIAN_DATE', language: 'en',
    question: 'What is the effective date recorded in this document?',
    evidence: 'Effective date: 2026-09-30. Renewal is automatic unless cancelled.',
    expected: ['2026-09-30'], forbiddenConversions: ['2569'] },

  // C. จำนวนเงิน
  { id: 'money-large', category: 'MONEY', language: 'th',
    question: 'มูลค่าตามสัญญาเท่าไร',
    evidence: 'มูลค่าตามสัญญารวมภาษีมูลค่าเพิ่มเท่ากับ 12,450,000.00 บาท',
    expected: ['12,450,000'] },
  { id: 'money-decimal', category: 'MONEY', language: 'th',
    question: 'ยอดที่ต้องชำระตามใบแจ้งหนี้นี้เท่าไร',
    evidence: 'ใบแจ้งหนี้เลขที่ INV-2569-00817 ยอดที่ต้องชำระ 85,750.50 บาท',
    expected: ['85,750.50'] },
  { id: 'money-en-ask', category: 'MONEY', language: 'en',
    question: 'What is the invoice amount due?',
    evidence: 'ใบแจ้งหนี้เลขที่ INV-2569-00817 ยอดที่ต้องชำระ 85,750.50 บาท',
    expected: ['85,750.50'] },

  // D. อัตราร้อยละ
  { id: 'pct-vat', category: 'PERCENTAGE', language: 'th',
    question: 'อัตราภาษีมูลค่าเพิ่มที่ระบุไว้เท่าไร',
    evidence: 'ราคาดังกล่าวรวมภาษีมูลค่าเพิ่มในอัตรา 7% แล้ว',
    expected: ['7'] },
  { id: 'pct-fraction', category: 'PERCENTAGE', language: 'th',
    question: 'อัตราดอกเบี้ยผิดนัดชำระเท่าไร',
    evidence: 'กรณีผิดนัดชำระ ผู้ซื้อต้องชำระดอกเบี้ยในอัตรา 3.5% ต่อปี',
    expected: ['3.5'] },

  // E. เลขประจำตัวและเลขอ้างอิง (ค่าสังเคราะห์ทั้งหมด)
  { id: 'id-tax', category: 'IDENTIFIER', language: 'th',
    question: 'เลขประจำตัวผู้เสียภาษีของผู้ขายคือเลขอะไร',
    evidence: 'ผู้ขาย บริษัท ตัวอย่างทดสอบ จำกัด เลขประจำตัวผู้เสียภาษี 0-9999-88888-77-6',
    expected: ['0-9999-88888-77-6'] },
  { id: 'id-invoice', category: 'IDENTIFIER', language: 'th',
    question: 'เลขที่ใบแจ้งหนี้คือเลขอะไร',
    evidence: 'ใบแจ้งหนี้เลขที่ INV-2569-00817 ออกให้แก่ลูกค้ารายเดิม',
    expected: ['INV-2569-00817'] },
  { id: 'id-contract', category: 'IDENTIFIER', language: 'en',
    question: 'What is the contract reference number?',
    evidence: 'สัญญาจ้างเหมาก่อสร้าง เลขที่ ก-2568/117 ลงนามแล้วทั้งสองฝ่าย',
    expected: ['2568/117'] },

  // G. เงื่อนไขการชำระเงิน
  { id: 'terms-th', category: 'PAYMENT_TERMS', language: 'th',
    question: 'เงื่อนไขการชำระเงินกี่วัน',
    evidence: 'เงื่อนไขการชำระเงิน ภายใน 30 วัน นับจากวันที่ได้รับใบแจ้งหนี้',
    expected: ['30'] },
  { id: 'terms-en', category: 'PAYMENT_TERMS', language: 'en',
    question: 'What are the payment terms?',
    evidence: 'Payment terms are net 45 days from the invoice date.',
    expected: ['45'] },

  // H. วันที่เดียวกันปรากฏทั้งเอกสารไทยและอังกฤษ
  { id: 'bilingual', category: 'BILINGUAL_DATE', language: 'en',
    question: 'What delivery date does each document state?',
    evidence: '__BILINGUAL__',
    expected: ['2569', '2026'] },
];

const BILINGUAL: GroundedEvidence[] = [
  { id: 'E1', title: 'contract-th.txt', textSource: 'NATIVE_TEXT',
    text: 'สัญญาฉบับภาษาไทย กำหนดส่งมอบงานภายในวันที่ 30 กันยายน 2569' },
  { id: 'E2', title: 'contract-en.txt', textSource: 'NATIVE_TEXT',
    text: 'English counterpart of the contract. Delivery is due on 30 September 2026.' },
];

interface Outcome {
  exact: boolean;
  converted: boolean;
  mutated: boolean;
  omitted: boolean;
  answer: string;
  rejected?: boolean;
  repairCount?: number;
  falsePositiveRepair?: boolean;
}

/** ตัวเลขทุกรูปแบบที่ปรากฏในข้อความ ใช้ตรวจว่ามีค่าแปลกปลอมโผล่มาหรือไม่ */
function numericTokens(text: string): string[] {
  return [...text.matchAll(/\d[\d,.\-/]*\d|\d/gu)].map((match) => match[0]);
}

function classify(answer: string, testCase: FidelityCase, evidenceText: string): Outcome {
  const normalized = answer.replace(/\s+/gu, ' ');
  const exact = testCase.expected.every((value) => normalized.includes(value));
  const converted = (testCase.forbiddenConversions ?? []).some((value) => normalized.includes(value));

  // ค่าตัวเลขที่โผล่ในคำตอบแต่ไม่มีในหลักฐานเลย ถือว่าถูกดัดแปลง
  const evidenceNumbers = new Set(numericTokens(evidenceText));
  const stray = numericTokens(normalized).filter((token) => token.length >= 3 && !evidenceNumbers.has(token)
    && ![...evidenceNumbers].some((known) => known.includes(token) || token.includes(known)));
  const omitted = !exact && !converted && stray.length === 0;
  return { exact, converted, mutated: !exact && stray.length > 0, omitted, answer: normalized };
}

async function main() {
  const repetitions = Number(process.argv[2] ?? 10);
  const only = process.argv[3];
  const guard = process.env.F21_FIDELITY_GUARD === '1';
  console.log(guard ? "ด่านตรวจค่า: เปิด" : "ด่านตรวจค่า: ปิด (วัดพฤติกรรมดิบของโมเดล)");
  const provider = new LlamaCppDocumentAssistantProvider(true);
  const health = await provider.health();
  if (health.status !== 'READY') throw new Error(`โมเดลไม่พร้อม: ${health.reason ?? 'ไม่ทราบสาเหตุ'}`);

  const results: Array<{ case: FidelityCase; outcomes: Outcome[] }> = [];
  const started = Date.now();
  for (const testCase of CASES) {
    if (only && testCase.category !== only && testCase.id !== only) continue;
    const evidence: GroundedEvidence[] = testCase.evidence === '__BILINGUAL__' ? BILINGUAL
      : [{ id: 'E1', title: `${testCase.id}.txt`, textSource: 'NATIVE_TEXT', text: testCase.evidence }];
    const evidenceText = evidence.map((item) => item.text).join(' ');
    const outcomes: Outcome[] = [];
    let repairedRuns = 0;
    for (let run = 0; run < repetitions; run++) {
      const output = await provider.generateGroundedAnswer({ question: testCase.question,
        language: testCase.language, mode: 'QA', history: [], evidence, maxOutputTokens: 192 });
      // เมื่อเปิดด่านตรวจ จะวัดคำตอบหลังผ่านการซ่อม/ปฏิเสธ ซึ่งคือสิ่งที่ผู้ใช้ได้เห็นจริง
      let answer = output.answer;
      let rejected = false;
      let repairCount = 0;
      let falsePositiveRepair = false;
      if (guard) {
        const raw = classify(answer, testCase, evidenceText);
        const checked = enforceValueFidelity(answer, evidence.map((item) => item.text));
        if (checked.unresolved.length > 0) rejected = true;
        else answer = checked.answer;
        repairCount = checked.repaired.length;
        falsePositiveRepair = raw.exact && repairCount > 0;
        repairedRuns += repairCount > 0 ? 1 : 0;
      }
      // คำตอบที่ถูกปฏิเสธไม่ถึงผู้ใช้ จึงไม่นับเป็นค่าที่คงเดิมและไม่นับเป็นค่าที่เพี้ยน
      outcomes.push(rejected
        ? { exact: false, converted: false, mutated: false, omitted: false, answer: "[ปฏิเสธ]", rejected: true,
          repairCount, falsePositiveRepair }
        : { ...classify(answer, testCase, evidenceText), rejected: false, repairCount, falsePositiveRepair });
    }
    const exactCount = outcomes.filter((outcome) => outcome.exact).length;
    console.log(`${testCase.id.padEnd(16)} ${testCase.category.padEnd(16)} ` +
      `exact ${exactCount}/${repetitions}  converted ${outcomes.filter((o) => o.converted).length}  ` +
      `mutated ${outcomes.filter((o) => o.mutated).length}  omitted ${outcomes.filter((o) => o.omitted).length}  ` +
      `repaired ${repairedRuns}  rejected ${outcomes.filter((o) => o.rejected).length}`);
    for (const outcome of outcomes.filter((o) => !o.exact)) console.log(`    ✖ ${outcome.answer.slice(0, 150)}`);
    results.push({ case: testCase, outcomes });
  }

  const byCategory = new Map<string, { exact: number; total: number; converted: number; mutated: number; omitted: number }>();
  for (const { case: testCase, outcomes } of results) {
    const bucket = byCategory.get(testCase.category) ?? { exact: 0, total: 0, converted: 0, mutated: 0, omitted: 0 };
    bucket.total += outcomes.length;
    bucket.exact += outcomes.filter((o) => o.exact).length;
    bucket.converted += outcomes.filter((o) => o.converted).length;
    bucket.mutated += outcomes.filter((o) => o.mutated).length;
    bucket.omitted += outcomes.filter((o) => o.omitted).length;
    byCategory.set(testCase.category, bucket);
  }

  console.log('\n=== อัตราการคงค่าเดิมตรงตัว ===');
  for (const [category, bucket] of byCategory) {
    const rate = (bucket.exact / bucket.total * 100).toFixed(1);
    console.log(`${category.padEnd(18)} ${String(bucket.exact).padStart(3)}/${String(bucket.total).padEnd(3)} = ${rate.padStart(5)}%  ` +
      `converted=${bucket.converted} mutated=${bucket.mutated} omitted=${bucket.omitted}`);
  }
  const totals = [...byCategory.values()].reduce((sum, bucket) => ({
    exact: sum.exact + bucket.exact, total: sum.total + bucket.total,
    converted: sum.converted + bucket.converted, mutated: sum.mutated + bucket.mutated,
    omitted: sum.omitted + bucket.omitted }), { exact: 0, total: 0, converted: 0, mutated: 0, omitted: 0 });
  const guardTotals = results.flatMap((result) => result.outcomes).reduce((sum, outcome) => ({
    repairedRuns: sum.repairedRuns + ((outcome.repairCount ?? 0) > 0 ? 1 : 0),
    repairedValues: sum.repairedValues + (outcome.repairCount ?? 0),
    rejected: sum.rejected + (outcome.rejected ? 1 : 0),
    falsePositiveRepairs: sum.falsePositiveRepairs + (outcome.falsePositiveRepair ? 1 : 0),
    unsupportedVisibleValues: sum.unsupportedVisibleValues + (!outcome.rejected && (outcome.converted || outcome.mutated) ? 1 : 0),
  }), { repairedRuns: 0, repairedValues: 0, rejected: 0, falsePositiveRepairs: 0, unsupportedVisibleValues: 0 });
  console.log(`${'รวม'.padEnd(18)} ${totals.exact}/${totals.total} = ${(totals.exact / totals.total * 100).toFixed(1)}%  ` +
    `converted=${totals.converted} mutated=${totals.mutated} omitted=${totals.omitted}`);
  console.log(`repair-runs=${guardTotals.repairedRuns} repair-values=${guardTotals.repairedValues} ` +
    `rejected=${guardTotals.rejected} false-positive-repairs=${guardTotals.falsePositiveRepairs} ` +
    `unsupported-visible-values=${guardTotals.unsupportedVisibleValues}`);
  console.log(`ใช้เวลาทั้งหมด ${((Date.now() - started) / 60_000).toFixed(1)} นาที`);

  const out = process.env.F21_FIDELITY_OUT;
  if (out) {
    writeFileSync(out, JSON.stringify({ repetitions, guard, totals: { ...totals, ...guardTotals }, byCategory: Object.fromEntries(byCategory),
      results: results.map(({ case: c, outcomes }) => ({ id: c.id, category: c.category, outcomes })) }, null, 2));
    console.log(`บันทึกผลดิบไว้ที่ ${out}`);
  }
}

await main();

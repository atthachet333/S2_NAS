import { LlamaCppDocumentAssistantProvider } from '../src/modules/assistant/llama-cpp.provider.js';
import type { GroundedEvidence } from '../src/modules/assistant/provider.js';
import { enforceValueFidelity, extractValueTokens } from '../src/modules/assistant/fidelity.js';
import { surfaceStructuredConflict } from '../src/modules/assistant/conflict.js';
import type { AssistantEvidence } from '../src/modules/assistant/rag.service.js';

/**
 * เกณฑ์วัดความครบถ้วนเมื่อมีหลายเอกสาร (F21-Q3)
 *
 * **ที่มา:** การวัดความตรงของค่าพบว่าเมื่อถามถึงเอกสารสองฉบับพร้อมกัน โมเดลตอบจาก
 * ฉบับเดียว 10/10 ครั้ง โดยค่าที่ตอบถูกต้องและอ้างอิงถูกต้องด้วย จึงไม่ใช่ปัญหาความตรงของค่า
 * แต่เป็นความไม่ครบถ้วน ซึ่งด่านตรวจค่ามองไม่เห็นโดยการออกแบบ
 *
 * เรื่องนี้สำคัญเพราะข้อกำหนดบอกว่าเอกสารที่ขัดแย้งกันต้องถูกรายงานว่าขัดแย้ง
 * ห้ามเลือกข้างเงียบ ๆ การตอบจากฉบับเดียวอย่างมั่นใจคือการเลือกข้างเงียบ ๆ พอดี
 *
 * วัดแยกตามโหมดเพราะ COMPARE ใช้คำสั่งและงบต่างจาก QA จึงอาจให้ผลต่างกัน
 * และการสรุปจากโหมดเดียวแล้วเหมาไปทั้งระบบจะเป็นข้อสรุปที่กว้างเกินกว่าที่วัดจริง
 */

const CONFLICT: GroundedEvidence[] = [
  { id: 'E1', title: 'agreement-a.txt', textSource: 'NATIVE_TEXT',
    text: 'บันทึกข้อตกลงฉบับ ก กำหนดส่งมอบงานภายในวันที่ 30 กันยายน 2569' },
  { id: 'E2', title: 'agreement-b.txt', textSource: 'NATIVE_TEXT',
    text: 'บันทึกข้อตกลงฉบับ ข กำหนดส่งมอบงานภายในวันที่ 15 ตุลาคม 2569' },
];

/** ชุดสองภาษา - เงื่อนไขเดิมที่พบการตอบจากฉบับเดียว 10/10 ในโหมด QA */
const BILINGUAL: GroundedEvidence[] = [
  { id: 'E1', title: 'contract-th.txt', textSource: 'NATIVE_TEXT',
    text: 'สัญญาฉบับภาษาไทย กำหนดส่งมอบงานภายในวันที่ 30 กันยายน 2569' },
  { id: 'E2', title: 'contract-en.txt', textSource: 'NATIVE_TEXT',
    text: 'English counterpart of the contract. Delivery is due on 15 October 2026.' },
];

interface CoverageCase {
  id: string;
  mode: 'QA' | 'COMPARE';
  language: 'th' | 'en';
  question: string;
  evidence?: GroundedEvidence[];
  /** คู่วันที่ที่ต้องปรากฏครบ เขียนเป็น วัน/เดือน/ปี */
  expectDates?: [string, string];
}

const CASES: CoverageCase[] = [
  { id: 'conflict-qa-th', mode: 'QA', language: 'th',
    question: 'กำหนดส่งมอบงานตามเอกสารแต่ละฉบับคือวันที่เท่าไร' },
  { id: 'conflict-compare-th', mode: 'COMPARE', language: 'th',
    question: 'เปรียบเทียบกำหนดส่งมอบงานของเอกสารทั้งสองฉบับ' },
  { id: 'conflict-compare-en', mode: 'COMPARE', language: 'en',
    question: 'Compare the delivery deadline stated in each of the two documents.' },
  { id: 'bilingual-qa-en', mode: 'QA', language: 'en',
    question: 'What delivery date does each document state?',
    evidence: BILINGUAL, expectDates: ['30/9/2569', '15/10/2026'] },
  { id: 'bilingual-compare-en', mode: 'COMPARE', language: 'en',
    question: 'Compare the delivery date stated in each of the two documents.',
    evidence: BILINGUAL, expectDates: ['30/9/2569', '15/10/2026'] },
];

/** คำที่บ่งชี้ว่าโมเดลรับรู้ว่าข้อมูลไม่ตรงกัน ไม่ได้เลือกข้างเงียบ ๆ */
const CONFLICT_WORDS = /ขัดแย้ง|ไม่ตรงกัน|ต่างกัน|แตกต่าง|conflict|differ|discrepanc|inconsisten/iu;

async function main() {
  const repetitions = Number(process.argv.find((arg) => /^\d+$/u.test(arg)) ?? 10);
  const grounded = process.argv.includes('--grounded');
  const requested = process.argv.find((arg) => arg.startsWith('--cases='))?.slice('--cases='.length).split(',');
  const provider = new LlamaCppDocumentAssistantProvider(true);
  const health = await provider.health();
  if (health.status !== 'READY') throw new Error(`โมเดลไม่พร้อม: ${health.reason ?? 'ไม่ทราบ'}`);

  for (const testCase of CASES.filter((testCase) => !requested || requested.includes(testCase.id))) {
    let bothValues = 0; let bothCitations = 0; let statesConflict = 0;
    const samples: string[] = [];
    for (let run = 0; run < repetitions; run++) {
      const sourceEvidence = testCase.evidence ?? CONFLICT;
      const output = await provider.generateGroundedAnswer({ question: testCase.question,
        language: testCase.language, mode: testCase.mode, history: [], evidence: sourceEvidence,
        maxOutputTokens: testCase.mode === 'COMPARE' ? 320 : 192 });
      let answer = output.answer;
      let cited = new Set([...output.usedEvidenceIds,
        ...[...answer.matchAll(/\[(E[12])\]/gu)].map((match) => match[1]!)]);
      if (grounded) {
        const citedTexts = sourceEvidence.filter((item) => cited.has(item.id)).map((item) => item.text);
        const fidelity = enforceValueFidelity(answer,
          citedTexts.length ? citedTexts : sourceEvidence.map((item) => item.text));
        if (fidelity.unresolved.length) throw new Error(`${testCase.id}: unsupported values remain after grounding`);
        const applicationEvidence: AssistantEvidence[] = sourceEvidence.map((item, index) => ({
          ...item, resourceId: `R${index + 1}`, resourceVersionId: `RV${index + 1}`, resourceVersion: 1,
          chunkIndex: null, startOffset: 0, endOffset: item.text.length, score: 1,
        }));
        const conflict = surfaceStructuredConflict({ question: testCase.question, language: testCase.language,
          answer: fidelity.answer, evidence: applicationEvidence });
        answer = conflict.answer;
        cited = new Set([...cited, ...conflict.evidenceIds]);
      }
      answer = answer.replace(/\s+/gu, ' ');
      // เทียบวันที่เชิงโครงสร้าง ไม่ใช่ตามชื่อเดือนของภาษาใดภาษาหนึ่ง
      // คำตอบภาษาอังกฤษเขียนเดือนเป็นอังกฤษ การหาสตริงไทยจึงนับพลาดทั้งที่ครบถ้วน
      const dates = extractValueTokens(answer).filter((token) => token.kind === 'DATE')
        .map((token) => `${token.date!.day}/${token.date!.month}/${token.date!.year}`);
      const [first, second] = testCase.expectDates ?? ['30/9/2569', '15/10/2569'];
      const hasBoth = dates.includes(first) && dates.includes(second);
      if (hasBoth) bothValues++;
      else if (samples.length < 3) samples.push(answer.slice(0, 150));
      if (cited.has('E1') && cited.has('E2')) bothCitations++;
      if (CONFLICT_WORDS.test(answer)) statesConflict++;
    }
    console.log(`${testCase.id.padEnd(20)} ${testCase.mode.padEnd(8)} ` +
      `ค่าครบสองฉบับ ${bothValues}/${repetitions}  อ้างอิงครบสองฉบับ ${bothCitations}/${repetitions}  ` +
      `ระบุว่าขัดแย้ง ${statesConflict}/${repetitions}`);
    for (const sample of samples) console.log(`    ✖ ${sample}`);
  }
}

await main();

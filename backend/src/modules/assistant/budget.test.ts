import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { env } from '../../config/env.js';
import {
  LATENCY_SAFETY_MARGIN_SECONDS, MEASURED_GENERATION_TOKENS_PER_SECOND, MEASURED_PROMPT_TOKENS_PER_SECOND,
  MIN_VIABLE_EVIDENCE_TOKENS, RESERVED_SYSTEM_TOKENS, TASK_PROFILES, estimateSeconds, fitEvidenceToBudget,
  planEvidenceBudget, splitIntoPasses, taskProfile, type AssistantMode,
} from './budget.js';
import { generateWithHierarchy } from './hierarchical.js';
import { LlamaCppDocumentAssistantProvider } from './llama-cpp.provider.js';
import type { AssistantEvidence } from './rag.service.js';
import type { DocumentAssistantProvider, GroundedGenerationInput } from './provider.js';

const MODES: AssistantMode[] = ['QA', 'SUMMARY', 'COMPARE', 'EXTRACT'];
const evidenceItem = (resourceId: string, tokens: number, id: string): AssistantEvidence & { tokens: number } => ({
  id, resourceId, resourceVersionId: `${resourceId}-v1`, resourceVersion: 1, title: `${resourceId}.pdf`,
  chunkIndex: null, startOffset: 0, endOffset: tokens, textSource: 'NATIVE_TEXT',
  text: 'x'.repeat(tokens * 4), score: 1, tokens,
});

/** ผู้ให้บริการปลอมที่บันทึกทุกคำขอไว้ ใช้ตรวจว่าโมเดลถูกเรียกกี่ครั้งและด้วยอะไร */
class RecordingProvider implements DocumentAssistantProvider {
  calls: GroundedGenerationInput[] = [];
  constructor(private readonly answer: (call: GroundedGenerationInput, index: number) => { answer: string; usedEvidenceIds: string[] }) {}
  getModelInfo() { return { provider: 'test', model: 'test', quantization: 'none', contextTokens: 8192, offline: true as const }; }
  async health() { return { status: 'READY' as const }; }
  async countTokens(text: string) { return LlamaCppDocumentAssistantProvider.estimateTokensFromCharacters(text); }
  async generateGroundedAnswer(input: GroundedGenerationInput) {
    this.calls.push(input);
    return this.answer(input, this.calls.length - 1);
  }
}

describe('F21-D1 adaptive evidence budgeting', { concurrency: 1 }, () => {
  // 1. งบที่วางแผนไว้ต้องไม่ทำให้ prompt เกิน context ไม่ว่าคำถามและประวัติจะยาวแค่ไหน
  test('1. planner never exceeds the model context window', () => {
    for (const mode of MODES) {
      for (const questionTokens of [0, 50, 400, 1200]) {
        for (const historyTokens of [0, 100, 900, 3000]) {
          const plan = planEvidenceBudget({ mode, questionTokens, historyTokens });
          assert.ok(plan.maxPromptTokens <= env.S2_NAS_ASSISTANT_CONTEXT_TOKENS,
            `${mode} q=${questionTokens} h=${historyTokens} ใช้ ${plan.maxPromptTokens} เกิน context`);
          assert.ok(plan.evidenceTokens >= 0);
        }
      }
    }
  });

  // 2. ส่วนที่กันไว้ต้องถูกหักออกจริง ไม่ใช่แค่มีชื่อในสูตร
  test('2. planner reserves output, system, history and question tokens', () => {
    const plan = planEvidenceBudget({ mode: 'QA', questionTokens: 100, historyTokens: 250 });
    const accounted = RESERVED_SYSTEM_TOKENS + 100 + 250 + plan.outputTokens + plan.evidenceTokens;
    assert.equal(plan.maxPromptTokens, accounted);
    assert.ok(accounted <= env.S2_NAS_ASSISTANT_CONTEXT_TOKENS);

    // ประวัติที่ยาวขึ้นต้องเบียดงบหลักฐานลงจริง ไม่ใช่ถูกมองข้าม
    const longer = planEvidenceBudget({ mode: 'QA', questionTokens: 100, historyTokens: 1250 });
    assert.ok(longer.evidenceTokens < plan.evidenceTokens,
      'ประวัติที่ยาวขึ้นหนึ่งพัน token ต้องทำให้งบหลักฐานลดลง');
  });

  /**
   * 3. QA ต้องได้งบแคบกว่า SUMMARY
   *
   * เทียบที่งบ *รวม* ไม่ใช่ต่อ prompt เพราะการสร้าง token ช้ากว่าการอ่านเก้าเท่า
   * คำตอบที่ยาวกว่าของ SUMMARY จึงกินเวลาไปจนเหลือที่ให้หลักฐานต่อ prompt น้อยกว่า QA
   * ความกว้างของ SUMMARY มาจากการอ่านหลายรอบ ซึ่งคือเหตุผลที่ต้องมีการสรุปเป็นชั้น
   */
  test('3. QA receives a narrower evidence budget than SUMMARY', () => {
    const qa = planEvidenceBudget({ mode: 'QA', questionTokens: 40, historyTokens: 0 });
    const summary = planEvidenceBudget({ mode: 'SUMMARY', questionTokens: 40, historyTokens: 0 });
    assert.ok(qa.totalEvidenceTokens < summary.totalEvidenceTokens,
      `QA รวม ${qa.totalEvidenceTokens} ต้องน้อยกว่า SUMMARY รวม ${summary.totalEvidenceTokens}`);
    assert.equal(qa.passes, 1);
    assert.ok(summary.passes > 1, 'SUMMARY ต้องวางแผนอ่านหลายรอบ');
    assert.ok(qa.outputTokens < summary.outputTokens, 'QA ต้องได้เพดานคำตอบสั้นกว่า SUMMARY');
  });

  // 4. เอกสารที่ตรงคำค้นมากที่สุดต้องไม่กินงบจนอีกฉบับไม่มีที่ยืน
  test('4. compare keeps evidence from every resource', () => {
    const profile = taskProfile('COMPARE');
    const ranked = [
      evidenceItem('A', 120, 'E1'), evidenceItem('A', 120, 'E2'), evidenceItem('A', 120, 'E3'),
      evidenceItem('A', 120, 'E4'), evidenceItem('B', 120, 'E5'), evidenceItem('B', 120, 'E6'),
    ];
    const chosen = fitEvidenceToBudget(ranked, { evidenceTokens: 360,
      evidenceLimit: profile.evidenceLimit, perResourceLimit: profile.perResourceLimit });
    const resources = new Set(chosen.map((item) => item.resourceId));
    assert.ok(resources.has('A') && resources.has('B'), 'ต้องมีหลักฐานจากทั้งสองฉบับ');
    for (const resourceId of resources) {
      const used = chosen.filter((item) => item.resourceId === resourceId).length;
      assert.ok(used <= profile.perResourceLimit, `${resourceId} ใช้ ${used} เกินโควตาต่อเอกสาร`);
    }
  });

  // 5. เมื่องบไม่พอ ต้องตัดหลักฐานลงให้พอดีก่อน ไม่ใช่ส่งทั้งหมดไปให้ llama.cpp ตัดเอง
  test('5. an over-budget candidate set is reduced before it reaches the provider', () => {
    const ranked = Array.from({ length: 30 }, (_, index) => evidenceItem(`R${index % 5}`, 400, `E${index + 1}`));
    const plan = planEvidenceBudget({ mode: 'QA', questionTokens: 40, historyTokens: 0 });
    const chosen = fitEvidenceToBudget(ranked, { evidenceTokens: plan.evidenceTokens,
      evidenceLimit: taskProfile('QA').evidenceLimit, perResourceLimit: taskProfile('QA').perResourceLimit });
    const total = chosen.reduce((sum, item) => sum + item.tokens, 0);
    assert.ok(chosen.length < ranked.length, 'ต้องมีการตัดออกจริง');
    assert.ok(total <= plan.evidenceTokens, `เลือกมา ${total} token เกินงบ ${plan.evidenceTokens}`);
  });

  // 6. คำขอที่ทำไม่เสร็จแน่นอนต้องถูกปฏิเสธก่อน ไม่ใช่ปล่อยให้ผู้ใช้รอจนหมดเวลา
  test('6. a still-impossible request is flagged instead of being sent to the model', () => {
    const plan = planEvidenceBudget({ mode: 'SUMMARY', questionTokens: 3000, historyTokens: 3500 });
    assert.equal(plan.impossible, true);
    assert.ok(plan.evidenceTokens < MIN_VIABLE_EVIDENCE_TOKENS);

    // ต้องพยายามลดเพดานคำตอบก่อนยอมแพ้ ไม่ใช่ปฏิเสธทันที
    const rescued = planEvidenceBudget({ mode: 'SUMMARY', questionTokens: 900, historyTokens: 0,
      timeoutSeconds: 140 });
    assert.equal(rescued.reducedOutput, true, 'ต้องลดเพดานคำตอบเพื่อแลกที่ว่างให้หลักฐาน');
    assert.ok(rescued.outputTokens >= TASK_PROFILES.SUMMARY.outputFloorTokens);
  });

  // 7. ไม่มีเส้นทางไหนที่ปล่อยให้ llama.cpp ตัด context ทิ้งเงียบ ๆ
  test('7. no configuration produces a silently truncated context', () => {
    for (const mode of MODES) {
      for (const timeoutSeconds of [60, 120, 180, 300]) {
        for (const contextTokens of [2048, 4096, 8192]) {
          const plan = planEvidenceBudget({ mode, questionTokens: 120, historyTokens: 200, timeoutSeconds, contextTokens });
          assert.ok(plan.maxPromptTokens <= contextTokens,
            `${mode}/${timeoutSeconds}s/${contextTokens} วางแผน ${plan.maxPromptTokens} เกิน context`);
          if (plan.impossible) continue;
          // แผนที่อนุมัติแล้วต้องคาดว่าจะเสร็จก่อนหมดเวลาเสมอ
          const seconds = estimateSeconds({ promptTokens: plan.maxPromptTokens - plan.outputTokens,
            outputTokens: plan.outputTokens }) + LATENCY_SAFETY_MARGIN_SECONDS;
          assert.ok(seconds <= timeoutSeconds + 0.001,
            `${mode}/${timeoutSeconds}s คาดว่าใช้ ${seconds.toFixed(1)}s เกินเวลา`);
        }
      }
    }
  });

  // 8. ชื่อ E1..En ต้องต่อเนื่องและตรงกับสิ่งที่โมเดลเห็นจริง แม้หลังตัดหลักฐานออก
  test('8. evidence aliases stay contiguous and stable after pruning', () => {
    const ranked = [
      evidenceItem('A', 100, 'raw-1'), evidenceItem('B', 100, 'raw-2'),
      evidenceItem('A', 100, 'raw-3'), evidenceItem('C', 9_000, 'raw-4'),
    ];
    const chosen = fitEvidenceToBudget(ranked, { evidenceTokens: 300, evidenceLimit: 10, perResourceLimit: 3 });
    const aliased = chosen.map((item, index) => ({ ...item, id: `E${index + 1}` }));
    assert.deepEqual(aliased.map((item) => item.id), ['E1', 'E2', 'E3']);
    // ชิ้นที่ใหญ่เกินงบต้องหายไปทั้งชิ้น ไม่ใช่เหลือชื่อค้างไว้โดยไม่มีเนื้อหา
    assert.ok(!chosen.some((item) => item.tokens === 9_000));
    assert.equal(new Set(aliased.map((item) => item.id)).size, aliased.length);
  });

  /**
   * 9. คำตอบสุดท้ายของการสรุปเป็นชั้นต้องอ้างอิงกลับไปยังหลักฐานต้นทางเสมอ
   *
   * รอบสุดท้ายเห็นแต่บทสรุปย่อยที่โมเดลสร้างขึ้น ถ้าปล่อยให้อ้างอิงบทสรุปย่อยได้
   * ผู้ใช้จะกดดูที่มาแล้วเจอข้อความที่โมเดลแต่งเอง ไม่ใช่หน้าเอกสารจริง
   */
  test('9. hierarchical summary citations map back to original evidence', async () => {
    const evidence = Array.from({ length: 6 }, (_, index) => evidenceItem(`R${index}`, 500, `E${index + 1}`));
    const provider = new RecordingProvider((call) => ({
      answer: `สรุป [${call.evidence[0]!.id}]`, usedEvidenceIds: [call.evidence[0]!.id],
    }));
    const budget = { evidenceTokens: 1_000, outputTokens: 256, passes: 3, totalEvidenceTokens: 3_000,
      maxPromptTokens: 2_000, estimatedSecondsPerPass: 100, limitedBy: 'LATENCY' as const,
      reducedOutput: false, impossible: false };

    const result = await generateWithHierarchy({ provider, question: 'สรุปเอกสารนี้', language: 'th',
      mode: 'SUMMARY', history: [], evidence, budget, estimateTokens: (text) => Math.ceil(text.length / 4) });

    assert.ok(result.passes > 1, 'ต้องเกิดการสรุปเป็นชั้นจริง');
    assert.ok(result.intermediateSummaries.length >= 2);

    // บทสรุปย่อยต้องใช้ชื่อคนละชุดกับหลักฐานจริง เพื่อให้อ้างอิงผิดไม่ผ่านการตรวจสอบ
    const finalCall = provider.calls.at(-1)!;
    assert.ok(finalCall.evidence.every((item) => /^S[0-9]+$/u.test(item.id)),
      'รอบสุดท้ายต้องเห็นบทสรุปย่อยในชื่อ S1..Sn ไม่ใช่ชื่อหลักฐานจริง');

    // และรหัสที่คำตอบสุดท้ายอ้างอิงต้องเป็นหลักฐานต้นทางทั้งหมด
    const originalIds = new Set(evidence.map((item) => item.id));
    assert.ok(result.output.usedEvidenceIds.length > 0);
    for (const id of result.output.usedEvidenceIds) {
      assert.ok(originalIds.has(id), `${id} ไม่ใช่รหัสหลักฐานต้นทาง`);
    }
    // บทสรุปย่อยเป็นข้อมูลชั่วคราว ต้องไม่ถูกส่งกลับเป็นเนื้อหาคำตอบ
    assert.ok(!result.output.answer.includes('S1'));
  });

  /**
   * ตัวนับสำรองต้องประเมินสูงไว้ก่อนเสมอ
   *
   * ค่า exact ด้านล่างวัดจริงด้วย llama-tokenize.exe บน vocab ของ Qwen3-4B ที่ใช้งานอยู่
   * ฝังไว้เป็นค่าคงที่เพื่อให้เทสต์รันได้โดยไม่ต้องมีไบนารีและไม่ต้องโหลดโมเดล
   *
   * กรณี 'ตัวเลขและเลขที่เอกสาร' คือกรณีที่เคยพลาด สูตรเดิมคิดตัวอักษรที่ไม่ใช่ภาษาไทย
   * เป็น 0.25 token เท่ากันหมด แต่ตัวเลขและเครื่องหมายถูกตัดเกือบหนึ่งต่อหนึ่ง
   * เอกสารการเงินซึ่งเต็มไปด้วยจำนวนเงินและเลขที่เอกสารจึงถูกประเมินต่ำไปราวสองเท่า
   */
  test('character fallback never underestimates real Qwen token counts', () => {
    const measured: Array<[string, string, number]> = [
      ['สัญญาไทยผสมตัวเลข', 'สัญญาจ้างเหมาก่อสร้างอาคารสำนักงาน เลขที่ ก-2568/117 มูลค่า 12,450,000 บาท', 46],
      ['ไทยล้วน', 'ผู้รับจ้างต้องส่งมอบงานงวดสุดท้ายภายในกำหนดเวลาที่ระบุไว้ในสัญญาฉบับนี้', 35],
      ['อังกฤษ', 'The contractor shall deliver the final milestone by the agreed date.', 12],
      ['ตัวเลขและเลขที่เอกสาร', '12,450,000.00 บาท 30/09/2569 VAT 7% เลขที่ INV-2569-00817', 46],
      ['เลขผู้เสียภาษีและบัญชี', 'เลขประจำตัวผู้เสียภาษี 0107536000102 เลขที่บัญชี 123-4-56789-0', 47],
    ];
    for (const [name, text, exact] of measured) {
      const estimated = LlamaCppDocumentAssistantProvider.estimateTokensFromCharacters(text);
      assert.ok(estimated >= exact, `${name}: ประเมินได้ ${estimated} ต่ำกว่าค่าจริง ${exact}`);
    }
    // สูตรเดิม length/3 ประเมินเอกสารการเงินต่ำกว่าความจริงอย่างชัดเจน
    const financial = measured[3]!;
    assert.ok(Math.ceil(financial[1].length / 3) < financial[2],
      'ยืนยันว่าสูตรเดิมประเมินต่ำกว่าความจริงจริง ซึ่งคือต้นเหตุของ F21-D1');
  });

  // การแบ่งรอบต้องไม่ทำให้หลักฐานหายไปเงียบ ๆ
  test('splitting into passes preserves evidence order within the planned passes', () => {
    const items = Array.from({ length: 7 }, (_, index) => ({ resourceId: `R${index}`, tokens: 400, id: index }));
    const groups = splitIntoPasses(items, { evidenceTokens: 1_000, passes: 3 });
    assert.ok(groups.length <= 3);
    const flat = groups.flat();
    assert.deepEqual(flat.map((item) => item.id), items.slice(0, flat.length).map((item) => item.id));
    for (const group of groups.slice(0, -1)) {
      assert.ok(group.reduce((sum, item) => sum + item.tokens, 0) <= 1_000 + 400);
    }
  });

  // อัตราที่ใช้คำนวณต้องเป็นค่าที่วัดได้จริง ไม่ใช่ค่าที่ปรับให้เทสต์ผ่าน
  test('measured throughput constants stay within the observed range', () => {
    assert.ok(MEASURED_PROMPT_TOKENS_PER_SECOND >= 29 && MEASURED_PROMPT_TOKENS_PER_SECOND <= 35);
    assert.ok(MEASURED_GENERATION_TOKENS_PER_SECOND >= 3 && MEASURED_GENERATION_TOKENS_PER_SECOND <= 7);
    assert.equal(env.S2_NAS_ASSISTANT_TIMEOUT_SECONDS, 180, 'ต้องคง timeout ไว้ที่ 180 วินาที');
  });
});

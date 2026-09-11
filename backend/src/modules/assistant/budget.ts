import { env } from '../../config/env.js';

/**
 * ตัววางแผนงบหลักฐานของผู้ช่วยเอกสาร (F21 · แก้ F21-D1)
 *
 * **ปัญหาที่แก้:** เดิมงบหลักฐานเป็นเพดานจำนวนตัวอักษรค่าเดียวสำหรับทุกงาน
 * วัดบนเครื่องจริงแล้วพบว่าเพดานนั้นสร้างคำขอที่ทำไม่เสร็จได้สองแบบ
 *
 * 1. ยาวเกิน context - llama.cpp ตัดทิ้งเงียบ ๆ แล้วโมเดลถูกขอให้อ้างอิงหลักฐาน
 *    ที่ไม่เคยเห็น กลายเป็นการอ้างอิงผิดที่ตรวจจับไม่ได้จากภายนอก
 * 2. ยาวเกินเวลา - prompt eval ~29 tokens/s หลักฐานเต็มเพดานใช้เวลาเกิน timeout
 *    ผู้ใช้รอสามนาทีแล้วไม่ได้อะไรเลย
 *
 * ตัววางแผนนี้คิดงบจาก "สิ่งที่ทำเสร็จได้จริง" คือ context ที่เหลือหลังกันส่วนจำเป็น
 * และเวลาที่เหลือก่อน timeout อัตราทั้งสองมาจากการวัดบนเครื่องนี้จริง
 *
 * **ข้อค้นพบสำคัญที่กำหนดรูปร่างของงบ:** การสร้าง token ช้ากว่าการอ่านราวเก้าเท่า
 * (3.1 เทียบกับ 29 tokens/s) ดังนั้นทุก token ที่กันไว้ให้คำตอบ กินโควตาหลักฐาน
 * ไปประมาณเก้า token งานที่ต้องการคำตอบยาวอย่าง SUMMARY จึงเหลือที่ให้หลักฐาน
 * *น้อยกว่า* QA ต่อหนึ่ง prompt ทั้งที่ควรได้กว้างกว่า
 *
 * ทางออกจึงไม่ใช่การยัดทุกอย่างลง prompt เดียว แต่คือการสรุปเป็นชั้น - SUMMARY
 * ได้งบรวมมากกว่า QA ด้วยการแบ่งเป็นหลายรอบ โดยแต่ละรอบยังพอดีทั้ง context และเวลา
 */

export type AssistantMode = 'QA' | 'SUMMARY' | 'COMPARE' | 'EXTRACT';

/**
 * อัตราที่วัดได้บนเครื่องจริง (4 threads, batch 256, Qwen3-4B Q4_K_M, context 8192)
 *
 * ใช้ค่าที่ช้าที่สุดในช่วงที่วัดได้ ไม่ใช่ค่าเฉลี่ย เพราะการประเมินที่มองโลกในแง่ดี
 * จะทำให้ตัววางแผนอนุมัติคำขอที่ทำไม่เสร็จ ซึ่งคือสิ่งที่กำลังแก้อยู่พอดี
 * (ช่วงที่วัดได้ prompt 29-35 t/s, generation 3-7 t/s)
 */
export const MEASURED_PROMPT_TOKENS_PER_SECOND = 29;
export const MEASURED_GENERATION_TOKENS_PER_SECOND = 3.1;

/** เผื่อเวลา spawn process, โหลดโมเดล 2.5GB และเขียนฐานข้อมูล */
export const LATENCY_SAFETY_MARGIN_SECONDS = 25;

/** system prompt คงที่ วัดจาก buildGroundedPrompt จริง */
export const RESERVED_SYSTEM_TOKENS = 420;

/** ต่ำกว่านี้หลักฐานสั้นจนตอบไม่ได้ แจ้งผู้ใช้ดีกว่าเรียกโมเดลให้เดา */
export const MIN_VIABLE_EVIDENCE_TOKENS = 200;

export interface TaskProfile {
  /** เพดาน token คำตอบตามปกติของงานนี้ */
  outputTokens: number;
  /** ลดเพดานคำตอบได้ถึงเท่านี้เมื่อเวลาไม่พอ ต่ำกว่านี้คำตอบจะขาดกลางประโยค */
  outputFloorTokens: number;
  evidenceLimit: number;
  /** จำนวนหลักฐานสูงสุดต่อหนึ่งเอกสาร คุมไม่ให้เอกสารเดียวกินงบทั้งหมด */
  perResourceLimit: number;
  /** จำนวนรอบสรุปเป็นชั้นสูงสุด 1 คือส่ง prompt เดียวไม่มีชั้น */
  maxPasses: number;
}

/**
 * งบต่องาน
 *
 * QA/EXTRACT ต้องการคำตอบสั้นและหลักฐานที่ตรงที่สุดไม่กี่ชิ้น คำตอบที่สั้นแลกกลับมา
 * เป็นหลักฐานที่กว้างที่สุดต่อ prompt ซึ่งเหมาะกับคำถามเจาะจงอยู่แล้ว
 *
 * COMPARE ต้องได้หลักฐานจากทุกเอกสาร จึงเปิดจำนวนชิ้นให้กว้างแต่จำกัดต่อเอกสารไว้แน่น
 *
 * SUMMARY ได้งบรวมมากที่สุดผ่านการสรุปเป็นชั้น ไม่ใช่ผ่าน prompt เดียวที่ใหญ่ขึ้น
 */
export const TASK_PROFILES: Record<AssistantMode, TaskProfile> = {
  QA: { outputTokens: 192, outputFloorTokens: 128, evidenceLimit: 6, perResourceLimit: 3, maxPasses: 1 },
  EXTRACT: { outputTokens: 192, outputFloorTokens: 128, evidenceLimit: 6, perResourceLimit: 3, maxPasses: 1 },
  COMPARE: { outputTokens: 320, outputFloorTokens: 256, evidenceLimit: 10, perResourceLimit: 2, maxPasses: 1 },
  SUMMARY: { outputTokens: 320, outputFloorTokens: 256, evidenceLimit: 12, perResourceLimit: 4, maxPasses: 3 },
};

export function taskProfile(mode: AssistantMode): TaskProfile {
  const profile = TASK_PROFILES[mode];
  const ceiling = env.S2_NAS_ASSISTANT_MAX_OUTPUT_TOKENS;
  // เพดานรวมของระบบคุมอยู่เหนือค่าต่องานเสมอ ตั้งให้ต่ำลงได้แต่ตั้งให้สูงกว่านี้ไม่ได้
  return {
    ...profile,
    outputTokens: Math.min(profile.outputTokens, ceiling),
    outputFloorTokens: Math.min(profile.outputFloorTokens, ceiling),
  };
}

export interface BudgetInput {
  mode: AssistantMode;
  questionTokens: number;
  historyTokens: number;
  contextTokens?: number;
  timeoutSeconds?: number;
  promptTokensPerSecond?: number;
  generationTokensPerSecond?: number;
}

export interface EvidenceBudget {
  /** งบหลักฐานต่อหนึ่ง prompt ค่านี้คือสิ่งที่ห้ามเกิน */
  evidenceTokens: number;
  /** เพดาน token คำตอบที่อนุมัติ อาจถูกลดจากค่าปกติเมื่อเวลาไม่พอ */
  outputTokens: number;
  /** จำนวนรอบที่วางแผนไว้ 1 คือ prompt เดียว */
  passes: number;
  /** งบหลักฐานรวมทุกรอบ ตัวเลขที่ใช้เทียบความกว้างระหว่างงาน */
  totalEvidenceTokens: number;
  /** ขนาด prompt สูงสุดที่แผนนี้จะสร้าง ต้องไม่เกิน context เสมอ */
  maxPromptTokens: number;
  estimatedSecondsPerPass: number;
  /** ข้อจำกัดที่บีบงบนี้ ใช้เลือกข้อความแจ้งผู้ใช้ให้ตรงสาเหตุ */
  limitedBy: 'CONTEXT' | 'LATENCY';
  /** ต้องลดเพดานคำตอบลงจากค่าปกติเพื่อให้ยังพอมีที่ให้หลักฐาน */
  reducedOutput: boolean;
  /** ทำไม่ได้ตั้งแต่ยังไม่เริ่ม แม้ลดเพดานคำตอบจนถึงพื้นแล้ว */
  impossible: boolean;
}

export function estimateSeconds(input: {
  promptTokens: number; outputTokens: number;
  promptTokensPerSecond?: number; generationTokensPerSecond?: number;
}): number {
  const promptRate = input.promptTokensPerSecond ?? MEASURED_PROMPT_TOKENS_PER_SECOND;
  const genRate = input.generationTokensPerSecond ?? MEASURED_GENERATION_TOKENS_PER_SECOND;
  return input.promptTokens / promptRate + input.outputTokens / genRate;
}

/**
 * คำนวณงบหลักฐานที่ทั้ง context และเวลาเอื้อให้ทำได้จริง
 *
 * คืนค่าที่น้อยกว่าเสมอ เพราะผ่านข้อจำกัดเดียวไม่พอ - คำขอที่พอดี context
 * แต่ใช้เวลาเกิน timeout ก็จบด้วยความล้มเหลวเหมือนกัน
 *
 * เมื่อเวลาไม่พอจะลดเพดานคำตอบลงหาพื้นก่อนที่จะยอมแพ้ เพราะทุก token คำตอบที่คืนมา
 * แลกเป็นหลักฐานได้ประมาณเก้า token การลดคำตอบจึงคุ้มกว่าการทิ้งหลักฐาน
 */
export function planEvidenceBudget(input: BudgetInput): EvidenceBudget {
  const profile = taskProfile(input.mode);
  const context = input.contextTokens ?? env.S2_NAS_ASSISTANT_CONTEXT_TOKENS;
  const timeout = input.timeoutSeconds ?? env.S2_NAS_ASSISTANT_TIMEOUT_SECONDS;
  const promptRate = input.promptTokensPerSecond ?? MEASURED_PROMPT_TOKENS_PER_SECOND;
  const genRate = input.generationTokensPerSecond ?? MEASURED_GENERATION_TOKENS_PER_SECOND;
  const fixed = RESERVED_SYSTEM_TOKENS + input.questionTokens + input.historyTokens;

  const evaluate = (outputTokens: number) => {
    const byContext = context - fixed - outputTokens;
    const promptSecondsAvailable = timeout - LATENCY_SAFETY_MARGIN_SECONDS - outputTokens / genRate;
    const byLatency = Math.floor(promptSecondsAvailable * promptRate) - fixed;
    return { outputTokens, byContext, byLatency, evidenceTokens: Math.min(byContext, byLatency) };
  };

  // ลองเพดานคำตอบปกติก่อน ลดลงหาพื้นเฉพาะเมื่อจำเป็นจริง
  let attempt = evaluate(profile.outputTokens);
  let reducedOutput = false;
  if (attempt.evidenceTokens < MIN_VIABLE_EVIDENCE_TOKENS && profile.outputFloorTokens < profile.outputTokens) {
    const floor = evaluate(profile.outputFloorTokens);
    if (floor.evidenceTokens > attempt.evidenceTokens) {
      attempt = floor;
      reducedOutput = true;
    }
  }

  const evidenceTokens = Math.max(0, attempt.evidenceTokens);
  // แต่ละรอบใช้ prompt ของตัวเอง จึงนับ context ต่อรอบ ไม่ใช่ผลรวมทุกรอบ
  const maxPromptTokens = fixed + evidenceTokens + attempt.outputTokens;
  return {
    evidenceTokens,
    outputTokens: attempt.outputTokens,
    passes: profile.maxPasses,
    totalEvidenceTokens: evidenceTokens * profile.maxPasses,
    maxPromptTokens,
    estimatedSecondsPerPass: estimateSeconds({
      promptTokens: fixed + evidenceTokens, outputTokens: attempt.outputTokens,
      promptTokensPerSecond: promptRate, generationTokensPerSecond: genRate,
    }),
    limitedBy: attempt.byLatency < attempt.byContext ? 'LATENCY' : 'CONTEXT',
    reducedOutput,
    impossible: evidenceTokens < MIN_VIABLE_EVIDENCE_TOKENS,
  };
}

export interface BudgetedItem { resourceId: string; tokens: number }

/**
 * ตัดหลักฐานให้พอดีงบ โดยรักษาความหลากหลายของเอกสารไว้ก่อน
 *
 * รอบแรกให้ทุกเอกสารได้ที่นั่งละหนึ่งชิ้นตามลำดับคะแนน จากนั้นจึงเติมชิ้นที่เหลือ
 * ถ้าเรียงตามคะแนนล้วน ๆ เอกสารที่ตรงคำค้นมากฉบับเดียวจะกินงบทั้งหมด
 * แล้วคำถามเปรียบเทียบจะได้หลักฐานด้านเดียว - ตอบผิดโดยที่ดูเหมือนตอบได้
 */
export function fitEvidenceToBudget<T extends BudgetedItem>(
  ranked: readonly T[],
  budget: { evidenceTokens: number; evidenceLimit: number; perResourceLimit: number },
): T[] {
  const chosen: T[] = [];
  const perResource = new Map<string, number>();
  let used = 0;

  const take = (item: T): void => {
    if (chosen.length >= budget.evidenceLimit) return;
    if ((perResource.get(item.resourceId) ?? 0) >= budget.perResourceLimit) return;
    if (used + item.tokens > budget.evidenceTokens) return;
    chosen.push(item);
    used += item.tokens;
    perResource.set(item.resourceId, (perResource.get(item.resourceId) ?? 0) + 1);
  };

  const seeded = new Set<string>();
  for (const item of ranked) {
    if (seeded.has(item.resourceId)) continue;
    seeded.add(item.resourceId);
    take(item);
  }
  const already = new Set(chosen);
  for (const item of ranked) if (!already.has(item)) take(item);
  return chosen;
}

/**
 * แบ่งหลักฐานเป็นรอบ ๆ ให้แต่ละรอบพอดีงบต่อ prompt (การสรุปเป็นชั้น)
 *
 * ใช้เมื่อ SUMMARY เลือกหลักฐานมาเกินกว่าที่ prompt เดียวจะรับไหว แต่ละกลุ่มจะถูก
 * สรุปแยกกันแล้วนำผลมารวมในรอบสุดท้าย ชิ้นที่ใหญ่เกินหนึ่งรอบจะได้อยู่กลุ่มของตัวเอง
 * แทนที่จะถูกทิ้ง เพราะการทิ้งหมายถึงเนื้อหาส่วนนั้นหายไปจากบทสรุปโดยไม่มีร่องรอย
 */
export function splitIntoPasses<T extends BudgetedItem>(
  items: readonly T[], budget: { evidenceTokens: number; passes: number },
): T[][] {
  if (items.length === 0) return [];
  const groups: T[][] = [];
  let current: T[] = [];
  let used = 0;
  for (const item of items) {
    if (current.length > 0 && used + item.tokens > budget.evidenceTokens) {
      groups.push(current);
      current = [];
      used = 0;
    }
    current.push(item);
    used += item.tokens;
  }
  if (current.length > 0) groups.push(current);
  return groups.slice(0, Math.max(1, budget.passes));
}

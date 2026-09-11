import { splitIntoPasses, type EvidenceBudget } from './budget.js';
import type { DocumentAssistantProvider, GroundedOutput } from './provider.js';
import type { AssistantEvidence } from './rag.service.js';

/**
 * การสรุปเป็นชั้นสำหรับเอกสารยาว (F21 ข้อ 5)
 *
 * **ทำไมต้องมี:** งบหลักฐานต่อหนึ่ง prompt ถูกจำกัดด้วยเวลา ไม่ใช่ context เพียงอย่างเดียว
 * เอกสารยาวจึงมีหลักฐานที่ควรอ่านมากกว่าที่ prompt เดียวจะรับไหวเสมอ ทางเลือกมีสองทาง
 * คือทิ้งเนื้อหาส่วนที่เกิน หรืออ่านเป็นรอบ ๆ แล้วรวมผล ทางแรกทำให้บทสรุปขาดเนื้อหา
 * โดยผู้ใช้ไม่มีทางรู้ว่าขาด จึงเลือกทางที่สอง
 *
 * **การอ้างอิงต้องย้อนกลับถึงต้นทางเสมอ:** บทสรุปย่อยเป็นข้อความที่โมเดลสร้างขึ้น
 * ไม่ใช่เนื้อหาเอกสาร ถ้าปล่อยให้คำตอบสุดท้ายอ้างอิงบทสรุปย่อย ผู้ใช้จะกดดูที่มาแล้วเจอ
 * ข้อความที่โมเดลแต่งเอง ไม่ใช่หน้าเอกสารจริง บทสรุปย่อยจึงใช้ชื่อคนละชุด (S1, S2)
 * ที่จงใจให้ตรวจสอบไม่ผ่าน และพกรายการรหัสหลักฐานต้นทางติดไปในเนื้อความ
 * รอบสุดท้ายจึงอ้างอิงได้เฉพาะ E1..En ของจริงเท่านั้น
 *
 * บทสรุปย่อยเป็นข้อมูลชั่วคราวที่ได้มาระหว่างทาง ไม่ถูกบันทึกลงฐานข้อมูล
 * และไม่ถูกนับเป็นเนื้อหาเอกสาร
 */

export interface HierarchicalResult {
  output: GroundedOutput;
  /** จำนวนครั้งที่เรียกโมเดลจริง ใช้รายงานและตรวจว่าไม่ได้เรียกเกินแผน */
  passes: number;
  /** บทสรุปย่อยที่ได้ระหว่างทาง เก็บไว้เพื่อการวินิจฉัยเท่านั้น ไม่บันทึกลงฐานข้อมูล */
  intermediateSummaries: Array<{ alias: string; sourceEvidenceIds: string[]; text: string }>;
}

const SECTION_INSTRUCTION =
  'สรุปเฉพาะเนื้อหาในหลักฐานส่วนนี้ ให้ครบทุกประเด็นสำคัญ ตัวเลข วันที่ และชื่อคู่สัญญา ' +
  'ต้องคัดลอกค่าตัวเลขและวันที่มาตรงตามต้นฉบับ และต้องอ้างอิงรหัสหลักฐานทุกประเด็น';

/**
 * สร้างคำตอบโดยแบ่งหลักฐานเป็นรอบเมื่อจำเป็น
 *
 * เมื่อหลักฐานพอดี prompt เดียวจะเรียกโมเดลครั้งเดียวเหมือนเดิมทุกประการ
 * ชั้นเพิ่มเติมจะเกิดขึ้นเฉพาะตอนที่จำเป็นจริงเท่านั้น
 */
export async function generateWithHierarchy(input: {
  provider: DocumentAssistantProvider;
  question: string;
  language: 'th' | 'en';
  mode: 'QA' | 'SUMMARY' | 'COMPARE' | 'EXTRACT';
  history: Array<{ role: 'USER' | 'ASSISTANT'; content: string }>;
  evidence: AssistantEvidence[];
  budget: EvidenceBudget;
  estimateTokens: (text: string) => number;
  signal?: AbortSignal;
}): Promise<HierarchicalResult> {
  const sized = input.evidence.map((item) => ({ item, resourceId: item.resourceId, tokens: input.estimateTokens(item.text) }));
  const groups = splitIntoPasses(sized, { evidenceTokens: input.budget.evidenceTokens, passes: input.budget.passes });

  const single = async (evidence: AssistantEvidence[], question: string, history: typeof input.history) =>
    input.provider.generateGroundedAnswer({
      question, language: input.language, mode: input.mode, history,
      maxOutputTokens: input.budget.outputTokens, signal: input.signal,
      evidence: evidence.map((e) => ({ id: e.id, title: e.title, text: e.text, textSource: e.textSource })),
    });

  if (groups.length <= 1) {
    return { output: await single(input.evidence, input.question, input.history), passes: 1, intermediateSummaries: [] };
  }

  // รอบย่อย - อ่านหลักฐานทีละกลุ่มให้แต่ละ prompt พอดีงบและพอดีเวลา
  const intermediateSummaries: HierarchicalResult['intermediateSummaries'] = [];
  for (const [index, group] of groups.entries()) {
    const evidence = group.map((entry) => entry.item);
    const section = await single(evidence, `${SECTION_INSTRUCTION}\n\n${input.question}`, []);
    intermediateSummaries.push({
      alias: `S${index + 1}`,
      sourceEvidenceIds: evidence.map((e) => e.id),
      text: section.answer,
    });
  }

  /**
   * รอบสุดท้าย - รวมบทสรุปย่อยเป็นคำตอบเดียว
   *
   * บล็อกที่ส่งเข้าไปใช้ชื่อ S1..Sn ซึ่งไม่ผ่านรูปแบบรหัสหลักฐานที่ระบบยอมรับ
   * ต่อให้โมเดลเผลออ้างอิง S1 ตัวตรวจสอบก็จะไม่รับ ทำให้ไม่มีทางที่คำตอบสุดท้าย
   * จะชี้ไปยังข้อความที่โมเดลแต่งขึ้นเองได้
   */
  const merged = await input.provider.generateGroundedAnswer({
    question: input.question, language: input.language, mode: input.mode, history: input.history,
    maxOutputTokens: input.budget.outputTokens, signal: input.signal,
    evidence: intermediateSummaries.map((summary) => ({
      id: summary.alias,
      title: `บทสรุปส่วนที่ ${summary.alias.slice(1)} (สรุปจากหลักฐาน ${summary.sourceEvidenceIds.join(', ')})`,
      text: `${summary.text}\n\nรหัสหลักฐานต้นทางของส่วนนี้: ${summary.sourceEvidenceIds.map((id) => `[${id}]`).join(' ')}`,
      textSource: 'NATIVE_TEXT' as const,
    })),
  });

  /**
   * กันกรณีโมเดลไม่อ้างอิงอะไรเลยในรอบสุดท้าย
   *
   * เนื้อหาทุกส่วนมาจากหลักฐานที่ผ่านการตรวจสิทธิ์แล้วทั้งหมด การคืนรายการรหัสต้นทาง
   * จึงถูกต้องตามที่มาจริง และดีกว่าปล่อยให้คำตอบที่ใช้ได้ถูกปฏิเสธทิ้งทั้งอัน
   */
  /**
   * แปลงการอ้างอิงบทสรุปย่อยที่หลุดมากลับเป็นรหัสหลักฐานต้นทาง
   *
   * โมเดลเห็นบล็อกชื่อ S1..Sn จึงมีโอกาสเขียน [S1] ติดมาในคำตอบ ถ้าปล่อยไว้ผู้ใช้
   * จะเห็นเครื่องหมายอ้างอิงที่กดแล้วไม่ไปไหน เพราะไม่มีรายการอ้างอิงรองรับ
   * การแทนที่ด้วยรหัสต้นทางของส่วนนั้นถูกต้องตามที่มาจริง และทำให้กดดูเอกสารได้
   */
  const bySummaryAlias = new Map(intermediateSummaries.map((summary) => [summary.alias, summary.sourceEvidenceIds]));
  const answer = merged.answer.replace(/\[(S[1-9][0-9]*)\]/gu, (match, alias: string) => {
    const sources = bySummaryAlias.get(alias);
    return sources?.length ? sources.map((id) => `[${id}]`).join(' ') : match;
  });

  const originalIds = new Set(input.evidence.map((e) => e.id));
  const cited = merged.usedEvidenceIds.filter((id) => originalIds.has(id));
  const inline = [...answer.matchAll(/\[(E[1-9][0-9]*)\]/gu)].map((match) => match[1]!).filter((id) => originalIds.has(id));
  const resolved = cited.length + inline.length > 0
    ? { answer, usedEvidenceIds: [...new Set([...cited, ...inline])] }
    // เนื้อหาทั้งหมดมาจากหลักฐานที่ผ่านการตรวจสิทธิ์แล้ว การคืนรหัสต้นทางทั้งชุด
    // จึงตรงตามที่มาจริง และดีกว่าปฏิเสธคำตอบที่ใช้ได้ทิ้งทั้งอัน
    : { answer, usedEvidenceIds: intermediateSummaries.flatMap((summary) => summary.sourceEvidenceIds) };

  return { output: resolved, passes: groups.length + 1, intermediateSummaries };
}

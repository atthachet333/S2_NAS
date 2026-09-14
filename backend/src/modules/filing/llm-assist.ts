import { env } from '../../config/env.js';
import { assistantGenerationQueue } from '../assistant/generation-queue.js';
import { documentAssistantProvider } from '../assistant/provider-instance.js';
import type { ClientCandidate, FilingSuggestion } from './rank.js';

/**
 * ตัวช่วยจากโมเดลภาษา - เป็นตัวเสริม ไม่ใช่ผู้ตัดสิน (F22-E)
 *
 * **ขอบเขตที่แคบโดยตั้งใจ:** เครื่องกำหนดกติกาแบบแน่นอนยังเป็นผู้ตัดสินเสมอ
 * โมเดลได้ทำอย่างเดียวคือ "เรียงลำดับผู้สมัครที่ผ่านการตรวจสิทธิ์มาแล้ว"
 * มันไม่มีเครื่องมือ ไม่เห็นฐานข้อมูล ไม่รู้จักเส้นทางไฟล์ และย้ายอะไรไม่ได้เลย
 *
 * **วิธีที่ทำให้ปลอดภัยโดยโครงสร้าง:** ผู้สมัครถูกแปลงเป็นบล็อกหลักฐาน E1..En
 * ของสัญญา F21 เดิม โมเดลจึงเลือกได้เฉพาะด้วยการอ้างอิงรหัสที่เราส่งให้เท่านั้น
 * รหัสที่มันแต่งขึ้นเองจะไม่ผ่านการตรวจสอบของ F21 ตั้งแต่ต้นทาง
 * และเราตรวจซ้ำอีกชั้นว่ารหัสที่ได้กลับมาอยู่ในรายการที่อนุญาตจริง
 *
 * **ล้มเหลวแล้วต้องไม่พาใครล้มตาม:** ทุกความล้มเหลวของโมเดล ไม่ว่าจะปิดอยู่ หายไป
 * หมดเวลา คิวเต็ม หรือคืนค่าที่อ่านไม่ได้ จะถอยกลับไปใช้ผลของเครื่องกำหนดกติกาเงียบ ๆ
 * ผู้ใช้ยังได้ข้อเสนอเสมอ เพียงแต่ไม่มีคำอธิบายที่เรียบเรียงเพิ่ม
 */

export interface LlmAssistOutcome {
  /** ลำดับผู้สมัครหลังการช่วยจัดเรียง - เป็นชุดเดิมเสมอ เปลี่ยนได้แค่ลำดับ */
  clients: ClientCandidate[];
  invoked: boolean;
  applied: boolean;
  /** เหตุผลที่ไม่ได้ใช้ผลจากโมเดล ใช้สำหรับวัดผลและวินิจฉัย ไม่แสดงต่อผู้ใช้ */
  skipReason?: string;
}

/**
 * ควรเรียกโมเดลหรือไม่
 *
 * ไม่เรียกเมื่อกติกาแน่นอนตอบได้ชัดอยู่แล้ว การเรียกโมเดลในกรณีเหล่านั้นมีแต่
 * เพิ่มเวลาและความเสี่ยง โดยไม่มีอะไรให้ปรับปรุง
 */
export function shouldAssist(result: FilingSuggestion): { assist: boolean; reason: string } {
  if (env.S2_NAS_SMART_FILING_LLM_ENABLED !== 1) return { assist: false, reason: 'LLM_DISABLED' };
  if (result.clients.length === 0) return { assist: false, reason: 'NO_CANDIDATES' };
  // ตัวระบุที่ตรงตัวและไม่กำกวมตอบได้ชัดแล้ว ไม่มีอะไรให้โมเดลช่วยตัดสิน
  if (result.clientConfidence === 'HIGH') return { assist: false, reason: 'DETERMINISTIC_HIGH' };
  if (result.clients.length < 2) return { assist: false, reason: 'SINGLE_CANDIDATE' };
  return { assist: true, reason: 'AMBIGUOUS_CLIENTS' };
}

/**
 * ผู้สมัครที่มีตัวระบุตรงตัวและไม่กำกวม ห้ามถูกโมเดลแซง
 *
 * เลขประจำตัวผู้เสียภาษีที่ตรงกันทั้งสิบสามหลักเป็นหลักฐานที่หนักกว่าความเห็น
 * ของโมเดลเสมอ ไม่ว่าโมเดลจะให้เหตุผลดีเพียงใด
 */
function hasProtectedIdentifier(candidate: ClientCandidate): boolean {
  return candidate.signals.includes('EXACT_TAX_ID') && candidate.ambiguousIdentifiers.length === 0;
}

/**
 * ให้โมเดลช่วยจัดลำดับผู้สมัคร
 *
 * คืนชุดเดิมเสมอเมื่อมีอะไรผิดพลาด ไม่มีทางที่ฟังก์ชันนี้จะทำให้ผู้สมัครหายไป
 * หรือมีผู้สมัครใหม่โผล่มา
 */
export async function assistRanking(
  result: FilingSuggestion,
  documentSummary: { fileName: string; categories: string[]; years: number[] },
): Promise<LlmAssistOutcome> {
  const gate = shouldAssist(result);
  if (!gate.assist) return { clients: result.clients, invoked: false, applied: false, skipReason: gate.reason };

  /**
   * ตัวระบุที่ตรงตัวมีอำนาจเหนือโมเดล
   *
   * ถ้าผู้สมัครอันดับหนึ่งมีเลขผู้เสียภาษีที่ไม่กำกวมอยู่แล้ว จะไม่เรียกโมเดลเลย
   * เพราะไม่ว่าโมเดลจะตอบอะไร ผลลัพธ์ก็ต้องเป็นอันเดิม
   */
  if (result.clients.some(hasProtectedIdentifier)) {
    return { clients: result.clients, invoked: false, applied: false, skipReason: 'PROTECTED_IDENTIFIER' };
  }

  const allowed = new Map(result.clients.map((candidate, index) => [`E${index + 1}`, candidate]));
  const evidence = result.clients.map((candidate, index) => ({
    id: `E${index + 1}`,
    // ป้ายที่ปลอดภัยต่อการแสดงผล ไม่มีเส้นทางบนดิสก์หรือรหัสภายในของที่เก็บไฟล์
    title: candidate.clientName,
    text: [
      `ชื่อโฟลเดอร์ลูกค้า: ${candidate.clientName}`,
      `เส้นทาง: ${candidate.pathLabel}`,
      `สัญญาณที่พบ: ${candidate.signals.join(', ') || 'ไม่มี'}`,
      `เหตุผล: ${candidate.reasons.map((reason) => reason.label).join(' / ') || 'ไม่มี'}`,
    ].join('\n'),
    textSource: 'NATIVE_TEXT' as const,
  }));

  const question = [
    'เลือกโฟลเดอร์ลูกค้าที่เหมาะสมที่สุดสำหรับเอกสารนี้ จากตัวเลือกที่ให้มาเท่านั้น',
    `ชื่อไฟล์: ${documentSummary.fileName}`,
    documentSummary.categories.length ? `ประเภทเอกสารที่ตรวจพบ: ${documentSummary.categories.join(', ')}` : '',
    documentSummary.years.length ? `ปีที่ตรวจพบ: ${documentSummary.years.join(', ')}` : '',
    'ตอบเป็นรหัสตัวเลือกเดียวที่เลือก และอธิบายเหตุผลสั้น ๆ',
  ].filter(Boolean).join('\n');

  try {
    const provider = documentAssistantProvider();
    const health = await provider.health();
    if (health.status !== 'READY') {
      return { clients: result.clients, invoked: false, applied: false, skipReason: 'MODEL_NOT_READY' };
    }

    /**
     * ใช้คิวเดียวกับผู้ช่วยเอกสาร
     *
     * เครื่องนี้รันโมเดลบน CPU ได้ทีละงานเท่านั้น การสร้างคิวแยกจะทำให้สองความสามารถ
     * แย่งเครื่องกันเองจนช้าลงทั้งคู่ คิวเต็มถือเป็นความล้มเหลวที่ถอยกลับได้ตามปกติ
     */
    const output = await assistantGenerationQueue.run(() => provider.generateGroundedAnswer({
      question, language: 'th', mode: 'EXTRACT', history: [], evidence, maxOutputTokens: 128,
    }));

    const cited = output.usedEvidenceIds.filter((id) => allowed.has(id));
    if (cited.length === 0) {
      // โมเดลไม่ได้เลือกอะไรที่เรารู้จัก ถือว่าไม่มีข้อมูลเพิ่ม
      return { clients: result.clients, invoked: true, applied: false, skipReason: 'NO_VALID_CHOICE' };
    }

    const chosen = allowed.get(cited[0]!)!;
    // จัดลำดับใหม่โดยไม่เพิ่มหรือลบผู้สมัคร ชุดผลลัพธ์จึงเหมือนเดิมทุกประการ
    const reordered = [chosen, ...result.clients.filter((candidate) => candidate !== chosen)];
    return { clients: reordered, invoked: true, applied: true };
  } catch {
    /**
     * ความล้มเหลวทุกชนิดจบเหมือนกัน - ใช้ผลของกติกาแน่นอน
     *
     * ปิดอยู่ โมเดลหาย หมดเวลา คิวเต็ม หรือคืนค่าที่อ่านไม่ได้ ล้วนไม่ใช่เหตุให้
     * ผู้ใช้ไม่ได้ข้อเสนอเลย ส่วนเสริมที่พังต้องไม่ลากส่วนหลักลงไปด้วย
     */
    return { clients: result.clients, invoked: true, applied: false, skipReason: 'MODEL_FAILED' };
  }
}

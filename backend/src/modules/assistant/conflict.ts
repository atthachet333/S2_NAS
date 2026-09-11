import { extractValueTokens, type ValueKind, type ValueToken } from './fidelity.js';
import type { AssistantEvidence } from './rag.service.js';

interface ConflictResult {
  answer: string;
  evidenceIds: string[];
  detected: boolean;
}

/**
 * The detector is deliberately limited to questions that name one structured
 * business field. Generic comparisons and multi-field questions stay with the
 * model because two different values are not necessarily contradictory there.
 */
function requestedKind(question: string): ValueKind | null {
  if (/\b(?:start|commencement).*(?:end|expiry)|\bfrom\b.*\bto\b|วันเริ่ม.*วันสิ้นสุด/iu.test(question)) return null;
  const requested: ValueKind[] = [];
  if (/วันที่|กำหนดส่ง|วันครบกำหนด|delivery\s+(?:date|deadline)|due\s+date|effective\s+date|\bdate\b/iu.test(question)) requested.push('DATE');
  if (/เงื่อนไขการชำระ|ระยะเวลา|กี่\s*(?:วัน|เดือน|ปี)|payment\s+terms?|duration|within\s+\d*\s*(?:days?|months?|years?)/iu.test(question)) requested.push('DURATION');
  if (/ร้อยละ|เปอร์เซ็นต์|อัตรา(?:ภาษี|ดอกเบี้ย)|percent(?:age)?|\bvat\b|interest\s+rate/iu.test(question)) requested.push('PERCENT');
  if (/ยอด(?:รวม|ชำระ)|มูลค่า|จำนวนเงิน|ราคา|เงินเดือน|amount|total|price|salary|payroll/iu.test(question)) requested.push('MONEY');
  if (/เลขประจำตัว|เลขที่(?:สัญญา|ใบแจ้งหนี้|เอกสาร|บัญชี)|tax\s*id|invoice\s*(?:number|no\.? )|contract\s*(?:reference|number)|account\s*(?:number|no\.?)/iu.test(question)) requested.push('IDENTIFIER');
  return requested.length === 1 ? requested[0]! : null;
}

function key(token: ValueToken): string {
  if (token.kind === 'DATE') return `${token.date!.day}/${token.date!.month}/${token.date!.year}`;
  if (token.kind === 'IDENTIFIER') return token.text!;
  return `${token.numeric}:${token.unit ?? ''}`;
}

function identifierEvidenceMatchesQuestion(question: string, text: string): boolean {
  const concepts: Array<[RegExp, RegExp]> = [
    [/(?:เลขที่)?สัญญา|contract/iu, /(?:เลขที่)?สัญญา|contract/iu],
    [/ใบแจ้งหนี้|invoice/iu, /ใบแจ้งหนี้|invoice/iu],
    [/บัญชี|account/iu, /บัญชี|account/iu],
    [/เลขประจำตัวผู้เสียภาษี|tax\s*id/iu, /เลขประจำตัวผู้เสียภาษี|tax\s*id/iu],
  ];
  const requested = concepts.filter(([questionPattern]) => questionPattern.test(question));
  return requested.length === 1 && requested[0]![1].test(text);
}

/**
 * Surface a conflict only when every participating resource states exactly one
 * value for the requested field and at least two resources state different
 * values. This intentionally declines ambiguous chunks rather than guessing.
 */
export function surfaceStructuredConflict(input: {
  question: string;
  language: 'th' | 'en';
  answer: string;
  evidence: AssistantEvidence[];
}): ConflictResult {
  const kind = requestedKind(input.question);
  if (!kind) return { answer: input.answer, evidenceIds: [], detected: false };

  const byResource = new Map<string, Array<{ evidence: AssistantEvidence; token: ValueToken }>>();
  for (const evidence of input.evidence) {
    if (kind === 'IDENTIFIER' && !identifierEvidenceMatchesQuestion(input.question, evidence.text)) continue;
    for (const token of extractValueTokens(evidence.text).filter((candidate) => candidate.kind === kind)) {
      const entries = byResource.get(evidence.resourceId) ?? [];
      entries.push({ evidence, token });
      byResource.set(evidence.resourceId, entries);
    }
  }

  const facts: Array<{ evidence: AssistantEvidence; token: ValueToken }> = [];
  for (const entries of byResource.values()) {
    const distinct = new Map(entries.map((entry) => [key(entry.token), entry]));
    if (distinct.size === 1) facts.push([...distinct.values()][0]!);
  }
  if (facts.length < 2 || new Set(facts.map((fact) => key(fact.token))).size < 2) {
    return { answer: input.answer, evidenceIds: [], detected: false };
  }

  // Filenames may contain unrelated numbers and are metadata, not evidence for
  // the requested field. Keep the deterministic statement value-only.
  const clauses = facts.map(({ evidence, token }) =>
    input.language === 'th'
      ? `เอกสารระบุ ${token.raw} [${evidence.id}]`
      : `A cited document states ${token.raw} [${evidence.id}]`);
  return {
    answer: input.language === 'th'
      ? `พบข้อมูลไม่ตรงกันระหว่างเอกสาร: ${clauses.join(' ขณะที่ ')}`
      : `The documents contain conflicting information: ${clauses.join('; while ')}`,
    evidenceIds: facts.map((fact) => fact.evidence.id),
    detected: true,
  };
}

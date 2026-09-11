import type { SearchTextSource } from '@prisma/client';
import { env } from '../../config/env.js';
import { AppError } from '../../core/errors.js';
import { planEvidenceBudget, fitEvidenceToBudget, taskProfile, type EvidenceBudget } from './budget.js';
import { LlamaCppDocumentAssistantProvider } from './llama-cpp.provider.js';
import { prisma } from '../../core/prisma.js';
import type { AuthUser } from '../auth/auth.service.js';
import { capabilities, resourceInclude } from '../resources/resource.service.js';
import { semanticEvidenceCandidates } from '../semantic/vector-search.js';
import { visibilityScope } from '../workspace/search.service.js';

export interface AssistantRetrieval { evidence: AssistantEvidence[]; budget: EvidenceBudget }

export type AssistantScopeValue = 'CURRENT_RESOURCE' | 'SELECTED_RESOURCES' | 'AUTHORIZED_LIBRARY';
export interface AssistantEvidence {
  id: string; resourceId: string; resourceVersionId: string; resourceVersion: number;
  title: string; chunkIndex: number | null; startOffset: number; endOffset: number;
  textSource: SearchTextSource; text: string; score: number;
}

function queryTerms(question: string): string[] {
  const words = question.normalize('NFC').toLocaleLowerCase().split(/[^\p{L}\p{N}]+/u).filter((term) => term.length >= 2);
  // Thai normally has no spaces. Four-code-point windows provide deterministic lexical recall;
  // semantic retrieval still supplies meaning/cross-language recall.
  const thaiWindows = words.filter((word) => /[\u0E00-\u0E7F]/u.test(word) && [...word].length > 4)
    .flatMap((word) => { const chars = [...word]; return chars.slice(0, -3).map((_, index) => chars.slice(index, index + 4).join('')); });
  return [...new Set([...words, ...thaiWindows])].slice(0, 40);
}

function excerpt(text: string, start: number, end: number): { text: string; start: number; end: number } {
  const from = Math.max(0, start - 140); const to = Math.min(text.length, Math.max(end + 240, from + 900));
  return { text: text.slice(from, to).replace(/\s+/gu, ' ').trim(), start: from, end: to };
}

export function evidenceHasRequiredExactAnchor(question: string, evidenceText: string): boolean {
  const rules: Array<[RegExp, RegExp]> = [
    [/(?:เลข)?บัญชีธนาคาร|account\s*(?:number|no\.? )|\biban\b|\bswift\b/iu, /(?:เลข)?บัญชีธนาคาร|account\s*(?:number|no\.?)|\biban\b|\bswift\b/iu],
    [/เลขประจำตัวผู้เสียภาษี|tax\s*(?:id|identification)/iu, /เลขประจำตัวผู้เสียภาษี|tax\s*(?:id|identification)/iu],
  ];
  const rule = rules.find(([questionPattern]) => questionPattern.test(question));
  return !rule || rule[1].test(evidenceText);
}

const estimateTokensFromCharacters = LlamaCppDocumentAssistantProvider.estimateTokensFromCharacters;

export async function retrieveAssistantEvidence(input: {
  question: string; scope: AssistantScopeValue; resourceIds: string[]; includeArchived: boolean; mode: 'QA' | 'SUMMARY' | 'COMPARE' | 'EXTRACT';
  /** ข้อความประวัติที่จะถูกส่งไปกับ prompt - ต้องนับรวมในงบไม่งั้นเธรดยาวจะล้น context */
  historyText?: string;
  /** ตัวนับ token จริง เมื่อไม่ส่งมาจะถอยไปใช้การประมาณจากตัวอักษร */
  countTokens?: (text: string) => Promise<number>;
}, user: AuthUser): Promise<AssistantRetrieval> {
  /**
   * วางแผนงบก่อนแตะฐานข้อมูล (F21-D1)
   *
   * งบขึ้นกับชนิดงาน คำถาม และประวัติเท่านั้น ไม่ขึ้นกับผลค้น จึงคำนวณได้ก่อน
   * คำขอที่เป็นไปไม่ได้อยู่แล้วจะถูกปฏิเสธทันทีโดยไม่ต้องค้นเอกสารห้าร้อยฉบับทิ้ง
   */
  const count = input.countTokens ?? (async (text: string) => estimateTokensFromCharacters(text));
  const [questionTokens, historyTokens] = await Promise.all([count(input.question), count(input.historyText ?? "")]);
  const budget = planEvidenceBudget({ mode: input.mode, questionTokens, historyTokens });
  const profile = taskProfile(input.mode);
  if (budget.impossible) {
    // ไม่เหลือที่ว่างพอสำหรับหลักฐานที่ใช้ตอบได้ การเรียกโมเดลจะจบด้วยหมดเวลา
    // หรือถูก llama.cpp ตัด context ทิ้งเงียบ ๆ แจ้งผู้ใช้ทันทีดีกว่าให้รอสามนาทีแล้วล้มเหลว
    throw new AppError("ASSISTANT_REQUEST_TOO_LARGE",
      budget.limitedBy === "LATENCY"
        ? "คำถามและประวัติการสนทนายาวเกินกว่าจะตอบให้ทันในเวลาที่กำหนด กรุณาเริ่มการสนทนาใหม่หรือถามให้สั้นลง"
        : "คำถามและประวัติการสนทนายาวเกินขนาดที่โมเดลรับได้ กรุณาเริ่มการสนทนาใหม่หรือถามให้สั้นลง", 422);
  }

  const scopedWhere = input.scope === 'AUTHORIZED_LIBRARY' ? {} : { id: { in: input.resourceIds } };
  // Only metadata/relations are loaded here. Document text is loaded after both DB scope and capabilities agree.
  const rows = await prisma.resource.findMany({
    where: { ...scopedWhere, type: 'FILE', deletedAt: null,
      ...(input.includeArchived ? {} : { lifecycleState: 'ACTIVE' }), ...visibilityScope(user) },
    include: resourceInclude,
    take: input.scope === 'AUTHORIZED_LIBRARY' ? 2_500 : env.S2_NAS_ASSISTANT_MAX_SELECTED_RESOURCES,
  });
  const authorized = rows.filter((row) => capabilities(row, user).canView);
  if (!authorized.length) return { evidence: [], budget };
  const allowedIds = authorized.map((row) => row.id);
  const safeById = new Map(authorized.map((row) => [row.id, row]));

  const indexes = await prisma.resourceSearchIndex.findMany({
    where: { resourceId: { in: allowedIds }, status: 'READY', extractedText: { not: null } },
    select: { resourceId: true, resourceVersionId: true, versionNumber: true, extractedText: true, textSource: true },
  });
  const current = indexes.filter((idx) => idx.versionNumber === safeById.get(idx.resourceId)?.currentVersion && idx.extractedText && idx.textSource);
  if (!current.length) return { evidence: [], budget };
  const indexByResource = new Map(current.map((idx) => [idx.resourceId, idx]));

  const semantic = await semanticEvidenceCandidates(input.question, [...indexByResource.keys()], env.S2_NAS_ASSISTANT_CANDIDATE_LIMIT)
    .catch(() => []);
  const candidates: Omit<AssistantEvidence, 'id'>[] = [];
  semantic.forEach((hit, rank) => {
    const idx = indexByResource.get(hit.resourceId); const resource = safeById.get(hit.resourceId);
    if (!idx?.extractedText || !resource || idx.resourceVersionId !== hit.resourceVersionId) return;
    const part = excerpt(idx.extractedText, hit.startOffset, hit.endOffset);
    candidates.push({ resourceId: resource.id, resourceVersionId: idx.resourceVersionId,
      resourceVersion: idx.versionNumber, title: resource.name, chunkIndex: hit.chunkIndex,
      startOffset: part.start, endOffset: part.end, textSource: idx.textSource!, text: part.text,
      score: 2 / (60 + rank + 1) });
  });

  const terms = queryTerms(input.question);
  for (const idx of current) {
    const resource = safeById.get(idx.resourceId); const text = idx.extractedText!;
    if (!resource) continue;
    const lower = text.toLocaleLowerCase();
    const matches = terms.map((term) => ({ term, at: lower.indexOf(term) })).filter((m) => m.at >= 0);
    if (matches.length) {
      const at = Math.min(...matches.map((m) => m.at)); const part = excerpt(text, at, at + 500);
      candidates.push({ resourceId: resource.id, resourceVersionId: idx.resourceVersionId, resourceVersion: idx.versionNumber,
        title: resource.name, chunkIndex: null, startOffset: part.start, endOffset: part.end,
        textSource: idx.textSource!, text: part.text, score: 2 / 61 + matches.length / 1000 });
    }
    // The finite scope is already authorized. Representative QA evidence avoids
    // losing an English question over Thai text (or vice versa) when semantic
    // indexing is unavailable. Library scope deliberately has no such fallback.
    if (input.mode === 'QA' && input.scope !== 'AUTHORIZED_LIBRARY' &&
        !candidates.some((candidate) => candidate.resourceId === resource.id)) {
      const positions = text.length > 2200 ? [0, Math.floor(text.length / 2), Math.max(0, text.length - 1000)] : [0];
      positions.forEach((at, n) => { const part = excerpt(text, at, at + 700); candidates.push({
        resourceId: resource.id, resourceVersionId: idx.resourceVersionId, resourceVersion: idx.versionNumber,
        title: resource.name, chunkIndex: null, startOffset: part.start, endOffset: part.end,
        textSource: idx.textSource!, text: part.text, score: 1 / (80 + n + 1),
      }); });
    }
    // Summary/compare/extract need representative evidence even when the action words are absent from the document.
    if (input.mode !== 'QA' && input.scope !== 'AUTHORIZED_LIBRARY') {
      const positions = text.length > 2200 ? [0, Math.floor(text.length / 2), Math.max(0, text.length - 1000)] : [0];
      positions.forEach((at, n) => { const part = excerpt(text, at, at + 700); candidates.push({
        resourceId: resource.id, resourceVersionId: idx.resourceVersionId, resourceVersion: idx.versionNumber,
        title: resource.name, chunkIndex: null, startOffset: part.start, endOffset: part.end,
        textSource: idx.textSource!, text: part.text, score: 1 / (60 + n + 1),
      }); });
    }
  }

  const deduped = [...new Map(candidates.sort((a, b) => b.score - a.score)
    .map((item) => [`${item.resourceId}:${Math.floor(item.startOffset / 300)}`, item])).values()];
  const anchored = deduped.filter((item) => evidenceHasRequiredExactAnchor(input.question, item.text));
  if (deduped.length > 0 && anchored.length === 0) return { evidence: [], budget };
  const eligible = anchored.length > 0 ? anchored : deduped;
  const ranked = eligible.map((item) => ({ item, resourceId: item.resourceId, tokens: estimateTokensFromCharacters(item.text) }));
  // SUMMARY เลือกได้ถึงงบรวมทุกรอบ ชั้นบนจะแบ่งเป็นรอบย่อยให้แต่ละ prompt พอดีเอง
  let chosen = fitEvidenceToBudget(ranked, { evidenceTokens: budget.totalEvidenceTokens,
    evidenceLimit: Math.min(profile.evidenceLimit, env.S2_NAS_ASSISTANT_EVIDENCE_LIMIT), perResourceLimit: profile.perResourceLimit });

  // ยืนยันด้วยตัวนับจริงแล้วตัดชิ้นคะแนนต่ำสุดออกทีละชิ้นถ้ายังเกิน
  // การเลือกรอบแรกใช้ค่าประมาณเพื่อความเร็ว รอบนี้คือค่าจริงที่ใช้ตัดสิน
  // จำกัดจำนวนรอบไว้เพราะการนับมีค่าใช้จ่าย และการตัดทีละชิ้นลู่เข้าเร็วอยู่แล้ว
  for (let attempt = 0; attempt < 4 && chosen.length > 0; attempt++) {
    const exact = await count(chosen.map((entry) => entry.item.text).join("\n\n"));
    if (exact <= budget.totalEvidenceTokens) break;
    // รักษาความหลากหลายของเอกสารไว้ก่อน ตัดจากเอกสารที่มีหลายชิ้นก่อนเสมอ
    const counts = new Map<string, number>();
    for (const entry of chosen) counts.set(entry.resourceId, (counts.get(entry.resourceId) ?? 0) + 1);
    let dropIndex = -1;
    for (let index = chosen.length - 1; index >= 0; index--) {
      if ((counts.get(chosen[index]!.resourceId) ?? 0) > 1) { dropIndex = index; break; }
    }
    chosen.splice(dropIndex >= 0 ? dropIndex : chosen.length - 1, 1);
  }

  // ตั้งชื่อ E1..En หลังตัดเสร็จแล้วเท่านั้น ชื่อจึงต่อเนื่องเสมอและตรงกับสิ่งที่โมเดลเห็นจริง
  return { evidence: chosen.map((entry, index) => ({ ...entry.item, id: `E${index + 1}` })), budget };
}

import { env } from '../../config/env.js';
import { access } from 'node:fs/promises';
import { prisma } from '../../core/prisma.js';
import { AppError, badRequest, forbidden, notFound } from '../../core/errors.js';
import type { AuthUser } from '../auth/auth.service.js';
import { assistantGenerationQueue } from './generation-queue.js';
import { documentAssistantProvider } from './provider-instance.js';
import { validateGroundedCitations } from './provider.js';
import { retrieveAssistantEvidence, type AssistantScopeValue } from './rag.service.js';
import { generateWithHierarchy } from './hierarchical.js';
import { enforceValueFidelity } from './fidelity.js';
import { surfaceStructuredConflict } from './conflict.js';
import { LlamaCppDocumentAssistantProvider } from './llama-cpp.provider.js';
import { capabilities, resourceInclude } from '../resources/resource.service.js';
import { visibilityScope } from '../workspace/search.service.js';

const messageInclude = { citations: { include: { resource: { select: { name: true } } }, orderBy: { evidenceId: 'asc' as const } } } as const;
function messageDto(message: any) { return { id: message.id, role: message.role, content: message.content, createdAt: message.createdAt,
  citations: message.citations.map((c: any) => ({ evidenceId: c.evidenceId, resourceId: c.resourceId,
    resourceVersionId: c.resourceVersionId, filename: c.resource.name, chunkIndex: c.chunkIndex,
    textSource: c.textSource, snippet: c.snippet })) }; }
function threadDto(thread: any) { return { id: thread.id, title: thread.title, scope: thread.scope,
  includeArchived: thread.includeArchived, resourceIds: thread.resources.map((r: any) => r.resourceId),
  resources: thread.resources.map((r: any) => ({ id: r.resourceId, name: r.resource?.name ?? r.resourceId })),
  createdAt: thread.createdAt, updatedAt: thread.updatedAt,
  ...(thread.messages ? { messages: thread.messages.map(messageDto) } : {}) }; }

export async function createAssistantThread(input: { scope: AssistantScopeValue; resourceIds: string[]; includeArchived?: boolean; title?: string }, user: AuthUser) {
  if (!user.permissions.includes('resources:read')) throw forbidden();
  if (input.scope === 'CURRENT_RESOURCE' && input.resourceIds.length !== 1) throw badRequest('ASSISTANT_SCOPE_INVALID', 'ต้องเลือกเอกสารหนึ่งฉบับ');
  if (input.scope === 'SELECTED_RESOURCES' && (input.resourceIds.length < 1 || input.resourceIds.length > env.S2_NAS_ASSISTANT_MAX_SELECTED_RESOURCES))
    throw badRequest('ASSISTANT_SCOPE_INVALID', `เลือกเอกสารได้สูงสุด ${env.S2_NAS_ASSISTANT_MAX_SELECTED_RESOURCES} ฉบับ`);
  if (input.scope === 'AUTHORIZED_LIBRARY' && input.resourceIds.length) throw badRequest('ASSISTANT_SCOPE_INVALID', 'ขอบเขตคลังเอกสารไม่รับรายการไฟล์');
  // Metadata-only authorization. Missing text/model state must not be confused with access denial.
  if (input.scope !== 'AUTHORIZED_LIBRARY') {
    const rows = await prisma.resource.findMany({ where: { id: { in: input.resourceIds }, type: 'FILE', deletedAt: null,
      ...(input.includeArchived ? {} : { lifecycleState: 'ACTIVE' }), ...visibilityScope(user) }, include: resourceInclude });
    const authorizedIds = new Set(rows.filter((row) => capabilities(row, user).canView).map((row) => row.id));
    if (input.resourceIds.some((id) => !authorizedIds.has(id))) throw notFound('RESOURCE_NOT_FOUND', 'ไม่พบเอกสารที่เลือกหรือไม่มีสิทธิ์เข้าถึง');
  }
  const title = input.title?.trim().slice(0, 191) || (input.scope === 'AUTHORIZED_LIBRARY' ? 'ถามจากคลังเอกสาร' : 'ถามเกี่ยวกับเอกสาร');
  const created = await prisma.assistantThread.create({ data: { userId: user.id, title, scope: input.scope,
    includeArchived: Boolean(input.includeArchived), resources: { create: input.resourceIds.map((resourceId) => ({ resourceId })) } },
    include: { resources: { include: { resource: { select: { name: true } } } } } });
  return threadDto(created);
}

export async function listAssistantThreads(user: AuthUser) {
  const rows = await prisma.assistantThread.findMany({ where: { userId: user.id },
    include: { resources: { include: { resource: { select: { name: true } } } } }, orderBy: { updatedAt: 'desc' }, take: 50 });
  return rows.map(threadDto);
}
export async function getAssistantThread(id: string, user: AuthUser) {
  const row = await prisma.assistantThread.findFirst({ where: { id, userId: user.id }, include: {
    resources: { include: { resource: { select: { name: true } } } },
    messages: { include: messageInclude, orderBy: { createdAt: 'asc' }, take: 100 } } });
  if (!row) throw notFound('ASSISTANT_THREAD_NOT_FOUND', 'ไม่พบการสนทนา'); return threadDto(row);
}
export async function deleteAssistantThread(id: string, user: AuthUser) {
  const result = await prisma.assistantThread.deleteMany({ where: { id, userId: user.id } });
  if (!result.count) throw notFound('ASSISTANT_THREAD_NOT_FOUND', 'ไม่พบการสนทนา'); return { deleted: true };
}

function languageOf(text: string): 'th' | 'en' { return /[\u0E00-\u0E7F]/u.test(text) ? 'th' : 'en'; }
function safeNoEvidence(language: 'th' | 'en') { return language === 'th'
  ? 'ไม่พบข้อมูลที่เกี่ยวข้องในเอกสารที่คุณมีสิทธิ์เข้าถึง'
  : 'This information was not found in the documents you are authorized to access.'; }

export async function answerAssistantThread(input: { threadId: string; question: string; clientRequestId: string;
  mode: 'QA' | 'SUMMARY' | 'COMPARE' | 'EXTRACT' }, user: AuthUser) {
  const question = input.question.trim();
  if (!question || question.length > env.S2_NAS_ASSISTANT_MAX_QUESTION_CHARS) throw badRequest('ASSISTANT_QUESTION_INVALID', 'คำถามว่างเปล่าหรือยาวเกินไป');
  return assistantGenerationQueue.run(async () => {
    const existing = await prisma.assistantMessage.findFirst({ where: { threadId: input.threadId, clientRequestId: input.clientRequestId },
      include: { thread: true } });
    if (existing) {
      if (existing.thread.userId !== user.id) throw notFound('ASSISTANT_THREAD_NOT_FOUND', 'ไม่พบการสนทนา');
      const answer = await prisma.assistantMessage.findFirst({ where: { threadId: input.threadId, role: 'ASSISTANT', createdAt: { gte: existing.createdAt } },
        include: messageInclude, orderBy: { createdAt: 'asc' } });
      if (answer) return messageDto(answer);
    }
    const thread = await prisma.assistantThread.findFirst({ where: { id: input.threadId, userId: user.id }, include: { resources: true,
      messages: { orderBy: { createdAt: 'desc' }, take: 6 } } });
    if (!thread) throw notFound('ASSISTANT_THREAD_NOT_FOUND', 'ไม่พบการสนทนา');
    const language = languageOf(question);
    const provider = documentAssistantProvider();
    const history = thread.messages.slice().reverse().map((m) => ({ role: m.role, content: m.content }));
    // ประวัติกินที่ใน context เท่ากับหลักฐาน ตัววางแผนจึงต้องเห็นข้อความจริงที่จะถูกส่งไป
    // ไม่ใช่แค่คำถาม ไม่งั้นเธรดที่คุยกันยาวจะค่อย ๆ เบียดหลักฐานจนล้นโดยไม่มีใครรู้
    const historyText = history.map((m) => m.content).join("\n");
    const { evidence, budget } = await retrieveAssistantEvidence({ question, scope: thread.scope, resourceIds: thread.resources.map((r) => r.resourceId),
      includeArchived: thread.includeArchived, mode: input.mode, historyText,
      countTokens: (text) => provider.countTokens(text) }, user);
    const userMessage = existing ?? await prisma.assistantMessage.create({ data: { threadId: thread.id, role: 'USER', content: question, clientRequestId: input.clientRequestId } });
    if (!evidence.length) {
      const saved = await prisma.assistantMessage.create({ data: { threadId: thread.id, role: 'ASSISTANT', content: safeNoEvidence(language) }, include: messageInclude });
      return messageDto(saved);
    }
    const allowed = new Set(evidence.map((e) => e.id));
    // งบที่วางแผนไว้เป็นตัวกำหนดเพดานคำตอบ ไม่ใช่ค่าคงที่ต่องาน เพราะแผนอาจลดเพดานลง
    // เพื่อแลกที่ว่างให้หลักฐานเมื่อคำถามหรือประวัติยาว
    const { output } = await generateWithHierarchy({ provider, question, language, mode: input.mode, history,
      evidence, budget, estimateTokens: (text) => LlamaCppDocumentAssistantProvider.estimateTokensFromCharacters(text) });
    let used: string[];
    try { used = validateGroundedCitations(output, allowed); }
    catch { throw new AppError('ASSISTANT_CITATION_INVALID', 'โมเดลสร้างแหล่งอ้างอิงที่ตรวจสอบไม่ได้', 502); }
    const byId = new Map(evidence.map((e) => [e.id, e]));

    /**
     * ด่านสุดท้ายก่อนบันทึก - ค่าที่ต้องตรงตัวต้องมีหลักฐานรองรับ (F21-Q2)
     *
     * เทียบกับหลักฐานที่ถูกอ้างอิงจริงเป็นหลัก เพราะคำตอบต้องได้รับการรองรับจากสิ่งที่มันอ้างถึง
     * ไม่ใช่จากหลักฐานชิ้นอื่นที่บังเอิญมีตัวเลขใกล้เคียง กรณีไม่มีการอ้างอิง (คำตอบว่าไม่พบข้อมูล)
     * จึงเทียบกับหลักฐานทั้งชุดแทน
     *
     * ค่าที่ซ่อมไม่ได้อย่างมั่นใจจะไม่ถูกบันทึกและไม่ถูกส่งไปแสดงผล การเก็บคำตอบที่มีตัวเลขผิดไว้
     * อันตรายกว่าการไม่มีคำตอบ เพราะผู้ใช้เอาไปใช้ต่อโดยเข้าใจว่าตรวจสอบแล้ว
     */
    const citedTexts = used.length ? used.map((id) => byId.get(id)!.text) : evidence.map((e) => e.text);
    const fidelity = enforceValueFidelity(output.answer, citedTexts);
    if (fidelity.unresolved.length > 0) {
      throw new AppError('ASSISTANT_VALUE_UNSUPPORTED',
        'คำตอบมีค่าที่ไม่ตรงกับเอกสารอ้างอิง จึงไม่ถูกบันทึก กรุณาลองถามใหม่', 502);
    }
    // Library retrieval can include unrelated structured values. A conflict is
    // asserted only across evidence the model itself cited as supporting the answer.
    const conflictEvidence = thread.scope === 'SELECTED_RESOURCES'
      ? evidence
      : evidence.filter((item) => used.includes(item.id));
    const conflict = surfaceStructuredConflict({ question, language, answer: fidelity.answer, evidence: conflictEvidence });
    used = [...new Set([...used, ...conflict.evidenceIds])];
    const answerText = conflict.answer;
    const saved = await prisma.assistantMessage.create({ data: { threadId: thread.id, role: 'ASSISTANT', content: answerText,
      citations: { create: used.map((id) => { const e = byId.get(id)!; return { evidenceId: id, resourceId: e.resourceId,
        resourceVersionId: e.resourceVersionId, chunkIndex: e.chunkIndex, startOffset: e.startOffset, endOffset: e.endOffset,
        textSource: e.textSource, snippet: e.text.slice(0, 500) }; }) } }, include: messageInclude });
    await prisma.assistantThread.update({ where: { id: thread.id }, data: { updatedAt: new Date(),
      ...(thread.messages.length === 0 ? { title: question.replace(/\s+/gu, ' ').slice(0, 80) } : {}) } });
    void userMessage;
    return messageDto(saved);
  });
}

export async function assistantDiagnostics() {
  const provider = documentAssistantProvider(); const health = await provider.health();
  const installed = env.S2_NAS_ASSISTANT_PROVIDER === 'FAKE' || await Promise.all([
    access(env.ASSISTANT_MODEL_PATH), access(env.ASSISTANT_LLAMA_BIN),
  ]).then(() => true).catch(() => false);
  return { status: health.status, enabled: env.S2_NAS_ASSISTANT_ENABLED === 1, local: true, offline: true,
    installed, model: provider.getModelInfo(), queue: assistantGenerationQueue.diagnostics(),
    runtime: { threads: env.S2_NAS_ASSISTANT_THREADS, batchSize: env.S2_NAS_ASSISTANT_BATCH_SIZE },
    ...(health.reason ? { reason: health.reason } : {}) };
}

import { writeQaVersionFile } from '../src/modules/assistant/qa-fixture.js';
import { removeResourceDirectory } from '../src/core/file-storage.js';
import crypto from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { env } from '../src/config/env.js';
import { prisma } from '../src/core/prisma.js';
import type { AuthUser } from '../src/modules/auth/auth.service.js';
import { documentAssistantProvider } from '../src/modules/assistant/provider-instance.js';
import { planEvidenceBudget } from '../src/modules/assistant/budget.js';
import { generateWithHierarchy } from '../src/modules/assistant/hierarchical.js';
import { LlamaCppDocumentAssistantProvider } from '../src/modules/assistant/llama-cpp.provider.js';
import type { AssistantEvidence } from '../src/modules/assistant/rag.service.js';
import { runSemanticJob } from '../src/modules/semantic/semantic-index.service.js';
import { SEMANTIC_MODEL_VERSION } from '../src/modules/semantic/provider.js';
import { searchResources } from '../src/modules/workspace/search.service.js';

const prefix = `f21-contention-${process.pid}-${Date.now()}`;
let userId = ''; let resourceId = '';

function percentile(values: number[], p: number) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)] ?? 0;
}

async function main() {
  if (env.S2_NAS_ASSISTANT_ENABLED !== 1 || env.S2_NAS_ASSISTANT_PROVIDER !== 'LLAMA_CPP')
    throw new Error('contention QA requires the enabled real assistant');
  if (env.S2_NAS_SEMANTIC_ENABLED !== 1) throw new Error('contention QA requires real F20 semantic search');
  const provider = documentAssistantProvider();
  if ((await provider.health()).status !== 'READY') throw new Error('assistant model is not ready');

  const user = await prisma.user.create({ data: { email: `${prefix}@example.invalid`, displayName: 'F21 contention QA', status: 'ACTIVE' } });
  userId = user.id;
  const auth: AuthUser = { id: user.id, email: user.email, displayName: user.email, type: 'INTERNAL', status: 'ACTIVE',
    mustChangePassword: false, roles: ['MEMBER'], permissions: ['resources:read'] };
  const text = 'Annual payroll overtime report. Employee EMP-771 recorded 17.5 overtime hours for the Northstar project.';
  const resource = await prisma.resource.create({ data: { type: 'FILE', name: `${prefix}.txt`, normalizedName: `${prefix}.txt`,
    siblingKey: prefix, ownerId: user.id, createdById: user.id, visibility: 'ORGANIZATION', currentVersion: 1,
    size: BigInt(text.length), extension: 'txt', mimeType: 'text/plain' } });
  resourceId = resource.id;
  const stored = await writeQaVersionFile(resourceId, text);
  const version = await prisma.resourceVersion.create({ data: { resourceId, versionNumber: 1, storageKey: stored.storageKey,
    size: stored.size, checksum: stored.checksum, mimeType: 'text/plain', createdById: user.id } });
  await prisma.resourceSearchIndex.create({ data: { resourceId, resourceVersionId: version.id, versionNumber: 1, status: 'READY',
    textSource: 'NATIVE_TEXT', extractedText: text, normalizedText: text.toLowerCase(), characterCount: text.length,
    extractorVersion: 'f21-contention', extractedAt: new Date() } });
  const semantic = await prisma.semanticDocumentIndex.create({ data: { resourceId, resourceVersionId: version.id, versionNumber: 1,
    status: 'PENDING', modelVersion: SEMANTIC_MODEL_VERSION, textSource: 'NATIVE_TEXT' } });
  if (await runSemanticJob(semantic.id) !== 'READY') throw new Error('semantic fixture indexing failed');

  const query = async () => {
    const started = performance.now();
    const result = await searchResources({ q: 'payroll overtime Northstar', mode: 'SEMANTIC', limit: 20 }, auth);
    return { ms: performance.now() - started, matched: result.items.some((item) => item.id === resourceId) };
  };
  await query(); // warm model/session
  const baseline = [];
  for (let index = 0; index < 10; index++) baseline.push(await query());

  const measure = async (generation: Promise<{ answer: string; usedEvidenceIds: string[] }>) => {
    const generationStarted = performance.now();
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const queries = [];
    for (let index = 0; index < 10; index++) queries.push(await query());
    const answer = await generation;
    return { queries, ms: performance.now() - generationStarted,
      valid: answer.answer.length > 0 && answer.usedEvidenceIds.some((id) => /^E[1-9]/u.test(id)) };
  };

  const normal = await measure(provider.generateGroundedAnswer({ question: 'What is the delivery date?', language: 'en', mode: 'QA', history: [],
    maxOutputTokens: 192, evidence: [{ id: 'E1', title: 'contention-contract.txt', textSource: 'NATIVE_TEXT',
      text: 'Delivery date: 30 September 2569.' }] }));

  const summaryQuestion = 'Summarize the delivery date, penalty, and warranty.';
  const summaryBudget = planEvidenceBudget({ mode: 'SUMMARY', questionTokens: await provider.countTokens(summaryQuestion), historyTokens: 0 });
  const summaryEvidence: AssistantEvidence[] = Array.from({ length: 6 }, (_, index) => {
    const body = `${'Project execution remained on schedule. '.repeat(45)} Section ${index + 1}. ` +
      (index === 0 ? 'Delivery date: 30 September 2569.' : index === 5 ? 'Penalty: 1,250 baht per day. Warranty ends 31 December 2568.' : '');
    return { id: `E${index + 1}`, resourceId: `summary-${index + 1}`, resourceVersionId: `summary-v${index + 1}`,
      resourceVersion: 1, title: `summary-${index + 1}.txt`, chunkIndex: index, startOffset: 0, endOffset: body.length,
      textSource: 'NATIVE_TEXT', text: body, score: 1 };
  });
  const hierarchical = await measure(generateWithHierarchy({ provider, question: summaryQuestion, language: 'en', mode: 'SUMMARY', history: [],
    evidence: summaryEvidence, budget: summaryBudget,
    estimateTokens: (text) => LlamaCppDocumentAssistantProvider.estimateTokensFromCharacters(text) }).then((result) => result.output));

  const report = { measuredAt: new Date().toISOString(), runtime: { threads: env.S2_NAS_ASSISTANT_THREADS,
    batch: env.S2_NAS_ASSISTANT_BATCH_SIZE, context: env.S2_NAS_ASSISTANT_CONTEXT_TOKENS },
    baseline: { p50Ms: Math.round(percentile(baseline.map((item) => item.ms), 0.5)),
      p95Ms: Math.round(percentile(baseline.map((item) => item.ms), 0.95)), allMatched: baseline.every((item) => item.matched) },
    normal: { p50Ms: Math.round(percentile(normal.queries.map((item) => item.ms), 0.5)),
      p95Ms: Math.round(percentile(normal.queries.map((item) => item.ms), 0.95)), allMatched: normal.queries.every((item) => item.matched),
      generationMs: Math.round(normal.ms), valid: normal.valid },
    hierarchical: { p50Ms: Math.round(percentile(hierarchical.queries.map((item) => item.ms), 0.5)),
      p95Ms: Math.round(percentile(hierarchical.queries.map((item) => item.ms), 0.95)), allMatched: hierarchical.queries.every((item) => item.matched),
      generationMs: Math.round(hierarchical.ms), valid: hierarchical.valid, plannedPasses: summaryBudget.passes } };
  const out = process.env.F21_CONTENTION_OUT;
  if (out) writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  return report.baseline.allMatched && report.normal.allMatched && report.normal.valid
    && report.hierarchical.allMatched && report.hierarchical.valid;
}

let passed = false;
try { passed = await main(); }
catch (error) { console.error(error); }
finally {
  if (resourceId) await prisma.resource.deleteMany({ where: { id: resourceId } });
  if (resourceId) await removeResourceDirectory(resourceId);
  if (userId) await prisma.user.deleteMany({ where: { id: userId } });
  await prisma.$disconnect();
}
process.exit(passed ? 0 : 1);

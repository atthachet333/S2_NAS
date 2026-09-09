import { randomUUID } from 'node:crypto';
import type { SearchTextSource, SemanticIndexStatus } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { env } from '../../config/env.js';
import { logger } from '../../core/logger.js';
import { prisma } from '../../core/prisma.js';
import { chunkSemanticText } from './chunker.js';
import { semanticChunkFingerprint, semanticTextFingerprint } from './fingerprint.js';
import { localEmbeddingProvider } from './local-embedding.provider.js';
import { SEMANTIC_MODEL_VERSION, SemanticModelNotConfiguredError } from './provider.js';

const STALE_PROCESSING_MINUTES = 30;
const MAX_ATTEMPTS = 3;
/** ดูคำอธิบายการแลกเปลี่ยนระหว่างความหน่วงกับกำลังการผลิตใน config/env.ts */
const EMBED_BATCH_SIZE = env.S2_NAS_SEMANTIC_EMBED_BATCH;
let lastReconciledAt: Date | null = null;

async function auditSemantic(action: string, resourceId: string | null, metadata: Record<string, string | number | boolean>): Promise<void> {
  await prisma.activityLog.create({ data: { action, resourceId, metadata } }).catch((error) => {
    logger.warn({ err: error }, '[SEMANTIC] บันทึก audit ไม่สำเร็จ');
  });
}

export async function enqueueSemanticIndex(resourceVersionId: string): Promise<boolean> {
  if (env.S2_NAS_SEMANTIC_ENABLED !== 1) return false;
  try {
    const row = await prisma.resourceSearchIndex.findUnique({
      where: { resourceVersionId },
      select: {
        resourceId: true,
        resourceVersionId: true,
        versionNumber: true,
        status: true,
        extractedText: true,
        textSource: true,
        resource: { select: { currentVersion: true, deletedAt: true, type: true } },
      },
    });
    if (!row || row.status !== 'READY' || !row.extractedText || !row.textSource ||
        row.resource.type !== 'FILE' || row.resource.deletedAt || row.versionNumber !== row.resource.currentVersion) {
      return false;
    }
    const fingerprint = semanticTextFingerprint(row.extractedText);
    const existing = await prisma.semanticDocumentIndex.findUnique({
      where: { resourceVersionId },
      select: { status: true, modelVersion: true, effectiveTextFingerprint: true },
    });
    if (existing?.status === 'READY' && existing.modelVersion === SEMANTIC_MODEL_VERSION &&
        existing.effectiveTextFingerprint === fingerprint) return false;

    await prisma.semanticDocumentIndex.upsert({
      where: { resourceVersionId },
      create: {
        resourceId: row.resourceId,
        resourceVersionId,
        versionNumber: row.versionNumber,
        status: 'PENDING',
        modelVersion: SEMANTIC_MODEL_VERSION,
        textSource: row.textSource,
      },
      update: {
        status: 'PENDING', modelVersion: SEMANTIC_MODEL_VERSION, textSource: row.textSource,
        attempts: 0, processingStartedAt: null, indexedAt: null, errorCode: null,
      },
    });
    await auditSemantic('SEMANTIC_INDEX_QUEUED', row.resourceId, { modelVersion: SEMANTIC_MODEL_VERSION });
    return true;
  } catch (error) {
    logger.warn({ err: error }, '[SEMANTIC] เข้าคิวไม่สำเร็จ');
    return false;
  }
}

export async function invalidateAndEnqueueSemantic(resourceVersionId: string): Promise<void> {
  try {
    await prisma.semanticDocumentIndex.deleteMany({ where: { resourceVersionId } });
  } catch (error) {
    logger.warn({ err: error }, '[SEMANTIC] ล้างดัชนีเดิมไม่สำเร็จ');
  }
  await enqueueSemanticIndex(resourceVersionId);
}

export async function claimNextSemanticJob(now = new Date()): Promise<string | null> {
  const candidate = await prisma.semanticDocumentIndex.findFirst({
    where: { status: 'PENDING' }, orderBy: { createdAt: 'asc' }, select: { id: true },
  });
  if (!candidate) return null;
  const claimed = await prisma.semanticDocumentIndex.updateMany({
    where: { id: candidate.id, status: 'PENDING' },
    data: { status: 'PROCESSING', processingStartedAt: now, attempts: { increment: 1 } },
  });
  return claimed.count === 1 ? candidate.id : null;
}

function safeErrorCode(error: unknown): string {
  if (error instanceof SemanticModelNotConfiguredError) return error.code;
  if (error instanceof Error && /timeout/i.test(error.message)) return 'SEMANTIC_TIMEOUT';
  return 'SEMANTIC_INFERENCE_FAILED';
}

export async function runSemanticJob(indexId: string): Promise<SemanticIndexStatus> {
  const row = await prisma.semanticDocumentIndex.findUnique({
    where: { id: indexId },
    select: {
      id: true, resourceId: true, resourceVersionId: true, versionNumber: true, attempts: true,
      resource: { select: { currentVersion: true, deletedAt: true, type: true } },
      version: { select: { searchIndex: { select: { status: true, extractedText: true, textSource: true } } } },
    },
  });
  if (!row) return 'FAILED';

  const searchIndex = row.version.searchIndex;
  if (row.resource.deletedAt || row.resource.type !== 'FILE' || row.resource.currentVersion !== row.versionNumber ||
      searchIndex?.status !== 'READY' || !searchIndex.extractedText || !searchIndex.textSource) {
    await prisma.semanticDocumentIndex.delete({ where: { id: row.id } });
    return 'FAILED';
  }

  const effectiveText = searchIndex.extractedText.slice(0, env.S2_NAS_SEMANTIC_MAX_TEXT_CHARS);
  const fingerprint = semanticTextFingerprint(effectiveText);
  const provider = localEmbeddingProvider();
  const startedAt = Date.now();

  try {
    const result = await chunkSemanticText(effectiveText, provider, {
      maxTokens: env.S2_NAS_SEMANTIC_CHUNK_TOKENS,
      overlapTokens: env.S2_NAS_SEMANTIC_OVERLAP_TOKENS,
      maxChunks: env.S2_NAS_SEMANTIC_MAX_CHUNKS,
    });
    if (result.chunks.length === 0) throw new Error('ไม่มีข้อความที่สร้าง embedding ได้');

    const vectors: number[][] = [];
    for (let offset = 0; offset < result.chunks.length; offset += EMBED_BATCH_SIZE) {
      if (Date.now() - startedAt > env.S2_NAS_SEMANTIC_JOB_TIMEOUT_SECONDS * 1000) {
        throw new Error('semantic inference timeout');
      }
      /**
       * ส่งทีละแบตช์เล็ก ๆ ไม่ใช่ยัดทุก chunk เข้าคิวรวดเดียว
       *
       * ระหว่างแบตช์ คิวจะหยิบคำค้นของผู้ใช้ที่เข้ามาระหว่างทางขึ้นมาก่อน
       * ช่วงรอที่แย่ที่สุดของผู้ใช้จึงเท่ากับหนึ่งแบตช์ ไม่ใช่ทั้งเอกสาร
       */
      vectors.push(...await provider.embedBatch(
        result.chunks.slice(offset, offset + EMBED_BATCH_SIZE).map((chunk) => chunk.text),
        'passage',
        'BACKGROUND',
      ));
    }

    // Re-read the fingerprint immediately before commit so a correction made during inference cannot go stale-live.
    const current = await prisma.resourceSearchIndex.findUnique({
      where: { resourceVersionId: row.resourceVersionId }, select: { extractedText: true, textSource: true },
    });
    if (!current?.extractedText || semanticTextFingerprint(current.extractedText.slice(0, env.S2_NAS_SEMANTIC_MAX_TEXT_CHARS)) !== fingerprint) {
      await prisma.semanticDocumentIndex.update({
        where: { id: row.id }, data: { status: 'PENDING', processingStartedAt: null, attempts: 0, errorCode: null },
      });
      return 'PENDING';
    }

    await prisma.$transaction(async (tx) => {
      await tx.semanticChunk.deleteMany({ where: { semanticDocumentIndexId: row.id } });
      for (let index = 0; index < result.chunks.length; index += 1) {
        const chunk = result.chunks[index]!;
        const vector = vectors[index]!;
        await tx.$executeRaw(Prisma.sql`
          INSERT INTO semantic_chunks
            (id, semanticDocumentIndexId, resourceId, resourceVersionId, chunkIndex,
             startOffset, endOffset, modelVersion, embeddingFingerprint, textSource, embedding, createdAt)
          VALUES
            (${randomUUID()}, ${row.id}, ${row.resourceId}, ${row.resourceVersionId}, ${index},
             ${chunk.startOffset}, ${chunk.endOffset}, ${SEMANTIC_MODEL_VERSION},
             ${semanticChunkFingerprint(chunk.text)}, ${current.textSource as SearchTextSource},
             VEC_FromText(${JSON.stringify(vector)}), NOW(3))
        `);
      }
      await tx.semanticDocumentIndex.update({
        where: { id: row.id },
        data: {
          status: 'READY', modelVersion: SEMANTIC_MODEL_VERSION,
          effectiveTextFingerprint: fingerprint, textSource: current.textSource,
          chunkCount: result.chunks.length, processingStartedAt: null, indexedAt: new Date(), errorCode: null,
        },
      });
    }, { timeout: Math.max(10_000, env.S2_NAS_SEMANTIC_JOB_TIMEOUT_SECONDS * 1000) });
    await auditSemantic('SEMANTIC_INDEX_READY', row.resourceId, {
      modelVersion: SEMANTIC_MODEL_VERSION, chunks: result.chunks.length, truncated: result.truncated,
    });
    return 'READY';
  } catch (error) {
    const permanent = error instanceof SemanticModelNotConfiguredError || row.attempts >= MAX_ATTEMPTS;
    await prisma.semanticDocumentIndex.update({
      where: { id: row.id },
      data: { status: permanent ? 'FAILED' : 'PENDING', processingStartedAt: null, errorCode: safeErrorCode(error) },
    });
    logger.warn({ err: error, semanticIndexId: row.id }, '[SEMANTIC] สร้างดัชนีไม่สำเร็จ');
    await auditSemantic('SEMANTIC_INDEX_FAILED', row.resourceId, {
      modelVersion: SEMANTIC_MODEL_VERSION, errorCode: safeErrorCode(error), attempts: row.attempts,
    });
    return permanent ? 'FAILED' : 'PENDING';
  }
}

export async function reconcileSemanticIndex(now = new Date()): Promise<{ requeued: number; queued: number }> {
  if (env.S2_NAS_SEMANTIC_ENABLED !== 1) return { requeued: 0, queued: 0 };
  const staleBefore = new Date(now.getTime() - STALE_PROCESSING_MINUTES * 60_000);
  const requeued = await prisma.semanticDocumentIndex.updateMany({
    where: { status: 'PROCESSING', processingStartedAt: { lt: staleBefore } },
    data: { status: 'PENDING', processingStartedAt: null },
  });
  const candidates = await prisma.resourceSearchIndex.findMany({
    where: {
      status: 'READY', extractedText: { not: null }, textSource: { not: null },
      resource: { type: 'FILE', deletedAt: null },
    },
    select: { resourceVersionId: true, versionNumber: true, resource: { select: { currentVersion: true } } },
    orderBy: { updatedAt: 'desc' }, take: 500,
  });
  let queued = 0;
  for (const candidate of candidates) {
    if (candidate.versionNumber === candidate.resource.currentVersion &&
        await enqueueSemanticIndex(candidate.resourceVersionId)) queued += 1;
  }
  lastReconciledAt = new Date();
  return { requeued: requeued.count, queued };
}

export async function semanticDiagnostics(): Promise<{
  health: 'READY' | 'NOT_CONFIGURED' | 'ERROR';
  enabled: boolean;
  counts: Record<SemanticIndexStatus, number>;
  chunks: number;
  oldestPendingAt: Date | null;
  lastReconciledAt: Date | null;
  /** ความลึกของคิวอนุมาน - บอกผู้ดูแลว่าคำค้นกำลังรอเบื้องหลังอยู่หรือไม่ */
  inferenceQueue: ReturnType<ReturnType<typeof localEmbeddingProvider>['queueStats']>;
  model: Omit<ReturnType<typeof localEmbeddingProvider>['info'], 'modelPath'>;
}> {
  const counts = { PENDING: 0, PROCESSING: 0, READY: 0, FAILED: 0 } as Record<SemanticIndexStatus, number>;
  const [groups, chunks, oldest] = await Promise.all([
    prisma.semanticDocumentIndex.groupBy({ by: ['status'], _count: { _all: true } }),
    prisma.semanticChunk.count(),
    prisma.semanticDocumentIndex.findFirst({ where: { status: 'PENDING' }, orderBy: { createdAt: 'asc' }, select: { createdAt: true } }),
  ]);
  for (const group of groups) counts[group.status] = group._count._all;
  let health: 'READY' | 'NOT_CONFIGURED' | 'ERROR' = env.S2_NAS_SEMANTIC_ENABLED === 1 ? 'READY' : 'NOT_CONFIGURED';
  if (env.S2_NAS_SEMANTIC_ENABLED === 1) {
    try { await localEmbeddingProvider().initialize(); } catch (error) {
      health = error instanceof SemanticModelNotConfiguredError ? 'NOT_CONFIGURED' : 'ERROR';
    }
  }
  const { modelPath: _privatePath, ...model } = localEmbeddingProvider().info;
  return {
    health, enabled: env.S2_NAS_SEMANTIC_ENABLED === 1, counts, chunks,
    oldestPendingAt: oldest?.createdAt ?? null, lastReconciledAt,
    inferenceQueue: localEmbeddingProvider().queueStats(),
    model,
  };
}

export async function reindexAllSemantic(): Promise<number> {
  const rows = await prisma.semanticDocumentIndex.updateMany({
    where: {}, data: { status: 'PENDING', attempts: 0, processingStartedAt: null, indexedAt: null, errorCode: null },
  });
  const reconciled = await reconcileSemanticIndex();
  await auditSemantic('SEMANTIC_REINDEX_STARTED', null, { queued: rows.count + reconciled.queued, modelVersion: SEMANTIC_MODEL_VERSION });
  return rows.count + reconciled.queued;
}

export async function retryFailedSemantic(): Promise<number> {
  const result = await prisma.semanticDocumentIndex.updateMany({
    where: { status: 'FAILED' }, data: { status: 'PENDING', attempts: 0, processingStartedAt: null, errorCode: null },
  });
  return result.count;
}

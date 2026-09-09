import { Prisma } from '@prisma/client';
import { env } from '../../config/env.js';
import { prisma } from '../../core/prisma.js';
import { localEmbeddingProvider } from './local-embedding.provider.js';
import { SEMANTIC_MODEL_VERSION } from './provider.js';

export interface SemanticCandidate {
  resourceId: string;
  score: number;
  startOffset: number;
  endOffset: number;
  textSource: 'NATIVE_TEXT' | 'OCR' | 'HUMAN_CORRECTED';
}

interface CandidateRow {
  resourceId: string;
  distance: number;
  startOffset: number;
  endOffset: number;
  textSource: SemanticCandidate['textSource'];
}

/**
 * Query vectors never leave the process; stored vectors never leave MariaDB.
 * allowedResourceIds already contains the exact authorization/filter scope.
 */
export async function semanticCandidates(
  query: string,
  allowedResourceIds: string[],
): Promise<SemanticCandidate[]> {
  if (!query.trim() || allowedResourceIds.length === 0 || env.S2_NAS_SEMANTIC_ENABLED !== 1) return [];
  // คำค้นของผู้ใช้แซงงานทำดัชนีเบื้องหลังที่รออยู่เสมอ
  const vector = await localEmbeddingProvider().embed(query.trim(), 'query', 'INTERACTIVE');
  const vectorJson = JSON.stringify(vector);
  const limit = env.S2_NAS_SEMANTIC_CANDIDATE_LIMIT;
  // Exact scan is both faster and deterministic for a narrowly authorized/filter scope.
  // Larger corpora use the HNSW index. Neither path materializes vectors in application memory.
  const indexStrategy = allowedResourceIds.length <= 2_000
    ? Prisma.raw('IGNORE INDEX (semantic_chunks_embedding_idx)')
    : Prisma.empty;
  const rows = await prisma.$transaction(async (tx) => {
    // MariaDB defaults to only 20 HNSW candidates. A bounded higher recall is important
    // when relational authorization/filter predicates narrow the graph result set.
    await tx.$executeRawUnsafe('SET SESSION mhnsw_ef_search = 1000');
    return tx.$queryRaw<CandidateRow[]>(Prisma.sql`
      SELECT c.resourceId AS resourceId,
             VEC_DISTANCE_COSINE(c.embedding, VEC_FromText(${vectorJson})) AS distance,
             c.startOffset AS startOffset,
             c.endOffset AS endOffset,
             c.textSource AS textSource
      FROM semantic_chunks c ${indexStrategy}
      INNER JOIN semantic_document_indexes d ON d.id = c.semanticDocumentIndexId
      INNER JOIN resources r ON r.id = c.resourceId
      WHERE c.modelVersion = ${SEMANTIC_MODEL_VERSION}
        AND d.status = 'READY'
        AND d.versionNumber = r.currentVersion
        AND r.deletedAt IS NULL
        AND c.resourceId IN (${Prisma.join(allowedResourceIds)})
      ORDER BY distance ASC
      LIMIT ${limit}
    `);
  });

  // Several chunks can belong to one document; keep only its closest chunk.
  const best = new Map<string, SemanticCandidate>();
  for (const row of rows) {
    const score = 1 - Number(row.distance);
    if (!Number.isFinite(score) || score < env.S2_NAS_SEMANTIC_MIN_SCORE || best.has(row.resourceId)) continue;
    best.set(row.resourceId, {
      resourceId: row.resourceId,
      score,
      startOffset: Number(row.startOffset),
      endOffset: Number(row.endOffset),
      textSource: row.textSource,
    });
  }
  return [...best.values()];
}

export async function semanticSnippets(
  candidates: SemanticCandidate[],
  visibleResourceIds: string[],
): Promise<Map<string, { snippet: string; textSource: SemanticCandidate['textSource'] }>> {
  const visible = new Set(visibleResourceIds);
  const safe = candidates.filter((candidate) => visible.has(candidate.resourceId));
  if (safe.length === 0) return new Map();
  const rows = await prisma.resourceSearchIndex.findMany({
    where: { resourceId: { in: safe.map((item) => item.resourceId) }, status: 'READY' },
    select: { resourceId: true, versionNumber: true, extractedText: true, resource: { select: { currentVersion: true } } },
  });
  const textById = new Map(rows
    .filter((row) => row.versionNumber === row.resource.currentVersion && row.extractedText)
    .map((row) => [row.resourceId, row.extractedText!]));
  const snippets = new Map<string, { snippet: string; textSource: SemanticCandidate['textSource'] }>();
  for (const candidate of safe) {
    const text = textById.get(candidate.resourceId);
    if (!text) continue;
    const start = Math.max(0, candidate.startOffset - 80);
    const end = Math.min(text.length, candidate.endOffset + 80);
    snippets.set(candidate.resourceId, {
      snippet: `${start > 0 ? '…' : ''}${text.slice(start, end).replace(/\s+/gu, ' ').trim()}${end < text.length ? '…' : ''}`,
      textSource: candidate.textSource,
    });
  }
  return snippets;
}

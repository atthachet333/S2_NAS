import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { Prisma } from '@prisma/client';
import { env } from '../src/config/env.js';
import { prisma } from '../src/core/prisma.js';
import { localEmbeddingProvider } from '../src/modules/semantic/local-embedding.provider.js';
import { SEMANTIC_MODEL_VERSION } from '../src/modules/semantic/provider.js';
import { semanticCandidates } from '../src/modules/semantic/vector-search.js';

const digits = Prisma.raw('(SELECT 0 n UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9)');

async function main(): Promise<void> {
  if (env.S2_NAS_SEMANTIC_ENABLED !== 1) throw new Error('รันด้วย S2_NAS_SEMANTIC_ENABLED=1');
  const marker = `f20-perf-${Date.now()}`;
  const user = await prisma.user.create({ data: { email: `${marker}@test.invalid`, displayName: 'F20 performance fixture', status: 'ACTIVE' } });
  const resource = await prisma.resource.create({ data: {
    type: 'FILE', name: `${marker}.txt`, normalizedName: `${marker}.txt`, siblingKey: marker,
    ownerId: user.id, createdById: user.id, currentVersion: 1, size: 1n, extension: 'txt', mimeType: 'text/plain',
  } });
  const version = await prisma.resourceVersion.create({ data: {
    resourceId: resource.id, versionNumber: 1, storageKey: `qa/${marker}`, size: 1n,
    checksum: marker, mimeType: 'text/plain', createdById: user.id,
  } });
  const document = await prisma.semanticDocumentIndex.create({ data: {
    resourceId: resource.id, resourceVersionId: version.id, versionNumber: 1, status: 'READY',
    modelVersion: SEMANTIC_MODEL_VERSION, textSource: 'NATIVE_TEXT', chunkCount: 10_000, indexedAt: new Date(),
  } });

  try {
    const vector = await localEmbeddingProvider().embed('annual payroll and overtime report', 'passage');
    const beforeRss = process.memoryUsage().rss;
    const insertStarted = performance.now();
    await prisma.$executeRaw(Prisma.sql`
      INSERT INTO semantic_chunks
        (id, semanticDocumentIndexId, resourceId, resourceVersionId, chunkIndex, startOffset, endOffset,
         modelVersion, embeddingFingerprint, textSource, embedding, createdAt)
      SELECT UUID(), ${document.id}, ${resource.id}, ${version.id},
             a.n + 10*b.n + 100*c.n + 1000*d.n, 0, 40,
             ${SEMANTIC_MODEL_VERSION}, ${'0'.repeat(64)}, 'NATIVE_TEXT', VEC_FromText(${JSON.stringify(vector)}), NOW(3)
      FROM ${digits} a CROSS JOIN ${digits} b CROSS JOIN ${digits} c CROSS JOIN ${digits} d
    `);
    const insertMs = performance.now() - insertStarted;
    const coldStarted = performance.now();
    const first = await semanticCandidates('payroll overtime', [resource.id]);
    const firstQueryMs = performance.now() - coldStarted;
    const warmRuns: number[] = [];
    for (let index = 0; index < 10; index += 1) {
      const started = performance.now();
      await semanticCandidates('payroll overtime', [resource.id]);
      warmRuns.push(performance.now() - started);
    }
    warmRuns.sort((a, b) => a - b);
    console.log(JSON.stringify({
      chunks: await prisma.semanticChunk.count({ where: { semanticDocumentIndexId: document.id } }),
      insertMs: Math.round(insertMs), firstQueryMs: Math.round(firstQueryMs),
      warmP50Ms: Math.round(warmRuns[4]!), warmP95Ms: Math.round(warmRuns[9]!),
      processRssDeltaMb: Math.round((process.memoryUsage().rss - beforeRss) / 1024 / 1024),
      matched: first.length === 1,
    }, null, 2));
  } finally {
    await prisma.resource.delete({ where: { id: resource.id } });
    await prisma.user.delete({ where: { id: user.id } });
    await localEmbeddingProvider().dispose();
    await prisma.$disconnect();
  }
}

main().catch(async (error) => {
  console.error(error instanceof Error ? error.message : error);
  await prisma.$disconnect();
  process.exitCode = 1;
});

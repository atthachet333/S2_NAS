import { prisma } from '../src/core/prisma.js';
import { drainSemanticOnce } from '../src/modules/semantic/semantic.worker.js';
import { reconcileSemanticIndex, reindexAllSemantic, retryFailedSemantic, semanticDiagnostics } from '../src/modules/semantic/semantic-index.service.js';

async function main(): Promise<void> {
  const command = process.argv[2] ?? 'status';
  if (command === 'status') console.log(JSON.stringify(await semanticDiagnostics(), null, 2));
  else if (command === 'reindex') console.log(JSON.stringify({ queued: await reindexAllSemantic() }));
  else if (command === 'retry-failed') console.log(JSON.stringify({ queued: await retryFailedSemantic() }));
  else if (command === 'run') {
    await reconcileSemanticIndex();
    console.log(JSON.stringify({ processed: await drainSemanticOnce() }));
  } else throw new Error('คำสั่งที่รองรับ: status, reindex, retry-failed, run');
}

main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());

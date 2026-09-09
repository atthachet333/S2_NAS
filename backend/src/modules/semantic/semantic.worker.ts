import { env } from '../../config/env.js';
import { logger } from '../../core/logger.js';
import { claimNextSemanticJob, reconcileSemanticIndex, runSemanticJob } from './semantic-index.service.js';

export interface SemanticWorker { stop(): void; runOnce(): Promise<number> }

export async function drainSemanticOnce(concurrency = env.S2_NAS_SEMANTIC_CONCURRENCY): Promise<number> {
  let done = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    for (;;) {
      const id = await claimNextSemanticJob();
      if (!id) return;
      await runSemanticJob(id);
      done += 1;
      if (done >= concurrency * 3) return;
    }
  }));
  return done;
}

export function startSemanticWorker(): SemanticWorker | null {
  if (env.S2_NAS_SEMANTIC_ENABLED !== 1) return null;
  let stopped = false;
  let running = false;
  const tick = async (): Promise<number> => {
    if (stopped || running) return 0;
    running = true;
    try { return await drainSemanticOnce(); }
    catch (error) { logger.warn({ err: error }, '[SEMANTIC] รอบ worker ล้มเหลว'); return 0; }
    finally { running = false; }
  };
  void reconcileSemanticIndex().then(() => tick()).catch((error) => logger.warn({ err: error }, '[SEMANTIC] reconcile ล้มเหลว'));
  const timer = setInterval(() => void tick(), env.S2_NAS_SEMANTIC_POLL_SECONDS * 1000);
  timer.unref();
  return { stop() { stopped = true; clearInterval(timer); }, runOnce: tick };
}

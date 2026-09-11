import { env } from '../../config/env.js';
import { AppError } from '../../core/errors.js';

class GenerationQueue {
  private active = 0;
  private waiting: Array<() => void> = [];
  diagnostics() { return { active: this.active, queued: this.waiting.length, concurrency: 1, limit: env.S2_NAS_ASSISTANT_QUEUE_LIMIT }; }
  async run<T>(job: () => Promise<T>): Promise<T> {
    if (this.active >= 1) {
      if (this.waiting.length >= env.S2_NAS_ASSISTANT_QUEUE_LIMIT) throw new AppError('ASSISTANT_QUEUE_FULL', 'คิวผู้ช่วยเอกสารเต็ม กรุณาลองใหม่ภายหลัง', 429);
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.active++;
    try { return await job(); }
    finally { this.active--; this.waiting.shift()?.(); }
  }
}
export const assistantGenerationQueue = new GenerationQueue();

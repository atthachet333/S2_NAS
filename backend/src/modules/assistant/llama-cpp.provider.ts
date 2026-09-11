import { access, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { env } from '../../config/env.js';
import { AppError } from '../../core/errors.js';
import { buildGroundedPrompt, groundedOutputSchema, type DocumentAssistantProvider, type GroundedGenerationInput } from './provider.js';
import { z } from 'zod';

function jsonObjects(text: string): string[] {
  const objects: string[] = []; let depth = 0; let start = -1; let quoted = false; let escaped = false;
  for (let index = 0; index < text.length; index++) { const char = text[index]!;
    if (quoted) { if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === '"') quoted = false; continue; }
    if (char === '"') { quoted = true; continue; }
    if (char === '{') { if (depth++ === 0) start = index; }
    else if (char === '}' && depth > 0 && --depth === 0 && start >= 0) { objects.push(text.slice(start, index + 1)); start = -1; }
  }
  return objects;
}

export class LlamaCppDocumentAssistantProvider implements DocumentAssistantProvider {
  private readonly modelPath: string; private readonly modelId: string; private readonly quantization: string; private readonly contextTokens: number;
  private static readonly tokenCache = new Map<string, number>();
  lastMetrics: { promptTokensPerSecond: number | null; generationTokensPerSecond: number | null } = { promptTokensPerSecond: null, generationTokensPerSecond: null };
  constructor(private readonly allowDisabled = false, options?: { modelPath?: string; modelId?: string; quantization?: string; contextTokens?: number }) {
    this.modelPath = options?.modelPath ?? env.ASSISTANT_MODEL_PATH; this.modelId = options?.modelId ?? env.S2_NAS_ASSISTANT_MODEL_ID;
    this.quantization = options?.quantization ?? env.S2_NAS_ASSISTANT_QUANTIZATION; this.contextTokens = options?.contextTokens ?? env.S2_NAS_ASSISTANT_CONTEXT_TOKENS;
  }
  getModelInfo() {
    return { provider: 'llama.cpp', model: this.modelId,
      quantization: this.quantization, contextTokens: this.contextTokens, offline: true as const };
  }
  async health(): Promise<{ status: 'READY' | 'NOT_CONFIGURED'; reason?: string }> {
    if (env.S2_NAS_ASSISTANT_ENABLED !== 1 && !this.allowDisabled) return { status: 'NOT_CONFIGURED' as const, reason: 'disabled' };
    try { await Promise.all([access(this.modelPath), access(env.ASSISTANT_LLAMA_BIN)]); return { status: 'READY' as const }; }
    catch { return { status: 'NOT_CONFIGURED' as const, reason: 'model_or_runtime_missing' }; }
  }
  /**
   * ประมาณจำนวน token จากตัวอักษรเมื่อเรียกตัวนับจริงไม่ได้
   *
   * แยกอัตราตามภาษาเพราะวัดแล้วต่างกันมาก ไทย 0.61 token/ตัวอักษร
   * ละติน 0.25 การใช้อัตราเดียวกับทั้งสองภาษาจะพลาดไปเกินสองเท่า
   * บวกส่วนเผื่ออีก 15% เพราะการประเมินต่ำเกินจริงอันตรายกว่าสูงเกินจริง -
   * สูงไปแค่ตัดหลักฐานเกินจำเป็น แต่ต่ำไปทำให้ prompt ล้น context แล้วถูกตัดทิ้งเงียบ ๆ
   */
  static estimateTokensFromCharacters(text: string): number {
    let thai = 0; let dense = 0; let latin = 0;
    for (const char of text) {
      const code = char.codePointAt(0)!;
      if (code >= 0x0e00 && code <= 0x0e7f) thai++;
      // ตัวเลข เครื่องหมาย และสัญลักษณ์ถูกตัดเกือบหนึ่งต่อหนึ่ง เลขที่เอกสารกับจำนวนเงิน
      // จึงกิน token มากกว่าข้อความภาษาอังกฤษความยาวเท่ากันหลายเท่า
      else if (/[0-9\p{P}\p{S}]/u.test(char)) dense++;
      else latin++;
    }
    return Math.ceil((thai * 0.61 + dense * 0.9 + latin * 0.28) * 1.15);
  }

  /**
   * นับ token ด้วย vocab จริงของโมเดล
   *
   * ส่งข้อความผ่านไฟล์ไม่ใช่ผ่าน argument เพราะ Windows จำกัดความยาว command line
   * ไว้ราว 32,000 ตัวอักษร ซึ่งสั้นกว่าหลักฐานที่ส่งได้จริง
   */
  async countTokens(text: string): Promise<number> {
    if (text.length === 0) return 0;
    const cached = LlamaCppDocumentAssistantProvider.tokenCache.get(text);
    if (cached !== undefined) return cached;
    let counted: number;
    try { counted = await this.countTokensExact(text); }
    catch { return LlamaCppDocumentAssistantProvider.estimateTokensFromCharacters(text); }
    // แคชแบบมีเพดาน - ข้อความหลักฐานเดิมถูกนับซ้ำทุกครั้งที่ผู้ใช้ถามต่อในเธรดเดียวกัน
    if (LlamaCppDocumentAssistantProvider.tokenCache.size >= 512) LlamaCppDocumentAssistantProvider.tokenCache.clear();
    LlamaCppDocumentAssistantProvider.tokenCache.set(text, counted);
    return counted;
  }

  private async countTokensExact(text: string): Promise<number> {
    const file = path.join(tmpdir(), `s2nas-tok-${randomUUID()}.txt`);
    await writeFile(file, text, "utf8");
    try {
      return await new Promise<number>((resolve, reject) => {
        const child = spawn(env.ASSISTANT_TOKENIZER_BIN, ["-m", this.modelPath, "-f", file, "--ids"],
          { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "";
        // ตัวนับโหลดแค่ vocab ปกติเสร็จใน 0.4 วินาที ถ้าเกิน 20 ถือว่าผิดปกติ
        const timer = setTimeout(() => { child.kill(); reject(new Error("tokenizer timeout")); }, 20_000);
        child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
        child.once("error", (error) => { clearTimeout(timer); reject(error); });
        child.once("close", (code) => {
          clearTimeout(timer);
          if (code !== 0) { reject(new Error("tokenizer failed")); return; }
          const ids = /\[([^\]]*)\]/su.exec(stdout);
          if (!ids) { reject(new Error("tokenizer output unreadable")); return; }
          const count = ids[1]!.split(",").filter((part) => part.trim().length > 0).length;
          if (count === 0) { reject(new Error("tokenizer returned no tokens")); return; }
          resolve(count);
        });
      });
    } finally { await rm(file, { force: true }).catch(() => undefined); }
  }
  async generateGroundedAnswer(input: GroundedGenerationInput) {
    const health = await this.health();
    if (health.status !== 'READY') throw new AppError('ASSISTANT_NOT_CONFIGURED', 'ยังไม่ได้ติดตั้งโมเดลผู้ช่วยเอกสารในเครื่อง', 503);
    const prompt = buildGroundedPrompt(input);
    const args = ['-m', this.modelPath, '-p', prompt, '-n', String(Math.min(input.maxOutputTokens ?? env.S2_NAS_ASSISTANT_MAX_OUTPUT_TOKENS, env.S2_NAS_ASSISTANT_MAX_OUTPUT_TOKENS)),
      '-c', String(this.contextTokens), '--temp', '0.1', '--single-turn', '--reasoning', 'off',
      '-t', String(env.S2_NAS_ASSISTANT_THREADS), '-tb', String(env.S2_NAS_ASSISTANT_THREADS),
      '-b', String(env.S2_NAS_ASSISTANT_BATCH_SIZE), '-ub', String(env.S2_NAS_ASSISTANT_BATCH_SIZE),
      '--no-display-prompt', '--simple-io', '--log-disable'];
    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn(env.ASSISTANT_LLAMA_BIN, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = ''; let stderr = '';
      const timeout = setTimeout(() => { child.kill(); reject(new AppError('ASSISTANT_TIMEOUT', 'ผู้ช่วยเอกสารใช้เวลานานเกินไป กรุณาลองใหม่', 504)); }, env.S2_NAS_ASSISTANT_TIMEOUT_SECONDS * 1000);
      const abort = () => { child.kill(); reject(new AppError('ASSISTANT_CANCELLED', 'หยุดสร้างคำตอบแล้ว', 499)); };
      input.signal?.addEventListener('abort', abort, { once: true });
      child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
      child.stderr.on('data', (chunk: Buffer) => { if (stderr.length < 100_000) stderr += chunk.toString('utf8'); });
      child.once('error', reject);
      child.once('close', (code) => { clearTimeout(timeout); input.signal?.removeEventListener('abort', abort); code === 0 ? resolve(`${stdout}\n${stderr}`) : reject(new AppError('ASSISTANT_GENERATION_FAILED', 'สร้างคำตอบไม่สำเร็จ', 503)); });
    });
    const metrics = /Prompt:\s*([0-9.]+) t\/s\s*\|\s*Generation:\s*([0-9.]+) t\/s/iu.exec(output);
    this.lastMetrics = { promptTokensPerSecond: metrics ? Number(metrics[1]) : null, generationTokensPerSecond: metrics ? Number(metrics[2]) : null };
    for (const candidate of jsonObjects(output).reverse()) {
      try {
        const parsed: unknown = JSON.parse(candidate);
        const strict = groundedOutputSchema.safeParse(parsed); if (strict.success) return strict.data;
        // Safe repair: Qwen occasionally omits the redundant array. It may be reconstructed only
        // from syntactically valid inline evidence aliases; service-level allow-list validation follows.
        const answerOnly = z.object({ answer: z.string().min(1).max(30000) }).strict().safeParse(parsed);
        if (answerOnly.success) return { answer: answerOnly.data.answer,
          usedEvidenceIds: [...new Set([...answerOnly.data.answer.matchAll(/\[([ES][1-9][0-9]*)\]/gu)].map((m) => m[1]!))] };
      } catch { /* try next balanced candidate */ }
    }
    throw new AppError('ASSISTANT_INVALID_RESPONSE', 'โมเดลคืนคำตอบที่ตรวจสอบไม่ได้', 502);
  }
}

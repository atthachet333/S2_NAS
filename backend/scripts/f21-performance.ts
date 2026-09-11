import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { env } from '../src/config/env.js';
import { buildGroundedPrompt, groundedOutputSchema, type GroundedGenerationInput } from '../src/modules/assistant/provider.js';

interface MemorySample { atMs: number; workingSetBytes: number; peakWorkingSetBytes: number; privateBytes: number; cpuSeconds: number }

/** verbose lines look like "0.02.925.973 I slot init_sampler: ..." = H.MM.SS.mmm since process start */
function modelReadyMs(text: string): number | null {
  const match = /^(\d+)\.(\d{2})\.(\d{2})\.(\d{3}) .*init_sampler/mu.exec(text);
  if (!match) return null;
  return Math.round(Number(match[1]) * 3_600_000 + Number(match[2]) * 60_000 + Number(match[3]) * 1000 + Number(match[4]));
}

function numberMatch(text: string, pattern: RegExp): number | null {
  const match = pattern.exec(text);
  return match ? Number(match[1]) : null;
}

async function runCase(name: string, input: GroundedGenerationInput) {
  const prompt = buildGroundedPrompt(input);
  const started = performance.now();
  const args = ['-m', env.ASSISTANT_MODEL_PATH, '-p', prompt, '-n', '512', '-c', String(env.S2_NAS_ASSISTANT_CONTEXT_TOKENS),
    '--temp', '0.1', '--single-turn', '--reasoning', 'off', '--no-display-prompt', '--simple-io',
    '-t', String(env.S2_NAS_ASSISTANT_THREADS), '-tb', String(env.S2_NAS_ASSISTANT_THREADS),
    '-b', String(env.S2_NAS_ASSISTANT_BATCH_SIZE), '-ub', String(env.S2_NAS_ASSISTANT_BATCH_SIZE),
    // build b10868 prints token counts and load timestamps only in verbose mode
    '-v'];
  const child = spawn(env.ASSISTANT_LLAMA_BIN, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const samples: MemorySample[] = []; let combined = ''; let firstOutputMs: number | null = null; let firstJsonMs: number | null = null;
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; child.kill(); }, env.S2_NAS_ASSISTANT_TIMEOUT_SECONDS * 1000);
  let stdoutText = '';
  // Verbose diagnostics go to stderr and begin immediately, so first-output latency must be
  // measured from stdout alone; otherwise a log line is mistaken for the first generated token.
  child.stdout.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf8'); combined += text; stdoutText += text;
    if (firstOutputMs === null && text.trim()) firstOutputMs = performance.now() - started;
    if (firstJsonMs === null && stdoutText.includes('{')) firstJsonMs = performance.now() - started;
  });
  child.stderr.on('data', (chunk: Buffer) => { combined += chunk.toString('utf8'); });
  const monitorScript = `$targetPid=${child.pid}; while($true){$p=Get-Process -Id $targetPid -ErrorAction SilentlyContinue; if(-not $p){break}; Write-Output (([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()).ToString()+'|'+$p.WorkingSet64+'|'+$p.PeakWorkingSet64+'|'+$p.PrivateMemorySize64+'|'+$p.CPU); Start-Sleep -Milliseconds 100}`;
  const monitor = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', monitorScript], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  let monitorBuffer = '';
  monitor.stdout.on('data', (chunk: Buffer) => { monitorBuffer += chunk.toString('utf8'); const lines = monitorBuffer.split(/\r?\n/u); monitorBuffer = lines.pop() ?? '';
    for (const line of lines) { const parts = line.trim().split('|').map(Number); if (parts.length === 5 && parts.every(Number.isFinite))
      samples.push({ atMs: parts[0]! - Date.now() + performance.now() - started, workingSetBytes: parts[1]!, peakWorkingSetBytes: parts[2]!, privateBytes: parts[3]!, cpuSeconds: parts[4]! }); } });
  const [code] = await once(child, 'close') as [number]; clearTimeout(timeout); await once(monitor, 'close').catch(() => undefined);
  const elapsedMs = performance.now() - started;
  // Parse the answer from stdout only: verbose diagnostics on stderr also contain braces,
  // and matching those would score a valid answer as invalid.
  const jsonStart = stdoutText.lastIndexOf('{'); const jsonEnd = stdoutText.indexOf('}', jsonStart);
  let validJson = false;
  if (jsonStart >= 0 && jsonEnd > jsonStart) { try { validJson = groundedOutputSchema.safeParse(JSON.parse(stdoutText.slice(jsonStart, jsonEnd + 1))).success; } catch { /* reported below */ } }
  const peak = samples.reduce((best, sample) => sample.workingSetBytes > best.workingSetBytes ? sample : best,
    { atMs: 0, workingSetBytes: 0, peakWorkingSetBytes: 0, privateBytes: 0, cpuSeconds: 0 });
  const beforeFirstToken = samples.filter((sample) => firstJsonMs === null || sample.atMs <= firstJsonMs)
    .reduce((best, sample) => sample.workingSetBytes > best.workingSetBytes ? sample : best,
      { atMs: 0, workingSetBytes: 0, peakWorkingSetBytes: 0, privateBytes: 0, cpuSeconds: 0 });
  return {
    name, exitCode: code, timedOut, validJson, processStartupToFirstOutputMs: Math.round(firstOutputMs ?? 0),
    firstTokenApproxMs: Math.round(firstJsonMs ?? 0), totalMs: Math.round(elapsedMs),
    // this build prints no 'load time' line; verbose lines are stamped H.MM.SS.mmm from process
    // start, so the sampler-init stamp marks the model loaded and ready to evaluate
    modelLoadMs: modelReadyMs(combined),
    promptTokens: numberMatch(combined, /prompt eval time\s*=.*?\/\s*(\d+)\s*tokens/iu),
    // the generation line is 'eval time = ... / N tokens' and must not match 'prompt eval time'
    outputTokens: numberMatch(combined, /(?<!prompt )eval time\s*=.*?\/\s*(\d+)\s*tokens/iu),
    promptTokensPerSecond: numberMatch(combined, /Prompt:\s*([0-9.]+)\s*t\/s/iu),
    generationTokensPerSecond: numberMatch(combined, /Generation:\s*([0-9.]+)\s*t\/s/iu),
    preFirstTokenWorkingSetBytes: beforeFirstToken.workingSetBytes, peakWorkingSetBytes: peak.workingSetBytes,
    peakPrivateBytes: peak.privateBytes, cpuSeconds: samples.at(-1)?.cpuSeconds ?? null, sampleCount: samples.length,
  };
}

const longThai = Array.from({ length: 100 }, (_, index) =>
  `ส่วนที่ ${index + 1}: รายงานการดำเนินงานทั่วไปของบริษัท ไม่มีข้อกำหนดพิเศษ ${index === 92 ? 'กำหนดส่งรายงานฉบับสุดท้ายวันที่ 18 ธันวาคม 2569 และค่าปรับ 2,000 บาทต่อวัน' : ''}`,
).join('\n');
const cases: Array<[string, GroundedGenerationInput]> = [
  ['thai', { question: 'กำหนดส่งเมื่อไรและค่าปรับเท่าไร', language: 'th', mode: 'QA', history: [], evidence: [{ id: 'E1', title: 'สัญญา.txt', textSource: 'NATIVE_TEXT', text: 'กำหนดส่งวันที่ 30 กันยายน 2569 ค่าปรับ 1,500 บาทต่อวัน' }] }],
  ['english', { question: 'What is the termination notice period?', language: 'en', mode: 'QA', history: [], evidence: [{ id: 'E1', title: 'agreement.txt', textSource: 'NATIVE_TEXT', text: 'Either party may terminate this agreement with 45 days written notice.' }] }],
  ['cross-language', { question: 'What is the payment due date?', language: 'en', mode: 'QA', history: [], evidence: [{ id: 'E1', title: 'ใบแจ้งหนี้.txt', textSource: 'NATIVE_TEXT', text: 'กำหนดชำระเงินวันที่ 15 พฤศจิกายน 2569' }] }],
  ['long-summary', { question: 'สรุปกำหนดส่งและค่าปรับของเอกสารนี้', language: 'th', mode: 'SUMMARY', history: [], evidence: [{ id: 'E1', title: 'รายงานยาว.txt', textSource: 'NATIVE_TEXT', text: longThai }] }],
];

const results = [];
for (const [name, input] of cases) {
  const result = await runCase(name, input); results.push(result);
  process.stderr.write(`[F21-PERF] ${name}: ${result.totalMs} ms, peak ${result.peakWorkingSetBytes} bytes, valid=${result.validJson}\n`);
}
process.stdout.write(`${JSON.stringify({ measuredAt: new Date().toISOString(), hardware: { threads: env.S2_NAS_ASSISTANT_THREADS,
  batchSize: env.S2_NAS_ASSISTANT_BATCH_SIZE, contextTokens: env.S2_NAS_ASSISTANT_CONTEXT_TOKENS }, results }, null, 2)}\n`);

import { execFile } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { env } from '../../../config/env.js';

/**
 * ตัวเชื่อมกับเครื่องมือ OCR ในเครื่อง
 *
 * ความปลอดภัยของโมดูลนี้ตั้งอยู่บนกฎสามข้อที่ห้ามละเมิด:
 *
 *   1. ใช้ execFile พร้อมอาร์กิวเมนต์เป็นอาร์เรย์เสมอ ไม่มี shell: true
 *      คำสั่งจึงไม่ถูกตีความโดยเชลล์ และไม่มีทางเกิดการฉีดคำสั่ง
 *      แม้ชื่อไฟล์จะเป็น "; calc.exe" หรือ "& whoami" ก็ตาม
 *
 *   2. เส้นทางที่ส่งให้เครื่องมือถูกสร้างโดยเซิร์ฟเวอร์ทั้งหมด
 *      ผู้ใช้ไม่มีทางกำหนดเส้นทางจริงบนดิสก์ได้เลย ทั้งทางตรงและทางอ้อม
 *      ชื่อไฟล์ของผู้ใช้ไม่เคยกลายเป็นส่วนหนึ่งของเส้นทาง
 *
 *   3. เอกสารไม่เคยออกจากเครื่องนี้
 *      ไม่มีการเรียกบริการภายนอก ไม่มีการอัปโหลดไปที่ใด
 *      OCR ทั้งหมดเกิดขึ้นในเครื่องเดียวกับที่เก็บไฟล์
 */

export type OcrErrorCode =
  | 'OCR_NOT_CONFIGURED'
  | 'OCR_UNSUPPORTED'
  | 'OCR_PAGE_LIMIT_EXCEEDED'
  | 'OCR_IMAGE_TOO_LARGE'
  | 'OCR_TIMEOUT'
  | 'OCR_RENDER_FAILED'
  | 'OCR_ENGINE_FAILED'
  | 'OCR_NO_TEXT_FOUND';

export class OcrError extends Error {
  constructor(readonly code: OcrErrorCode, message: string) {
    super(message);
    this.name = 'OcrError';
  }
}

/** จำกัดขนาดผลลัพธ์ที่รับจากเครื่องมือ กันกรณีที่มันพ่นข้อมูลไม่รู้จบ */
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

export interface EngineProbe {
  available: boolean;
  binary: string | null;
  version: string | null;
  languages: string[];
  /** ภาษาที่ตั้งค่าไว้มีครบในเครื่องหรือไม่ */
  languagesReady: boolean;
  missingLanguages: string[];
  reason: string | null;
}

/**
 * เรียกโปรแกรมภายนอกอย่างปลอดภัย
 *
 * อาร์กิวเมนต์เป็นอาร์เรย์เสมอ - นี่คือจุดเดียวในระบบที่เรียกโปรแกรมภายนอกเพื่อ OCR
 * และไม่มีเส้นทางอื่นที่รับสตริงคำสั่งทั้งบรรทัด
 */
function run(
  binary: string,
  args: string[],
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      binary,
      args,
      {
        timeout: timeoutMs,
        maxBuffer: MAX_OUTPUT_BYTES,
        windowsHide: true,
        // ไม่มี shell โดยเด็ดขาด - อาร์กิวเมนต์ถูกส่งตรงถึงโปรแกรม
        shell: false,
        encoding: 'utf8',
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ stdout, stderr });
          return;
        }
        const killed = (error as NodeJS.ErrnoException & { killed?: boolean }).killed;
        if (killed) {
          reject(new OcrError('OCR_TIMEOUT', 'ใช้เวลาอ่านข้อความนานเกินกำหนด'));
          return;
        }
        // ข้อความจากเครื่องมือไม่ถูกส่งต่อออกไป - อาจมีเส้นทางจริงอยู่ข้างใน
        reject(new OcrError('OCR_ENGINE_FAILED', 'เครื่องมืออ่านข้อความทำงานไม่สำเร็จ'));
      },
    );
  });
}

/**
 * ตรวจว่าเครื่องมือ OCR พร้อมใช้งานจริงหรือไม่
 *
 * ต้อง "เรียกโปรแกรมจริง" ไม่ใช่แค่อ่านค่าจากไฟล์ตั้งค่า
 * ค่าที่ตั้งไว้ถูกต้องไม่ได้แปลว่าโปรแกรมมีอยู่ และโปรแกรมที่มีอยู่ไม่ได้แปลว่ามีภาษาไทย
 */
export async function probeEngine(): Promise<EngineProbe> {
  const empty: EngineProbe = {
    available: false,
    binary: null,
    version: null,
    languages: [],
    languagesReady: false,
    missingLanguages: [],
    reason: null,
  };

  if (env.S2_NAS_OCR_ENABLED !== 1) {
    return { ...empty, reason: 'ปิดการใช้งานไว้ในการตั้งค่า' };
  }

  const binary = env.S2_NAS_OCR_BIN?.trim();
  if (!binary) {
    return { ...empty, reason: 'ยังไม่ได้ระบุเส้นทางของเครื่องมือ OCR' };
  }

  try {
    await fsp.access(binary);
  } catch {
    return { ...empty, binary, reason: 'ไม่พบเครื่องมือ OCR ตามเส้นทางที่ตั้งไว้' };
  }

  let version: string | null = null;
  let languages: string[] = [];

  try {
    const versionResult = await run(binary, ['--version'], 15_000);
    version = `${versionResult.stdout}${versionResult.stderr}`.split(/\r?\n/)[0]?.trim() ?? null;
  } catch {
    return { ...empty, binary, reason: 'เรียกเครื่องมือ OCR ไม่สำเร็จ' };
  }

  try {
    const langResult = await run(binary, ['--list-langs'], 15_000);
    languages = `${langResult.stdout}${langResult.stderr}`
      .split(/\r?\n/)
      .map((line) => line.trim())
      // บรรทัดแรกเป็นข้อความอธิบาย ไม่ใช่ชื่อภาษา
      .filter((line) => line.length > 0 && /^[a-z_]{2,}$/i.test(line));
  } catch {
    return { ...empty, binary, version, reason: 'อ่านรายชื่อภาษาของเครื่องมือ OCR ไม่สำเร็จ' };
  }

  /**
   * ภาษาที่ตั้งค่าไว้ต้องมีอยู่ในเครื่องครบทุกภาษา
   * ถ้าตั้ง tha+eng ไว้แต่เครื่องมีแต่ eng การอ่านเอกสารไทยจะได้ข้อความขยะ
   * ที่ดูเหมือนสำเร็จ - แย่กว่าการบอกตรง ๆ ว่ายังไม่พร้อม
   */
  const wanted = env.S2_NAS_OCR_LANGUAGES.split('+').map((value) => value.trim()).filter(Boolean);
  const missing = wanted.filter((code) => !languages.includes(code));

  return {
    available: missing.length === 0,
    binary,
    version,
    languages,
    languagesReady: missing.length === 0,
    missingLanguages: missing,
    reason: missing.length === 0 ? null : `ไม่พบข้อมูลภาษา: ${missing.join(', ')}`,
  };
}

/** รากของไฟล์ชั่วคราว - อยู่นอกพื้นที่จัดเก็บของผู้ใช้เสมอ */
function tempRoot(): string {
  return env.S2_NAS_OCR_TEMP_ROOT?.trim() || path.join(os.tmpdir(), 's2-nas-ocr');
}

/**
 * พื้นที่ทำงานชั่วคราวหนึ่งชุด
 *
 * ชื่อโฟลเดอร์สุ่มโดยเซิร์ฟเวอร์ ไม่มีส่วนใดมาจากชื่อไฟล์ของผู้ใช้
 * จึงไม่มีทางเกิดการหลุดออกนอกรากด้วยชื่อที่มี ../ หรืออักขระพิเศษ
 */
export async function withTempDir<T>(work: (dir: string) => Promise<T>): Promise<T> {
  const root = tempRoot();
  await fsp.mkdir(root, { recursive: true });
  const dir = await fsp.mkdtemp(path.join(root, `job-${crypto.randomBytes(6).toString('hex')}-`));
  try {
    return await work(dir);
  } finally {
    // ลบเสมอ แม้จะล้มเหลว - ไฟล์ชั่วคราวของเอกสารลับต้องไม่ค้างอยู่บนดิสก์
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * เก็บกวาดพื้นที่ชั่วคราวที่ค้างจากการล่มกลางคัน
 * เรียกตอนเริ่มระบบ ลบเฉพาะโฟลเดอร์ที่เก่ากว่าหนึ่งวัน
 */
export async function cleanStaleTempDirs(now: Date = new Date()): Promise<number> {
  const root = tempRoot();
  let removed = 0;
  try {
    const entries = await fsp.readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith('job-')) continue;
      const target = path.join(root, entry.name);
      const stat = await fsp.stat(target).catch(() => null);
      if (!stat) continue;
      if (now.getTime() - stat.mtimeMs < 24 * 60 * 60 * 1000) continue;
      await fsp.rm(target, { recursive: true, force: true }).catch(() => undefined);
      removed += 1;
    }
  } catch {
    /* ยังไม่เคยมีโฟลเดอร์ชั่วคราว - ไม่ใช่ความผิดพลาด */
  }
  return removed;
}

export interface OcrPageResult {
  text: string;
  /** ความมั่นใจเฉลี่ยที่เครื่องรายงาน - ใช้เป็นข้อมูลวินิจฉัยเท่านั้น */
  confidence: number | null;
}

/**
 * อ่านข้อความจากไฟล์ภาพหนึ่งไฟล์
 *
 * imagePath ต้องเป็นเส้นทางที่เซิร์ฟเวอร์สร้างเองเท่านั้น
 * ผู้เรียกทุกจุดในระบบนี้ส่งเส้นทางที่มาจาก withTempDir หรือจากพื้นที่จัดเก็บที่ตรวจแล้ว
 */
export async function ocrImageFile(imagePath: string, probe: EngineProbe): Promise<OcrPageResult> {
  if (!probe.available || !probe.binary) {
    throw new OcrError('OCR_NOT_CONFIGURED', 'ยังไม่ได้ตั้งค่าเครื่องมืออ่านข้อความ');
  }

  /**
   * "-" คือการให้เครื่องมือเขียนผลลัพธ์ออกทาง stdout แทนการสร้างไฟล์
   * ลดจำนวนไฟล์ชั่วคราวที่มีเนื้อหาของเอกสารอยู่บนดิสก์
   */
  const args = [imagePath, '-', '-l', env.S2_NAS_OCR_LANGUAGES];
  const { stdout } = await run(probe.binary, args, env.S2_NAS_OCR_TIMEOUT_MS);

  return { text: stdout, confidence: null };
}

/**
 * อ่านข้อความพร้อมค่าความมั่นใจ
 *
 * ใช้รูปแบบ TSV ซึ่งมีคอลัมน์ความมั่นใจต่อคำ แล้วเฉลี่ยเฉพาะคำที่มีข้อความจริง
 * ค่านี้เป็นข้อมูลวินิจฉัยเท่านั้น ห้ามใช้ตัดสินสิทธิ์ และห้ามนำเสนอเป็นการรับประกันความถูกต้อง
 */
export async function ocrImageFileWithConfidence(
  imagePath: string,
  probe: EngineProbe,
): Promise<OcrPageResult> {
  if (!probe.available || !probe.binary) {
    throw new OcrError('OCR_NOT_CONFIGURED', 'ยังไม่ได้ตั้งค่าเครื่องมืออ่านข้อความ');
  }

  const args = [imagePath, '-', '-l', env.S2_NAS_OCR_LANGUAGES, 'tsv'];
  const { stdout } = await run(probe.binary, args, env.S2_NAS_OCR_TIMEOUT_MS);

  const words: string[] = [];
  const confidences: number[] = [];
  let previousLine = -1;

  for (const row of stdout.split(/\r?\n/).slice(1)) {
    const columns = row.split('\t');
    if (columns.length < 12) continue;
    const lineNumber = Number(columns[4]);
    const confidence = Number(columns[10]);
    const text = columns[11] ?? '';
    if (!text.trim()) continue;

    // ขึ้นบรรทัดใหม่เมื่อเครื่องมือบอกว่าเป็นคนละบรรทัด เพื่อให้ข้อความอ่านรู้เรื่อง
    if (previousLine >= 0 && lineNumber !== previousLine) words.push('\n');
    previousLine = lineNumber;

    words.push(text);
    if (Number.isFinite(confidence) && confidence >= 0) confidences.push(confidence);
  }

  const text = words.join(' ').replace(/\s*\n\s*/g, '\n');
  const confidence =
    confidences.length > 0
      ? Math.round((confidences.reduce((sum, value) => sum + value, 0) / confidences.length) * 10) / 10
      : null;

  return { text, confidence };
}

import fsp from 'node:fs/promises';
import path from 'node:path';
import { prisma } from '../../../core/prisma.js';
import { env } from '../../../config/env.js';
import { logger } from '../../../core/logger.js';
import { AppError, notFound } from '../../../core/errors.js';
import { statStoredFile } from '../../../core/file-storage.js';
import { resolveStorageKey } from '../../../core/storage-provider.js';
import { cleanExtractedText, normalizeForSearch, truncateText } from '../extract/normalize.js';
import { EXTRACTOR_VERSION } from '../extract/index.js';
import {
  OcrError,
  ocrImageFileWithConfidence,
  probeEngine,
  withTempDir,
  type EngineProbe,
} from './engine.js';
import { extractPageImages, PdfImageError } from './pdf-images.js';

/**
 * OCR แบบสั่งเอง
 *
 * หลักการที่ตัดสินทั้งเฟสนี้: **OCR ไม่เกิดขึ้นเอง**
 *
 * มันช้า กิน CPU มาก และผลลัพธ์เป็นการคาดเดา การไล่ทำกับทุกภาพที่อัปโหลดเข้ามา
 * จะเผาเวลาเครื่องไปกับโลโก้บริษัทและรูปถ่ายที่ไม่มีใครค้นหา
 *
 * ระบบจึงบอกได้เพียงว่าไฟล์ไหน "น่าจะได้ประโยชน์" แล้วปล่อยให้คนตัดสินใจ
 */

/** ชนิดภาพที่อ่านได้ - ตรงกับที่ Leptonica ของ Tesseract รองรับ */
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'tif', 'tiff', 'bmp']);

export type OcrEligibility =
  | { eligible: true; kind: 'IMAGE' | 'SCANNED_PDF'; alreadyDone: boolean }
  | { eligible: false; reason: string };

/**
 * ไฟล์นี้ควรใช้ OCR หรือไม่
 *
 * เงื่อนไขตั้งอยู่บนสิ่งที่ F12 รู้อยู่แล้ว: PDF ที่สกัดข้อความไม่ได้ (NO_TEXT)
 * และภาพที่การสกัดปกติไม่รองรับ (UNSUPPORTED)
 *
 * เอกสารที่มีข้อความฝังอยู่แล้วไม่เข้าเงื่อนไข - การ OCR ทับข้อความที่ถูกต้องอยู่แล้ว
 * ด้วยข้อความที่เครื่องเดาเอา คือการทำให้ผลแย่ลง
 */
export function evaluateEligibility(input: {
  resourceType: string;
  extension: string | null;
  indexStatus: string | null;
  textSource: string | null;
}): OcrEligibility {
  if (input.resourceType !== 'FILE') {
    return { eligible: false, reason: 'OCR ใช้ได้กับไฟล์เท่านั้น' };
  }

  const ext = (input.extension ?? '').toLowerCase().replace(/^\./, '');
  const alreadyDone = input.textSource === 'OCR' && input.indexStatus === 'READY';

  if (IMAGE_EXTENSIONS.has(ext)) {
    return { eligible: true, kind: 'IMAGE', alreadyDone };
  }

  if (ext === 'pdf') {
    /**
     * PDF ที่มีข้อความอยู่แล้วไม่ควร OCR
     * เข้าเงื่อนไขเมื่อการสกัดปกติได้ NO_TEXT ซึ่งคือเอกสารสแกน
     * หรือเมื่อเคย OCR ไปแล้ว (เพื่อให้สั่งทำใหม่ได้)
     */
    if (input.indexStatus === 'NO_TEXT' || alreadyDone) {
      return { eligible: true, kind: 'SCANNED_PDF', alreadyDone };
    }
    if (input.indexStatus === 'READY') {
      return { eligible: false, reason: 'เอกสารนี้มีข้อความอยู่แล้ว จึงค้นหาได้โดยไม่ต้องใช้ OCR' };
    }
    return { eligible: false, reason: 'ยังไม่ทราบว่าเอกสารนี้มีข้อความหรือไม่ กรุณารอการประมวลผล' };
  }

  return { eligible: false, reason: 'ไม่รองรับ OCR สำหรับไฟล์ชนิดนี้' };
}

/** สถานะ OCR ของทรัพยากรหนึ่งชิ้น สำหรับหน้าจอและ API */
export interface OcrState {
  eligible: boolean;
  reason: string | null;
  kind: 'IMAGE' | 'SCANNED_PDF' | null;
  status: string | null;
  textSource: string | null;
  ocrRequested: boolean;
  ocrCompletedAt: Date | null;
  ocrConfidence: number | null;
  ocrPageCount: number | null;
  truncated: boolean;
  engineAvailable: boolean;
}

export async function ocrStateFor(resourceId: string, probe?: EngineProbe): Promise<OcrState> {
  const resource = await prisma.resource.findUnique({
    where: { id: resourceId },
    select: { id: true, type: true, extension: true, currentVersion: true, deletedAt: true },
  });
  if (!resource || resource.deletedAt) throw notFound('RESOURCE_NOT_FOUND', 'ไม่พบทรัพยากร');

  const index = await prisma.resourceSearchIndex.findFirst({
    where: { resourceId, versionNumber: resource.currentVersion ?? -1 },
    select: {
      status: true, textSource: true, ocrRequested: true, ocrCompletedAt: true,
      ocrConfidence: true, ocrPageCount: true, truncated: true,
    },
  });

  const engine = probe ?? (await probeEngine());
  const eligibility = evaluateEligibility({
    resourceType: resource.type,
    extension: resource.extension,
    indexStatus: index?.status ?? null,
    textSource: index?.textSource ?? null,
  });

  return {
    eligible: eligibility.eligible,
    reason: eligibility.eligible ? null : eligibility.reason,
    kind: eligibility.eligible ? eligibility.kind : null,
    status: index?.status ?? null,
    textSource: index?.textSource ?? null,
    ocrRequested: index?.ocrRequested ?? false,
    ocrCompletedAt: index?.ocrCompletedAt ?? null,
    ocrConfidence: index?.ocrConfidence ?? null,
    ocrPageCount: index?.ocrPageCount ?? null,
    truncated: index?.truncated ?? false,
    engineAvailable: engine.available,
  };
}

/**
 * สั่งให้อ่านข้อความจากเอกสารหนึ่งชิ้น
 *
 * เข้าคิวเท่านั้น ไม่ทำงานทันที - คำขอ HTTP ต้องไม่ค้างรอ OCR ที่ใช้เวลาเป็นนาที
 *
 * ไม่ตรวจสิทธิ์ที่นี่โดยตั้งใจ ผู้เรียกจากฝั่ง API เป็นผู้ตรวจ capabilities ก่อนเสมอ
 * และ CLI ของผู้ดูแลเรียกโดยตรงได้ตามเจตนา
 */
export async function requestOcr(resourceId: string): Promise<{ queued: boolean; reason?: string }> {
  const probe = await probeEngine();
  if (!probe.available) {
    throw new AppError('OCR_NOT_CONFIGURED', probe.reason ?? 'ยังไม่ได้ตั้งค่าเครื่องมืออ่านข้อความ', 503);
  }

  const resource = await prisma.resource.findUnique({
    where: { id: resourceId },
    select: { id: true, type: true, extension: true, currentVersion: true, deletedAt: true },
  });
  if (!resource || resource.deletedAt) throw notFound('RESOURCE_NOT_FOUND', 'ไม่พบทรัพยากร');
  if (resource.currentVersion === null) throw notFound('RESOURCE_NOT_FOUND', 'ไฟล์นี้ยังไม่มีเนื้อหา');

  const version = await prisma.resourceVersion.findFirst({
    where: { resourceId, versionNumber: resource.currentVersion },
    select: { id: true, mimeType: true },
  });
  if (!version) throw notFound('RESOURCE_NOT_FOUND', 'ไม่พบเวอร์ชันปัจจุบันของไฟล์');

  const existing = await prisma.resourceSearchIndex.findUnique({
    where: { resourceVersionId: version.id },
    select: { status: true, textSource: true },
  });

  const eligibility = evaluateEligibility({
    resourceType: resource.type,
    extension: resource.extension,
    indexStatus: existing?.status ?? null,
    textSource: existing?.textSource ?? null,
  });
  if (!eligibility.eligible) {
    throw new AppError('OCR_UNSUPPORTED', eligibility.reason, 400);
  }

  /**
   * เข้าคิวซ้ำของเวอร์ชันเดิมคือการสั่งทำใหม่ ไม่ใช่การสร้างงานที่สอง
   * resourceVersionId เป็น unique จึงไม่มีทางเกิดแถวซ้ำ
   */
  await prisma.resourceSearchIndex.upsert({
    where: { resourceVersionId: version.id },
    create: {
      resourceId,
      resourceVersionId: version.id,
      versionNumber: resource.currentVersion,
      mimeType: version.mimeType,
      status: 'PENDING',
      jobKind: 'OCR',
      ocrRequested: true,
      extractorVersion: EXTRACTOR_VERSION,
    },
    update: {
      status: 'PENDING',
      jobKind: 'OCR',
      ocrRequested: true,
      attempts: 0,
      errorCode: null,
      processingStartedAt: null,
    },
  });

  return { queued: true };
}

/**
 * ทำงาน OCR หนึ่งชิ้นให้จบ
 *
 * ผลลัพธ์ทุกแบบถูกบันทึกเป็นสถานะ ไม่มีกรณีที่เงียบหาย
 * และไม่มีกรณีใดที่ทำให้ไฟล์ต้นฉบับเปลี่ยนแปลงหรือดาวน์โหลดไม่ได้
 */
export async function runOcrJob(indexId: string): Promise<string> {
  const row = await prisma.resourceSearchIndex.findUnique({
    where: { id: indexId },
    select: {
      id: true,
      versionNumber: true,
      version: { select: { storageKey: true, mimeType: true } },
      resource: { select: { id: true, extension: true, deletedAt: true, currentVersion: true } },
    },
  });
  if (!row) return 'FAILED';

  /**
   * ตรวจซ้ำก่อนลงมือทำจริง - สถานะอาจเปลี่ยนไปตั้งแต่ตอนเข้าคิว
   * ไฟล์ที่ถูกย้ายไปถังขยะระหว่างรอคิวจะไม่ถูกประมวลผล
   * การใช้ CPU กับเอกสารที่ไม่มีใครค้นหาแล้วไม่มีประโยชน์
   */
  if (row.resource.deletedAt) {
    await prisma.resourceSearchIndex.update({
      where: { id: indexId },
      data: { status: 'PENDING', jobKind: 'OCR', processingStartedAt: null },
    });
    return 'SKIPPED_TRASHED';
  }

  const probe = await probeEngine();
  if (!probe.available) {
    await failJob(indexId, 'OCR_NOT_CONFIGURED');
    return 'FAILED';
  }


  try {
    const result = await performOcr(row.version.storageKey, row.resource.extension, probe);

    const cleaned = cleanExtractedText(result.text);
    if (!cleaned) {
      /**
       * เครื่องมือทำงานสำเร็จแต่ไม่พบข้อความ - นี่ไม่ใช่ความล้มเหลว
       * เป็นข้อเท็จจริงเกี่ยวกับเอกสาร เช่นหน้ากระดาษเปล่าหรือภาพที่ไม่มีตัวอักษร
       */
      await prisma.resourceSearchIndex.update({
        where: { id: indexId },
        data: {
          status: 'NO_TEXT',
          textSource: null,
          extractedText: null,
          normalizedText: null,
          characterCount: 0,
          truncated: false,
          errorCode: 'OCR_NO_TEXT_FOUND',
          processingStartedAt: null,
          ocrEngine: probe.version,
          ocrLanguages: env.S2_NAS_OCR_LANGUAGES,
          ocrConfidence: result.confidence,
          ocrPageCount: result.pageCount,
          ocrCompletedAt: new Date(),
        },
      });
      return 'NO_TEXT';
    }

    const { text, truncated } = truncateText(cleaned, env.S2_NAS_EXTRACT_MAX_TEXT_CHARS);

    await prisma.resourceSearchIndex.update({
      where: { id: indexId },
      data: {
        status: 'READY',
        // ที่มาของข้อความต้องบันทึกไว้เสมอ - ข้อความจาก OCR เป็นการคาดเดา
        textSource: 'OCR',
        extractedText: text,
        normalizedText: normalizeForSearch(text),
        characterCount: text.length,
        truncated: truncated || result.truncatedPages,
        errorCode: null,
        processingStartedAt: null,
        extractedAt: new Date(),
        extractorVersion: EXTRACTOR_VERSION,
        ocrEngine: probe.version,
        ocrLanguages: env.S2_NAS_OCR_LANGUAGES,
        ocrConfidence: result.confidence,
        ocrPageCount: result.pageCount,
        ocrCompletedAt: new Date(),
      },
    });

    logger.info(`[OCR] อ่านข้อความสำเร็จ (${result.pageCount} หน้า)`);
    return 'READY';
  } catch (error) {
    const code =
      error instanceof OcrError || error instanceof PdfImageError ? error.code : 'OCR_ENGINE_FAILED';
    await failJob(indexId, code);
    return 'FAILED';
  }
}

/** รหัสที่ลองใหม่แล้วก็ไม่มีทางสำเร็จ */
const PERMANENT_OCR_FAILURES = new Set([
  'OCR_UNSUPPORTED',
  'OCR_PAGE_LIMIT_EXCEEDED',
  'OCR_IMAGE_TOO_LARGE',
  'OCR_RENDER_FAILED',
  'OCR_NOT_CONFIGURED',
]);

export function isPermanentOcrFailure(code: string | null | undefined): boolean {
  return code !== null && code !== undefined && PERMANENT_OCR_FAILURES.has(code);
}

async function failJob(indexId: string, code: string): Promise<void> {
  const row = await prisma.resourceSearchIndex.findUnique({
    where: { id: indexId },
    select: { attempts: true },
  });
  const permanent = isPermanentOcrFailure(code) || (row?.attempts ?? 0) >= 3;

  await prisma.resourceSearchIndex.update({
    where: { id: indexId },
    data: {
      status: permanent ? 'FAILED' : 'PENDING',
      errorCode: code,
      processingStartedAt: null,
      ocrCompletedAt: permanent ? new Date() : null,
    },
  });
}

interface OcrOutcome {
  text: string;
  confidence: number | null;
  pageCount: number;
  truncatedPages: boolean;
}

/**
 * อ่านข้อความจากไฟล์จริง
 *
 * เส้นทางของไฟล์มาจาก resolveStorageKey ซึ่งบังคับให้อยู่ในรากของพื้นที่จัดเก็บเสมอ
 * ผู้ใช้ไม่มีทางกำหนดเส้นทางจริงบนดิสก์ได้
 */
async function performOcr(
  storageKey: string,
  extension: string | null,
  probe: EngineProbe,
): Promise<OcrOutcome> {
  const stat = await statStoredFile(storageKey);
  if (!stat) throw new OcrError('OCR_RENDER_FAILED', 'ไม่พบไฟล์ในพื้นที่จัดเก็บ');
  if (stat.size > env.S2_NAS_OCR_MAX_IMAGE_BYTES) {
    throw new OcrError('OCR_IMAGE_TOO_LARGE', 'ไฟล์มีขนาดใหญ่เกินกำหนดสำหรับการอ่านข้อความ');
  }

  const source = resolveStorageKey(storageKey);
  const ext = (extension ?? '').toLowerCase().replace(/^\./, '');

  /* ---- ภาพเดี่ยว: ส่งให้เครื่องมืออ่านได้ตรง ๆ ---- */
  if (IMAGE_EXTENSIONS.has(ext)) {
    const page = await ocrImageFileWithConfidence(source, probe);
    return { text: page.text, confidence: page.confidence, pageCount: 1, truncatedPages: false };
  }

  /* ---- เอกสารสแกน: ดึงภาพของแต่ละหน้าออกมาแล้วอ่านทีละหน้า ---- */
  if (ext === 'pdf') {
    const buffer = await fsp.readFile(source);
    const extracted = extractPageImages(buffer, {
      maxPages: env.S2_NAS_OCR_MAX_PAGES,
      maxPixels: env.S2_NAS_OCR_MAX_PIXELS,
    });

    if (extracted.images.length === 0) {
      /**
       * ไม่มีภาพให้ดึง - อาจเป็นรูปแบบการบีบอัดที่ยังไม่รองรับ
       * บอกตามจริงว่าอ่านไม่ได้ ดีกว่าบันทึกว่า "ไม่พบข้อความ" ซึ่งไม่จริง
       */
      throw new PdfImageError(
        'OCR_RENDER_FAILED',
        extracted.totalFound > 0
          ? 'รูปแบบภาพในเอกสารนี้ยังไม่รองรับการอ่านข้อความ'
          : 'ไม่พบภาพในเอกสารนี้',
      );
    }

    return withTempDir(async (dir) => {
      const parts: string[] = [];
      const confidences: number[] = [];

      for (const [pageIndex, image] of extracted.images.entries()) {
        // ชื่อไฟล์ชั่วคราวสร้างโดยเซิร์ฟเวอร์ล้วน ไม่มีส่วนใดมาจากชื่อไฟล์ของผู้ใช้
        const target = path.join(dir, `page-${String(pageIndex + 1).padStart(4, '0')}.${image.format}`);
        await fsp.writeFile(target, image.data);

        const page = await ocrImageFileWithConfidence(target, probe);
        if (page.text.trim()) parts.push(page.text);
        if (page.confidence !== null) confidences.push(page.confidence);

        // ลบทันทีที่อ่านเสร็จ ไม่รอจนจบทั้งเอกสาร
        await fsp.rm(target, { force: true }).catch(() => undefined);
      }

      return {
        text: parts.join('\n\n'),
        confidence:
          confidences.length > 0
            ? Math.round((confidences.reduce((sum, value) => sum + value, 0) / confidences.length) * 10) / 10
            : null,
        pageCount: extracted.images.length,
        // หน้าที่เกินเพดานถูกบันทึกไว้ตามจริง ไม่ใช่ทำเหมือนอ่านครบแล้ว
        truncatedPages: extracted.totalFound > extracted.images.length,
      };
    });
  }

  throw new OcrError('OCR_UNSUPPORTED', 'ไม่รองรับ OCR สำหรับไฟล์ชนิดนี้');
}

/* ------------------------------------------------------------------ */
/* มุมมองของผู้ดูแล                                                    */
/* ------------------------------------------------------------------ */

export interface OcrDiagnostics {
  enabled: boolean;
  engineAvailable: boolean;
  engine: string | null;
  languages: string[];
  configuredLanguages: string;
  missingLanguages: string[];
  reason: string | null;
  queued: number;
  processing: number;
  ready: number;
  failed: number;
  /** ไฟล์ที่ยังไม่ได้ OCR แต่น่าจะได้ประโยชน์ */
  eligibleCount: number;
}

/** สถานะของ OCR - ไม่มีเส้นทางจริง ไม่มีชื่อไฟล์ และไม่มีข้อความของเอกสารใด ๆ */
export async function ocrDiagnostics(): Promise<OcrDiagnostics> {
  const probe = await probeEngine();

  const [queued, processing, ready, failed, noTextPdfs, images] = await Promise.all([
    prisma.resourceSearchIndex.count({ where: { jobKind: 'OCR', status: 'PENDING' } }),
    prisma.resourceSearchIndex.count({ where: { jobKind: 'OCR', status: 'PROCESSING' } }),
    prisma.resourceSearchIndex.count({ where: { textSource: 'OCR', status: 'READY' } }),
    prisma.resourceSearchIndex.count({ where: { jobKind: 'OCR', status: 'FAILED' } }),
    prisma.resourceSearchIndex.count({
      where: { status: 'NO_TEXT', ocrRequested: false, resource: { deletedAt: null, extension: 'pdf' } },
    }),
    prisma.resourceSearchIndex.count({
      where: {
        status: 'UNSUPPORTED',
        ocrRequested: false,
        resource: { deletedAt: null, extension: { in: [...IMAGE_EXTENSIONS] } },
      },
    }),
  ]);

  return {
    enabled: env.S2_NAS_OCR_ENABLED === 1,
    engineAvailable: probe.available,
    engine: probe.version,
    languages: probe.languages,
    configuredLanguages: env.S2_NAS_OCR_LANGUAGES,
    missingLanguages: probe.missingLanguages,
    reason: probe.reason,
    queued,
    processing,
    ready,
    failed,
    eligibleCount: noTextPdfs + images,
  };
}

/** รายการไฟล์ที่น่าจะได้ประโยชน์จาก OCR แต่ยังไม่เคยสั่ง */
export async function listOcrEligible(limit = 100) {
  const rows = await prisma.resourceSearchIndex.findMany({
    where: {
      ocrRequested: false,
      resource: { deletedAt: null },
      OR: [
        { status: 'NO_TEXT', resource: { extension: 'pdf' } },
        { status: 'UNSUPPORTED', resource: { extension: { in: [...IMAGE_EXTENSIONS] } } },
      ],
    },
    select: {
      status: true,
      resource: { select: { id: true, name: true, extension: true, size: true, updatedAt: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });

  return rows.map((row) => ({
    resourceId: row.resource.id,
    name: row.resource.name,
    extension: row.resource.extension,
    size: row.resource.size === null ? null : Number(row.resource.size),
    updatedAt: row.resource.updatedAt,
    reason: row.status === 'NO_TEXT' ? 'เอกสารสแกน ไม่มีข้อความให้ค้นหา' : 'ไฟล์ภาพ',
  }));
}

/** ลองใหม่เฉพาะงาน OCR ที่ล้มเหลวแบบไม่ถาวร */
export async function retryFailedOcr(): Promise<number> {
  const rows = await prisma.resourceSearchIndex.findMany({
    where: { jobKind: 'OCR', status: 'FAILED' },
    select: { id: true, errorCode: true },
    take: 500,
  });
  const retryable = rows.filter((row) => !isPermanentOcrFailure(row.errorCode));
  if (retryable.length === 0) return 0;

  const result = await prisma.resourceSearchIndex.updateMany({
    where: { id: { in: retryable.map((row) => row.id) } },
    data: { status: 'PENDING', attempts: 0, errorCode: null, processingStartedAt: null },
  });
  return result.count;
}

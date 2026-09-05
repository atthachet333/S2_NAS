/**
 * การตรวจแก้ข้อความโดยมนุษย์
 *
 * OCR คือการคาดเดาของเครื่อง ไม่ใช่ความจริงที่ยืนยันแล้ว เอกสารภาษาไทยที่สแกนมา
 * มักถูกอ่านผิดในจุดที่สำคัญที่สุด เช่น เลขที่เอกสาร ชื่อบริษัท หรือจำนวนเงิน
 * การให้คนแก้จุดที่ผิดได้จึงเปลี่ยนเอกสารที่ "ค้นเจอบ้างไม่เจอบ้าง" ให้ค้นเจอจริง
 *
 * หลักสามข้อที่ยึดไว้ทั้งไฟล์นี้:
 *
 *   1. ไม่แตะไบต์ของไฟล์ต้นฉบับ - PDF และรูปภาพยังเป็นไฟล์เดิมทุกไบต์
 *      checksum, storageKey และขนาดไฟล์ไม่เปลี่ยน การตรวจแก้แก้เฉพาะดัชนีค้นหา
 *
 *   2. ผลดิบของเครื่องไม่หายไปไหน - เก็บไว้ใน rawOcrText ถาวร
 *      เพื่อให้ย้อนกลับได้ และเพื่อให้ตอบได้ว่าเครื่องอ่านผิดตรงไหน
 *
 *   3. การตรวจแก้ผูกกับ "เวอร์ชันของไฟล์" ไม่ใช่ผูกกับไฟล์
 *      ข้อความที่แก้ไว้ของ v1 ต้องไม่ไปโผล่ในผลค้นหาของ v2 ซึ่งเป็นคนละเอกสาร
 */
import type { AuthUser } from '../../auth/auth.service.js';
import { AppError, notFound } from '../../../core/errors.js';
import { prisma } from '../../../core/prisma.js';
import { env } from '../../../config/env.js';
import { getResource } from '../../resources/resource.service.js';
import { normalizeForSearch, truncateText } from '../extract/normalize.js';

/** ข้อความที่คนแก้แล้วเชื่อถือได้กว่าผลดิบ จึงเป็นที่มาคนละชั้นกัน */
const HUMAN = 'HUMAN_CORRECTED' as const;

export interface OcrTextView {
  /** มีข้อความให้อ่านหรือยัง - ไฟล์ที่ยังไม่เคยทำดัชนีจะเป็น false */
  available: boolean;
  status: string | null;
  /** ที่มาของข้อความที่มีผลอยู่ตอนนี้ */
  textSource: string | null;
  /** ข้อความที่มีผล - ถ้ามีการตรวจแก้ นี่คือฉบับที่คนแก้แล้ว */
  text: string;
  /** ผลดิบของเครื่อง ใช้เทียบเคียงในหน้าตรวจแก้ */
  rawText: string;
  corrected: boolean;
  correctionRevision: number;
  correctedAt: Date | null;
  correctedBy: { id: string; name: string } | null;
  characterCount: number;
  truncated: boolean;
  /** ผู้เรียกแก้ข้อความนี้ได้หรือไม่ - หน้าจอใช้ตัดสินว่าจะให้พิมพ์ได้ไหม */
  canEdit: boolean;
  /** เพดานความยาวที่บันทึกได้ */
  maxCharacters: number;
  /** มีผล OCR รอบใหม่ที่ยังไม่ได้ตรวจแก้อยู่หรือไม่ */
  rawTextDiffersFromCorrection: boolean;
}

/** โหลดดัชนีของ "เวอร์ชันปัจจุบัน" เท่านั้น - เวอร์ชันเก่ามีดัชนีของตัวเองแยกกัน */
async function currentIndexOf(resourceId: string) {
  const resource = await prisma.resource.findUnique({
    where: { id: resourceId },
    select: { currentVersion: true },
  });
  if (!resource || resource.currentVersion === null) return null;

  return prisma.resourceSearchIndex.findFirst({
    where: { resourceId, versionNumber: resource.currentVersion },
    select: {
      id: true,
      status: true,
      textSource: true,
      extractedText: true,
      rawOcrText: true,
      characterCount: true,
      truncated: true,
      correctionRevision: true,
      correctedAt: true,
      correctedBy: { select: { id: true, displayName: true } },
    },
  });
}

/**
 * อ่านข้อความของเอกสาร
 *
 * ผู้ที่เปิดดูไฟล์ได้ก็อ่านข้อความได้ - ข้อความคือเนื้อในของเอกสารที่เขาเปิดดูได้อยู่แล้ว
 * การซ่อนไว้จากคนที่เปิดไฟล์ดูได้ทั้งฉบับไม่ได้เพิ่มความปลอดภัยอะไรเลย
 */
export async function ocrTextFor(resourceId: string, user: AuthUser): Promise<OcrTextView> {
  // getResource เป็นด่านสิทธิ์ - โยน 403/404 เองเมื่อผู้เรียกไม่ควรเห็นไฟล์นี้
  const resource = await getResource(resourceId, user);
  const index = await currentIndexOf(resourceId);

  const raw = index?.rawOcrText ?? '';
  const effective = index?.extractedText ?? '';
  const corrected = (index?.correctionRevision ?? 0) > 0;

  return {
    available: Boolean(index && effective),
    status: index?.status ?? null,
    textSource: index?.textSource ?? null,
    text: effective,
    rawText: raw,
    corrected,
    correctionRevision: index?.correctionRevision ?? 0,
    correctedAt: index?.correctedAt ?? null,
    correctedBy: index?.correctedBy
      ? { id: index.correctedBy.id, name: index.correctedBy.displayName }
      : null,
    characterCount: index?.characterCount ?? 0,
    truncated: index?.truncated ?? false,
    canEdit: resource.capabilities.canEdit,
    maxCharacters: env.S2_NAS_EXTRACT_MAX_TEXT_CHARS,
    rawTextDiffersFromCorrection: corrected && raw !== '' && raw !== effective,
  };
}

/**
 * ทำความสะอาดข้อความที่คนพิมพ์มา
 *
 * ต่างจากข้อความที่สกัดจากเครื่องตรงที่ "ไม่ยุบช่องว่าง" - คนตั้งใจจัดย่อหน้าอย่างไร
 * ก็ต้องได้อย่างนั้น การยุบช่องว่างของเขาทิ้งคือการลบงานที่เขาเพิ่งทำ
 *
 * สิ่งที่ตัดทิ้งคืออักขระควบคุมที่มองไม่เห็นเท่านั้น ซึ่งไม่ใช่ข้อความ
 * และ NFC เพื่อให้สระกับวรรณยุกต์ของไทยอยู่ในรูปเดียวกับที่ใช้ค้นหา
 */
export function normalizeCorrection(input: string): string {
  return input
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .replace(/[\p{Cc}\p{Cf}]/gu, (char) => (char === '\n' || char === '\t' ? char : ''))
    .replace(/[^\S\n]+$/gm, '')
    .trim();
}

export interface SaveCorrectionResult {
  correctionRevision: number;
  characterCount: number;
  truncated: boolean;
  /** สร้างครั้งแรก หรือแก้ของเดิม - ใช้เลือกชนิดของ audit */
  created: boolean;
}

/**
 * บันทึกการตรวจแก้
 *
 * ใช้ expectedRevision เป็นการล็อกแบบมองโลกในแง่ดี: ถ้ามีคนอื่นบันทึกไปก่อน
 * เลขรุ่นในฐานข้อมูลจะไม่ตรงกับที่หน้าจอถืออยู่ และการบันทึกจะถูกปฏิเสธ
 * ดีกว่าปล่อยให้คนที่กดช้ากว่าเขียนทับงานของคนแรกไปเงียบ ๆ โดยไม่มีใครรู้
 */
export async function saveCorrection(
  resourceId: string,
  user: AuthUser,
  input: { text: string; expectedRevision: number },
): Promise<SaveCorrectionResult> {
  const resource = await getResource(resourceId, user);
  if (!resource.capabilities.canEdit) {
    throw new AppError('OCR_CORRECTION_DENIED', 'ต้องมีสิทธิ์แก้ไขไฟล์นี้จึงจะตรวจแก้ข้อความได้', 403);
  }

  const index = await currentIndexOf(resourceId);
  if (!index) throw notFound('OCR_TEXT_NOT_FOUND', 'ไฟล์นี้ยังไม่มีข้อความให้ตรวจแก้');

  const cleaned = normalizeCorrection(input.text);
  if (!cleaned) {
    throw new AppError(
      'OCR_CORRECTION_EMPTY',
      'ข้อความที่ตรวจแก้ต้องไม่ว่าง หากต้องการยกเลิกการแก้ไข กรุณาใช้ปุ่มใช้ผล OCR เดิม',
      400,
    );
  }

  const { text, truncated } = truncateText(cleaned, env.S2_NAS_EXTRACT_MAX_TEXT_CHARS);
  const nextRevision = index.correctionRevision + 1;

  /**
   * ผลดิบต้องถูกเก็บก่อนการเขียนทับครั้งแรกเสมอ
   * แถวที่ทำดัชนีไว้ก่อน F14 ยังไม่มี rawOcrText จึงเก็บจากข้อความปัจจุบัน
   * ซึ่งตอนนั้นยังไม่มีใครแก้ได้ จึงเป็นผลดิบตามนิยาม
   */
  const rawSnapshot = index.rawOcrText ?? index.extractedText ?? '';

  const result = await prisma.$transaction(async (tx) => {
    /**
     * เขียนแบบมีเงื่อนไข - เลขรุ่นต้องยังเป็นค่าที่หน้าจออ่านไปตอนเปิดฟอร์ม
     * ถ้าไม่ตรง แปลว่ามีคนบันทึกแทรกเข้ามาระหว่างนั้น
     */
    const updated = await tx.resourceSearchIndex.updateMany({
      where: { id: index.id, correctionRevision: input.expectedRevision },
      data: {
        textSource: HUMAN,
        extractedText: text,
        normalizedText: normalizeForSearch(text),
        characterCount: text.length,
        truncated,
        rawOcrText: rawSnapshot,
        correctedById: user.id,
        correctedAt: new Date(),
        correctionRevision: nextRevision,
        /**
         * การแก้ข้อความคือการตรวจรูปแบบหนึ่ง จึงปิดงานในคิวตรวจไปด้วยในตัว
         * ไม่อย่างนั้นเอกสารที่มีคนนั่งแก้ไปแล้วจะยังค้างอยู่ในคิว "ยังไม่ตรวจ"
         * และคนจะถูกเรียกให้ตรวจงานที่ตัวเองเพิ่งทำเสร็จ
         */
        reviewStatus: 'CORRECTED',
        reviewedById: user.id,
        reviewedAt: new Date(),
        // ข้อความมีผลใช้งานได้แล้ว แม้ผลดิบเดิมจะเคยเป็น NO_TEXT
        status: 'READY',
        errorCode: null,
      },
    });

    if (updated.count === 0) return null;

    await tx.resourceTextCorrection.create({
      data: {
        resourceSearchIndexId: index.id,
        revision: nextRevision,
        text,
        characterCount: text.length,
        createdById: user.id,
      },
    });

    return { created: input.expectedRevision === 0 };
  });

  if (!result) {
    throw new AppError(
      'OCR_CORRECTION_CONFLICT',
      'ข้อความนี้ถูกแก้ไขโดยผู้ใช้อื่นแล้ว กรุณาโหลดข้อมูลล่าสุดก่อนบันทึกอีกครั้ง',
      409,
    );
  }

  return {
    correctionRevision: nextRevision,
    characterCount: text.length,
    truncated,
    created: result.created,
  };
}

/**
 * ยกเลิกการตรวจแก้ กลับไปใช้ผลดิบของเครื่อง
 *
 * ประวัติการแก้ไม่ถูกลบ - การกดปุ่มนี้คือการเปลี่ยนใจ ไม่ใช่การลบร่องรอย
 * ว่าเคยมีคนแก้ไว้ ซึ่งเป็นคนละเรื่องกันและสำคัญต่อการตรวจสอบย้อนหลัง
 */
export async function resetCorrection(
  resourceId: string,
  user: AuthUser,
): Promise<{ reset: boolean }> {
  const resource = await getResource(resourceId, user);
  if (!resource.capabilities.canEdit) {
    throw new AppError('OCR_CORRECTION_DENIED', 'ต้องมีสิทธิ์แก้ไขไฟล์นี้จึงจะตรวจแก้ข้อความได้', 403);
  }

  const index = await currentIndexOf(resourceId);
  if (!index) throw notFound('OCR_TEXT_NOT_FOUND', 'ไฟล์นี้ยังไม่มีข้อความให้ตรวจแก้');
  if (index.correctionRevision === 0) return { reset: false };

  const raw = index.rawOcrText ?? '';
  const hasRaw = raw.length > 0;

  await prisma.resourceSearchIndex.update({
    where: { id: index.id },
    data: {
      /**
       * ที่มากลับไปเป็นของเครื่อง - ถ้าผลดิบว่างเปล่าแปลว่าเครื่องไม่เคยอ่านอะไรได้เลย
       * สถานะจึงกลับไปเป็น NO_TEXT ตามความจริง ไม่ใช่ READY ที่ไม่มีข้อความ
       */
      textSource: hasRaw ? 'OCR' : null,
      status: hasRaw ? 'READY' : 'NO_TEXT',
      extractedText: hasRaw ? raw : null,
      normalizedText: hasRaw ? normalizeForSearch(raw) : null,
      characterCount: raw.length,
      correctedById: null,
      correctedAt: null,
      correctionRevision: 0,
      /**
       * กลับไปใช้ผลดิบแล้ว ข้อความจึงเป็นของเครื่องอีกครั้ง
       * แต่ "เคยมีคนดูแล้ว" ยังเป็นความจริงอยู่ จึงเหลือสถานะเป็น VERIFIED
       * ไม่ใช่ย้อนกลับไป UNREVIEWED ซึ่งจะทำให้เอกสารวนกลับเข้าคิวไม่รู้จบ
       */
      reviewStatus: 'VERIFIED',
      reviewedById: user.id,
      reviewedAt: new Date(),
    },
  });

  return { reset: true };
}

export interface CorrectionHistoryItem {
  revision: number;
  characterCount: number;
  createdAt: Date;
  createdBy: { id: string; name: string };
}

/**
 * ประวัติการตรวจแก้
 *
 * คืนเฉพาะข้อมูลว่า "ใครแก้เมื่อไร ยาวเท่าไร" ไม่คืนตัวข้อความของแต่ละรุ่น
 * เพราะสิ่งที่ต้องตอบคือความรับผิดชอบ ไม่ใช่การเปิดคลังข้อความหลายชุดให้รั่วได้หลายทาง
 */
export async function correctionHistory(
  resourceId: string,
  user: AuthUser,
): Promise<CorrectionHistoryItem[]> {
  await getResource(resourceId, user);
  const index = await currentIndexOf(resourceId);
  if (!index) return [];

  const rows = await prisma.resourceTextCorrection.findMany({
    where: { resourceSearchIndexId: index.id },
    orderBy: { revision: 'desc' },
    take: 50,
    select: {
      revision: true,
      characterCount: true,
      createdAt: true,
      createdBy: { select: { id: true, displayName: true } },
    },
  });

  return rows.map((row) => ({
    revision: row.revision,
    characterCount: row.characterCount,
    createdAt: row.createdAt,
    createdBy: { id: row.createdBy.id, name: row.createdBy.displayName },
  }));
}

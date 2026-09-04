import type { SearchIndexStatus } from '@prisma/client';
import { prisma } from '../../core/prisma.js';
import { logger } from '../../core/logger.js';
import { EXTRACTOR_VERSION, extractFromStorage, isPermanentFailure } from './extract/index.js';

/**
 * ดัชนีข้อความในเอกสาร
 *
 * งานทั้งหมดที่นี่ต้องทำซ้ำได้โดยไม่เกิดผลข้างเคียง เพราะเซิร์ฟเวอร์อาจล่มกลางคัน
 * และงานเดิมจะถูกหยิบขึ้นมาทำใหม่เสมอ กุญแจของความเป็น idempotent คือ
 * resourceVersionId ที่ unique - หนึ่งเวอร์ชันมีได้เพียงหนึ่งแถวเท่านั้น
 *
 * ดัชนีเป็น "ข้อมูลที่สร้างใหม่ได้" ไม่ใช่ข้อมูลต้นฉบับ
 * ระบบต้องทำงานได้ครบทุกอย่างแม้ตารางนี้จะว่างเปล่า - ค้นจากชื่อไฟล์ แท็ก และหมายเหตุยังได้เหมือนเดิม
 * เพียงแต่ค้นจากเนื้อในไม่ได้จนกว่าจะทำดัชนีใหม่เสร็จ
 */

/** งานที่ค้างในสถานะ PROCESSING นานเกินนี้ ถือว่าเซิร์ฟเวอร์ล่มกลางคัน */
const STALE_PROCESSING_MINUTES = 15;

/** ลองใหม่ได้กี่ครั้งก่อนยอมแพ้ - ความล้มเหลวชั่วคราวมักหายไปในรอบถัดไป */
const MAX_ATTEMPTS = 3;

/**
 * เข้าคิวสกัดข้อความของไฟล์หนึ่งเวอร์ชัน
 *
 * เรียกหลังจากไฟล์ลงดิสก์และมีแถวเวอร์ชันแล้วเท่านั้น
 * ไม่ throw ออกไปหาผู้เรียกเด็ดขาด - การอัปโหลดต้องไม่ล้มเหลวเพราะการทำดัชนีมีปัญหา
 */
export async function enqueueExtraction(resourceVersionId: string): Promise<void> {
  try {
    const version = await prisma.resourceVersion.findUnique({
      where: { id: resourceVersionId },
      select: { id: true, resourceId: true, versionNumber: true, mimeType: true },
    });
    if (!version) return;

    await prisma.resourceSearchIndex.upsert({
      where: { resourceVersionId: version.id },
      create: {
        resourceId: version.resourceId,
        resourceVersionId: version.id,
        versionNumber: version.versionNumber,
        mimeType: version.mimeType,
        status: 'PENDING',
        extractorVersion: EXTRACTOR_VERSION,
      },
      // เข้าคิวซ้ำของเวอร์ชันเดิมคือการสั่งทำใหม่ ไม่ใช่การสร้างงานที่สอง
      update: { status: 'PENDING', attempts: 0, errorCode: null, processingStartedAt: null },
    });
  } catch (error) {
    // คิวเสียไม่ใช่เหตุให้การอัปโหลดล้มเหลว - บันทึกไว้แล้วเดินต่อ
    logger.warn({ err: error }, '[SEARCH] เข้าคิวสกัดข้อความไม่สำเร็จ');
  }
}

/**
 * หางานถัดไปหนึ่งชิ้นแล้วจองไว้
 *
 * การจองใช้ updateMany พร้อมเงื่อนไขสถานะเดิม ซึ่งเป็นการเปรียบเทียบและเขียนในคำสั่งเดียว
 * ผู้ทำงานสองคนจึงหยิบงานชิ้นเดียวกันไปทำพร้อมกันไม่ได้ แม้จะมีหลายกระบวนการ
 */
export async function claimNextJob(now: Date = new Date()): Promise<string | null> {
  const candidate = await prisma.resourceSearchIndex.findFirst({
    where: { status: 'PENDING' },
    // เก่าที่สุดก่อน งานที่ค้างมานานจึงไม่ถูกแซงตลอดกาล
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  });
  if (!candidate) return null;

  const claimed = await prisma.resourceSearchIndex.updateMany({
    where: { id: candidate.id, status: 'PENDING' },
    data: { status: 'PROCESSING', processingStartedAt: now, attempts: { increment: 1 } },
  });
  return claimed.count === 1 ? candidate.id : null;
}

/** ทำงานหนึ่งชิ้นให้จบ - ผลลัพธ์ทุกแบบถูกบันทึกเป็นสถานะ ไม่มีกรณีที่เงียบหาย */
export async function runJob(indexId: string): Promise<SearchIndexStatus> {
  const row = await prisma.resourceSearchIndex.findUnique({
    where: { id: indexId },
    select: {
      id: true,
      attempts: true,
      version: { select: { storageKey: true, mimeType: true } },
      resource: { select: { extension: true, deletedAt: true } },
    },
  });
  if (!row) return 'FAILED';

  const outcome = await extractFromStorage({
    storageKey: row.version.storageKey,
    extension: row.resource.extension,
    mimeType: row.version.mimeType,
  });

  const base = { processingStartedAt: null, extractedAt: new Date(), extractorVersion: EXTRACTOR_VERSION };

  if (outcome.kind === 'TEXT') {
    await prisma.resourceSearchIndex.update({
      where: { id: indexId },
      data: {
        ...base,
        status: 'READY',
        extractedText: outcome.text,
        normalizedText: outcome.normalized,
        characterCount: outcome.text.length,
        truncated: outcome.truncated,
        errorCode: null,
      },
    });
    return 'READY';
  }

  if (outcome.kind === 'NO_TEXT' || outcome.kind === 'UNSUPPORTED') {
    /**
     * ไม่ใช่ความล้มเหลว - เป็นข้อเท็จจริงเกี่ยวกับไฟล์
     * PDF ที่เป็นภาพสแกนจบที่ NO_TEXT อย่างตรงไปตรงมา ระบบนี้ยังไม่มี OCR
     */
    await prisma.resourceSearchIndex.update({
      where: { id: indexId },
      data: {
        ...base,
        status: outcome.kind,
        extractedText: null,
        normalizedText: null,
        characterCount: 0,
        truncated: false,
        errorCode: null,
      },
    });
    return outcome.kind;
  }

  /**
   * ความล้มเหลวถาวรไม่ถูกลองใหม่ - PDF ที่ใส่รหัสผ่านไว้จะไม่เปิดได้เองในรอบหน้า
   * ความล้มเหลวชั่วคราวกลับเข้าคิวจนครบจำนวนครั้งที่กำหนด แล้วจึงหยุด
   */
  const permanent = isPermanentFailure(outcome.errorCode) || row.attempts >= MAX_ATTEMPTS;
  await prisma.resourceSearchIndex.update({
    where: { id: indexId },
    data: {
      ...base,
      status: permanent ? 'FAILED' : 'PENDING',
      processingStartedAt: null,
      errorCode: outcome.errorCode,
    },
  });
  return permanent ? 'FAILED' : 'PENDING';
}

/**
 * กู้คืนงานที่ค้างและสร้างงานที่ขาดหาย
 *
 * เรียกตอนเริ่มระบบ ทำสามอย่าง:
 *   1. งานที่ค้างในสถานะ PROCESSING นานผิดปกติ = เซิร์ฟเวอร์ล่มกลางคัน ให้กลับเข้าคิว
 *   2. ไฟล์ที่มีเวอร์ชันปัจจุบันแต่ยังไม่มีแถวดัชนี ให้สร้างแถวรอไว้
 *   3. แถวที่ทำด้วยตัวสกัดรุ่นเก่า ปล่อยไว้ตามเดิม - การทำใหม่ทั้งระบบเป็นการตัดสินใจของผู้ดูแล
 */
export async function reconcileIndex(now: Date = new Date()): Promise<{ requeued: number; created: number }> {
  const staleBefore = new Date(now.getTime() - STALE_PROCESSING_MINUTES * 60 * 1000);

  const requeued = await prisma.resourceSearchIndex.updateMany({
    where: { status: 'PROCESSING', processingStartedAt: { lt: staleBefore } },
    data: { status: 'PENDING', processingStartedAt: null },
  });

  /**
   * ไฟล์ที่ยังไม่มีดัชนีของเวอร์ชันปัจจุบัน
   * ทำเป็นชุดเล็ก ๆ เพื่อไม่ให้การเริ่มระบบช้าลงเพราะงานค้างจำนวนมาก
   */
  const missing = await prisma.resourceVersion.findMany({
    where: {
      searchIndex: null,
      resource: { type: 'FILE', deletedAt: null },
    },
    select: { id: true, resourceId: true, versionNumber: true, mimeType: true, resource: { select: { currentVersion: true } } },
    orderBy: { createdAt: 'desc' },
    take: 500,
  });

  const current = missing.filter((row) => row.versionNumber === row.resource.currentVersion);
  if (current.length > 0) {
    await prisma.resourceSearchIndex.createMany({
      data: current.map((row) => ({
        resourceId: row.resourceId,
        resourceVersionId: row.id,
        versionNumber: row.versionNumber,
        mimeType: row.mimeType,
        status: 'PENDING' as const,
        extractorVersion: EXTRACTOR_VERSION,
      })),
      skipDuplicates: true,
    });
  }

  return { requeued: requeued.count, created: current.length };
}

/* ------------------------------------------------------------------ */
/* มุมมองของผู้ดูแล                                                    */
/* ------------------------------------------------------------------ */

export interface IndexDiagnostics {
  counts: Record<SearchIndexStatus, number>;
  oldestPendingAt: Date | null;
  extractorVersion: string;
  enabled: boolean;
}

/** สถานะของคิว - ไม่มีเส้นทางจริงบนดิสก์และไม่มีข้อความของเอกสารใด ๆ ในผลลัพธ์ */
export async function indexDiagnostics(enabled: boolean): Promise<IndexDiagnostics> {
  const [groups, oldest] = await Promise.all([
    prisma.resourceSearchIndex.groupBy({ by: ['status'], _count: { _all: true } }),
    prisma.resourceSearchIndex.findFirst({
      where: { status: 'PENDING' },
      orderBy: { createdAt: 'asc' },
      select: { createdAt: true },
    }),
  ]);

  const counts = {
    PENDING: 0, PROCESSING: 0, READY: 0, NO_TEXT: 0, UNSUPPORTED: 0, FAILED: 0,
  } as Record<SearchIndexStatus, number>;
  for (const group of groups) counts[group.status] = group._count._all;

  return { counts, oldestPendingAt: oldest?.createdAt ?? null, extractorVersion: EXTRACTOR_VERSION, enabled };
}

/** สั่งทำดัชนีใหม่ของทรัพยากรหนึ่งชิ้น - เฉพาะเวอร์ชันปัจจุบัน */
export async function reindexResource(resourceId: string): Promise<boolean> {
  const resource = await prisma.resource.findUnique({
    where: { id: resourceId },
    select: { id: true, type: true, currentVersion: true, deletedAt: true },
  });
  if (!resource || resource.type !== 'FILE' || resource.deletedAt || resource.currentVersion === null) return false;

  const version = await prisma.resourceVersion.findFirst({
    where: { resourceId, versionNumber: resource.currentVersion },
    select: { id: true },
  });
  if (!version) return false;

  await enqueueExtraction(version.id);
  return true;
}

/**
 * สั่งทำดัชนีใหม่ทั้งระบบ
 *
 * เข้าคิวเท่านั้น ไม่ทำงานทันที การทำดัชนีใหม่ของทั้งระบบพร้อมกัน
 * จะกินทรัพยากรจนกระทบการใช้งานจริง ซึ่งสำคัญกว่าความเร็วของการค้นหา
 */
export async function reindexAll(): Promise<number> {
  const resources = await prisma.resource.findMany({
    where: { type: 'FILE', deletedAt: null, currentVersion: { not: null } },
    select: { id: true, currentVersion: true },
    take: 10_000,
  });

  let queued = 0;
  for (const resource of resources) {
    const version = await prisma.resourceVersion.findFirst({
      where: { resourceId: resource.id, versionNumber: resource.currentVersion ?? -1 },
      select: { id: true },
    });
    if (!version) continue;
    await enqueueExtraction(version.id);
    queued += 1;
  }
  return queued;
}

/** ลองใหม่เฉพาะงานที่ล้มเหลวแบบไม่ถาวร */
export async function retryFailed(): Promise<number> {
  const rows = await prisma.resourceSearchIndex.findMany({
    where: { status: 'FAILED' },
    select: { id: true, errorCode: true },
    take: 1000,
  });
  const retryable = rows.filter((row) => !isPermanentFailure(row.errorCode));
  if (retryable.length === 0) return 0;

  const result = await prisma.resourceSearchIndex.updateMany({
    where: { id: { in: retryable.map((row) => row.id) } },
    data: { status: 'PENDING', attempts: 0, errorCode: null, processingStartedAt: null },
  });
  return result.count;
}

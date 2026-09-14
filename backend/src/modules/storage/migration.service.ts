import crypto from 'node:crypto';
import type { Readable } from 'node:stream';
import type { StorageProviderKind } from '@prisma/client';
import { prisma } from '../../core/prisma.js';
import { logger } from '../../core/logger.js';
import { storageProviderFor } from '../../core/storage/index.js';
import type { StorageProvider } from '../../core/storage/provider.js';

/**
 * ย้ายวัตถุระหว่างผู้ให้บริการพื้นที่จัดเก็บ (F23-E)
 *
 * **ลำดับที่ห้ามสลับ: คัดลอก -> ตรวจสอบ -> สลับ metadata** เหตุผลคือทุกจังหวะที่
 * กระบวนการตายกลางทาง ต้องเหลือสถานะที่ยัง "จริง" อยู่เสมอ ถ้าสลับ metadata ก่อน
 * แล้วตาย ระบบจะชี้ไปยังวัตถุที่อาจยังไม่ครบ และไฟล์นั้นจะอ่านไม่ได้ทันที
 * แต่ถ้าคัดลอกก่อนแล้วตาย สิ่งที่เหลือคือสำเนาที่ไม่มีใครอ้างถึง ซึ่งไม่ทำร้ายใคร
 *
 * **ไม่ลบต้นทางเด็ดขาดในเฟสนี้** การคืนพื้นที่เป็นงานบำรุงรักษาที่ต้องทำหลังจาก
 * มีชุดสำรองที่ตรวจแล้วเท่านั้น การรวมมันเข้ามาที่นี่แปลว่าความผิดพลาดหนึ่งครั้ง
 * ระหว่างย้ายข้อมูลจะทำลายสำเนาเดียวที่เหลืออยู่
 *
 * **ตรวจซ้ำเสมอ ไม่เชื่อว่าคัดลอกแล้วต้องเหมือน** ขนาดและ SHA-256 ของปลายทาง
 * ถูกวัดจากไบต์ที่อ่านกลับมาจริง ไม่ใช่จากคำตอบของบริการ และไม่ใช่จาก ETag
 */

export type MigrationOutcome =
  | 'MIGRATED'
  | 'DRY_RUN'
  | 'SKIP_ALREADY_MIGRATED'
  | 'SKIP_NOT_ON_SOURCE'
  | 'SOURCE_MISSING'
  | 'SOURCE_SIZE_MISMATCH'
  | 'SOURCE_CHECKSUM_MISMATCH'
  | 'TARGET_CONFLICT'
  | 'TARGET_VERIFY_FAILED'
  | 'PROVIDER_UNAVAILABLE'
  | 'FAILED';

export interface MigrationItemResult {
  resourceVersionId: string;
  outcome: MigrationOutcome;
  /** true เมื่อรอบนี้ไม่ได้คัดลอกเพราะปลายทางมีวัตถุที่ถูกต้องอยู่แล้ว */
  reusedExistingTarget?: boolean;
  bytes?: number;
  detail?: string;
}

export interface MigrationSummary {
  from: StorageProviderKind;
  to: StorageProviderKind;
  dryRun: boolean;
  scanned: number;
  eligible: number;
  copied: number;
  verified: number;
  switched: number;
  alreadyMigrated: number;
  skipped: number;
  failed: number;
  sourceMissing: number;
  targetConflict: number;
  checksumMismatch: number;
  bytes: number;
  items: MigrationItemResult[];
}

export interface MigrationOptions {
  from: StorageProviderKind;
  to: StorageProviderKind;
  dryRun: boolean;
  limit?: number;
  resourceVersionId?: string;
  /**
   * จำกัดอยู่เฉพาะทรัพยากรที่ระบุ
   *
   * ทำให้ย้ายทีละกลุ่มได้ เช่นทีละลูกค้า และทำให้ชุดทดสอบแตะได้เฉพาะของทดสอบของตัวเอง
   * การรันแบบไม่จำกัดขอบเขตบนฐานข้อมูลที่มีข้อมูลจริงอยู่ด้วยเป็นความผิดพลาดที่แพง
   */
  resourceIds?: string[];
}

/** อ่านสตรีมทั้งเส้นเพื่อวัดขนาดและ SHA-256 โดยไม่เก็บเนื้อไฟล์ไว้ในหน่วยความจำ */
async function measure(stream: Readable): Promise<{ size: number; checksum: string }> {
  const hash = crypto.createHash('sha256');
  let size = 0;
  for await (const chunk of stream) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    hash.update(buffer);
  }
  return { size, checksum: hash.digest('hex') };
}

/**
 * ตรวจว่าผู้ให้บริการพร้อมใช้งานก่อนเริ่ม
 *
 * ถ้าไม่ตรวจ ความล้มเหลวของโครงสร้างพื้นฐานจะกลายเป็นรายงานว่า "ไฟล์หายหมดทุกไฟล์"
 * ซึ่งชวนให้คนตัดสินใจผิดอย่างร้ายแรง
 */
async function assertProvidersReady(
  source: StorageProvider, target: StorageProvider,
): Promise<string | null> {
  for (const provider of [source, target]) {
    const health = await provider.health();
    if (health.status !== 'READY') {
      return `ผู้ให้บริการ ${provider.kind} ไม่พร้อมใช้งาน (${health.status})`;
    }
  }
  return null;
}

/**
 * ย้ายเวอร์ชันเดียว
 *
 * แยกออกมาเป็นหน่วยเล็กที่สุดที่ยังปลอดภัยด้วยตัวเอง การรันซ้ำทั้งชุดจึงไม่ต่างจาก
 * การรันต่อจากจุดที่ค้างไว้ เพราะแต่ละแถวตัดสินใจจากสถานะจริงของตัวเองเสมอ
 */
export async function migrateVersion(
  resourceVersionId: string,
  options: { from: StorageProviderKind; to: StorageProviderKind; dryRun: boolean },
): Promise<MigrationItemResult> {
  const version = await prisma.resourceVersion.findUnique({
    where: { id: resourceVersionId },
    select: {
      id: true, resourceId: true, versionNumber: true, storageKey: true,
      storageProvider: true, size: true, checksum: true,
    },
  });
  if (!version) {
    return { resourceVersionId, outcome: 'FAILED', detail: 'ไม่พบแถวเวอร์ชัน' };
  }

  const source = storageProviderFor(options.from);
  const target = storageProviderFor(options.to);
  const expectedSize = Number(version.size);

  /**
   * แถวที่อยู่ปลายทางแล้ว
   *
   * นี่คือสิ่งที่เห็นเมื่อรันซ้ำ หรือเมื่อกระบวนการตายหลังสลับ metadata สำเร็จแล้ว
   * ตรวจให้แน่ว่าวัตถุที่ปลายทางใช้ได้จริง แล้วรายงานว่าเสร็จแล้ว ไม่คัดลอกซ้ำ
   */
  if (version.storageProvider === options.to) {
    const stat = await target.stat(version.storageKey);
    if (!stat) {
      return { resourceVersionId, outcome: 'SOURCE_MISSING',
        detail: 'แถวชี้ไปยังปลายทางแล้วแต่ไม่พบวัตถุที่นั่น' };
    }
    if (stat.size !== expectedSize) {
      return { resourceVersionId, outcome: 'TARGET_VERIFY_FAILED', detail: 'ขนาดที่ปลายทางไม่ตรงกับที่บันทึกไว้' };
    }
    return { resourceVersionId, outcome: 'SKIP_ALREADY_MIGRATED' };
  }

  if (version.storageProvider !== options.from) {
    return { resourceVersionId, outcome: 'SKIP_NOT_ON_SOURCE',
      detail: `แถวนี้อยู่บน ${version.storageProvider}` };
  }

  /* ---------------- ตรวจต้นทางก่อนแตะปลายทาง ---------------- */

  const sourceStat = await source.stat(version.storageKey);
  if (!sourceStat) return { resourceVersionId, outcome: 'SOURCE_MISSING' };
  if (sourceStat.size !== expectedSize) {
    return { resourceVersionId, outcome: 'SOURCE_SIZE_MISMATCH',
      detail: `ดิสก์ ${sourceStat.size} ไบต์ ฐานข้อมูล ${expectedSize} ไบต์` };
  }

  const sourceMeasured = await measure(await source.getStream(version.storageKey));
  if (sourceMeasured.checksum !== version.checksum) {
    // ต้นทางเสียหายอยู่ก่อนแล้ว การคัดลอกต่อไปมีแต่จะทำสำเนาของความเสียหาย
    return { resourceVersionId, outcome: 'SOURCE_CHECKSUM_MISMATCH' };
  }

  if (options.dryRun) {
    return { resourceVersionId, outcome: 'DRY_RUN', bytes: expectedSize };
  }

  /* ---------------- ปลายทาง: ใช้ของเดิมถ้าถูกต้อง มิฉะนั้นคัดลอกใหม่ ---------------- */

  let reusedExistingTarget = false;
  const existing = await target.stat(version.storageKey);
  if (existing) {
    /**
     * ปลายทางมีวัตถุอยู่แล้ว - เกิดขึ้นเมื่อกระบวนการตายหลังคัดลอกแต่ก่อนสลับ metadata
     *
     * ตรวจไบต์จริงก่อนเสมอ ถ้าตรงก็ใช้ต่อได้เลยโดยไม่ต้องคัดลอกซ้ำ
     * ถ้าไม่ตรง ห้ามเขียนทับเงียบ ๆ เพราะเราไม่รู้ว่าวัตถุนั้นเป็นของใครหรือมาจากไหน
     */
    const measured = await measure(await target.getStream(version.storageKey));
    if (measured.checksum === version.checksum && measured.size === expectedSize) {
      reusedExistingTarget = true;
    } else {
      return { resourceVersionId, outcome: 'TARGET_CONFLICT',
        detail: 'ปลายทางมีวัตถุอยู่แล้วแต่เนื้อหาไม่ตรงกับที่บันทึกไว้' };
    }
  }

  if (!reusedExistingTarget) {
    try {
      await target.put(version.storageKey, await source.getStream(version.storageKey));
    } catch (error) {
      return { resourceVersionId, outcome: 'FAILED',
        detail: `เขียนปลายทางไม่สำเร็จ: ${(error as Error).name}` };
    }

    // ตรวจจากไบต์ที่อ่านกลับมาจริง ไม่ใช่จากค่าที่ฟังก์ชันเขียนคืนมา
    const written = await measure(await target.getStream(version.storageKey));
    if (written.size !== expectedSize || written.checksum !== version.checksum) {
      return { resourceVersionId, outcome: 'TARGET_VERIFY_FAILED',
        detail: 'วัตถุที่เขียนไปไม่ตรงกับที่บันทึกไว้' };
    }
  }

  /* ---------------- สลับ metadata เป็นขั้นสุดท้าย ---------------- */

  try {
    await prisma.$transaction(async (tx) => {
      /**
       * สลับด้วยเงื่อนไขว่าแถวยังอยู่ต้นทาง
       *
       * ถ้ามีอีกกระบวนการหนึ่งย้ายแถวนี้ไปแล้วระหว่างที่เรากำลังคัดลอก การเขียนทับ
       * แบบไม่มีเงื่อนไขจะกลบผลของมัน จำนวนแถวที่ถูกแก้เป็นศูนย์แปลว่ามีคนทำไปก่อนแล้ว
       */
      const switched = await tx.resourceVersion.updateMany({
        where: { id: version.id, storageProvider: options.from },
        data: { storageProvider: options.to },
      });
      if (switched.count === 0) throw new Error('CONCURRENT_MIGRATION');

      /**
       * Resource สะท้อนเฉพาะเวอร์ชันปัจจุบัน
       *
       * เวอร์ชันเก่าที่ถูกย้ายต้องไม่แตะแถว Resource เลย มิฉะนั้นแถวนั้นจะชี้ไปยัง
       * ผู้ให้บริการของเวอร์ชันที่ไม่ได้ใช้งานอยู่ และการอ่านไฟล์ปัจจุบันจะหาผิดที่
       */
      const resource = await tx.resource.findUnique({
        where: { id: version.resourceId },
        select: { currentVersion: true },
      });
      if (resource?.currentVersion === version.versionNumber) {
        await tx.resource.update({
          where: { id: version.resourceId },
          data: { storageProvider: options.to },
        });
      }
    });
  } catch (error) {
    const reason = (error as Error).message === 'CONCURRENT_MIGRATION'
      ? 'มีการย้ายแถวนี้ไปแล้วระหว่างทาง'
      : 'สลับข้อมูลกำกับไม่สำเร็จ';
    // ต้นทางยังอยู่ครบและแถวยังชี้ไปที่เดิม การรันซ้ำจึงปลอดภัยเสมอ
    return { resourceVersionId, outcome: 'FAILED', detail: reason };
  }

  return {
    resourceVersionId, outcome: 'MIGRATED', reusedExistingTarget, bytes: expectedSize,
  };
}

/** ย้ายเป็นชุดตามเงื่อนไขที่ระบุ - ทำทีละแถวโดยตั้งใจ เพื่อให้หยุดกลางคันแล้วปลอดภัยเสมอ */
export async function migrateStorage(options: MigrationOptions): Promise<MigrationSummary> {
  const summary: MigrationSummary = {
    from: options.from, to: options.to, dryRun: options.dryRun,
    scanned: 0, eligible: 0, copied: 0, verified: 0, switched: 0, alreadyMigrated: 0,
    skipped: 0, failed: 0, sourceMissing: 0, targetConflict: 0, checksumMismatch: 0,
    bytes: 0, items: [],
  };

  const source = storageProviderFor(options.from);
  const target = storageProviderFor(options.to);
  const unavailable = await assertProvidersReady(source, target);
  if (unavailable) {
    summary.failed = 1;
    summary.items.push({ resourceVersionId: '-', outcome: 'PROVIDER_UNAVAILABLE', detail: unavailable });
    return summary;
  }

  const rows = await prisma.resourceVersion.findMany({
    where: options.resourceVersionId
      ? { id: options.resourceVersionId }
      : {
          storageProvider: options.from,
          ...(options.resourceIds ? { resourceId: { in: options.resourceIds } } : {}),
        },
    select: { id: true },
    orderBy: { createdAt: 'asc' },
    ...(options.limit ? { take: options.limit } : {}),
  });

  for (const row of rows) {
    summary.scanned += 1;
    const result = await migrateVersion(row.id, options);
    summary.items.push(result);

    switch (result.outcome) {
      case 'MIGRATED':
        summary.eligible += 1;
        if (!result.reusedExistingTarget) summary.copied += 1;
        summary.verified += 1;
        summary.switched += 1;
        summary.bytes += result.bytes ?? 0;
        break;
      case 'DRY_RUN':
        summary.eligible += 1;
        summary.verified += 1;
        summary.bytes += result.bytes ?? 0;
        break;
      case 'SKIP_ALREADY_MIGRATED':
        summary.alreadyMigrated += 1;
        break;
      case 'SKIP_NOT_ON_SOURCE':
        summary.skipped += 1;
        break;
      case 'SOURCE_MISSING':
        summary.sourceMissing += 1;
        summary.failed += 1;
        break;
      case 'SOURCE_CHECKSUM_MISMATCH':
      case 'TARGET_VERIFY_FAILED':
        summary.checksumMismatch += 1;
        summary.failed += 1;
        break;
      case 'TARGET_CONFLICT':
        summary.targetConflict += 1;
        summary.failed += 1;
        break;
      default:
        summary.failed += 1;
        break;
    }
  }

  logger.info({
    from: options.from, to: options.to, dryRun: options.dryRun,
    scanned: summary.scanned, switched: summary.switched, failed: summary.failed,
  }, '[STORAGE] สรุปการย้ายพื้นที่จัดเก็บ');

  return summary;
}

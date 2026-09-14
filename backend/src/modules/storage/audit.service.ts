import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import type { StorageProviderKind } from '@prisma/client';
import { env } from '../../config/env.js';
import { prisma } from '../../core/prisma.js';
import { resolveInsideStorage } from '../../core/storage.js';
import { storageProviderFor } from '../../core/storage/index.js';

/**
 * ตรวจความสอดคล้องระหว่างข้อมูลกำกับกับวัตถุจริง (F23-E)
 *
 * **ไม่ซ่อมอะไรเลยโดยค่าเริ่มต้น** เครื่องมือนี้รายงานอย่างเดียว การซ่อมอัตโนมัติ
 * บนข้อมูลที่ยังไม่เข้าใจสาเหตุ คือวิธีเปลี่ยนความไม่สอดคล้องที่มองเห็นได้
 * ให้กลายเป็นความเสียหายที่มองไม่เห็น
 *
 * **แยก "ไม่มีวัตถุ" ออกจาก "ติดต่อบริการไม่ได้" เสมอ** ถ้ายุบสองอย่างนี้เข้าด้วยกัน
 * บริการที่ล่มชั่วคราวจะถูกรายงานว่าไฟล์หายทั้งคลัง ซึ่งชวนให้คนกู้คืนทับของที่ยังดีอยู่
 *
 * **แต่ละแถวใช้ผู้ให้บริการของตัวเอง** ไม่ใช่ผู้ให้บริการที่ตั้งไว้เป็นค่าเริ่มต้น
 */

export type AuditFindingKind =
  | 'RESTORE_STAGE_RESIDUE'
  | 'OBJECT_MISSING'
  | 'SIZE_MISMATCH'
  | 'CHECKSUM_MISMATCH'
  | 'PROVIDER_UNAVAILABLE'
  | 'UNSUPPORTED_PROVIDER'
  | 'RESOURCE_PROVIDER_MISMATCH'
  | 'RESOURCE_KEY_MISMATCH'
  | 'RESOURCE_CHECKSUM_MISMATCH'
  | 'ORPHAN_OBJECT';

export interface AuditFinding {
  kind: AuditFindingKind;
  /** อ้างด้วยรหัสแถวเสมอ - ปลอดภัยต่อการบันทึกและสืบย้อนได้ */
  resourceVersionId?: string;
  resourceId?: string;
  provider?: StorageProviderKind;
  detail?: string;
}

export interface StorageAuditReport {
  checkedVersions: number;
  checkedResources: number;
  /** true เมื่อรอบนี้อ่านไบต์จริงเพื่อคำนวณ SHA-256 */
  checksumVerified: boolean;
  bytesRead: number;
  providerStatus: Record<string, string>;
  orphanScan: { local: boolean; s3: boolean };
  orphanCount: number;
  findings: AuditFinding[];
}

export interface StorageAuditOptions {
  /** อ่านไบต์จริงเพื่อตรวจ SHA-256 - แพงกว่ามาก จึงต้องขอเป็นพิเศษ */
  checksum?: boolean;
  /** ตรวจหาวัตถุที่ไม่มีแถวใดอ้างถึง */
  orphans?: boolean;
  limit?: number;
}

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
 * ชุดคีย์ที่ระบบอ้างถึงจริง
 *
 * **ไม่ได้มีแค่ ResourceVersion** แถว Resource รุ่นก่อนมีระบบเวอร์ชันยังชี้ไปยังวัตถุ
 * ด้วยตัวเอง และชุดสำรองก็เก็บวัตถุเหล่านั้นไว้ การนับเฉพาะเวอร์ชันจะทำให้ไฟล์เก่า
 * ถูกป้ายว่าเป็นขยะทั้งที่ยังถูกใช้งานอยู่ - ซึ่งเป็นคำแนะนำที่อันตรายที่สุดที่เครื่องมือนี้ให้ได้
 */
async function referencedKeys(provider: StorageProviderKind): Promise<Set<string>> {
  const keys = new Set<string>();
  const versions = await prisma.resourceVersion.findMany({
    where: { storageProvider: provider }, select: { storageKey: true },
  });
  for (const version of versions) keys.add(version.storageKey);

  const resources = await prisma.resource.findMany({
    where: { storageProvider: provider, storageKey: { not: null } }, select: { storageKey: true },
  });
  for (const resource of resources) if (resource.storageKey) keys.add(resource.storageKey);

  return keys;
}

/**
 * แจกแจงวัตถุบนดิสก์ใต้ resources/ เท่านั้น
 *
 * temp/ เป็นพื้นที่พักระหว่างอัปโหลดและการทำไฟล์ชั่วคราว ส่วนโฟลเดอร์อื่นของระบบ
 * ไม่ใช่ของเวอร์ชันเอกสาร การเหมารวมทั้งรากจะทำให้ของที่ยังใช้งานอยู่ถูกป้ายว่าเป็นขยะ
 */
async function listLocalObjects(): Promise<string[]> {
  const root = resolveInsideStorage('resources');
  const found: string[] = [];

  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) {
        const relative = path.relative(env.STORAGE_ROOT, full).split(path.sep).join('/');
        found.push(relative);
      }
    }
  };

  await walk(root);
  return found;
}

export async function auditStorage(options: StorageAuditOptions = {}): Promise<StorageAuditReport> {
  const report: StorageAuditReport = {
    checkedVersions: 0, checkedResources: 0,
    checksumVerified: Boolean(options.checksum), bytesRead: 0,
    providerStatus: {}, orphanScan: { local: false, s3: false }, orphanCount: 0, findings: [],
  };

  /* ---------------- สุขภาพของผู้ให้บริการก่อนตัดสินอะไรทั้งสิ้น ---------------- */

  const usedProviders = await prisma.resourceVersion.groupBy({ by: ['storageProvider'] });
  const healthy = new Map<StorageProviderKind, boolean>();

  for (const row of usedProviders) {
    const kind = row.storageProvider;
    try {
      const status = (await storageProviderFor(kind).health()).status;
      report.providerStatus[kind] = status;
      healthy.set(kind, status === 'READY');
      if (status !== 'READY') {
        report.findings.push({ kind: 'PROVIDER_UNAVAILABLE', provider: kind, detail: status });
      }
    } catch {
      // ผู้ให้บริการที่ยังไม่ได้ตั้งค่า แต่มีแถวอ้างถึง - ต้องรายงาน ไม่ใช่ล้มทั้งการตรวจ
      report.providerStatus[kind] = 'NOT_CONFIGURED';
      healthy.set(kind, false);
      report.findings.push({ kind: 'UNSUPPORTED_PROVIDER', provider: kind });
    }
  }

  /* ---------------- ตรวจทีละเวอร์ชันด้วยผู้ให้บริการของแถวนั้น ---------------- */

  const versions = await prisma.resourceVersion.findMany({
    select: { id: true, resourceId: true, storageKey: true, storageProvider: true, size: true, checksum: true },
    orderBy: { createdAt: 'asc' },
    ...(options.limit ? { take: options.limit } : {}),
  });

  for (const version of versions) {
    report.checkedVersions += 1;
    // ผู้ให้บริการที่ติดต่อไม่ได้ถูกรายงานไปแล้วครั้งเดียว ไม่ต้องป้ายทุกแถวว่าไฟล์หาย
    if (healthy.get(version.storageProvider) !== true) continue;

    const provider = storageProviderFor(version.storageProvider);
    const expectedSize = Number(version.size);
    const stat = await provider.stat(version.storageKey);

    if (!stat) {
      report.findings.push({ kind: 'OBJECT_MISSING', resourceVersionId: version.id,
        resourceId: version.resourceId, provider: version.storageProvider });
      continue;
    }
    if (stat.size !== expectedSize) {
      report.findings.push({ kind: 'SIZE_MISMATCH', resourceVersionId: version.id,
        resourceId: version.resourceId, provider: version.storageProvider,
        detail: `พื้นที่จัดเก็บ ${stat.size} ไบต์ ฐานข้อมูล ${expectedSize} ไบต์` });
      continue;
    }

    if (options.checksum) {
      const measured = await measure(await provider.getStream(version.storageKey));
      report.bytesRead += measured.size;
      if (measured.checksum !== version.checksum) {
        report.findings.push({ kind: 'CHECKSUM_MISMATCH', resourceVersionId: version.id,
          resourceId: version.resourceId, provider: version.storageProvider });
      }
    }
  }

  /* ---------------- ความสอดคล้องของ Resource กับเวอร์ชันปัจจุบัน ---------------- */

  const resources = await prisma.resource.findMany({
    where: { type: 'FILE', currentVersion: { not: null } },
    select: { id: true, currentVersion: true, storageKey: true, storageProvider: true, checksum: true },
    ...(options.limit ? { take: options.limit } : {}),
  });

  for (const resource of resources) {
    report.checkedResources += 1;
    const current = await prisma.resourceVersion.findFirst({
      where: { resourceId: resource.id, versionNumber: resource.currentVersion ?? 0 },
      select: { storageKey: true, storageProvider: true, checksum: true },
    });
    if (!current) continue;

    if (resource.storageProvider !== current.storageProvider) {
      report.findings.push({ kind: 'RESOURCE_PROVIDER_MISMATCH', resourceId: resource.id,
        detail: `Resource ${resource.storageProvider} เวอร์ชันปัจจุบัน ${current.storageProvider}` });
    }
    if (resource.storageKey !== current.storageKey) {
      report.findings.push({ kind: 'RESOURCE_KEY_MISMATCH', resourceId: resource.id });
    }
    if (resource.checksum !== current.checksum) {
      report.findings.push({ kind: 'RESOURCE_CHECKSUM_MISMATCH', resourceId: resource.id });
    }
  }

  /* ---------------- วัตถุที่ไม่มีใครอ้างถึง ---------------- */

  if (options.orphans) {
    /**
     * ตรวจที่เก็บวัตถุแม้ไม่มีแถวใดอ้างถึงมันเลย
     *
     * เดิมตรวจเฉพาะผู้ให้บริการที่มีแถวอ้างถึง ซึ่งพลาดกรณีที่สำคัญที่สุด:
     * ระบบที่ยังเก็บทุกอย่างบนดิสก์ แต่เคยลองกู้คืนขึ้นที่เก็บวัตถุแล้วล้มกลางคัน
     * ตอนนั้นไม่มีแถวใดเป็น S3 เลย เศษที่ค้างอยู่จึงไม่มีใครเห็น
     */
    if (!healthy.has('S3')) {
      try {
        const status = (await storageProviderFor('S3').health()).status;
        report.providerStatus.S3 ??= status;
        healthy.set('S3', status === 'READY');
      } catch {
        // ยังไม่ได้ตั้งค่า S3 - ไม่ใช่ความผิดปกติ และไม่มีอะไรให้ตรวจ
        healthy.set('S3', false);
      }
    }

    if (healthy.get('LOCAL') !== false) {
      report.orphanScan.local = true;
      const referenced = await referencedKeys('LOCAL');
      for (const key of await listLocalObjects()) {
        if (!referenced.has(key)) {
          report.findings.push({ kind: 'ORPHAN_OBJECT', provider: 'LOCAL', detail: key });
          report.orphanCount += 1;
        }
      }
    }

    if (healthy.get('S3') === true) {
      report.orphanScan.s3 = true;
      const referenced = await referencedKeys('S3');
      for (const key of await listS3Objects()) {
        if (!referenced.has(key)) {
          report.findings.push({ kind: 'ORPHAN_OBJECT', provider: 'S3', detail: key });
          report.orphanCount += 1;
        }
      }

      /**
       * เศษที่เหลือจากการกู้คืนที่ไม่จบ
       *
       * การกู้คืนที่ถูกขัดจังหวะกลางคันทิ้งวัตถุไว้ใต้ restore-stage/<runId>/ ซึ่งไม่มี
       * แถวใดอ้างถึงโดยตั้งใจ - มันไม่ใช่ข้อมูลที่ใช้งานอยู่ และไม่ใช่ขยะที่เกิดจากความผิดพลาด
       * จึงต้องรายงานแยกจากวัตถุกำพร้าทั่วไป เพราะวิธีจัดการต่างกัน: อันนี้ลบได้อย่างปลอดภัย
       * เมื่อรอบการกู้คืนนั้นจบไปแล้ว ส่วนวัตถุกำพร้าทั่วไปต้องสืบให้รู้ก่อนว่ามาจากไหน
       *
       * ไม่ลบให้เอง เพราะการกู้คืนที่กำลังทำงานอยู่ก็มีวัตถุอยู่ใต้คำนำหน้าเดียวกัน
       */
      for (const [runId, count] of await countRestoreStageObjects()) {
        report.findings.push({
          kind: 'RESTORE_STAGE_RESIDUE', provider: 'S3',
          detail: `รอบ ${runId} เหลือ ${count} วัตถุ`,
        });
      }
    }
  }

  return report;
}

/**
 * แจกแจงวัตถุบน S3 เฉพาะใต้ <prefix>/resources/
 *
 * ถังหนึ่งอาจมีข้อมูลของระบบอื่นอยู่ด้วย การแจกแจงทั้งถังแล้วเรียกสิ่งที่ไม่รู้จักว่า
 * "ขยะของ NAS" คือวิธีที่จะแนะนำให้คนลบของคนอื่นสักวันหนึ่ง
 *
 * คีย์ที่คืนออกมาเป็นคีย์เชิงตรรกะเสมอ เพื่อเทียบกับค่าที่บันทึกในฐานข้อมูลได้ตรง ๆ
 */
async function listS3Objects(): Promise<string[]> {
  const { S3StorageProvider } = await import('../../core/storage/s3.provider.js');
  const provider = storageProviderFor('S3');
  if (!(provider instanceof S3StorageProvider)) return [];
  return provider.listLogicalKeys('resources/');
}

/**
 * นับวัตถุที่ค้างอยู่ในพื้นที่พักของการกู้คืน แยกตามรอบ
 *
 * รายงานเป็นรายรอบ ไม่ใช่รายวัตถุ เพราะการกู้คืนหนึ่งครั้งทิ้งวัตถุไว้ได้ทั้งคลัง
 * การพิมพ์ทีละชิ้นจะกลบรายงานอื่นจนอ่านไม่ออก
 */
async function countRestoreStageObjects(): Promise<Map<string, number>> {
  const { S3StorageProvider } = await import('../../core/storage/s3.provider.js');
  const { RESTORE_STAGE_PREFIX } = await import('../backup/restore-target.js');
  const provider = storageProviderFor('S3');
  const counts = new Map<string, number>();
  if (!(provider instanceof S3StorageProvider)) return counts;

  for (const key of await provider.listLogicalKeys(`${RESTORE_STAGE_PREFIX}/`)) {
    const runId = key.slice(RESTORE_STAGE_PREFIX.length + 1).split('/')[0];
    if (runId) counts.set(runId, (counts.get(runId) ?? 0) + 1);
  }
  return counts;
}

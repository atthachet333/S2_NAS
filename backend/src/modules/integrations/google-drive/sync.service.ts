import type { GoogleDriveSync, Resource } from '@prisma/client';
import { Readable } from 'node:stream';
import { prisma } from '../../../core/prisma.js';
import { AppError, notFound } from '../../../core/errors.js';
import { logger } from '../../../core/logger.js';
import { uploadVersion } from '../../files/file.service.js';
import { capabilities } from '../../resources/resource.service.js';
import { resourceInclude, type AuditContext } from '../../workspace/workspace.service.js';
import type { AuthUser } from '../../auth/auth.service.js';
import { accessTokenFor } from './connection.service.js';
import { DriveError } from './google-api.js';
import { fetchContent } from './import.service.js';
import type { GoogleDriveProvider } from './provider.js';
import { contentFingerprint, isOoxmlExportMime } from './content-fingerprint.js';
import { createStoredFileStream } from '../../../core/file-storage.js';

/**
 * การซิงก์จาก Google Drive มาที่ S2 NAS (F19)
 *
 * **ทางเดียวเท่านั้น: Google → S2 NAS**
 *
 * ไม่มีการเขียนกลับไปที่ Google และจะไม่มีในเฟสนี้ การซิงก์สองทางต้องตอบคำถามว่า
 * "ถ้าทั้งสองฝั่งแก้พร้อมกัน ฝั่งไหนถูก" ซึ่งไม่มีคำตอบที่ถูกเสมอ และคำตอบที่ผิด
 * แปลว่างานของใครบางคนหายไปโดยไม่มีใครรู้ตัว
 *
 * ทางเดียวทำให้กฎชัดเจน: Google คือต้นทาง S2 NAS คือสำเนาที่มีประวัติ
 */

/** สถานะที่คำนวณจากข้อมูลจริง ไม่เก็บซ้ำเพราะจะเพี้ยนจากความจริงเมื่อเวลาผ่านไป */
export type SyncStatus =
  | 'SYNCED'
  | 'UPDATE_AVAILABLE'
  | 'PAUSED_LIFECYCLE'
  | 'PAUSED_LEGAL_HOLD'
  | 'SOURCE_MISSING'
  | 'ERROR'
  | 'REAUTH_REQUIRED'
  | 'DISCONNECTED'
  | 'DETACHED';

/**
 * เหตุที่การซิงก์หยุดชั่วคราวตามวงจรชีวิตของเอกสาร
 *
 * ทั้งสามกรณีมีเหตุผลเดียวกัน: มีคนตัดสินใจบางอย่างกับเอกสารนี้แล้ว
 * และการเอาเนื้อหาใหม่ยัดเข้าไปเงียบ ๆ จะทำให้การตัดสินใจนั้นเสียความหมาย
 */
export type LifecyclePause = 'TRASHED' | 'ARCHIVED' | 'LEGAL_HOLD' | null;

type ResourceState = Pick<Resource, 'deletedAt' | 'lifecycleState'>;

/**
 * ตรวจว่าทรัพยากรอยู่ในสภาพที่รับเนื้อหาใหม่ได้หรือไม่
 *
 * - ถังขยะ: ผู้ใช้ตั้งใจจะทิ้ง การสร้างเวอร์ชันใหม่ให้ของที่กำลังจะหายไปไม่มีความหมาย
 * - คลัง: งานชิ้นนั้นจบแล้ว เอกสารที่เก็บเข้าคลังคือหลักฐานของสภาพ ณ ตอนนั้น
 * - Legal Hold: เอกสารอยู่ระหว่างข้อพิพาท **นี่คือกรณีที่สำคัญที่สุด**
 *
 * Legal Hold ห้ามลบ แต่ไม่ได้ห้ามต้นทางฝั่ง Google เปลี่ยน ถ้าเราดึงเนื้อหาใหม่
 * เข้ามาเป็นเวอร์ชันปัจจุบันโดยอัตโนมัติ ชุดหลักฐานที่ถูกสั่งให้เก็บรักษาจะเปลี่ยนไป
 * โดยไม่มีมนุษย์คนไหนตัดสินใจ - ซึ่งขัดกับเจตนาทั้งหมดของการระงับการลบ
 *
 * เวอร์ชันเก่ายังอยู่ครบก็จริง แต่ "เวอร์ชันปัจจุบัน" คือสิ่งที่คนเปิดดูและส่งต่อ
 */
export async function lifecyclePause(resourceId: string): Promise<LifecyclePause> {
  const resource = await prisma.resource.findUnique({
    where: { id: resourceId },
    select: { deletedAt: true, lifecycleState: true },
  });
  if (!resource) return 'TRASHED';
  if (resource.deletedAt) return 'TRASHED';
  if (resource.lifecycleState !== 'ACTIVE') return 'ARCHIVED';

  const hold = await prisma.legalHold.findFirst({
    where: { resourceId, isActive: true },
    select: { id: true },
  });
  return hold ? 'LEGAL_HOLD' : null;
}

export function syncStatus(
  sync: GoogleDriveSync,
  connectionState: string,
  pause: LifecyclePause,
): SyncStatus {
  if (sync.detachedAt) return 'DETACHED';
  if (connectionState === 'DISCONNECTED') return 'DISCONNECTED';
  if (connectionState === 'REAUTH_REQUIRED' || connectionState === 'CREDENTIAL_UNREADABLE') {
    return 'REAUTH_REQUIRED';
  }
  if (pause === 'LEGAL_HOLD') return 'PAUSED_LEGAL_HOLD';
  if (pause) return 'PAUSED_LIFECYCLE';
  if (sync.lastIssue === 'SOURCE_MISSING') return 'SOURCE_MISSING';
  if (sync.lastIssue) return 'ERROR';
  return 'SYNCED';
}

/* ------------------------------------------------------------------ */
/* ผลของการตรวจหนึ่งครั้ง                                                */
/* ------------------------------------------------------------------ */

export type CheckOutcome =
  | 'UNCHANGED'
  | 'VERSION_CREATED'
  | 'IDENTICAL_BYTES'
  | 'PAUSED'
  | 'SOURCE_MISSING'
  | 'PERMISSION_LOST'
  | 'AUTH_REQUIRED'
  | 'UNSUPPORTED'
  | 'ERROR';

export interface CheckResult {
  outcome: CheckOutcome;
  status: SyncStatus;
  message: string;
}

const OUTCOME_TEXT: Record<CheckOutcome, string> = {
  UNCHANGED: 'ต้นทางยังไม่มีการเปลี่ยนแปลง',
  VERSION_CREATED: 'พบการเปลี่ยนแปลง สร้างเวอร์ชันใหม่แล้ว',
  IDENTICAL_BYTES: 'ต้นทางถูกแก้ไข แต่เนื้อหาไฟล์เหมือนเดิม จึงไม่สร้างเวอร์ชันใหม่',
  PAUSED: 'การซิงก์หยุดชั่วคราว',
  SOURCE_MISSING: 'ไฟล์ต้นทางใน Google Drive ไม่พบแล้ว',
  PERMISSION_LOST: 'บัญชีที่เชื่อมต่อไม่มีสิทธิ์เข้าถึงไฟล์ต้นทางแล้ว',
  AUTH_REQUIRED: 'ต้องเชื่อมต่อ Google Drive ใหม่',
  UNSUPPORTED: 'ไฟล์ชนิดนี้ซิงก์ไม่ได้',
  ERROR: 'ตรวจสอบไม่สำเร็จ กรุณาลองใหม่',
};

const PAUSE_TEXT: Record<Exclude<LifecyclePause, null>, string> = {
  TRASHED: 'การซิงก์หยุดชั่วคราวเนื่องจากทรัพยากรอยู่ในถังขยะ',
  ARCHIVED: 'การซิงก์หยุดชั่วคราวเนื่องจากทรัพยากรถูกเก็บเข้าคลัง',
  LEGAL_HOLD: 'ซิงก์หยุดชั่วคราวเนื่องจาก Legal Hold',
};

/* ------------------------------------------------------------------ */
/* การตรวจหนึ่งรายการ                                                    */
/* ------------------------------------------------------------------ */

/**
 * ตรวจและซิงก์รายการเดียว
 *
 * เส้นทางเดียวที่ใช้ทั้งจากปุ่ม "ตรวจสอบตอนนี้" และจากตัวทำงานเบื้องหลัง
 * ไม่มีตรรกะสองชุดที่อาจให้ผลต่างกัน
 */
export async function checkOne(
  sync: GoogleDriveSync,
  provider: GoogleDriveProvider,
  audit: AuditContext,
  actingUser?: AuthUser,
): Promise<CheckResult> {
  const connection = await prisma.googleDriveConnection.findUnique({
    where: { id: sync.connectionId },
  });
  if (!connection) {
    return { outcome: 'ERROR', status: 'DISCONNECTED', message: OUTCOME_TEXT.ERROR };
  }

  if (sync.detachedAt) {
    return { outcome: 'PAUSED', status: 'DETACHED', message: 'การซิงก์ถูกหยุดถาวรแล้ว' };
  }

  /**
   * ตรวจวงจรชีวิตก่อนแตะ Google เลย
   *
   * ไม่ใช่แค่ประหยัดคำขอ - เอกสารที่ถูกระงับหรือเก็บเข้าคลังไม่ควรมีคำขออ่านต้นทาง
   * เกิดขึ้นในนามของมันด้วยซ้ำ
   */
  const pause = await lifecyclePause(sync.resourceId);
  if (pause) {
    await prisma.googleDriveSync.update({
      where: { id: sync.id },
      data: { lastCheckedAt: new Date() },
    });
    return {
      outcome: 'PAUSED',
      status: pause === 'LEGAL_HOLD' ? 'PAUSED_LEGAL_HOLD' : 'PAUSED_LIFECYCLE',
      message: PAUSE_TEXT[pause],
    };
  }

  try {
    const accessToken = await accessTokenFor(connection, provider);
    const remote = await provider.getFileMetadata(accessToken, sync.googleFileId);

    const changed =
      remote.version !== sync.lastRemoteVersion ||
      remote.modifiedTime?.getTime() !== sync.lastRemoteModifiedTime?.getTime();

    if (!changed) {
      await prisma.googleDriveSync.update({
        where: { id: sync.id },
        data: { lastCheckedAt: new Date(), lastIssue: null, lastErrorCode: null },
      });
      return { outcome: 'UNCHANGED', status: 'SYNCED', message: OUTCOME_TEXT.UNCHANGED };
    }

    /**
     * เมทาดาทาเปลี่ยน ไม่ได้แปลว่าเนื้อหาเปลี่ยน
     *
     * Google ขยับ modifiedTime เมื่อมีคนเปลี่ยนชื่อ ย้ายโฟลเดอร์ หรือแก้สิทธิ์ และ
     * ขยับ `version` เองด้วยซ้ำจากงานเบื้องหลังที่ผู้ใช้ไม่เห็น เมทาดาทาจึงบอกได้แค่
     * "ควรไปดู" ไม่ใช่ "เนื้อหาเปลี่ยนแล้ว"
     *
     * คำตัดสินจริงเกิดหลังดาวน์โหลด โดยเทียบลายนิ้วมือเนื้อหา ไม่ใช่ไบต์ของคอนเทนเนอร์
     */
    const content = await fetchContent(provider, accessToken, remote);

    /**
     * ผู้ลงมือคือเจ้าของการเชื่อมต่อเสมอ ไม่ใช่คนที่กดปุ่ม
     *
     * เนื้อหามาจาก Drive ของเจ้าของการเชื่อมต่อ และสิทธิ์ที่ใช้ดึงก็เป็นของเขา
     * การบันทึกว่าคนอื่นเป็นผู้สร้างเวอร์ชันจะทำให้ประวัติเล่าเรื่องผิด
     */
    const owner = actingUser ?? (await ownerAsAuthUser(connection.userId));

    const remoteMetadata = {
      remoteName: remote.name.slice(0, 191),
      remoteMimeType: remote.mimeType.slice(0, 191),
      remoteWebUrl: remote.webViewLink,
      lastRemoteModifiedTime: remote.modifiedTime,
      lastRemoteVersion: remote.version?.slice(0, 64) ?? null,
    };

    /**
     * ไฟล์ Google ที่ส่งออกเป็น OOXML ต้องตัดสินด้วยลายนิ้วมือ ไม่ใช่ SHA-256 ของทั้งไฟล์
     *
     * Google ประทับเวลาที่ส่งออกลงในหัวของแต่ละรายการใน ZIP การส่งออกเอกสารเดิมซ้ำ
     * จึงได้ไบต์ต่างกันเสมอ - ด่านกัน checksum ของท่ออัปโหลดจึงไม่มีวันทำงานกับไฟล์พวกนี้
     * และประวัติเวอร์ชันจะงอกเวอร์ชันที่เอกสารเหมือนกันทุกประการไปเรื่อย ๆ
     *
     * โหลดเข้าหน่วยความจำได้เพราะเป็นเอกสาร ไม่ใช่ไฟล์สื่อขนาดใหญ่ - และมีเพดานกำกับ
     * ไฟล์ไบนารีปกติยังไหลเป็นสตรีมตามเดิม ไม่ถูกดึงเข้าหน่วยความจำ
     */
    if (isOoxmlExportMime(content.mimeType)) {
      const bytes = await collectBounded(content.stream);
      const fingerprint = contentFingerprint(bytes, content.mimeType);

      /**
       * ค่าที่เก็บไว้เป็นทางลัด ส่วนไฟล์ที่เก็บจริงคือผู้ตัดสิน
       *
       * ถ้าเชื่อเฉพาะค่าที่เก็บไว้ ทุกครั้งที่วิธีคำนวณลายนิ้วมือเปลี่ยน (หรือแถวยัง
       * ไม่มีค่านี้เลย) ไฟล์ที่ซิงก์อยู่ทุกไฟล์จะได้เวอร์ชันซ้ำฟรีหนึ่งรอบทันที
       *
       * การเทียบกับเวอร์ชันปัจจุบันที่เก็บไว้จริงจึงเป็นด่านสุดท้าย - อ่านไฟล์ในเครื่อง
       * หนึ่งครั้ง ซึ่งถูกกว่าการสร้างเวอร์ชันใหม่ที่ไม่มีใครต้องการมาก
       */
      const equivalent =
        sync.lastContentFingerprint === fingerprint ||
        (await currentVersionFingerprint(sync.resourceId)) === fingerprint;

      if (equivalent) {
        /**
         * เนื้อหาเท่าเดิม - ไม่แตะไบต์ที่เก็บไว้
         *
         * ไม่เขียนทับไฟล์เดิมเพียงเพื่อให้เวลาใน ZIP ตรงกับครั้งล่าสุด เพราะไบต์ชุดเดิม
         * คือหลักฐานที่ผูกกับ checksum ของเวอร์ชันนั้นอยู่แล้ว
         */
        await prisma.googleDriveSync.update({
          where: { id: sync.id },
          data: {
            ...remoteMetadata,
            lastContentFingerprint: fingerprint,
            lastCheckedAt: new Date(),
            lastSyncedAt: new Date(),
            lastIssue: null,
            lastErrorCode: null,
          },
        });
        await prisma.googleDriveConnection.update({
          where: { id: connection.id },
          data: { lastSuccessfulSyncAt: new Date() },
        });
        return {
          outcome: 'IDENTICAL_BYTES',
          status: 'SYNCED',
          message: OUTCOME_TEXT.IDENTICAL_BYTES,
        };
      }

      const created = await storeNewVersion(owner, sync.resourceId, Readable.from(bytes), content, audit);
      await finishSync(sync.id, connection.id, remoteMetadata, fingerprint);
      await recordSynced(created, connection, sync, audit);
      return created.versionCreated
        ? { outcome: 'VERSION_CREATED', status: 'SYNCED', message: OUTCOME_TEXT.VERSION_CREATED }
        : { outcome: 'IDENTICAL_BYTES', status: 'SYNCED', message: OUTCOME_TEXT.IDENTICAL_BYTES };
    }

    /**
     * ไฟล์ไบนารีปกติ - ความหมายเดิมทุกประการ
     *
     * SHA-256 ของไบต์จริงเป็นตัวตัดสิน และท่ออัปโหลดเป็นผู้เทียบให้เหมือนเดิม
     */
    const created = await storeNewVersion(owner, sync.resourceId, content.stream, content, audit);
    await finishSync(sync.id, connection.id, remoteMetadata, created.checksum ? `bytes:${created.checksum}` : null);
    await recordSynced(created, connection, sync, audit);
    return created.versionCreated
      ? { outcome: 'VERSION_CREATED', status: 'SYNCED', message: OUTCOME_TEXT.VERSION_CREATED }
      : { outcome: 'IDENTICAL_BYTES', status: 'SYNCED', message: OUTCOME_TEXT.IDENTICAL_BYTES };

  } catch (error) {
    return recordFailure(sync, error, audit);
  }
}

/**
 * บันทึกความล้มเหลวโดยไม่แตะไฟล์ใน NAS
 *
 * **ไม่มีเส้นทางใดในไฟล์นี้ที่ลบทรัพยากร** ต้นทางหายไม่ได้แปลว่าสำเนาของเราควรหายตาม
 * ในทางกลับกัน ต้นทางที่หายทำให้สำเนาของเรามีค่ามากขึ้น ไม่ใช่น้อยลง
 */
async function recordFailure(
  sync: GoogleDriveSync,
  error: unknown,
  audit: AuditContext,
): Promise<CheckResult> {
  let issue: 'SOURCE_MISSING' | 'PERMISSION_LOST' | 'AUTH_REQUIRED' | 'UNSUPPORTED' | 'TRANSIENT' =
    'TRANSIENT';
  let outcome: CheckOutcome = 'ERROR';
  let status: SyncStatus = 'ERROR';

  if (error instanceof DriveError) {
    if (error.kind === 'NOT_FOUND') {
      issue = 'SOURCE_MISSING';
      outcome = 'SOURCE_MISSING';
      status = 'SOURCE_MISSING';
    } else if (error.kind === 'PERMISSION_DENIED') {
      issue = 'PERMISSION_LOST';
      outcome = 'PERMISSION_LOST';
    } else if (error.kind === 'AUTH_REQUIRED') {
      issue = 'AUTH_REQUIRED';
      outcome = 'AUTH_REQUIRED';
      status = 'REAUTH_REQUIRED';
    } else if (error.kind === 'UNSUPPORTED') {
      issue = 'UNSUPPORTED';
      outcome = 'UNSUPPORTED';
    }
  } else if (error instanceof AppError && error.code === 'GOOGLE_DRIVE_REAUTH_REQUIRED') {
    issue = 'AUTH_REQUIRED';
    outcome = 'AUTH_REQUIRED';
    status = 'REAUTH_REQUIRED';
  }

  const code = error instanceof AppError ? error.code : 'UNKNOWN';

  await prisma.googleDriveSync.update({
    where: { id: sync.id },
    data: { lastCheckedAt: new Date(), lastIssue: issue, lastErrorCode: code.slice(0, 64) },
  });

  const connection = await prisma.googleDriveConnection.findUnique({
    where: { id: sync.connectionId },
    select: { userId: true },
  });

  await prisma.activityLog.create({
    data: {
      userId: connection?.userId ?? null,
      action: issue === 'SOURCE_MISSING' ? 'GOOGLE_DRIVE_SOURCE_MISSING' : 'GOOGLE_DRIVE_SYNC_FAILED',
      resourceId: sync.resourceId,
      ipAddress: audit.ipAddress,
      userAgent: audit.userAgent?.slice(0, 500),
      metadata: {
        connectionId: sync.connectionId,
        googleFileId: sync.googleFileId,
        issue,
        errorCode: code,
      },
    },
  });

  logger.warn(`[DRIVE] ซิงก์ ${sync.googleFileId} ไม่สำเร็จ: ${issue}`);
  return { outcome, status, message: OUTCOME_TEXT[outcome] };
}


/* ------------------------------------------------------------------ */
/* ตัวช่วยของการตัดสินเนื้อหา (D1)                                        */
/* ------------------------------------------------------------------ */

/** เพดานเดียวกับตัวอ่าน OOXML - ไฟล์ที่ใหญ่กว่านี้ไม่ใช่เอกสารที่ Google ส่งออก */
const MAX_EXPORT_BYTES = 256 * 1024 * 1024;

/** อ่านสตรีมเข้าหน่วยความจำโดยมีเพดาน - ใช้เฉพาะไฟล์ Google ที่ส่งออกแล้ว */
async function collectBounded(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const piece = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    total += piece.length;
    if (total > MAX_EXPORT_BYTES) {
      stream.destroy();
      throw new AppError('GOOGLE_DRIVE_EXPORT_TOO_LARGE', 'ไฟล์ที่ส่งออกใหญ่เกินกว่าจะตรวจสอบได้', 413);
    }
    chunks.push(piece);
  }
  return Buffer.concat(chunks);
}

/**
 * ลายนิ้วมือของเวอร์ชันปัจจุบันที่เก็บอยู่ใน NAS
 *
 * ใช้ตอนที่ยังไม่เคยบันทึกลายนิ้วมือไว้ (แถวเก่าก่อนมีฟิลด์นี้) เพื่อไม่ให้การเพิ่ม
 * ฟิลด์ใหม่กลายเป็นเหตุให้ทุกไฟล์ที่ซิงก์อยู่ได้เวอร์ชันซ้ำฟรี ๆ หนึ่งรอบ
 *
 * อ่านไม่ได้ก็คืน null - แล้วผู้เรียกจะถือว่าเนื้อหาต่างและปล่อยให้ท่ออัปโหลด
 * ตัดสินด้วย checksum ตามปกติ ซึ่งเป็นพฤติกรรมเดิม
 */
async function currentVersionFingerprint(resourceId: string): Promise<string | null> {
  const current = await prisma.resource.findUnique({
    where: { id: resourceId },
    select: { currentVersion: true, mimeType: true },
  });
  if (!current?.currentVersion) return null;

  const version = await prisma.resourceVersion.findFirst({
    where: { resourceId, versionNumber: current.currentVersion },
    select: { storageKey: true, mimeType: true },
  });
  if (!version) return null;

  try {
    const bytes = await collectBounded(createStoredFileStream(version.storageKey));
    return contentFingerprint(bytes, version.mimeType ?? current.mimeType ?? '');
  } catch {
    return null;
  }
}

interface StoreResult {
  versionCreated: boolean;
  versionNumber: number | null;
  checksum: string | null;
}

/** เขียนเวอร์ชันผ่านท่ออัปโหลดเดิม แล้วรายงานว่าเวอร์ชันขยับจริงหรือไม่ */
async function storeNewVersion(
  owner: AuthUser,
  resourceId: string,
  stream: Readable,
  content: { mimeType: string },
  audit: AuditContext,
): Promise<StoreResult> {
  const before = await prisma.resource.findUnique({
    where: { id: resourceId },
    select: { currentVersion: true },
  });

  await uploadVersion(
    owner,
    resourceId,
    stream,
    {
      declaredMime: content.mimeType,
      remark: 'อัปเดตจาก Google Drive',
      /** ตัวการซิงก์คือฝ่ายที่ด่านห้ามอัปโหลดทับปกป้องอยู่ จึงผ่านได้ */
      fromGoogleSync: true,
      /** ไบต์เท่ากันเป๊ะก็ไม่ต้องสร้างเวอร์ชัน - ด่านสุดท้ายของไฟล์ไบนารี */
      skipIfUnchanged: true,
    },
    audit,
  );

  const after = await prisma.resource.findUnique({
    where: { id: resourceId },
    select: { currentVersion: true },
  });

  const versionCreated = (after?.currentVersion ?? 0) > (before?.currentVersion ?? 0);
  const stored = after?.currentVersion
    ? await prisma.resourceVersion.findFirst({
        where: { resourceId, versionNumber: after.currentVersion },
        select: { checksum: true },
      })
    : null;

  return { versionCreated, versionNumber: after?.currentVersion ?? null, checksum: stored?.checksum ?? null };
}

/** บันทึกผลสำเร็จของรอบตรวจลงการผูกและการเชื่อมต่อ */
async function finishSync(
  syncId: string,
  connectionId: string,
  remoteMetadata: Record<string, unknown>,
  fingerprint: string | null,
): Promise<void> {
  await prisma.googleDriveSync.update({
    where: { id: syncId },
    data: {
      ...remoteMetadata,
      ...(fingerprint ? { lastContentFingerprint: fingerprint } : {}),
      lastCheckedAt: new Date(),
      lastSyncedAt: new Date(),
      lastIssue: null,
      lastErrorCode: null,
    },
  });
  await prisma.googleDriveConnection.update({
    where: { id: connectionId },
    data: { lastSuccessfulSyncAt: new Date() },
  });
}

/** บันทึกกิจกรรมเฉพาะเมื่อมีเวอร์ชันใหม่จริง - รอบที่ไม่เปลี่ยนอะไรไม่ใช่เหตุการณ์ */
async function recordSynced(
  created: StoreResult,
  connection: { id: string; userId: string },
  sync: GoogleDriveSync,
  audit: AuditContext,
): Promise<void> {
  if (!created.versionCreated) return;
  await prisma.activityLog.create({
    data: {
      userId: connection.userId,
      action: 'GOOGLE_DRIVE_SYNCED',
      resourceId: sync.resourceId,
      ipAddress: audit.ipAddress,
      userAgent: audit.userAgent?.slice(0, 500),
      metadata: {
        connectionId: connection.id,
        googleFileId: sync.googleFileId,
        versionNumber: created.versionNumber,
      },
    },
  });
}


/** ผู้ใช้เจ้าของการเชื่อมต่อในรูปแบบที่ท่ออัปโหลดต้องการ */
async function ownerAsAuthUser(userId: string): Promise<AuthUser> {
  const row = await prisma.user.findUnique({
    where: { id: userId },
    include: {
      roles: { include: { role: { include: { permissions: { include: { permission: true } } } } } },
    },
  });
  if (!row) throw new AppError('GOOGLE_DRIVE_OWNER_MISSING', 'ไม่พบเจ้าของการเชื่อมต่อ', 500);

  return {
    id: row.id,
    email: row.email,
    displayName: row.displayName,
    type: row.type,
    status: row.status,
    mustChangePassword: row.mustChangePassword,
    roles: row.roles.map((item) => item.role.code),
    permissions: [
      ...new Set(row.roles.flatMap((item) => item.role.permissions.map((p) => p.permission.code))),
    ],
  };
}

/* ------------------------------------------------------------------ */
/* การกระทำของผู้ใช้                                                     */
/* ------------------------------------------------------------------ */

/** โหลดการผูกของทรัพยากร พร้อมตรวจว่าผู้เรียกมีสิทธิ์กับทรัพยากรนั้นจริง */
async function loadSyncFor(resourceId: string, user: AuthUser): Promise<GoogleDriveSync> {
  const resource = await prisma.resource.findFirst({
    where: { id: resourceId },
    include: resourceInclude,
  });
  if (!resource) throw notFound('RESOURCE_NOT_FOUND', 'ไม่พบทรัพยากร');

  /**
   * สิทธิ์ตัดสินจากทรัพยากรใน NAS ไม่ใช่จากการเป็นเจ้าของการเชื่อมต่อ Google
   *
   * การถือ Google Drive ไม่ได้ให้สิทธิ์อะไรเพิ่มในระบบนี้ และในทางกลับกัน
   * คนที่ดูแลเอกสารใน NAS ต้องสั่งตรวจและหยุดซิงก์ได้แม้จะไม่ใช่เจ้าของการเชื่อมต่อ
   */
  const caps = capabilities(resource, user);
  if (!caps.canView) throw notFound('RESOURCE_NOT_FOUND', 'ไม่พบทรัพยากร');

  const sync = await prisma.googleDriveSync.findFirst({ where: { resourceId } });
  if (!sync) {
    throw notFound('GOOGLE_DRIVE_SYNC_NOT_FOUND', 'ทรัพยากรนี้ไม่ได้เชื่อมกับ Google Drive');
  }
  return sync;
}

/** ปุ่ม "ตรวจสอบตอนนี้" - เส้นทางเดียวกับตัวทำงานเบื้องหลังทุกประการ */
export async function checkNow(
  resourceId: string,
  user: AuthUser,
  provider: GoogleDriveProvider,
  audit: AuditContext,
): Promise<CheckResult> {
  const sync = await loadSyncFor(resourceId, user);
  return checkOne(sync, provider, audit);
}

/**
 * หยุดซิงก์ถาวร
 *
 * **ไม่ลบไฟล์ ไม่ลบเวอร์ชัน ไม่ลบที่มา** ทรัพยากรกลายเป็นเอกสารธรรมดาของ S2 NAS
 * ที่มีบันทึกว่าเคยมาจาก Google - ซึ่งยังเป็นข้อเท็จจริงที่มีค่าต่อการตรวจสอบ
 */
export async function detach(
  resourceId: string,
  user: AuthUser,
  audit: AuditContext,
): Promise<{ detached: true }> {
  const resource = await prisma.resource.findFirst({
    where: { id: resourceId },
    include: resourceInclude,
  });
  if (!resource) throw notFound('RESOURCE_NOT_FOUND', 'ไม่พบทรัพยากร');

  // การหยุดซิงก์เปลี่ยนว่าใครเป็นเจ้าของความจริงของเอกสาร จึงใช้เกณฑ์ของการแก้ไข
  if (!capabilities(resource, user).canEdit) {
    throw new AppError('GOOGLE_DRIVE_DETACH_DENIED', 'ไม่มีสิทธิ์หยุดซิงก์ทรัพยากรนี้', 403);
  }

  const sync = await prisma.googleDriveSync.findFirst({ where: { resourceId } });
  if (!sync) {
    throw notFound('GOOGLE_DRIVE_SYNC_NOT_FOUND', 'ทรัพยากรนี้ไม่ได้เชื่อมกับ Google Drive');
  }

  await prisma.googleDriveSync.update({
    where: { id: sync.id },
    data: { syncEnabled: false, detachedAt: new Date(), mode: 'IMPORT_ONCE' },
  });

  await prisma.activityLog.create({
    data: {
      userId: user.id,
      action: 'GOOGLE_DRIVE_SYNC_DETACHED',
      resourceId,
      ipAddress: audit.ipAddress,
      userAgent: audit.userAgent?.slice(0, 500),
      metadata: { connectionId: sync.connectionId, googleFileId: sync.googleFileId },
    },
  });

  return { detached: true };
}

/* ------------------------------------------------------------------ */
/* ข้อมูลสำหรับหน้าจอ                                                    */
/* ------------------------------------------------------------------ */

export interface ResourceSyncDto {
  id: string;
  status: SyncStatus;
  mode: string;
  remoteName: string | null;
  remoteWebUrl: string | null;
  googleAccountEmail: string;
  lastCheckedAt: string | null;
  lastSyncedAt: string | null;
  message: string | null;
}

export async function resourceSyncInfo(
  resourceId: string,
  user: AuthUser,
): Promise<ResourceSyncDto | null> {
  const resource = await prisma.resource.findFirst({
    where: { id: resourceId },
    include: resourceInclude,
  });
  if (!resource || !capabilities(resource, user).canView) return null;

  const sync = await prisma.googleDriveSync.findFirst({
    where: { resourceId },
    include: { connection: { select: { state: true, googleAccountEmail: true } } },
  });
  if (!sync) return null;

  const pause = await lifecyclePause(resourceId);
  const status = syncStatus(sync, sync.connection.state, pause);

  return {
    id: sync.id,
    status,
    mode: sync.mode,
    remoteName: sync.remoteName,
    /** ลิงก์ไป Google เห็นเฉพาะบุคลากรภายใน - ผู้เรียกผ่าน capabilities มาแล้ว */
    remoteWebUrl: sync.remoteWebUrl,
    googleAccountEmail: sync.connection.googleAccountEmail,
    lastCheckedAt: sync.lastCheckedAt?.toISOString() ?? null,
    lastSyncedAt: sync.lastSyncedAt?.toISOString() ?? null,
    message:
      pause === 'LEGAL_HOLD'
        ? PAUSE_TEXT.LEGAL_HOLD
        : pause
          ? PAUSE_TEXT[pause]
          : sync.lastIssue
            ? OUTCOME_TEXT[sync.lastIssue === 'SOURCE_MISSING' ? 'SOURCE_MISSING' : 'ERROR']
            : null,
  };
}

/**
 * ห้ามอัปโหลดเวอร์ชันด้วยมือทับทรัพยากรที่กำลังซิงก์อยู่
 *
 * ถ้าอนุญาต จะมีสองฝ่ายที่อ้างเป็นเจ้าของความจริงของเอกสารเดียวกัน:
 * คนที่อัปโหลด กับ Google รอบซิงก์ถัดไปจะทับงานที่คนเพิ่งอัปโหลดไปโดยไม่ถามใคร
 * และคนนั้นจะไม่มีทางรู้ว่างานหายไปตอนไหน
 *
 * ทางออกคือให้ผู้ใช้เลือกอย่างชัดเจนว่าจะเลิกให้ Google เป็นต้นทาง (หยุดซิงก์) ก่อน
 */
export async function assertNotGoogleSynced(resourceId: string): Promise<void> {
  const sync = await prisma.googleDriveSync.findFirst({
    where: { resourceId, syncEnabled: true, detachedAt: null, mode: 'SYNCED' },
    select: { id: true },
  });
  if (sync) {
    throw new AppError(
      'GOOGLE_DRIVE_SYNC_ACTIVE',
      'ทรัพยากรนี้กำลังซิงก์จาก Google Drive - ต้องหยุดซิงก์ก่อนจึงจะอัปโหลดเวอร์ชันเองได้',
      409,
    );
  }
}

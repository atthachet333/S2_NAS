import type { GoogleDriveConnection } from '@prisma/client';
import { prisma } from '../../../core/prisma.js';
import { AppError } from '../../../core/errors.js';
import { logger } from '../../../core/logger.js';
import { uploadFile } from '../../files/file.service.js';
import { createFolder } from '../../resources/resource.service.js';
import type { AuthUser } from '../../auth/auth.service.js';
import type { AuditContext } from '../../workspace/workspace.service.js';
import { accessTokenFor } from './connection.service.js';
import { DriveError } from './google-api.js';
import {
  importedFileName,
  type DriveEntry,
  type DriveDownload,
  type GoogleDriveProvider,
} from './provider.js';

/**
 * การนำเข้าจาก Google Drive (F19)
 *
 * ทุกไฟล์เดินผ่าน `uploadFile` เดิมของระบบ **ไม่มีเส้นทางลัดที่เขียนลงพื้นที่จัดเก็บเอง**
 *
 * ผลที่ได้มาฟรีจากการไม่ลัด: การตรวจชนิดไฟล์จากลายเซ็นจริง เพดานขนาด การคำนวณ
 * checksum การเข้าคิวสกัดข้อความ การตรวจสิทธิ์ปลายทาง และการบันทึกกิจกรรม
 * ถ้าเขียนเส้นทางที่สอง ทุกอย่างข้างต้นต้องทำซ้ำ และจะมีข้อใดข้อหนึ่งถูกลืมเสมอ
 */

export type ImportMode = 'IMPORT_ONCE' | 'SYNCED';

export interface ImportRequest {
  fileIds: string[];
  destinationParentId: string | null;
  mode: ImportMode;
  /** ใช้เฉพาะการนำเข้าที่ระดับราก - ในโฟลเดอร์ยึดไดร์ฟของโฟลเดอร์แม่เสมอ */
  driveScope?: 'MY_DRIVE' | 'SYSTEM_DRIVE';
}

export type ImportOutcome = 'IMPORTED' | 'SKIPPED' | 'FAILED';

export interface ImportItemResult {
  googleFileId: string;
  name: string;
  outcome: ImportOutcome;
  resourceId?: string;
  /** เหตุผลที่ปลอดภัยต่อการแสดง - ไม่ใช่ข้อความดิบจาก Google */
  reason?: string;
}

export interface ImportSummary {
  imported: number;
  skipped: number;
  failed: number;
  items: ImportItemResult[];
}

/**
 * จำนวนไฟล์ที่ดาวน์โหลดพร้อมกัน
 *
 * ไม่มาก เพราะแต่ละไฟล์กินทั้งแบนด์วิดท์ ดิสก์ และโควตาของ Google พร้อมกัน
 * การยิงพร้อมกันสิบไฟล์ทำให้ทั้งชุดช้าลงและมีโอกาสโดนจำกัดอัตรามากขึ้น
 */
const IMPORT_CONCURRENCY = 2;

/** เพดานจำนวนไฟล์ต่อหนึ่งคำขอ - งานใหญ่กว่านี้ควรแบ่งเป็นหลายรอบ */
const MAX_ITEMS_PER_REQUEST = 100;

/** ความลึกสูงสุดของโครงสร้างโฟลเดอร์ที่ยอมไล่ตาม - กันโครงสร้างที่ลึกผิดปกติ */
const MAX_FOLDER_DEPTH = 10;

/* ------------------------------------------------------------------ */
/* การแปลงข้อผิดพลาด                                                    */
/* ------------------------------------------------------------------ */

/**
 * เหตุผลที่ผู้ใช้อ่านแล้วรู้ว่าต้องทำอะไรต่อ
 *
 * ไม่ส่งข้อความดิบของ Google ต่อ - อาจมีรายละเอียดภายในปนอยู่ และผู้ใช้อ่านไม่รู้เรื่องอยู่ดี
 */
function safeReason(error: unknown): string {
  if (error instanceof DriveError) {
    switch (error.kind) {
      case 'NOT_FOUND':
        return 'ไม่พบไฟล์ใน Google Drive';
      case 'PERMISSION_DENIED':
        return 'บัญชีที่เชื่อมต่อไม่มีสิทธิ์เข้าถึงไฟล์นี้';
      case 'AUTH_REQUIRED':
        return 'ต้องเชื่อมต่อ Google Drive ใหม่';
      case 'UNSUPPORTED':
        return 'ไฟล์ชนิดนี้ยังนำเข้าไม่ได้';
      case 'QUOTA':
        return 'ใช้โควตา Google Drive เกินกำหนด กรุณาลองใหม่ภายหลัง';
      default:
        return 'ติดต่อ Google Drive ไม่สำเร็จ';
    }
  }
  if (error instanceof AppError) {
    // ข้อผิดพลาดของเราเองปลอดภัยที่จะแสดง - เขียนขึ้นเพื่อให้คนอ่านอยู่แล้ว
    return error.message;
  }
  return 'นำเข้าไม่สำเร็จ';
}

/* ------------------------------------------------------------------ */
/* การดึงเนื้อหา                                                        */
/* ------------------------------------------------------------------ */

/**
 * ดึงเนื้อหาของรายการหนึ่งจาก Google
 *
 * ไฟล์ของ Google เอง (Docs/Sheets/Slides) ต้อง "ส่งออก" ไม่ใช่ "ดาวน์โหลด"
 * การเรียกดาวน์โหลดกับไฟล์เหล่านั้นจะได้ข้อผิดพลาด ไม่ใช่ไบต์ของเอกสาร
 */
export async function fetchContent(
  provider: GoogleDriveProvider,
  accessToken: string,
  entry: DriveEntry,
): Promise<DriveDownload> {
  switch (entry.kind) {
    case 'GOOGLE_DOC':
    case 'GOOGLE_SHEET':
    case 'GOOGLE_SLIDES':
      return provider.exportGoogleFile(accessToken, entry);
    case 'BINARY':
      return provider.downloadFile(accessToken, entry);
    default:
      throw new DriveError('UNSUPPORTED', 'ไฟล์ชนิดนี้ยังนำเข้าไม่ได้', 400);
  }
}

/**
 * คลี่ทางลัดของ Google ให้เป็นไฟล์จริง
 *
 * ทางลัดไม่มีเนื้อหาของตัวเอง มีแต่ตัวชี้ไปที่ไฟล์อื่น การนำเข้าโดยไม่คลี่จะได้
 * ไฟล์ขนาดไม่กี่ไบต์ที่ข้างในเป็นเมทาดาทา ซึ่งผู้ใช้จะเปิดแล้วพบว่าเอกสารหายไป
 */
async function resolveShortcut(
  provider: GoogleDriveProvider,
  accessToken: string,
  entry: DriveEntry,
): Promise<DriveEntry> {
  if (entry.kind !== 'SHORTCUT') return entry;
  if (!entry.shortcutTargetId) {
    throw new DriveError('UNSUPPORTED', 'ทางลัดนี้ไม่มีปลายทางที่ใช้ได้', 400);
  }

  const target = await provider.getFileMetadata(accessToken, entry.shortcutTargetId);
  // ทางลัดที่ชี้ไปทางลัดอีกทีไม่ใช่รูปแบบที่ควรไล่ตามต่อไปเรื่อย ๆ
  if (target.kind === 'SHORTCUT') {
    throw new DriveError('UNSUPPORTED', 'ทางลัดซ้อนทางลัดยังไม่รองรับ', 400);
  }
  return target;
}

/* ------------------------------------------------------------------ */
/* การนำเข้าไฟล์เดียว                                                    */
/* ------------------------------------------------------------------ */

async function importOne(
  user: AuthUser,
  connection: GoogleDriveConnection,
  provider: GoogleDriveProvider,
  accessToken: string,
  entry: DriveEntry,
  parentId: string | null,
  mode: ImportMode,
  driveScope: ImportRequest['driveScope'],
  audit: AuditContext,
): Promise<ImportItemResult> {
  const base: Pick<ImportItemResult, 'googleFileId' | 'name'> = {
    googleFileId: entry.id,
    name: entry.name,
  };

  try {
    const target = await resolveShortcut(provider, accessToken, entry);

    /**
     * การผูกซ้ำในโหมดซิงก์
     *
     * ไฟล์ Google หนึ่งไฟล์ผูกกับทรัพยากรได้ครั้งเดียวต่อการเชื่อมต่อหนึ่งอัน
     * ถ้าปล่อยให้ผูกซ้ำ จะมีสองทรัพยากรที่ซิงก์จากต้นทางเดียวกัน แล้วผู้ใช้
     * จะไม่รู้ว่าฉบับไหนคือฉบับที่ควรใช้ ทั้งที่ทั้งคู่ "ถูกต้อง" เท่ากัน
     *
     * โหมดคัดลอกครั้งเดียวไม่มีปัญหานี้ เพราะสำเนาเป็นอิสระตั้งแต่วินาทีแรก
     */
    if (mode === 'SYNCED') {
      const existing = await prisma.googleDriveSync.findUnique({
        where: {
          connectionId_googleFileId: { connectionId: connection.id, googleFileId: target.id },
        },
        select: { resourceId: true, detachedAt: true },
      });
      if (existing && !existing.detachedAt) {
        return {
          ...base,
          outcome: 'SKIPPED',
          resourceId: existing.resourceId,
          reason: 'ไฟล์นี้ถูกนำเข้าและซิงก์อยู่แล้ว',
        };
      }
    }

    const content = await fetchContent(provider, accessToken, target);
    const fileName = importedFileName(target);

    /**
     * เดินผ่านท่ออัปโหลดเดิมทั้งเส้น
     *
     * สตรีมจาก Google ต่อตรงเข้า stageUpload ซึ่งเขียนลงไฟล์ชั่วคราวพร้อมนับขนาด
     * ไฟล์ที่เกินเพดานถูกตัดระหว่างทาง ไม่ใช่หลังจากเขียนจนเต็มดิสก์ไปแล้ว
     *
     * `declaredMime` เป็นเพียงคำใบ้ - ตัวตรวจยังอ่านลายเซ็นจริงของไบต์อยู่ดี
     */
    const uploaded = await uploadFile(
      user,
      content.stream,
      {
        parentId,
        fileName,
        declaredMime: content.mimeType,
        ...(parentId ? {} : driveScope ? { driveScope } : {}),
        /** ที่มาใช้ฟิลด์เดิมของระบบ ไม่สร้างระบบที่มาชุดที่สอง */
        sourceType: 'GOOGLE',
        sourceSystem: 'GOOGLE_DRIVE',
        sourceEntityType: target.mimeType,
        sourceEntityId: target.id,
        sourceUrl: target.webViewLink,
        /** ไฟล์คนละไฟล์ใน Google ที่เนื้อหาเหมือนกันเป็นเรื่องปกติ ไม่ต้องถามซ้ำ */
        allowDuplicateContent: true,
      },
      audit,
    );

    const resourceId = uploaded.resource.id;

    if (mode === 'SYNCED') {
      await prisma.googleDriveSync.upsert({
        where: {
          connectionId_googleFileId: { connectionId: connection.id, googleFileId: target.id },
        },
        create: {
          connectionId: connection.id,
          resourceId,
          googleFileId: target.id,
          mode: 'SYNCED',
          remoteName: target.name.slice(0, 191),
          remoteMimeType: target.mimeType.slice(0, 191),
          remoteWebUrl: target.webViewLink,
          lastRemoteModifiedTime: target.modifiedTime,
          lastRemoteVersion: target.version?.slice(0, 64) ?? null,
          lastCheckedAt: new Date(),
          lastSyncedAt: new Date(),
          syncEnabled: true,
        },
        update: {
          resourceId,
          mode: 'SYNCED',
          remoteName: target.name.slice(0, 191),
          remoteMimeType: target.mimeType.slice(0, 191),
          remoteWebUrl: target.webViewLink,
          lastRemoteModifiedTime: target.modifiedTime,
          lastRemoteVersion: target.version?.slice(0, 64) ?? null,
          lastCheckedAt: new Date(),
          lastSyncedAt: new Date(),
          syncEnabled: true,
          detachedAt: null,
          lastIssue: null,
          lastErrorCode: null,
        },
      });
    }

    await prisma.activityLog.create({
      data: {
        userId: user.id,
        action: 'GOOGLE_DRIVE_IMPORTED',
        resourceId,
        ipAddress: audit.ipAddress,
        userAgent: audit.userAgent?.slice(0, 500),
        metadata: {
          connectionId: connection.id,
          googleFileId: target.id,
          mode,
          remoteMimeType: target.mimeType,
          exported: target.kind !== 'BINARY',
        },
      },
    });

    return { ...base, name: fileName, outcome: 'IMPORTED', resourceId };
  } catch (error) {
    await prisma.activityLog
      .create({
        data: {
          userId: user.id,
          action: 'GOOGLE_DRIVE_IMPORT_FAILED',
          ipAddress: audit.ipAddress,
          userAgent: audit.userAgent?.slice(0, 500),
          metadata: {
            connectionId: connection.id,
            googleFileId: entry.id,
            errorCode: error instanceof AppError ? error.code : 'UNKNOWN',
          },
        },
      })
      .catch(() => {
        /* การบันทึกล้มเหลวต้องไม่กลบข้อผิดพลาดตัวจริง */
      });

    /** บันทึกเฉพาะรหัสข้อผิดพลาด ไม่ใช่ข้อความดิบซึ่งอาจมีรายละเอียดของ Google ปนมา */
    logger.warn(
      `[DRIVE] นำเข้า ${entry.id} ไม่สำเร็จ: ${error instanceof AppError ? error.code : 'UNKNOWN'}`,
    );
    return { ...base, outcome: 'FAILED', reason: safeReason(error) };
  }
}

/* ------------------------------------------------------------------ */
/* โฟลเดอร์                                                            */
/* ------------------------------------------------------------------ */

/**
 * สร้างโครงสร้างโฟลเดอร์ตามที่เลือก แล้วคืนรายการไฟล์ที่ต้องนำเข้า
 *
 * ใช้ `createFolder` เดิม จึงได้การตรวจชื่อ การกันชื่อซ้ำ การสืบทอดไดร์ฟ
 * และการตรวจสิทธิ์ปลายทางมาครบโดยไม่ต้องเขียนใหม่
 */
async function planFolder(
  user: AuthUser,
  provider: GoogleDriveProvider,
  accessToken: string,
  folder: DriveEntry,
  parentId: string | null,
  audit: AuditContext,
  depth: number,
  collected: Array<{ entry: DriveEntry; parentId: string }>,
): Promise<void> {
  if (depth > MAX_FOLDER_DEPTH) return;

  const created = await createFolder(user, { name: folder.name, parentId }, audit);

  let pageToken: string | undefined;
  do {
    const page = await provider.listFiles(accessToken, {
      folderId: folder.id,
      pageToken,
      pageSize: 200,
    });

    for (const child of page.items) {
      if (child.kind === 'FOLDER') {
        await planFolder(user, provider, accessToken, child, created.id, audit, depth + 1, collected);
      } else if (child.kind !== 'UNSUPPORTED') {
        collected.push({ entry: child, parentId: created.id });
      }
    }
    pageToken = page.nextPageToken ?? undefined;
  } while (pageToken);
}

/* ------------------------------------------------------------------ */
/* จุดเข้าใช้งาน                                                        */
/* ------------------------------------------------------------------ */

export async function importFromDrive(
  user: AuthUser,
  connection: GoogleDriveConnection,
  provider: GoogleDriveProvider,
  request: ImportRequest,
  audit: AuditContext,
): Promise<ImportSummary> {
  if (request.fileIds.length === 0) {
    throw new AppError('GOOGLE_DRIVE_NO_SELECTION', 'ยังไม่ได้เลือกไฟล์ที่จะนำเข้า', 400);
  }
  if (request.fileIds.length > MAX_ITEMS_PER_REQUEST) {
    throw new AppError(
      'GOOGLE_DRIVE_TOO_MANY',
      `นำเข้าได้ครั้งละไม่เกิน ${MAX_ITEMS_PER_REQUEST} รายการ`,
      400,
    );
  }

  const accessToken = await accessTokenFor(connection, provider);

  await prisma.activityLog.create({
    data: {
      userId: user.id,
      action: 'GOOGLE_DRIVE_IMPORT_STARTED',
      ipAddress: audit.ipAddress,
      userAgent: audit.userAgent?.slice(0, 500),
      metadata: {
        connectionId: connection.id,
        itemCount: request.fileIds.length,
        mode: request.mode,
      },
    },
  });

  /* ---- ขั้นวางแผน: คลี่โฟลเดอร์ให้เป็นรายการไฟล์ก่อนเริ่มโหลด ---- */
  const queue: Array<{ entry: DriveEntry; parentId: string | null }> = [];
  const results: ImportItemResult[] = [];

  for (const fileId of request.fileIds) {
    try {
      const entry = await provider.getFileMetadata(accessToken, fileId);

      if (entry.kind === 'FOLDER') {
        const nested: Array<{ entry: DriveEntry; parentId: string }> = [];
        await planFolder(
          user,
          provider,
          accessToken,
          entry,
          request.destinationParentId,
          audit,
          0,
          nested,
        );
        queue.push(...nested);
      } else if (entry.kind === 'UNSUPPORTED') {
        results.push({
          googleFileId: entry.id,
          name: entry.name,
          outcome: 'SKIPPED',
          reason: 'ไฟล์ชนิดนี้ของ Google ยังนำเข้าไม่ได้',
        });
      } else {
        queue.push({ entry, parentId: request.destinationParentId });
      }
    } catch (error) {
      results.push({
        googleFileId: fileId,
        name: fileId,
        outcome: 'FAILED',
        reason: safeReason(error),
      });
    }
  }

  /* ---- ขั้นโหลด: หลายตัวพร้อมกันแต่มีเพดาน ---- */
  let cursor = 0;
  const workers = Array.from({ length: Math.min(IMPORT_CONCURRENCY, queue.length) }, async () => {
    for (;;) {
      const index = cursor++;
      const job = queue[index];
      if (!job) return;

      results.push(
        await importOne(
          user,
          connection,
          provider,
          accessToken,
          job.entry,
          job.parentId,
          request.mode,
          request.driveScope,
          audit,
        ),
      );
    }
  });
  await Promise.all(workers);

  const summary: ImportSummary = {
    imported: results.filter((item) => item.outcome === 'IMPORTED').length,
    skipped: results.filter((item) => item.outcome === 'SKIPPED').length,
    failed: results.filter((item) => item.outcome === 'FAILED').length,
    items: results,
  };

  if (summary.imported > 0) {
    await prisma.googleDriveConnection.update({
      where: { id: connection.id },
      data: { lastSuccessfulSyncAt: new Date() },
    });
  }

  logger.info(
    `[DRIVE] นำเข้า ${summary.imported} สำเร็จ · ข้าม ${summary.skipped} · ล้มเหลว ${summary.failed}`,
  );
  return summary;
}

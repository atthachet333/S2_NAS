import crypto from 'node:crypto';
import type { GoogleDriveConnection } from '@prisma/client';
import { prisma } from '../../../core/prisma.js';
import { AppError, notFound } from '../../../core/errors.js';
import { logger } from '../../../core/logger.js';
import { credentialCipher, credentialCipherReady, secretEquals } from '../integration-crypto.js';
import type { AuthUser } from '../../auth/auth.service.js';
import type { AuditContext } from '../../workspace/workspace.service.js';
import { DriveError, isDriveConfigured } from './google-api.js';
import type { GoogleDriveProvider, GoogleTokens } from './provider.js';

/**
 * การเชื่อมต่อบัญชี Google Drive (F19)
 *
 * ถือกุญแจที่อ่านไฟล์ทั้งหมดใน Drive ของผู้ใช้ได้เป็นเวลาหลายเดือน
 * ทุกอย่างในไฟล์นี้จึงเขียนโดยตั้งสมมติฐานว่าฐานข้อมูลอาจรั่ววันหนึ่ง
 */

/** อายุของ state - สั้นพอที่ลิงก์ค้างจะใช้ไม่ได้ แต่พอให้ผู้ใช้ยินยอมที่ Google ทัน */
const STATE_TTL_MS = 10 * 60 * 1000;

/** ต่ออายุ access token ก่อนหมดจริงเล็กน้อย เผื่อเวลาเดินทางของคำขอ */
const REFRESH_SKEW_MS = 60 * 1000;

/* ------------------------------------------------------------------ */
/* state ของ OAuth                                                     */
/* ------------------------------------------------------------------ */

interface PendingConnect {
  userId: string;
  codeVerifier: string;
  createdAt: number;
}

/**
 * คำขอเชื่อมต่อที่ยังไม่จบ
 *
 * เก็บในหน่วยความจำเพราะอายุสั้นและใช้ครั้งเดียว - เหมือนกับที่การเข้าสู่ระบบด้วย
 * Google ทำอยู่แล้ว การรีสตาร์ทระหว่างทางแปลว่าต้องกดเชื่อมต่อใหม่ ซึ่งปลอดภัยกว่า
 * การเก็บ state ที่ผูกกับสิทธิ์ระดับนี้ไว้ในที่ที่อยู่ได้นาน
 */
const pending = new Map<string, PendingConnect>();

function sweep(now: number): void {
  for (const [key, entry] of pending) {
    if (now - entry.createdAt > STATE_TTL_MS) pending.delete(key);
  }
}

export function resetPendingConnects(): void {
  pending.clear();
}

/**
 * ผูก state กับผู้ใช้ที่กดเชื่อมต่อ
 *
 * ถ้า state ไม่ผูกกับผู้ใช้ ผู้โจมตีสามารถหลอกให้เหยื่อเปิด callback ที่มี code
 * ของบัญชี Google ของผู้โจมตี แล้วบัญชีนั้นจะไปผูกกับผู้ใช้เหยื่อแทน
 */
export function beginConnect(
  user: AuthUser,
  provider: GoogleDriveProvider,
  options: { forceConsent?: boolean } = {},
  now: number = Date.now(),
): { url: string; state: string } {
  assertCanConnect(user);
  sweep(now);

  const state = crypto.randomBytes(32).toString('base64url');
  const codeVerifier = crypto.randomBytes(64).toString('base64url');
  const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');

  pending.set(state, { userId: user.id, codeVerifier, createdAt: now });

  return {
    url: provider.getAuthorizationUrl({
      state,
      codeChallenge,
      forceConsent: options.forceConsent ?? false,
    }),
    state,
  };
}

/**
 * ใช้ state หนึ่งครั้งแล้วทิ้ง
 *
 * state ที่ใช้ซ้ำได้เปิดช่องให้เล่นซ้ำคำขอเดิม จึงลบทันทีที่หยิบออกมา
 * ไม่ว่าขั้นตอนที่เหลือจะสำเร็จหรือไม่
 */
export function consumeState(state: string | undefined, now: number = Date.now()): PendingConnect {
  if (!state) throw new AppError('GOOGLE_DRIVE_STATE_INVALID', 'คำขอเชื่อมต่อไม่ถูกต้อง', 400);

  // เทียบแบบไม่ให้เวลาบอกใบ้ แม้ Map จะหาแบบตรงตัวก็ตาม - กันการไล่เดาทีละอักขระ
  const key = [...pending.keys()].find((candidate) => secretEquals(candidate, state));
  const entry = key ? pending.get(key) : undefined;
  if (key) pending.delete(key);

  if (!entry) {
    throw new AppError('GOOGLE_DRIVE_STATE_INVALID', 'คำขอเชื่อมต่อไม่ถูกต้องหรือถูกใช้ไปแล้ว', 400);
  }
  if (now - entry.createdAt > STATE_TTL_MS) {
    throw new AppError('GOOGLE_DRIVE_STATE_EXPIRED', 'คำขอเชื่อมต่อหมดอายุ กรุณาลองใหม่', 400);
  }
  return entry;
}

/* ------------------------------------------------------------------ */
/* สิทธิ์                                                              */
/* ------------------------------------------------------------------ */

/**
 * ใครเชื่อมต่อ Google Drive ได้
 *
 * เฉพาะบุคลากรภายในที่ยังใช้งานอยู่ - บัญชีลูกค้าและบัญชีบริการเชื่อมต่อไม่ได้เลย
 *
 * บัญชีลูกค้าไม่มีที่ยืนในพื้นที่ทำงานภายในตั้งแต่ต้น ส่วนบัญชีบริการเป็นของระบบ
 * ไม่ใช่ของมนุษย์ จึงไม่มี "Google Drive ของตัวเอง" ให้เชื่อม
 */
export function assertCanConnect(user: AuthUser): void {
  if (user.type !== 'INTERNAL') {
    throw new AppError(
      'GOOGLE_DRIVE_CONNECT_DENIED',
      'เฉพาะบุคลากรภายในเท่านั้นที่เชื่อมต่อ Google Drive ได้',
      403,
    );
  }
}

/**
 * ระบบพร้อมให้เชื่อมต่อหรือไม่ - แยกจากคำถามว่าผู้ใช้คนนี้มีสิทธิ์หรือไม่
 *
 * สองเรื่องนี้ล้มเหลวด้วยเหตุผลคนละอย่างและแก้ด้วยวิธีคนละอย่าง:
 * เรื่องหนึ่งผู้ดูแลระบบต้องไปตั้งค่า อีกเรื่องผู้ใช้ต้องใช้บัญชีอื่น
 * การรวมไว้ในฟังก์ชันเดียวทำให้ข้อความที่ผู้ใช้เห็นชี้ไปผิดทาง
 */
export function assertDriveAvailable(): void {
  if (!isDriveConfigured()) {
    throw new AppError('GOOGLE_DRIVE_NOT_CONFIGURED', 'ยังไม่ได้ตั้งค่าการเชื่อมต่อ Google Drive', 503);
  }
  if (!credentialCipherReady()) {
    throw new AppError(
      'INTEGRATION_ENCRYPTION_UNAVAILABLE',
      'ยังไม่ได้ตั้งค่ากุญแจเข้ารหัสข้อมูลรับรอง จึงเชื่อมต่อ Google Drive ไม่ได้',
      503,
    );
  }
}

/**
 * การเชื่อมต่อเป็นของเจ้าของเท่านั้น
 *
 * **ผู้ดูแลระบบก็เข้าไม่ได้** ผู้ดูแลดูสถานะสุขภาพของการเชื่อมต่อได้ แต่ใช้
 * Drive ของคนอื่นไม่ได้ - นั่นคือการสวมรอย ไม่ใช่การดูแลระบบ
 * และเป็นสิ่งที่พนักงานคนนั้นไม่ได้ยินยอมตอนกดเชื่อมต่อ
 */
async function loadOwnConnection(id: string, user: AuthUser): Promise<GoogleDriveConnection> {
  const connection = await prisma.googleDriveConnection.findUnique({ where: { id } });
  // "ไม่พบ" ไม่ใช่ "ไม่มีสิทธิ์" - ผู้เรียกจึงเดาไม่ได้ว่ามีการเชื่อมต่อนั้นอยู่จริงหรือไม่
  if (!connection || connection.userId !== user.id) {
    throw notFound('GOOGLE_DRIVE_CONNECTION_NOT_FOUND', 'ไม่พบการเชื่อมต่อ Google Drive');
  }
  return connection;
}

/* ------------------------------------------------------------------ */
/* การสร้างและต่ออายุ                                                    */
/* ------------------------------------------------------------------ */

export interface ConnectionDto {
  id: string;
  googleAccountEmail: string;
  state: string;
  connectedAt: string;
  lastSuccessfulSyncAt: string | null;
  lastErrorCode: string | null;
  scope: string | null;
  /** ซิงก์ระยะยาวได้หรือไม่ - ขึ้นกับว่ามี refresh token หรือเปล่า */
  syncCapable: boolean;
  syncCount: number;
}

/**
 * แปลงเป็นข้อมูลที่ส่งออกได้
 *
 * **ไม่มีฟิลด์ token ใด ๆ อยู่ในผลลัพธ์นี้** หน้าจอต้องการรู้แค่ว่าเชื่อมต่ออยู่กับ
 * บัญชีไหนและสถานะเป็นอย่างไร ไม่มีเหตุผลใดที่ค่าลับจะออกจากเซิร์ฟเวอร์
 */
export function toConnectionDto(
  connection: GoogleDriveConnection,
  syncCount = 0,
): ConnectionDto {
  return {
    id: connection.id,
    googleAccountEmail: connection.googleAccountEmail,
    state: connection.state,
    connectedAt: connection.connectedAt.toISOString(),
    lastSuccessfulSyncAt: connection.lastSuccessfulSyncAt?.toISOString() ?? null,
    lastErrorCode: connection.lastErrorCode,
    scope: connection.scope,
    syncCapable: connection.refreshTokenEncrypted !== null,
    syncCount,
  };
}

export async function completeConnect(
  userId: string,
  tokens: GoogleTokens,
  account: { subject: string; email: string },
  audit: AuditContext,
): Promise<GoogleDriveConnection> {
  const cipher = credentialCipher();

  const existing = await prisma.googleDriveConnection.findUnique({
    where: { userId_providerSubject: { userId, providerSubject: account.subject } },
  });

  /**
   * Google ไม่คืน refresh token ทุกครั้ง
   *
   * จะคืนเฉพาะตอนยินยอมครั้งแรก หรือเมื่อขอ prompt=consent เท่านั้น
   * เมื่อเชื่อมต่อซ้ำโดยไม่บังคับ consent เราจึงต้องเก็บของเดิมไว้
   * ถ้าเขียนทับด้วย null การซิงก์จะตายเงียบ ๆ เมื่อ access token หมดอายุในหนึ่งชั่วโมง
   */
  const refreshTokenEncrypted = tokens.refreshToken
    ? cipher.encrypt(tokens.refreshToken)
    : (existing?.refreshTokenEncrypted ?? null);

  const data = {
    googleAccountEmail: account.email,
    accessTokenEncrypted: cipher.encrypt(tokens.accessToken),
    refreshTokenEncrypted,
    tokenExpiresAt: tokens.expiresAt,
    scope: tokens.scope.slice(0, 500),
    state: 'ACTIVE' as const,
    lastErrorCode: null,
    revokedAt: null,
  };

  const connection = existing
    ? await prisma.googleDriveConnection.update({ where: { id: existing.id }, data })
    : await prisma.googleDriveConnection.create({
        data: { userId, providerSubject: account.subject, ...data },
      });

  await prisma.activityLog.create({
    data: {
      userId,
      action: 'GOOGLE_DRIVE_CONNECTED',
      ipAddress: audit.ipAddress,
      userAgent: audit.userAgent?.slice(0, 500),
      metadata: {
        connectionId: connection.id,
        reconnected: existing !== null,
        syncCapable: refreshTokenEncrypted !== null,
      },
    },
  });

  // บันทึกอีเมลได้ - เป็นข้อมูลระบุตัวตนที่ผู้ใช้เห็นอยู่แล้ว ส่วน token ไม่มีทางถูกบันทึก
  logger.info(`[DRIVE] เชื่อมต่อ Google Drive ของ ${account.email} แล้ว`);
  return connection;
}

/**
 * คืน access token ที่ใช้งานได้ ต่ออายุให้เองเมื่อจำเป็น
 *
 * **ค่าที่คืนไม่เคยเดินทางไปถึงเบราว์เซอร์** ใช้ภายในเซิร์ฟเวอร์เท่านั้น
 */
export async function accessTokenFor(
  connection: GoogleDriveConnection,
  provider: GoogleDriveProvider,
  now: Date = new Date(),
): Promise<string> {
  if (connection.state === 'DISCONNECTED') {
    throw new AppError('GOOGLE_DRIVE_DISCONNECTED', 'การเชื่อมต่อ Google Drive ถูกยกเลิกแล้ว', 409);
  }

  const cipher = credentialCipher();

  const stillValid =
    connection.accessTokenEncrypted &&
    connection.tokenExpiresAt &&
    connection.tokenExpiresAt.getTime() - REFRESH_SKEW_MS > now.getTime();

  if (stillValid) {
    try {
      return cipher.decrypt(connection.accessTokenEncrypted!);
    } catch {
      // กุญแจเปลี่ยนหรือไบต์เสีย - ตกไปที่เส้นทางต่ออายุ ซึ่งจะจัดการสถานะให้ถูกต้อง
      await markUnreadable(connection.id);
      throw new AppError('CREDENTIAL_UNREADABLE', 'ข้อมูลรับรองอ่านไม่ได้ ต้องเชื่อมต่อใหม่', 409);
    }
  }

  if (!connection.refreshTokenEncrypted) {
    await markReauthRequired(connection.id, 'NO_REFRESH_TOKEN');
    throw new AppError('GOOGLE_DRIVE_REAUTH_REQUIRED', 'ต้องเชื่อมต่อ Google Drive ใหม่', 409);
  }

  let refreshToken: string;
  try {
    refreshToken = cipher.decrypt(connection.refreshTokenEncrypted);
  } catch {
    /**
     * ถอดรหัสไม่ได้ = กุญแจหายหรือเปลี่ยน
     *
     * **ไม่ลบข้อมูลรับรองและไม่ลบไฟล์ใด ๆ** เพราะกุญแจอาจกลับมาได้
     * ถ้าลบทิ้งตอนนี้ การกู้กุญแจคืนในภายหลังจะไม่ช่วยอะไรอีกต่อไป
     */
    await markUnreadable(connection.id);
    throw new AppError('CREDENTIAL_UNREADABLE', 'ข้อมูลรับรองอ่านไม่ได้ ต้องเชื่อมต่อใหม่', 409);
  }

  let tokens: GoogleTokens;
  try {
    tokens = await provider.refreshAccessToken(refreshToken);
  } catch (error) {
    if (error instanceof DriveError && error.kind === 'AUTH_REQUIRED') {
      await markReauthRequired(connection.id, 'REFRESH_REJECTED');
      throw new AppError('GOOGLE_DRIVE_REAUTH_REQUIRED', 'ต้องเชื่อมต่อ Google Drive ใหม่', 409);
    }
    throw error;
  }

  await prisma.googleDriveConnection.update({
    where: { id: connection.id },
    data: {
      accessTokenEncrypted: cipher.encrypt(tokens.accessToken),
      tokenExpiresAt: tokens.expiresAt,
      state: 'ACTIVE',
      lastErrorCode: null,
    },
  });

  return tokens.accessToken;
}

async function markReauthRequired(connectionId: string, code: string): Promise<void> {
  const connection = await prisma.googleDriveConnection.update({
    where: { id: connectionId },
    data: { state: 'REAUTH_REQUIRED', lastErrorCode: code },
  });

  await prisma.activityLog.create({
    data: {
      userId: connection.userId,
      action: 'GOOGLE_DRIVE_REAUTH_REQUIRED',
      metadata: { connectionId, errorCode: code },
    },
  });
}

async function markUnreadable(connectionId: string): Promise<void> {
  await prisma.googleDriveConnection.update({
    where: { id: connectionId },
    data: { state: 'CREDENTIAL_UNREADABLE', lastErrorCode: 'CREDENTIAL_UNREADABLE' },
  });
}

/* ------------------------------------------------------------------ */
/* การอ่านสถานะ                                                        */
/* ------------------------------------------------------------------ */

/** การเชื่อมต่อที่ยังใช้งานได้ของผู้ใช้คนหนึ่ง */
export async function activeConnectionFor(userId: string): Promise<GoogleDriveConnection | null> {
  return prisma.googleDriveConnection.findFirst({
    where: { userId, state: { not: 'DISCONNECTED' } },
    orderBy: { connectedAt: 'desc' },
  });
}

export async function connectionStatus(user: AuthUser): Promise<{
  configured: boolean;
  encryptionReady: boolean;
  connection: ConnectionDto | null;
}> {
  const base = {
    configured: isDriveConfigured(),
    encryptionReady: credentialCipherReady(),
  };

  // บัญชีที่เชื่อมต่อไม่ได้ก็ไม่ต้องรู้ว่ามีใครเชื่อมต่ออยู่บ้าง
  if (user.type !== 'INTERNAL') return { ...base, connection: null };

  const connection = await activeConnectionFor(user.id);
  if (!connection) return { ...base, connection: null };

  const syncCount = await prisma.googleDriveSync.count({
    where: { connectionId: connection.id, detachedAt: null },
  });
  return { ...base, connection: toConnectionDto(connection, syncCount) };
}

/* ------------------------------------------------------------------ */
/* การตัดการเชื่อมต่อ                                                    */
/* ------------------------------------------------------------------ */

/**
 * ตัดการเชื่อมต่อ
 *
 * **ไม่ลบไฟล์ใน NAS แม้แต่ไฟล์เดียว** ไฟล์ที่นำเข้ามาแล้วเป็นของ S2 NAS
 * ไม่ใช่ของ Google การเลิกเชื่อมต่อบัญชีคือการเลิกอ่านต้นทาง ไม่ใช่การคืนของ
 *
 * ประวัติเวอร์ชัน ที่มา และการผูกกับไฟล์ Google ยังอยู่ครบเพื่อการตรวจสอบ
 * เพียงแต่หยุดทำงาน
 */
export async function disconnect(
  connectionId: string,
  user: AuthUser,
  provider: GoogleDriveProvider,
  audit: AuditContext,
): Promise<{ preservedResources: number }> {
  const connection = await loadOwnConnection(connectionId, user);

  /**
   * พยายามเพิกถอนที่ฝั่ง Google ก่อน แต่ไม่ให้ผลของมันมาขวาง
   *
   * ถ้าเน็ตล่มหรือ Google ปฏิเสธ ผู้ใช้ก็ยังต้องตัดการเชื่อมต่อได้
   * สิ่งที่ควบคุมได้จริงคือข้อมูลรับรองฝั่งเรา และมันจะถูกลบแน่นอน
   */
  if (connection.refreshTokenEncrypted) {
    try {
      const cipher = credentialCipher();
      await provider.revokeToken(cipher.decrypt(connection.refreshTokenEncrypted));
    } catch {
      /* ถอดรหัสไม่ได้หรือ Google ปฏิเสธ - ดำเนินการต่อ */
    }
  }

  const syncs = await prisma.googleDriveSync.findMany({
    where: { connectionId },
    select: { id: true, resourceId: true },
  });

  await prisma.$transaction([
    // ลบข้อมูลรับรองทิ้งจริง ไม่ใช่แค่ทำเครื่องหมาย - ค่าที่ไม่มีอยู่รั่วไม่ได้
    prisma.googleDriveConnection.update({
      where: { id: connectionId },
      data: {
        accessTokenEncrypted: null,
        refreshTokenEncrypted: null,
        tokenExpiresAt: null,
        state: 'DISCONNECTED',
        revokedAt: new Date(),
        lastErrorCode: null,
      },
    }),
    // การผูกยังอยู่เพื่อการตรวจสอบ แต่หยุดทำงาน
    prisma.googleDriveSync.updateMany({
      where: { connectionId },
      data: { syncEnabled: false },
    }),
  ]);

  await prisma.activityLog.create({
    data: {
      userId: user.id,
      action: 'GOOGLE_DRIVE_DISCONNECTED',
      ipAddress: audit.ipAddress,
      userAgent: audit.userAgent?.slice(0, 500),
      metadata: { connectionId, pausedSyncs: syncs.length },
    },
  });

  logger.info(`[DRIVE] ตัดการเชื่อมต่อ Google Drive ของ ${connection.googleAccountEmail}`);
  return { preservedResources: syncs.length };
}

/**
 * เชื่อมต่อใหม่กับบัญชีอื่น
 *
 * ถ้าผู้ใช้เชื่อมต่อด้วยบัญชี Google คนละบัญชีกับเดิม การผูกเก่าจะไม่ถูกนำมาใช้ต่อ
 * โดยอัตโนมัติ - fileId ของ Google ไม่ซ้ำกันข้ามบัญชีก็จริง แต่การเดาว่าบัญชีใหม่
 * ควรรับช่วงไฟล์ของบัญชีเก่าเป็นการตัดสินใจที่ระบบไม่ควรทำแทนคน
 */
export async function subjectChanged(userId: string, newSubject: string): Promise<boolean> {
  const previous = await activeConnectionFor(userId);
  return previous !== null && previous.providerSubject !== newSubject;
}

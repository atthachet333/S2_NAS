import { prisma } from '../../core/prisma.js';
import { AppError } from '../../core/errors.js';
import { logger } from '../../core/logger.js';
import type { GoogleIdentity } from './google-oauth.js';
import { issueSessionForUser, type AuthUser } from './auth.service.js';

/**
 * การเชื่อมตัวตน Google เข้ากับผู้ใช้ S2 NAS
 *
 * หลักสำคัญสามข้อของเฟสนี้:
 *   1. ไม่สร้างผู้ใช้ใหม่จากบัญชี Google เด็ดขาด - Google บอกได้แค่ว่า "คุณคือใคร"
 *      ไม่ได้บอกว่า "คุณควรเข้าถึง S2 NAS ได้" ผู้ดูแลเป็นผู้ตัดสินข้อหลัง
 *   2. ไม่เพิ่มบทบาทหรือสิทธิ์ใด ๆ - ผู้ใช้ได้สิทธิ์เท่าที่บัญชีเดิมมีอยู่แล้ว
 *   3. providerSubject เป็นกุญแจของตัวตน ไม่ใช่อีเมล
 */

export type GoogleLoginFailure =
  | 'ACCOUNT_NOT_ALLOWED'
  | 'ACCOUNT_DISABLED'
  | 'IDENTITY_CONFLICT';

export class GoogleLoginError extends AppError {
  constructor(readonly reason: GoogleLoginFailure, message: string, status = 403) {
    super(reason, message, status);
    this.name = 'GoogleLoginError';
  }
}

interface AuditContext {
  ipAddress?: string;
  userAgent?: string;
}

async function audit(
  action: string,
  userId: string | null,
  metadata: Record<string, unknown>,
  context: AuditContext,
): Promise<void> {
  await prisma.activityLog.create({
    data: {
      userId,
      action,
      ipAddress: context.ipAddress,
      userAgent: context.userAgent?.slice(0, 500),
      // ห้ามบันทึก authorization code, ID token หรือความลับของ client ลง audit เด็ดขาด
      metadata: { provider: 'GOOGLE', ...metadata },
    },
  });
}

/**
 * เข้าสู่ระบบด้วยตัวตนที่ Google ยืนยันแล้ว
 *
 * คืน session ชุดเดียวกับการเข้าสู่ระบบด้วยรหัสผ่าน ไม่มีระบบ session แยกสำหรับ Google
 */
export async function loginWithGoogleIdentity(
  identity: GoogleIdentity,
  context: AuditContext = {},
): Promise<{ user: AuthUser; accessToken: string; refreshToken: string; refreshMaxAgeSeconds: number }> {
  /* ---- 1. ตัวตนนี้เคยเชื่อมไว้แล้วหรือยัง ---- */
  const existingLink = await prisma.userIdentity.findUnique({
    where: { provider_providerSubject: { provider: 'GOOGLE', providerSubject: identity.subject } },
    include: { user: true },
  });

  if (existingLink) {
    const user = existingLink.user;

    if (user.status !== 'ACTIVE') {
      await audit('GOOGLE_LOGIN_FAILED', user.id, { reason: 'ACCOUNT_DISABLED' }, context);
      throw new GoogleLoginError('ACCOUNT_DISABLED', 'บัญชีนี้ถูกปิดการใช้งาน');
    }

    /**
     * อีเมลของบัญชี Google เปลี่ยนได้ แต่ตัวตนต้องไม่ย้ายเจ้าของตามอีเมล
     * เก็บอีเมลใหม่ไว้เป็นข้อมูลประกอบเท่านั้น การผูกยังอยู่กับผู้ใช้คนเดิม
     */
    if (existingLink.providerEmailNormalized !== identity.emailNormalized) {
      logger.info('[AUTH] อีเมลของบัญชี Google เปลี่ยนไป - คงการเชื่อมกับผู้ใช้เดิมไว้');
    }

    await prisma.userIdentity.update({
      where: { id: existingLink.id },
      data: {
        providerEmail: identity.email,
        providerEmailNormalized: identity.emailNormalized,
        lastLoginAt: new Date(),
      },
    });

    const session = await issueSessionForUser(user.id);
    await audit('GOOGLE_LOGIN_SUCCEEDED', user.id, { linked: 'EXISTING' }, context);
    return session;
  }

  /* ---- 2. ยังไม่เคยเชื่อม: หาผู้ใช้เดิมจากอีเมลที่ Google ยืนยันแล้ว ---- */
  const user = await prisma.user.findUnique({ where: { email: identity.emailNormalized } });

  if (!user) {
    /**
     * ไม่สร้างผู้ใช้ใหม่ - นี่คือค่าคงที่ด้านความปลอดภัยของเฟสนี้
     * ถ้าสร้างอัตโนมัติ ใครก็ตามที่มีบัญชี Google จะเข้าระบบขององค์กรได้ทันที
     */
    await audit('GOOGLE_LOGIN_FAILED', null, { reason: 'ACCOUNT_NOT_ALLOWED' }, context);
    throw new GoogleLoginError(
      'ACCOUNT_NOT_ALLOWED',
      'บัญชี Google นี้ยังไม่ได้รับอนุญาตให้ใช้งาน S2 NAS กรุณาติดต่อผู้ดูแลระบบ',
    );
  }

  if (user.status !== 'ACTIVE') {
    await audit('GOOGLE_LOGIN_FAILED', user.id, { reason: 'ACCOUNT_DISABLED' }, context);
    throw new GoogleLoginError('ACCOUNT_DISABLED', 'บัญชีนี้ถูกปิดการใช้งาน');
  }

  /**
   * ผู้ใช้คนนี้เชื่อมบัญชี Google อื่นไว้แล้วหรือไม่
   *
   * ถ้าเชื่อมไว้แล้วต้องไม่เปลี่ยนให้เงียบ ๆ การย้ายตัวตนเป็นการเปลี่ยนสิทธิ์เข้าถึงบัญชี
   * ซึ่งต้องผ่านผู้ดูแลระบบเสมอ
   */
  const otherLink = await prisma.userIdentity.findUnique({
    where: { provider_userId: { provider: 'GOOGLE', userId: user.id } },
  });
  if (otherLink) {
    await audit('GOOGLE_IDENTITY_CONFLICT', user.id, { reason: 'USER_ALREADY_LINKED' }, context);
    throw new GoogleLoginError(
      'IDENTITY_CONFLICT',
      'บัญชี Google นี้เชื่อมกับผู้ใช้อื่นอยู่แล้ว กรุณาติดต่อผู้ดูแลระบบ',
      409,
    );
  }

  /* ---- 3. เชื่อมตัวตนครั้งแรก ---- */
  try {
    await prisma.userIdentity.create({
      data: {
        userId: user.id,
        provider: 'GOOGLE',
        providerSubject: identity.subject,
        providerEmail: identity.email,
        providerEmailNormalized: identity.emailNormalized,
        lastLoginAt: new Date(),
      },
    });
  } catch (error) {
    // แข่งกันเชื่อมพร้อมกัน หรือ unique constraint ชน - ปิดประตูไว้ก่อนเสมอ
    await audit('GOOGLE_IDENTITY_CONFLICT', user.id, { reason: 'CONSTRAINT' }, context);
    throw new GoogleLoginError(
      'IDENTITY_CONFLICT',
      'บัญชี Google นี้เชื่อมกับผู้ใช้อื่นอยู่แล้ว กรุณาติดต่อผู้ดูแลระบบ',
      409,
    );
  }

  const session = await issueSessionForUser(user.id);
  await audit('GOOGLE_IDENTITY_LINKED', user.id, { linked: 'NEW' }, context);
  await audit('GOOGLE_LOGIN_SUCCEEDED', user.id, { linked: 'NEW' }, context);
  logger.info('[AUTH] เชื่อมบัญชี Google กับผู้ใช้เดิมสำเร็จ');
  return session;
}

/** ข้อมูลการเชื่อมบัญชีสำหรับหน้าผู้ดูแล - ไม่เปิดเผย providerSubject */
export async function googleLinkFor(userId: string): Promise<{
  linked: boolean;
  email: string | null;
  linkedAt: Date | null;
  lastLoginAt: Date | null;
}> {
  const link = await prisma.userIdentity.findUnique({
    where: { provider_userId: { provider: 'GOOGLE', userId } },
    select: { providerEmail: true, createdAt: true, lastLoginAt: true },
  });
  return {
    linked: link !== null,
    email: link?.providerEmail ?? null,
    linkedAt: link?.createdAt ?? null,
    lastLoginAt: link?.lastLoginAt ?? null,
  };
}

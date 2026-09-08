import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { env } from '../../../config/env.js';
import { prisma } from '../../../core/prisma.js';
import { AppError } from '../../../core/errors.js';
import { requireInternal } from '../../auth/auth.guard.js';
import { isAdminUser } from '../../resources/system-drive.js';
import { credentialCipherReady } from '../integration-crypto.js';
import { googleDriveProvider, isDriveConfigured } from './google-api.js';
import {
  accessTokenFor,
  activeConnectionFor,
  assertCanConnect,
  assertDriveAvailable,
  beginConnect,
  completeConnect,
  connectionStatus,
  consumeState,
  disconnect,
  subjectChanged,
} from './connection.service.js';
import { importFromDrive } from './import.service.js';
import { checkNow, detach, resourceSyncInfo } from './sync.service.js';

/**
 * เส้นทางของการเชื่อมต่อ Google Drive (F19)
 *
 * แยกจาก `/api/auth/google/*` โดยสิ้นเชิง - นั่นคือการเข้าสู่ระบบ ที่นี่คือการให้สิทธิ์
 * อ่านไฟล์ ปนกันเมื่อไรก็จะมีวันที่การล็อกอินขอสิทธิ์อ่าน Drive ไปด้วยโดยไม่มีใครสังเกต
 *
 * ทุกเส้นทางอยู่หลัง requireInternal ยกเว้น callback ซึ่งมี state เป็นตัวพิสูจน์
 */

const audit = (request: FastifyRequest) => ({
  ipAddress: request.ip,
  userAgent: request.headers['user-agent'],
});

const idParams = z.object({ id: z.string().min(1) });

/** หน้าจอปลายทางหลังจบขั้นตอนที่ Google - เป็นเส้นทางภายในแอปเสมอ */
const SETTINGS_PATH = '/settings/integrations';

function frontendRedirect(result: string, detail?: string): string {
  const url = new URL(SETTINGS_PATH, env.publicBaseUrl);
  url.searchParams.set('googleDrive', result);
  if (detail) url.searchParams.set('reason', detail);
  return url.toString();
}

export async function googleDriveRoutes(app: FastifyInstance): Promise<void> {
  const base = '/integrations/google-drive';

  /* ---------------- สถานะ ---------------- */

  app.get(`${base}/status`, { preHandler: requireInternal }, async (request) => ({
    success: true,
    data: await connectionStatus(request.authUser!),
  }));

  /* ---------------- เริ่มเชื่อมต่อ ---------------- */

  /**
   * คืน URL ให้หน้าจอพาผู้ใช้ไปเอง แทนที่จะตอบ 302
   *
   * คำขอนี้มาจาก fetch ที่แนบ token - การตอบ redirect จะทำให้เบราว์เซอร์ตามไปที่ Google
   * ในบริบทของ XHR ซึ่งไม่ใช่สิ่งที่ผู้ใช้เห็นและจบลงด้วยข้อผิดพลาด CORS
   */
  app.post(`${base}/connect`, { preHandler: requireInternal }, async (request) => {
    const user = request.authUser!;
    const body = z
      .object({ forceConsent: z.boolean().optional() })
      .strict()
      .parse(request.body ?? {});

    assertCanConnect(user);
    assertDriveAvailable();

    /**
     * บังคับขอความยินยอมใหม่เมื่อยังไม่มี refresh token ที่ใช้ได้
     *
     * Google คืน refresh token เฉพาะครั้งแรกที่ยินยอม การเชื่อมต่อซ้ำแบบธรรมดา
     * จึงได้แต่ access token อายุหนึ่งชั่วโมง ซึ่งซิงก์ระยะยาวไม่ได้
     * แต่ถ้าบังคับทุกครั้ง ผู้ใช้จะต้องกดยืนยันซ้ำจนเลิกอ่านว่ากำลังอนุญาตอะไร
     */
    const existing = await activeConnectionFor(user.id);
    const forceConsent = body.forceConsent ?? existing?.refreshTokenEncrypted == null;

    const { url } = beginConnect(user, googleDriveProvider, { forceConsent });
    return { success: true, data: { url } };
  });

  /* ---------------- callback ---------------- */

  /**
   * Google ส่งผู้ใช้กลับมาที่นี่
   *
   * ไม่มี requireInternal เพราะเบราว์เซอร์เดินทางมาตรงจาก Google โดยไม่มี header ของเรา
   * ตัวพิสูจน์ตัวตนคือ state ซึ่งผูกกับผู้ใช้ที่กดเชื่อมต่อ ใช้ได้ครั้งเดียว และมีอายุสั้น
   */
  app.get(`${base}/callback`, async (request, reply) => {
    const query = z
      .object({
        code: z.string().min(1).optional(),
        state: z.string().min(1).optional(),
        error: z.string().max(200).optional(),
      })
      .parse(request.query);

    // ผู้ใช้กดยกเลิกที่หน้าจอของ Google - ไม่ใช่ข้อผิดพลาดของระบบ
    if (query.error || !query.code) {
      return reply.redirect(frontendRedirect('cancelled'));
    }

    try {
      const pending = consumeState(query.state);

      const tokens = await googleDriveProvider.exchangeCode({
        code: query.code,
        codeVerifier: pending.codeVerifier,
      });
      const account = await googleDriveProvider.getAccount(tokens.accessToken);

      /**
       * เชื่อมต่อด้วยบัญชี Google คนละบัญชีกับเดิม
       *
       * ไม่ยกการผูกไฟล์ของบัญชีเก่ามาให้บัญชีใหม่โดยอัตโนมัติ - fileId ของ Google
       * ไม่ซ้ำกันข้ามบัญชีก็จริง แต่การเดาว่าบัญชีใหม่ควรรับช่วงงานของบัญชีเก่า
       * เป็นการตัดสินใจที่ระบบไม่ควรทำแทนคน การผูกเก่าจึงยังหยุดอยู่จนกว่าจะมีคนสั่ง
       */
      const changed = await subjectChanged(pending.userId, account.subject);

      await completeConnect(pending.userId, tokens, account, audit(request));

      return reply.redirect(frontendRedirect('connected', changed ? 'account-changed' : undefined));
    } catch (error) {
      /**
       * ไม่ส่งรายละเอียดข้อผิดพลาดกลับไปที่ URL
       *
       * ค่าใน query string ไปโผล่ในประวัติเบราว์เซอร์และบันทึกของ proxy
       * รหัสสั้น ๆ ที่หน้าจอแปลเป็นข้อความไทยได้ก็เพียงพอ
       */
      const code = error instanceof AppError ? error.code : 'UNKNOWN';
      return reply.redirect(frontendRedirect('failed', code));
    }
  });

  /* ---------------- ตัดการเชื่อมต่อ ---------------- */

  app.post(`${base}/disconnect`, { preHandler: requireInternal }, async (request) => {
    const user = request.authUser!;
    const body = z.object({ connectionId: z.string().min(1) }).strict().parse(request.body);

    return {
      success: true,
      // บริการตรวจเองว่าการเชื่อมต่อนี้เป็นของผู้เรียกจริง
      data: await disconnect(body.connectionId, user, googleDriveProvider, audit(request)),
    };
  });

  /* ---------------- เบราว์เซอร์ของ Drive ---------------- */

  /**
   * รายการไฟล์ - ผ่านเซิร์ฟเวอร์เสมอ
   *
   * หน้าจอไม่เคยได้ access token ของ Google จึงเรียก Drive API เองไม่ได้
   * ถ้าให้หน้าจอเรียกตรง token จะอยู่ในหน่วยความจำของเบราว์เซอร์และเดินทางผ่าน
   * ทุกส่วนขยายที่ผู้ใช้ติดตั้งไว้
   */
  app.get(`${base}/files`, { preHandler: requireInternal }, async (request) => {
    const user = request.authUser!;
    const query = z
      .object({
        folderId: z.string().max(191).optional(),
        q: z.string().max(191).optional(),
        pageToken: z.string().max(4096).optional(),
        pageSize: z.coerce.number().int().min(1).max(200).default(100),
      })
      .parse(request.query);

    const connection = await activeConnectionFor(user.id);
    if (!connection) {
      throw new AppError('GOOGLE_DRIVE_NOT_CONNECTED', 'ยังไม่ได้เชื่อมต่อ Google Drive', 409);
    }

    const accessToken = await accessTokenFor(connection, googleDriveProvider);
    const page = await googleDriveProvider.listFiles(accessToken, {
      folderId: query.folderId ?? 'root',
      ...(query.q ? { query: query.q } : {}),
      ...(query.pageToken ? { pageToken: query.pageToken } : {}),
      pageSize: query.pageSize,
    });

    return {
      success: true,
      data: {
        items: page.items.map((entry) => ({
          id: entry.id,
          name: entry.name,
          kind: entry.kind,
          mimeType: entry.mimeType,
          size: entry.size,
          modifiedTime: entry.modifiedTime?.toISOString() ?? null,
          webViewLink: entry.webViewLink,
        })),
        nextPageToken: page.nextPageToken,
      },
    };
  });

  /* ---------------- นำเข้า ---------------- */

  app.post(`${base}/import`, { preHandler: requireInternal }, async (request) => {
    const user = request.authUser!;
    const body = z
      .object({
        fileIds: z.array(z.string().min(1).max(191)).min(1).max(100),
        destinationParentId: z.string().min(1).nullable(),
        mode: z.enum(['IMPORT_ONCE', 'SYNCED']),
        driveScope: z.enum(['MY_DRIVE', 'SYSTEM_DRIVE']).optional(),
      })
      .strict()
      .parse(request.body);

    const connection = await activeConnectionFor(user.id);
    if (!connection) {
      throw new AppError('GOOGLE_DRIVE_NOT_CONNECTED', 'ยังไม่ได้เชื่อมต่อ Google Drive', 409);
    }

    return {
      success: true,
      // สิทธิ์ปลายทางถูกตรวจโดยท่ออัปโหลดเดิม - การเชื่อมต่อ Google ไม่ขยายสิทธิ์ใน NAS
      data: await importFromDrive(user, connection, googleDriveProvider, body, audit(request)),
    };
  });

  /* ---------------- การซิงก์ของทรัพยากรหนึ่งชิ้น ---------------- */

  app.get('/resources/:id/google-drive', { preHandler: requireInternal }, async (request) => ({
    success: true,
    data: await resourceSyncInfo(idParams.parse(request.params).id, request.authUser!),
  }));

  app.post('/resources/:id/google-drive/check-sync', { preHandler: requireInternal }, async (request) => ({
    success: true,
    data: await checkNow(
      idParams.parse(request.params).id,
      request.authUser!,
      googleDriveProvider,
      audit(request),
    ),
  }));

  app.post('/resources/:id/google-drive/detach', { preHandler: requireInternal }, async (request) => ({
    success: true,
    data: await detach(idParams.parse(request.params).id, request.authUser!, audit(request)),
  }));

  /* ---------------- ภาพรวมของผู้ดูแลระบบ ---------------- */

  /**
   * สุขภาพของการเชื่อมต่อทั้งระบบ
   *
   * ผู้ดูแลเห็นว่าใครเชื่อมต่ออยู่ ใครต้องเชื่อมต่อใหม่ และมีการผูกไฟล์กี่รายการ
   * **แต่ใช้การเชื่อมต่อของคนอื่นไม่ได้และไม่เห็นข้อมูลรับรอง** - การดูแลระบบ
   * ไม่ใช่การสวมรอย และพนักงานไม่ได้ยินยอมให้ใครอ่าน Drive ของตัวเองแทน
   */
  app.get('/admin/integrations/google-drive', { preHandler: requireInternal }, async (request) => {
    if (!isAdminUser(request.authUser!)) {
      throw new AppError('GOOGLE_DRIVE_ADMIN_DENIED', 'ไม่มีสิทธิ์ดูภาพรวมการเชื่อมต่อ', 403);
    }

    const connections = await prisma.googleDriveConnection.findMany({
      select: {
        id: true,
        googleAccountEmail: true,
        state: true,
        connectedAt: true,
        lastSuccessfulSyncAt: true,
        lastErrorCode: true,
        user: { select: { id: true, displayName: true, email: true } },
        _count: { select: { syncs: true } },
      },
      orderBy: { connectedAt: 'desc' },
      take: 200,
    });

    const failing = await prisma.googleDriveSync.count({
      where: { lastIssue: { not: null }, detachedAt: null },
    });

    return {
      success: true,
      data: {
        configured: isDriveConfigured(),
        encryptionReady: credentialCipherReady(),
        pollSeconds: env.S2_NAS_DRIVE_SYNC_POLL_SECONDS,
        failingSyncs: failing,
        connections: connections.map((row) => ({
          id: row.id,
          googleAccountEmail: row.googleAccountEmail,
          state: row.state,
          connectedAt: row.connectedAt.toISOString(),
          lastSuccessfulSyncAt: row.lastSuccessfulSyncAt?.toISOString() ?? null,
          lastErrorCode: row.lastErrorCode,
          user: row.user,
          syncCount: row._count.syncs,
        })),
      },
    };
  });
}

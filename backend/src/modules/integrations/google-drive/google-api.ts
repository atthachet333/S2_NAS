import { Readable } from 'node:stream';
import { env } from '../../../config/env.js';
import { AppError } from '../../../core/errors.js';
import {
  GOOGLE_EXPORT,
  classifyEntry,
  importedFileName,
  type DriveEntry,
  type DriveDownload,
  type DriveListOptions,
  type DriveListPage,
  type GoogleAccount,
  type GoogleDriveProvider,
  type GoogleTokens,
} from './provider.js';

/**
 * การคุยกับ Google Drive จริง (F19)
 *
 * ทุกคำขอออกจากที่นี่ที่เดียว และทุกข้อผิดพลาดถูกแปลงเป็นชนิดที่ระบบเรารู้จัก
 * ก่อนจะไปถึงชั้นบน - บริการชั้นบนจึงไม่ต้องรู้จักรูปแบบข้อผิดพลาดของ Google เลย
 */

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const REVOKE_ENDPOINT = 'https://oauth2.googleapis.com/revoke';
const USERINFO_ENDPOINT = 'https://www.googleapis.com/oauth2/v3/userinfo';
const DRIVE_FILES = 'https://www.googleapis.com/drive/v3/files';

/**
 * ขอบเขตขั้นต่ำ - อ่านอย่างเดียว
 *
 * F19 เป็นการซิงก์ทางเดียวจาก Google มาที่ S2 NAS จึงไม่มีเหตุผลใดที่จะขอสิทธิ์เขียน
 * สิทธิ์ที่ขอมาแล้วไม่ได้ใช้คือความเสี่ยงที่ให้ประโยชน์เป็นศูนย์ และเป็นสิ่งที่
 * ผู้ใช้ต้องกดยินยอมโดยไม่รู้ว่าทำไม
 *
 * `drive.readonly` ครอบคลุมการอ่านเมทาดาทา การดาวน์โหลด และการส่งออกไฟล์ Google
 * ซึ่งคือทุกอย่างที่เฟสนี้ต้องการ
 */
export const DRIVE_SCOPES = [
  'https://www.googleapis.com/auth/drive.readonly',
  'openid',
  'email',
] as const;

/** ฟิลด์ที่ขอจาก Drive - ระบุให้ชัดเพื่อไม่ดึงข้อมูลที่ไม่ได้ใช้ เช่น รายชื่อผู้มีสิทธิ์ */
const FILE_FIELDS =
  'id,name,mimeType,size,modifiedTime,version,md5Checksum,webViewLink,shortcutDetails,parents,trashed';

/* ------------------------------------------------------------------ */
/* การจัดประเภทข้อผิดพลาด                                                */
/* ------------------------------------------------------------------ */

export type DriveErrorKind =
  | 'TRANSIENT'
  | 'AUTH_REQUIRED'
  | 'NOT_FOUND'
  | 'PERMISSION_DENIED'
  | 'UNSUPPORTED'
  | 'QUOTA';

export class DriveError extends AppError {
  readonly kind: DriveErrorKind;

  constructor(kind: DriveErrorKind, message: string, status = 502) {
    super(`GOOGLE_DRIVE_${kind}`, message, status);
    this.name = 'DriveError';
    this.kind = kind;
  }
}

/** ข้อผิดพลาดชนิดไหนควรลองใหม่ - ที่เหลือลองอีกกี่ครั้งก็ได้ผลเดิม */
export function isRetryable(kind: DriveErrorKind): boolean {
  return kind === 'TRANSIENT' || kind === 'QUOTA';
}

/**
 * แปลงคำตอบที่ล้มเหลวของ Google เป็นข้อผิดพลาดของเรา
 *
 * **ไม่ส่งเนื้อหาดิบของ Google ต่อไปที่ใดเลย** คำตอบของ OAuth ที่ล้มเหลวอาจมี
 * client_id, ส่วนของ token หรือรายละเอียดภายในของ Google ปนอยู่ ซึ่งไม่ควรไปโผล่
 * ในบันทึกหรือในหน้าจอของผู้ใช้
 */
async function toDriveError(response: Response): Promise<DriveError> {
  // อ่านทิ้งเพื่อไม่ให้ socket ค้าง แต่ไม่นำเนื้อหาไปใช้
  await response.text().catch(() => '');

  if (response.status === 401) {
    return new DriveError('AUTH_REQUIRED', 'การเชื่อมต่อ Google Drive หมดอายุ ต้องเชื่อมต่อใหม่', 401);
  }
  if (response.status === 403) {
    /**
     * 403 ของ Google กำกวม: อาจเป็น "ไม่มีสิทธิ์" หรือ "เกินโควตา"
     * เราไม่อ่านเนื้อหาเพื่อแยก จึงถือเป็นโควตาไว้ก่อนแล้วลองใหม่แบบถอยห่าง
     * การลองใหม่กับกรณีไม่มีสิทธิ์จริงจะจบลงที่เพดานจำนวนครั้ง ซึ่งเสียหายน้อยกว่า
     * การเลิกถาวรกับกรณีที่แค่ยิงเร็วเกินไป
     */
    return new DriveError('QUOTA', 'Google Drive ปฏิเสธคำขอชั่วคราว กรุณาลองใหม่ภายหลัง', 429);
  }
  if (response.status === 404) {
    return new DriveError('NOT_FOUND', 'ไม่พบไฟล์ต้นทางใน Google Drive', 404);
  }
  if (response.status === 429) {
    return new DriveError('QUOTA', 'ใช้โควตา Google Drive เกินกำหนด กรุณาลองใหม่ภายหลัง', 429);
  }
  if (response.status >= 500) {
    return new DriveError('TRANSIENT', 'Google Drive ขัดข้องชั่วคราว', 502);
  }
  return new DriveError('UNSUPPORTED', 'Google Drive ปฏิเสธคำขอนี้', 502);
}

/** คำขอที่ล้มเหลวเพราะเครือข่ายก็เป็นเรื่องชั่วคราวเช่นกัน */
async function driveFetch(url: string, init: RequestInit): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch {
    throw new DriveError('TRANSIENT', 'ติดต่อ Google Drive ไม่สำเร็จ', 502);
  }
  if (!response.ok) throw await toDriveError(response);
  return response;
}

/* ------------------------------------------------------------------ */
/* การตั้งค่า                                                           */
/* ------------------------------------------------------------------ */

export interface DriveOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

/**
 * การเชื่อมต่อ Drive ใช้ OAuth client ของตัวเอง แยกจากการเข้าสู่ระบบด้วย Google
 *
 * แยกเพราะสองอย่างนี้ขอสิทธิ์คนละระดับโดยสิ้นเชิง: การเข้าสู่ระบบขอแค่ "คุณคือใคร"
 * ส่วนตรงนี้ขอ "ให้ฉันอ่านไฟล์ทั้งหมดของคุณ" ถ้าใช้ client เดียวกัน
 * หน้าจอยินยอมของการเข้าสู่ระบบจะขอสิทธิ์อ่าน Drive ไปด้วยทุกครั้ง
 * ซึ่งเป็นสิ่งที่ผู้ใช้ไม่ได้ขอและไม่ควรต้องยอมรับเพื่อจะล็อกอิน
 *
 * ถ้าไม่ได้ตั้งค่าไว้ จะถอยไปใช้ client ของการเข้าสู่ระบบ **ไม่ได้** โดยเจตนา
 */
export function driveOAuthConfig(): DriveOAuthConfig | null {
  const { GOOGLE_DRIVE_CLIENT_ID, GOOGLE_DRIVE_CLIENT_SECRET, GOOGLE_DRIVE_REDIRECT_URI } = env;
  if (!GOOGLE_DRIVE_CLIENT_ID || !GOOGLE_DRIVE_CLIENT_SECRET || !GOOGLE_DRIVE_REDIRECT_URI) {
    return null;
  }
  return {
    clientId: GOOGLE_DRIVE_CLIENT_ID,
    clientSecret: GOOGLE_DRIVE_CLIENT_SECRET,
    redirectUri: GOOGLE_DRIVE_REDIRECT_URI,
  };
}

export function isDriveConfigured(): boolean {
  return driveOAuthConfig() !== null;
}

function requireConfig(): DriveOAuthConfig {
  const config = driveOAuthConfig();
  if (!config) {
    throw new AppError(
      'GOOGLE_DRIVE_NOT_CONFIGURED',
      'ยังไม่ได้ตั้งค่าการเชื่อมต่อ Google Drive',
      503,
    );
  }
  return config;
}

/* ------------------------------------------------------------------ */
/* การแปลงข้อมูล                                                        */
/* ------------------------------------------------------------------ */

interface RawFile {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  modifiedTime?: string;
  version?: string;
  md5Checksum?: string;
  webViewLink?: string;
  shortcutDetails?: { targetId?: string };
  parents?: string[];
  trashed?: boolean;
}

function toEntry(raw: RawFile): DriveEntry {
  return {
    id: raw.id,
    name: raw.name,
    kind: classifyEntry(raw.mimeType),
    mimeType: raw.mimeType,
    size: raw.size ? Number(raw.size) : null,
    modifiedTime: raw.modifiedTime ? new Date(raw.modifiedTime) : null,
    version: raw.version ?? null,
    md5Checksum: raw.md5Checksum ?? null,
    webViewLink: raw.webViewLink ?? null,
    shortcutTargetId: raw.shortcutDetails?.targetId ?? null,
    parents: raw.parents ?? [],
  };
}

/**
 * ปิดกั้นอักขระที่ใช้แหกเงื่อนไขค้นหาของ Drive
 *
 * Drive query เป็นภาษาที่มี string literal ครอบด้วยอัญประกาศเดี่ยว
 * ชื่อไฟล์ที่ผู้ใช้พิมพ์ค้นซึ่งมี ' อยู่ข้างในจะปิด literal ก่อนกำหนด
 * แล้วส่วนที่เหลือกลายเป็นเงื่อนไขที่เราไม่ได้ตั้งใจ
 */
function escapeQuery(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/* ------------------------------------------------------------------ */
/* ตัวเชื่อมจริง                                                        */
/* ------------------------------------------------------------------ */

export const googleDriveProvider: GoogleDriveProvider = {
  getAuthorizationUrl({ state, codeChallenge, forceConsent }) {
    const config = requireConfig();
    const url = new URL(AUTH_ENDPOINT);

    url.searchParams.set('client_id', config.clientId);
    url.searchParams.set('redirect_uri', config.redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', DRIVE_SCOPES.join(' '));
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
    /** จำเป็นต่อการได้ refresh token - ถ้าไม่ขอ การซิงก์จะตายเมื่อ access token หมดอายุ */
    url.searchParams.set('access_type', 'offline');
    url.searchParams.set('include_granted_scopes', 'false');

    /**
     * ขอความยินยอมใหม่เฉพาะเมื่อจำเป็น
     *
     * Google คืน refresh token เฉพาะครั้งแรกที่ผู้ใช้ยินยอม การขอ consent ใหม่ทุกครั้ง
     * จึงเป็นวิธีเดียวที่จะได้ refresh token กลับมาเมื่อของเดิมหาย
     * แต่ถ้าขอทุกครั้งโดยไม่จำเป็น ผู้ใช้จะต้องกดยืนยันซ้ำทุกรอบจนเลิกอ่านว่ากดอะไร
     */
    if (forceConsent) url.searchParams.set('prompt', 'consent');

    return url.toString();
  },

  async exchangeCode({ code, codeVerifier }) {
    const config = requireConfig();
    const response = await driveFetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: config.clientId,
        client_secret: config.clientSecret,
        redirect_uri: config.redirectUri,
        grant_type: 'authorization_code',
        code_verifier: codeVerifier,
      }),
    });

    const payload = (await response.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      scope?: string;
    };
    if (!payload.access_token) {
      throw new DriveError('AUTH_REQUIRED', 'ไม่สามารถเชื่อมต่อ Google Drive ได้', 401);
    }

    return {
      accessToken: payload.access_token,
      refreshToken: payload.refresh_token ?? null,
      expiresAt: new Date(Date.now() + (payload.expires_in ?? 3600) * 1000),
      scope: payload.scope ?? DRIVE_SCOPES.join(' '),
    };
  },

  async refreshAccessToken(refreshToken) {
    const config = requireConfig();
    const response = await driveFetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        refresh_token: refreshToken,
        client_id: config.clientId,
        client_secret: config.clientSecret,
        grant_type: 'refresh_token',
      }),
    });

    const payload = (await response.json()) as {
      access_token?: string;
      expires_in?: number;
      scope?: string;
    };
    if (!payload.access_token) {
      throw new DriveError('AUTH_REQUIRED', 'ต้องเชื่อมต่อ Google Drive ใหม่', 401);
    }

    return {
      accessToken: payload.access_token,
      // การต่ออายุไม่คืน refresh token ใหม่ - ของเดิมยังใช้ได้ต่อไป
      refreshToken: null,
      expiresAt: new Date(Date.now() + (payload.expires_in ?? 3600) * 1000),
      scope: payload.scope ?? DRIVE_SCOPES.join(' '),
    };
  },

  async getAccount(accessToken) {
    const response = await driveFetch(USERINFO_ENDPOINT, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const payload = (await response.json()) as { sub?: string; email?: string };
    if (!payload.sub || !payload.email) {
      throw new DriveError('AUTH_REQUIRED', 'ไม่สามารถอ่านข้อมูลบัญชี Google ได้', 401);
    }
    return { subject: payload.sub, email: payload.email };
  },

  async listFiles(accessToken, options) {
    const url = new URL(DRIVE_FILES);

    const clauses = ['trashed = false'];
    if (options.folderId) clauses.push(`'${escapeQuery(options.folderId)}' in parents`);
    if (options.query) clauses.push(`name contains '${escapeQuery(options.query)}'`);

    url.searchParams.set('q', clauses.join(' and '));
    url.searchParams.set('fields', `nextPageToken,files(${FILE_FIELDS})`);
    url.searchParams.set('pageSize', String(Math.min(options.pageSize ?? 100, 200)));
    url.searchParams.set('orderBy', 'folder,name');
    /**
     * ไดร์ฟที่ใช้ร่วมกัน (Shared Drives)
     *
     * องค์กรที่ใช้ Google Workspace เก็บงานส่วนใหญ่ไว้ในไดร์ฟร่วม ไม่ใช่ไดร์ฟส่วนตัว
     * ถ้าไม่เปิดสองค่านี้ ผู้ใช้จะเปิดเบราว์เซอร์มาแล้วเห็นว่างเปล่าทั้งที่มีไฟล์อยู่เต็ม
     */
    url.searchParams.set('supportsAllDrives', 'true');
    url.searchParams.set('includeItemsFromAllDrives', 'true');
    if (options.pageToken) url.searchParams.set('pageToken', options.pageToken);

    const response = await driveFetch(url.toString(), {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const payload = (await response.json()) as { files?: RawFile[]; nextPageToken?: string };

    return {
      items: (payload.files ?? []).map(toEntry),
      nextPageToken: payload.nextPageToken ?? null,
    };
  },

  async getFileMetadata(accessToken, fileId) {
    const url = new URL(`${DRIVE_FILES}/${encodeURIComponent(fileId)}`);
    url.searchParams.set('fields', FILE_FIELDS);
    url.searchParams.set('supportsAllDrives', 'true');

    const response = await driveFetch(url.toString(), {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const raw = (await response.json()) as RawFile;

    // ไฟล์ที่ถูกย้ายไปถังขยะของ Google ถือว่าหายไปแล้วในสายตาของการซิงก์
    if (raw.trashed) throw new DriveError('NOT_FOUND', 'ไฟล์ต้นทางถูกย้ายไปถังขยะใน Google Drive', 404);

    return toEntry(raw);
  },

  async downloadFile(accessToken, entry) {
    const url = new URL(`${DRIVE_FILES}/${encodeURIComponent(entry.id)}`);
    url.searchParams.set('alt', 'media');
    url.searchParams.set('supportsAllDrives', 'true');

    const response = await driveFetch(url.toString(), {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!response.body) throw new DriveError('TRANSIENT', 'ไม่ได้รับเนื้อหาไฟล์จาก Google Drive', 502);

    return {
      // สตรีมต่อตรง ไม่พักทั้งไฟล์ไว้ในหน่วยความจำ - ไฟล์ขนาดกิกะไบต์จึงไม่ล้ม process
      stream: Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
      mimeType: entry.mimeType,
      fileName: entry.name,
    };
  },

  async exportGoogleFile(accessToken, entry) {
    const target = GOOGLE_EXPORT[entry.mimeType];
    if (!target) {
      throw new DriveError('UNSUPPORTED', 'ไฟล์ชนิดนี้ของ Google ยังนำเข้าไม่ได้', 400);
    }

    const url = new URL(`${DRIVE_FILES}/${encodeURIComponent(entry.id)}/export`);
    url.searchParams.set('mimeType', target.mimeType);

    const response = await driveFetch(url.toString(), {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!response.body) throw new DriveError('TRANSIENT', 'ไม่ได้รับเนื้อหาไฟล์จาก Google Drive', 502);

    return {
      stream: Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
      /** ชนิดของไบต์ที่ได้จริง ไม่ใช่ชนิดของไฟล์ Google ต้นทาง */
      mimeType: target.mimeType,
      fileName: importedFileName(entry),
    };
  },

  async revokeToken(token) {
    try {
      await fetch(REVOKE_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token }),
      });
    } catch {
      /**
       * การเพิกถอนที่ฝั่ง Google ล้มเหลวไม่ควรทำให้การตัดการเชื่อมต่อล้มเหลว
       *
       * ผู้ใช้ที่กด "ยกเลิกการเชื่อมต่อ" ต้องได้ผลลัพธ์เสมอ - เราลบข้อมูลรับรอง
       * ฝั่งเราได้แน่นอน ส่วนการแจ้ง Google เป็นความพยายามที่ดีแต่ไม่ใช่เงื่อนไข
       * ถ้าโยนข้อผิดพลาดที่นี่ ผู้ใช้จะติดอยู่กับการเชื่อมต่อที่ตัดไม่ได้
       */
    }
  },
};

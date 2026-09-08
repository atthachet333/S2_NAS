import { Readable } from 'node:stream';
import { buildZip } from './zip-fixture.js';
import { DriveError } from './google-api.js';
import {
  classifyEntry,
  importedFileName,
  GOOGLE_EXPORT,
  type DriveDownload,
  type DriveEntry,
  type DriveListOptions,
  type DriveListPage,
  type GoogleAccount,
  type GoogleDriveProvider,
  type GoogleTokens,
} from './provider.js';

/**
 * Google Drive จำลองสำหรับชุดทดสอบ (F19)
 *
 * ทำงานตามสัญญาเดียวกับตัวจริงทุกประการ ชุดทดสอบจึงพิสูจน์ตรรกะของการนำเข้า
 * การซิงก์ การตรวจการเปลี่ยนแปลง และการจัดการข้อผิดพลาดได้จริง
 * โดยไม่ต้องมีบัญชี Google ไม่ต้องต่อเน็ต และได้ผลเหมือนเดิมทุกครั้งที่รัน
 *
 * **ตัวปลอมนี้ไม่ได้แทนที่การทดสอบกับ Google จริง** มันพิสูจน์ว่าตรรกะฝั่งเราถูก
 * ส่วนการพิสูจน์ว่าเราเข้าใจ Google ถูกต้องหรือไม่ ต้องทดสอบกับของจริงเท่านั้น
 */

export interface FakeFile {
  id: string;
  name: string;
  mimeType: string;
  /** เนื้อหาที่จะส่งกลับ - เปลี่ยนค่านี้เพื่อจำลองว่าต้นทางถูกแก้ */
  content: string;
  modifiedTime: Date;
  version: string;
  parents: string[];
  webViewLink?: string;
  shortcutTargetId?: string;
  /** จำลองว่าไฟล์หายไปจาก Google */
  missing?: boolean;
  /** จำลองว่าบัญชีไม่มีสิทธิ์อ่านไฟล์นี้แล้ว */
  forbidden?: boolean;
}

export class FakeDriveProvider implements GoogleDriveProvider {
  readonly files = new Map<string, FakeFile>();

  account: GoogleAccount = { subject: 'fake-subject-1', email: 'drive-user@example.invalid' };

  /** ควบคุมว่าการแลก code จะคืน refresh token หรือไม่ - จำลองพฤติกรรมจริงของ Google */
  nextRefreshToken: string | null = 'fake-refresh-token';

  /** ทำให้การต่ออายุล้มเหลว เพื่อทดสอบเส้นทาง REAUTH_REQUIRED */
  refreshFails = false;

  /** นับจำนวนครั้งที่ถูกเรียก - ใช้ยืนยันว่าเส้นทางที่ควรข้ามได้ข้ามจริง */
  readonly calls = { list: 0, metadata: 0, download: 0, export: 0, revoke: 0, refresh: 0 };

  /** เวลาที่ประทับลง ZIP ขยับทุกครั้งที่ส่งออก - จำลองพฤติกรรมจริงของ Google */
  private exportClock = 0;

  add(file: FakeFile): FakeFile {
    this.files.set(file.id, file);
    return file;
  }

  /** จำลองการแก้ไขต้นทาง - เมทาดาทาขยับพร้อมเนื้อหา เหมือนที่ Google ทำ */
  edit(id: string, content: string): void {
    const file = this.files.get(id);
    if (!file) throw new Error(`ไม่มีไฟล์ ${id} ในตัวปลอม`);
    file.content = content;
    file.version = String(Number(file.version) + 1);
    file.modifiedTime = new Date(file.modifiedTime.getTime() + 60_000);
  }

  /** จำลองการแตะต้นทางโดยไม่เปลี่ยนเนื้อหา เช่น เปลี่ยนชื่อหรือย้ายโฟลเดอร์ */
  touch(id: string): void {
    const file = this.files.get(id);
    if (!file) throw new Error(`ไม่มีไฟล์ ${id} ในตัวปลอม`);
    file.version = String(Number(file.version) + 1);
    file.modifiedTime = new Date(file.modifiedTime.getTime() + 60_000);
  }

  private toEntry(file: FakeFile): DriveEntry {
    return {
      id: file.id,
      name: file.name,
      kind: classifyEntry(file.mimeType),
      mimeType: file.mimeType,
      size: GOOGLE_EXPORT[file.mimeType] ? null : Buffer.byteLength(file.content, 'utf8'),
      modifiedTime: file.modifiedTime,
      version: file.version,
      md5Checksum: null,
      webViewLink: file.webViewLink ?? `https://drive.google.com/file/d/${file.id}/view`,
      shortcutTargetId: file.shortcutTargetId ?? null,
      parents: file.parents,
    };
  }

  private require(fileId: string): FakeFile {
    const file = this.files.get(fileId);
    if (!file || file.missing) {
      throw new DriveError('NOT_FOUND', 'ไม่พบไฟล์ต้นทางใน Google Drive', 404);
    }
    if (file.forbidden) {
      throw new DriveError('PERMISSION_DENIED', 'ไม่มีสิทธิ์เข้าถึงไฟล์นี้', 403);
    }
    return file;
  }

  /* ---------------- OAuth ---------------- */

  getAuthorizationUrl({ state, codeChallenge, forceConsent }: {
    state: string;
    codeChallenge: string;
    forceConsent: boolean;
  }): string {
    const url = new URL('https://accounts.google.test/authorize');
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', codeChallenge);
    url.searchParams.set('access_type', 'offline');
    if (forceConsent) url.searchParams.set('prompt', 'consent');
    return url.toString();
  }

  async exchangeCode(): Promise<GoogleTokens> {
    return {
      accessToken: 'fake-access-token',
      refreshToken: this.nextRefreshToken,
      expiresAt: new Date(Date.now() + 3600_000),
      scope: 'https://www.googleapis.com/auth/drive.readonly',
    };
  }

  async refreshAccessToken(): Promise<GoogleTokens> {
    this.calls.refresh += 1;
    if (this.refreshFails) {
      throw new DriveError('AUTH_REQUIRED', 'refresh token ใช้ไม่ได้แล้ว', 401);
    }
    return {
      accessToken: 'fake-access-token-refreshed',
      refreshToken: null,
      expiresAt: new Date(Date.now() + 3600_000),
      scope: 'https://www.googleapis.com/auth/drive.readonly',
    };
  }

  async getAccount(): Promise<GoogleAccount> {
    return this.account;
  }

  /* ---------------- Drive ---------------- */

  async listFiles(_token: string, options: DriveListOptions): Promise<DriveListPage> {
    this.calls.list += 1;
    const all = [...this.files.values()].filter((file) => !file.missing);

    const matched = all.filter((file) => {
      const inFolder = options.folderId
        ? file.parents.includes(options.folderId) ||
          (options.folderId === 'root' && file.parents.length === 0)
        : true;
      const matchesQuery = options.query ? file.name.includes(options.query) : true;
      return inFolder && matchesQuery;
    });

    /** แบ่งหน้าจริง เพื่อให้ชุดทดสอบพิสูจน์ได้ว่าโค้ดฝั่งเราไล่ทุกหน้าครบ */
    const size = options.pageSize ?? 100;
    const start = options.pageToken ? Number(options.pageToken) : 0;
    const slice = matched.slice(start, start + size);
    const next = start + size < matched.length ? String(start + size) : null;

    return { items: slice.map((file) => this.toEntry(file)), nextPageToken: next };
  }

  async getFileMetadata(_token: string, fileId: string): Promise<DriveEntry> {
    this.calls.metadata += 1;
    return this.toEntry(this.require(fileId));
  }

  async downloadFile(_token: string, entry: DriveEntry): Promise<DriveDownload> {
    this.calls.download += 1;
    const file = this.require(entry.id);
    if (GOOGLE_EXPORT[file.mimeType]) {
      throw new DriveError('UNSUPPORTED', 'ไฟล์ของ Google ต้องใช้การส่งออก', 400);
    }
    return {
      stream: Readable.from([Buffer.from(file.content, 'utf8')]),
      mimeType: file.mimeType,
      fileName: file.name,
    };
  }

  async exportGoogleFile(_token: string, entry: DriveEntry): Promise<DriveDownload> {
    this.calls.export += 1;
    const file = this.require(entry.id);
    const target = GOOGLE_EXPORT[file.mimeType];
    if (!target) throw new DriveError('UNSUPPORTED', 'ไฟล์ชนิดนี้ส่งออกไม่ได้', 400);

    /**
     * ไบต์ที่ส่งกลับต้องเป็น OOXML จริง และต้องไม่คงที่ระหว่างการส่งออกสองครั้ง
     *
     * ของจริงประทับ "เวลาที่ส่งออก" ลงในหัวของทุกรายการใน ZIP การส่งออกเอกสารเดิม
     * ที่ไม่มีใครแก้สองครั้งจึงได้ไบต์ต่างกันเสมอ (ยืนยันจาก live QA: ทุกส่วนข้างใน
     * CRC เท่ากันหมด ต่างแค่เวลาในหัวรายการ)
     *
     * ถ้าตัวปลอมส่งไบต์ชุดเดิมทุกครั้ง ชุดทดสอบจะผ่านทั้งที่ของจริงสร้างเวอร์ชันซ้ำ
     * - เป็นความมั่นใจที่ผิด และเป็นเหตุผลที่ D1 หลุดไปถึงการใช้งานจริง
     */
    this.exportClock += 1;
    const partName =
      file.mimeType === 'application/vnd.google-apps.spreadsheet'
        ? 'xl/worksheets/sheet1.xml'
        : file.mimeType === 'application/vnd.google-apps.presentation'
          ? 'ppt/slides/slide1.xml'
          : 'word/document.xml';

    const body = buildZip(
      [
        { name: '[Content_Types].xml', content: '<Types/>' },
        { name: partName, content: file.content },
      ],
      // เวลาขยับทุกครั้งที่ส่งออก เหมือนที่ Google ทำจริง
      { dosTime: (0x6000 + this.exportClock) & 0xffff, dosDate: 0x5900 },
    );
    return {
      stream: Readable.from([body]),
      mimeType: target.mimeType,
      fileName: importedFileName(this.toEntry(file)),
    };
  }

  async revokeToken(): Promise<void> {
    this.calls.revoke += 1;
  }
}

import type { BackupDto, BackupReadiness, LockStatus, RehearsalResult, RehearsalSchedule, RestorePrecheckResult, RestoreStageResult, RetentionRunResult, ScheduleStatus, VerificationResult } from './backup';
import type { SettingView } from './system-settings';
/**
 * API client กลาง
 * เรียกผ่าน /api ซึ่ง Vite proxy ไปที่ backend http://localhost:8889
 */
export interface ApiErrorBody {
  success: false;
  error: { code: string; message: string; details?: unknown };
}

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  /** รายละเอียดเพิ่มเติมจาก backend เช่น สาเหตุที่กู้คืนไม่ได้ */
  readonly details?: unknown;

  constructor(code: string, message: string, status: number, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

let accessToken: string | null = null;
export function setAccessToken(token: string | null): void {
  accessToken = token;
}

/** ใช้กับการอัปโหลดผ่าน XMLHttpRequest ซึ่งต้องแนบ header เอง */
export function getAccessToken(): string | null {
  return accessToken;
}

/**
 * ดึงไฟล์/สตรีมจาก API โดยแนบ access token ให้อัตโนมัติ
 *
 * endpoint เนื้อหาและดาวน์โหลดใช้การยืนยันตัวตนแบบ Bearer เหมือน API อื่น ๆ
 * (refresh cookie ผูกกับ /api/auth เท่านั้น จึงใช้แทนกันไม่ได้)
 * ทุกจุดที่โหลดเนื้อหาไฟล์ต้องผ่านฟังก์ชันนี้ ไม่ใช้ fetch ตรง ๆ
 */
export function authorizedFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(path, {
    ...init,
    credentials: 'include',
    headers: {
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      ...init?.headers,
    },
  });
}

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      ...init,
      credentials: 'include',
      headers: {
        Accept: 'application/json',
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        ...init?.headers,
      },
    });
  } catch {
    throw new ApiError('NETWORK_ERROR', 'เชื่อมต่อเซิร์ฟเวอร์ไม่ได้', 0);
  }

  const text = await response.text();
  const data: unknown = text ? JSON.parse(text) : null;

  if (!response.ok) {
    const body = data as ApiErrorBody | null;
    throw new ApiError(
      body?.error?.code ?? 'REQUEST_FAILED',
      body?.error?.message ?? 'เกิดข้อผิดพลาดในการเรียกข้อมูล',
      response.status,
      body?.error?.details,
    );
  }

  return data as T;
}

/* ---------- Types ---------- */

export interface HealthResponse {
  status: 'ok' | 'degraded' | 'error';
  service: string;
  database: 'connected' | 'disconnected' | 'not_configured';
  storage: 'ready' | 'read_only' | 'unavailable';
  uptime: number;
  timestamp: string;
}

export interface StorageResponse {
  success: true;
  data: {
    status: 'READY' | 'READ_ONLY' | 'UNAVAILABLE';
    readable: boolean;
    writable: boolean;
    totalBytes: number | null;
    usedBytes: number | null;
    freeBytes: number | null;
  };
}

export interface SystemInfoResponse {
  success: true;
  data: {
    service: string;
    subtitle: string;
    environment: string;
    version: string;
    phase: number;
    uptime: number;
    database: string;
    maxUploadSizeMb: number;
  };
}

export const api = {
  health: () => apiFetch<HealthResponse>('/health'),
  storage: () => apiFetch<StorageResponse>('/system/storage'),
  systemInfo: () => apiFetch<SystemInfoResponse>('/system/info'),
  /** ปุ่ม Google ควรแสดงหรือไม่ - ไม่มี client id หรือความลับใด ๆ ในคำตอบนี้ */
  googleConfig: () => apiFetch<{ success: true; data: { enabled: boolean } }>('/auth/google/config'),
};

/** ค่าตั้งค่าการทำงานของระบบ - เฉพาะผู้ที่มีสิทธิ์ system:settings:manage */
export const systemSettingsApi = {
  list: () => apiFetch<{ success: true; data: SettingView[] }>('/admin/settings'),
  update: (values: Record<string, number>) =>
    apiFetch<{ success: true; data: SettingView[] }>('/admin/settings', {
      method: 'PATCH',
      body: JSON.stringify(values),
    }),
  reset: (key: string) =>
    apiFetch<{ success: true; data: SettingView[] }>(`/admin/settings/${key}`, { method: 'DELETE' }),
};

/** งานสำรอง/กู้คืน - เฉพาะผู้ที่มีสิทธิ์ system:backup:manage */
export const backupApi = {
  readiness: () => apiFetch<{ success: true; data: BackupReadiness }>('/admin/backups/readiness'),
  list: () => apiFetch<{ success: true; data: BackupDto[] }>('/admin/backups'),
  get: (id: string) => apiFetch<{ success: true; data: BackupDto }>(`/admin/backups/${id}`),
  create: () => apiFetch<{ success: true; data: BackupDto }>('/admin/backups', { method: 'POST' }),
  verify: (id: string) =>
    apiFetch<{ success: true; data: VerificationResult }>(`/admin/backups/${id}/verify`, { method: 'POST' }),
  restorePrecheck: (id: string) =>
    apiFetch<{ success: true; data: RestorePrecheckResult }>(`/admin/backups/${id}/restore-precheck`, { method: 'POST' }),
  restoreStage: (id: string) =>
    apiFetch<{ success: true; data: RestoreStageResult }>(`/admin/backups/${id}/restore-stage`, { method: 'POST' }),
  discardStage: (id: string) =>
    apiFetch<{ success: true; data: { discarded: true } }>(`/admin/backups/${id}/restore-stage`, { method: 'DELETE' }),
  remove: (id: string) =>
    apiFetch<{ success: true; data: { deleted: true } }>(`/admin/backups/${id}`, { method: 'DELETE' }),
  schedule: () => apiFetch<{ success: true; data: ScheduleStatus }>('/admin/backups/schedule'),
  updateSchedule: (input: Record<string, number | boolean | string>) =>
    apiFetch<{ success: true; data: ScheduleStatus }>('/admin/backups/schedule', {
      method: 'PATCH',
      body: JSON.stringify(input),
    }),
  runNow: () => apiFetch<{ success: true; data: BackupDto }>('/admin/backups/run-now', { method: 'POST' }),
  runRetention: () =>
    apiFetch<{ success: true; data: RetentionRunResult }>('/admin/backups/retention', { method: 'POST' }),
  offsite: (id: string) =>
    apiFetch<{ success: true; data: { ok: boolean; problems: string[] } }>(`/admin/backups/${id}/offsite`, { method: 'POST' }),
  offsiteRetry: (id: string) =>
    apiFetch<{ success: true; data: { ok: boolean; problems: string[] } }>(`/admin/backups/${id}/offsite-retry`, { method: 'POST' }),
  rehearsal: () => apiFetch<{ success: true; data: RehearsalSchedule }>('/admin/backups/rehearsal'),
  updateRehearsal: (input: Record<string, number | boolean | string>) =>
    apiFetch<{ success: true; data: RehearsalSchedule }>('/admin/backups/rehearsal', {
      method: 'PATCH',
      body: JSON.stringify(input),
    }),
  runRehearsal: () =>
    apiFetch<{ success: true; data: RehearsalResult | null }>('/admin/backups/rehearsal/run-now', { method: 'POST' }),
  rehearsals: () => apiFetch<{ success: true; data: RehearsalResult[] }>('/admin/backups/rehearsals'),
  lock: () => apiFetch<{ success: true; data: LockStatus }>('/admin/backups/lock'),
};

export interface AuthUser {
  id: string;
  email: string;
  displayName: string;
  /** INTERNAL | EXTERNAL | SERVICE - ตัวกำหนดว่าผู้ใช้อยู่ฝั่งไหนของระบบ */
  type: string;
  status: string;
  mustChangePassword: boolean;
  roles: string[];
  permissions: string[];
}

export interface AuthResponse {
  success: true;
  data: { accessToken: string; user: AuthUser };
}

/**
 * ผลลัพธ์การกู้คืน session ตอนเปิดแอป
 * "ยังไม่ได้เข้าสู่ระบบ" เป็นคำตอบปกติ ไม่ใช่ error
 */
export type SessionResponse =
  | { success: true; data: { authenticated: true; accessToken: string; user: AuthUser } }
  | { success: true; data: { authenticated: false } };

export const authApi = {
  login: (email: string, password: string) => apiFetch<AuthResponse>('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }),
  refresh: () => apiFetch<AuthResponse>('/auth/refresh', { method: 'POST' }),
  /** กู้คืน session จาก refresh cookie (httpOnly) ตอน bootstrap */
  session: () => apiFetch<SessionResponse>('/auth/session', { method: 'POST' }),
  logout: () => apiFetch<{ success: true }>('/auth/logout', { method: 'POST' }),
  changePassword: (currentPassword: string, newPassword: string) => apiFetch<{ success: true; data: { changed: boolean; loginRequired: boolean } }>('/auth/change-password', { method: 'POST', body: JSON.stringify({ currentPassword, newPassword }) }),
  updateProfile: (displayName: string) =>
    apiFetch<{ success: true; data: AuthUser }>('/auth/profile', {
      method: 'PATCH',
      body: JSON.stringify({ displayName }),
    }),
};

export interface ResourceCapabilities {
  canView: boolean; canEdit: boolean; canRename: boolean; canMove: boolean;
  canDelete: boolean; canShare: boolean; canLock: boolean;
  canDownload: boolean; canUploadVersion: boolean; canTransferOwner: boolean;
}

export interface ResourceDto {
  id: string;
  type: 'FILE' | 'FOLDER' | 'GOOGLE_SHEET' | 'GOOGLE_DOC' | 'GOOGLE_DRIVE' | 'WEB_LINK' | 'SYSTEM_FILE' | 'SHORTCUT';
  name: string; parentId: string | null;
  owner: { id: string; displayName: string; email: string };
  sourceType: 'MANUAL' | 'GOOGLE' | 'S2_PAYROLL' | 'S2_ERP' | 'S2_LINE_BOT' | 'EXTERNAL_UPLOAD' | 'SYSTEM';
  mimeType: string | null; extension: string | null; size: number | null;
  externalUrl: string | null; externalProvider: string | null; remark: string | null;
  sourceSystem: string | null; sourceEntityType: string | null; sourceEntityId: string | null;
  sourceUrl: string | null;
  createdByIntegrationApp: { id: string; name: string; code: string } | null;
  isLocked: boolean; itemCount: number; createdAt: string; updatedAt: string;
  /** ประเภทเอกสารที่คนกำหนดไว้ - null คือยังไม่ได้จัดประเภท */
  documentCategory?: { id: string; name: string } | null;
  /* ---- วงจรชีวิตเอกสาร (F16) ---- */
  lifecycleState?: 'ACTIVE' | 'ARCHIVED';
  archivedAt?: string | null;
  retentionPolicy?: { id: string; name: string } | null;
  retentionUntil?: string | null;
  retentionForever?: boolean;
  /** ถูกระงับการลบอยู่หรือไม่ - ไม่บอกเหตุผล เหตุผลมีเส้นทางของตัวเอง */
  onLegalHold?: boolean;
  visibility: 'ORGANIZATION' | 'RESTRICTED';
  /** ไดร์ฟที่ทรัพยากรนี้สังกัด - ตัดสินนโยบายการเขียนได้จากแถวเดียว */
  driveScope: 'MY_DRIVE' | 'SYSTEM_DRIVE';
  currentVersion: number | null;
  /** ผู้อัปโหลดตามประวัติ ไม่ใช่เจ้าของไฟล์ */
  uploadedBy: { id: string; displayName: string; email: string } | null;
  tags: TagDto[];
  lockedAt: string | null;
  lockReason: string | null;
  lockedBy: { id: string; displayName: string; email: string } | null;
  capabilities: ResourceCapabilities;
}

export interface ResourceVersionDto {
  id: string;
  versionNumber: number;
  size: number;
  checksum: string;
  mimeType: string | null;
  remark: string | null;
  createdAt: string;
  createdBy: { id: string; displayName: string; email: string };
  isCurrent: boolean;
  canDownload: boolean;
}

export interface TrashEntryDto extends ResourceDto {
  /** เวลาที่รายการนี้จะถูกลบถาวรอัตโนมัติ (null = ปิดการเก็บกวาดตามอายุ) */
  expiresAt: string | null;
  deletedAt: string | null;
  deletedBy: { id: string; displayName: string; email: string } | null;
  /** null = รากของไดร์ฟ หน้าจอเป็นผู้เติมชื่อไดร์ฟจาก drive-labels */
  originalLocation: string | null;
  originalParentId: string | null;
}

export interface UploadResultDto {
  status: 'CREATED' | 'VERSION_ADDED';
  resource: ResourceDto;
  duplicateOf?: { id: string; name: string };
}

export interface ResourceListResponse { success: true; data: { items: ResourceDto[]; nextCursor: string | null } }
export interface ResourceResponse { success: true; data: ResourceDto }
export interface BreadcrumbResponse { success: true; data: Array<{ id: string; name: string }> }

export const resourceApi = {
  /** สถานะการอ่านข้อความจากเอกสาร - ใช้ตัดสินว่าจะแสดงปุ่มอะไร */
  ocrState: (id: string) => apiFetch<Ok<OcrStateDto>>(`/resources/${id}/ocr`),
  /** สั่งอ่านข้อความ - เข้าคิวเท่านั้น ไม่รอให้เสร็จ */
  requestOcr: (id: string) =>
    apiFetch<Ok<{ queued: boolean }>>(`/resources/${id}/ocr`, { method: 'POST' }),
  /** ข้อความของเอกสาร - ผู้ที่เปิดไฟล์ดูได้ก็อ่านได้ */
  ocrText: (id: string) => apiFetch<Ok<OcrTextDto>>(`/resources/${id}/ocr-text`),
  /**
   * บันทึกข้อความที่ตรวจแก้แล้ว
   *
   * expectedRevision คือเลขรุ่นที่หน้าจออ่านมาตอนเปิดฟอร์ม เซิร์ฟเวอร์ใช้มัน
   * ปฏิเสธการบันทึกที่จะไปเขียนทับงานของคนอื่นที่บันทึกแทรกเข้ามาก่อน
   */
  saveOcrText: (id: string, input: { text: string; expectedRevision: number }) =>
    apiFetch<Ok<{ correctionRevision: number; characterCount: number; truncated: boolean; created: boolean }>>(
      `/resources/${id}/ocr-text`,
      { method: 'PUT', body: JSON.stringify(input) },
    ),
  /** กลับไปใช้ผลดิบของ OCR */
  resetOcrText: (id: string) =>
    apiFetch<Ok<{ reset: boolean }>>(`/resources/${id}/ocr-text`, { method: 'DELETE' }),
  /** ใครตรวจแก้เมื่อไร */
  ocrTextHistory: (id: string) =>
    apiFetch<Ok<CorrectionHistoryDto[]>>(`/resources/${id}/ocr-text/history`),
  list: (params: URLSearchParams) => apiFetch<ResourceListResponse>(`/resources?${params.toString()}`),
  get: (id: string) => apiFetch<ResourceResponse>(`/resources/${id}`),
  recent: (limit = 50) => apiFetch<{ success: true; data: ResourceDto[] }>(`/resources-recent?limit=${limit}`),
  breadcrumb: (id: string) => apiFetch<BreadcrumbResponse>(`/resources/${id}/breadcrumb`),
  createFolder: (input: { name: string; parentId?: string | null; ownerId?: string; remark?: string | null; driveScope?: 'MY_DRIVE' | 'SYSTEM_DRIVE' }) => apiFetch<ResourceResponse>('/folders', { method: 'POST', body: JSON.stringify(input) }),
  createExternal: (input: { type: 'GOOGLE_SHEET' | 'GOOGLE_DOC' | 'GOOGLE_DRIVE' | 'WEB_LINK'; name: string; parentId?: string | null; url: string; remark?: string | null; driveScope?: 'MY_DRIVE' | 'SYSTEM_DRIVE' }) => apiFetch<ResourceResponse>('/resources/external', { method: 'POST', body: JSON.stringify(input) }),
  update: (id: string, input: { name?: string; remark?: string | null; externalUrl?: string }) => apiFetch<ResourceResponse>(`/resources/${id}`, { method: 'PATCH', body: JSON.stringify(input) }),
  move: (id: string, parentId: string | null, driveScope?: 'MY_DRIVE' | 'SYSTEM_DRIVE') => apiFetch<ResourceResponse>(`/resources/${id}/move`, { method: 'PATCH', body: JSON.stringify({ parentId, ...(driveScope ? { driveScope } : {}) }) }),
  transferOwner: (id: string, newOwnerId: string) => apiFetch<ResourceResponse>(`/resources/${id}/owner`, { method: 'PATCH', body: JSON.stringify({ newOwnerId }) }),
  remove: (id: string) => apiFetch<{ success: true; data: { deleted: true; deletedAt: string } }>(`/resources/${id}`, { method: 'DELETE' }),
};

export type UserStatus = 'INVITED' | 'ACTIVE' | 'SUSPENDED' | 'DISABLED';

export interface RoleRef { id: string; code: string; name: string }

export interface PublicUser {
  id: string;
  email: string;
  displayName: string;
  type: string;
  /** ชื่อบริษัทของลูกค้า - บัญชีภายในเป็น null เสมอ */
  organizationName: string | null;
  status: UserStatus;
  mustChangePassword: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  roles: Array<{ role: RoleRef }>;
}

export interface UserPage { items: PublicUser[]; nextCursor: string | null; total: number }

export interface UserListFilter {
  q?: string;
  status?: UserStatus;
  roleCode?: string;
  /** แยกรายชื่อบุคลากรภายในออกจากลูกค้า - หน้าจัดการทั้งสองใช้เส้นทางเดียวกัน */
  type?: 'INTERNAL' | 'EXTERNAL' | 'SERVICE';
  limit?: number;
  cursor?: string;
}

export const usersApi = {
  list: (filter: UserListFilter = {}) => {
    const params = new URLSearchParams();
    if (filter.q) params.set('q', filter.q);
    if (filter.status) params.set('status', filter.status);
    if (filter.roleCode) params.set('roleCode', filter.roleCode);
    if (filter.type) params.set('type', filter.type);
    params.set('limit', String(filter.limit ?? 50));
    if (filter.cursor) params.set('cursor', filter.cursor);
    return apiFetch<{ success: true; data: UserPage }>(`/users?${params.toString()}`);
  },
  roles: () => apiFetch<{ success: true; data: Array<RoleRef & { permissions: Array<{ permission: { code: string; name: string } }> }> }>('/roles'),

  /** รหัสผ่านชั่วคราวถูกส่งครั้งเดียวตอนตั้ง และไม่มีเส้นทางใดอ่านกลับมาได้อีก */
  activate: (id: string, temporaryPassword: string) =>
    apiFetch<{ success: true; data: PublicUser }>(`/users/${id}/activate`, {
      method: 'POST',
      body: JSON.stringify({ temporaryPassword }),
    }),
  resetPassword: (id: string, temporaryPassword: string) =>
    apiFetch<{ success: true; data: PublicUser }>(`/users/${id}/reset-password`, {
      method: 'POST',
      body: JSON.stringify({ temporaryPassword }),
    }),
  disable: (id: string, acknowledgeHandover = false) =>
    apiFetch<{ success: true; data: PublicUser }>(`/users/${id}/disable`, {
      method: 'POST',
      body: JSON.stringify({ acknowledgeHandover }),
    }),
  changeRoles: (id: string, roleCodes: string[]) =>
    apiFetch<{ success: true; data: PublicUser }>(`/users/${id}/roles`, {
      method: 'PATCH',
      body: JSON.stringify({ roleCodes }),
    }),
  updateProfile: (id: string, displayName: string) =>
    apiFetch<{ success: true; data: PublicUser }>(`/users/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ displayName }),
    }),

  /** "ลูกค้ารายนี้เข้าถึงอะไรได้บ้าง" - มุมมองของผู้ดูแล ไม่ใช่ของพื้นที่ลูกค้า */
  clientPortalAccess: (userId: string) =>
    apiFetch<Ok<ClientPortalSummary>>(`/users/${userId}/portal-access`),

  /**
   * สร้างบัญชี
   *
   * บัญชีลูกค้าไม่รับบทบาทภายใน สิทธิ์ของลูกค้ามาจากการแชร์รายทรัพยากรเท่านั้น
   * ทุกบัญชีเริ่มที่ INVITED - ต้องมีผู้ดูแลตั้งรหัสผ่านชั่วคราวก่อนจึงใช้งานได้
   */
  create: (input: {
    email: string;
    displayName: string;
    type: 'INTERNAL' | 'EXTERNAL';
    organizationName?: string | null;
    roleCodes: string[];
  }) =>
    apiFetch<{ success: true; data: PublicUser }>('/users', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  setOrganization: (id: string, organizationName: string | null) =>
    apiFetch<{ success: true; data: PublicUser }>(`/users/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ organizationName }),
    }),
};


export interface DashboardSummaryResponse {
  success: true;
  data: {
    totals: { resources: number; folders: number; files: number; ownedByMe: number };
    recentResources: ResourceDto[];
    recentActivity: Array<{
      id: string;
      action: string;
      createdAt: string;
      actor: { displayName: string; email: string } | null;
      resourceName: string | null;
    }>;
    activityScopeIsOrganization: boolean;
  };
}

export const dashboardApi = {
  summary: () => apiFetch<DashboardSummaryResponse>('/dashboard/summary'),
};

export const fileApi = {
  versions: (id: string) => apiFetch<{ success: true; data: ResourceVersionDto[] }>(`/resources/${id}/versions`),
  trash: () => apiFetch<{ success: true; data: { items: TrashEntryDto[]; retentionDays: number } }>('/trash'),
  moveToTrash: (id: string) => apiFetch<{ success: true; data: { trashed: true; affected: number } }>(`/resources/${id}/trash`, { method: 'POST' }),
  restore: (id: string, body: { targetParentId?: string | null; newName?: string } = {}) =>
    apiFetch<ResourceResponse>(`/resources/${id}/restore`, { method: 'POST', body: JSON.stringify(body) }),
  permanentDeletePreview: (id: string) =>
    apiFetch<{ success: true; data: { resourceCount: number; fileCount: number; versionCount: number; type: string } }>(
      `/resources/${id}/permanent-delete-preview`,
    ),
  permanentDelete: (id: string) =>
    apiFetch<{ success: true; data: { deleted: true; resourceCount: number; versionCount: number } }>(
      `/resources/${id}/permanent`,
      { method: 'DELETE' },
    ),
  managedStorage: () =>
    apiFetch<{ success: true; data: { managedBytes: number; maxUploadBytes: number } }>('/system/managed-storage'),

  /** URL สำหรับเปิดดูเนื้อหา (inline) - ต้องผ่าน fetch ที่แนบ token เสมอ */
  contentPath: (id: string, version?: number) =>
    `/api/resources/${id}/content${version ? `?version=${version}` : ''}`,
  downloadPath: (id: string, version?: number) =>
    `/api/resources/${id}/download${version ? `?version=${version}` : ''}`,
  folderZipPath: (id: string) => `/api/resources/${id}/download-zip`,
  selectionZipPath: '/api/resources/download-zip',
};

export interface OwnershipRow { user: { id: string; displayName: string; email: string }; ownedFolderCount: number }
export const adminApi = { ownership: () => apiFetch<{ success: true; data: OwnershipRow[] }>('/admin/ownership') };

export type IntegrationScope = 'resources:read'|'resources:create'|'resources:upload'|'resources:update'|'resources:download'|'resources:metadata';
export interface IntegrationCredentialDto { id:string; label:string|null; createdAt:string; lastUsedAt:string|null; expiresAt:string|null; revokedAt:string|null }
export interface IntegrationAppDto { id:string; name:string; code:string; description:string|null; isActive:boolean; scopes:IntegrationScope[]; lastUsedAt:string|null; createdAt:string; allowedRoot:{id:string;name:string}; credentials:IntegrationCredentialDto[]; _count:{credentials:number} }
export const integrationsAdminApi = {
  list:()=>apiFetch<{success:true;data:IntegrationAppDto[]}>('/admin/integrations'),
  create:(input:{name:string;code:string;description?:string|null;allowedRootId:string;scopes:IntegrationScope[]})=>apiFetch<{success:true;data:IntegrationAppDto}>('/admin/integrations',{method:'POST',body:JSON.stringify(input)}),
  update:(id:string,input:Partial<{name:string;description:string|null;isActive:boolean;allowedRootId:string;scopes:IntegrationScope[]}>)=>apiFetch<{success:true;data:IntegrationAppDto}>(`/admin/integrations/${id}`,{method:'PATCH',body:JSON.stringify(input)}),
  credential:(id:string,label?:string)=>apiFetch<{success:true;data:{credentialId:string;secret:string}}>(`/admin/integrations/${id}/credentials`,{method:'POST',body:JSON.stringify({label:label||null})}),
  revoke:(id:string,credentialId:string)=>apiFetch<{success:true;data:{revoked:boolean}}>(`/admin/integrations/${id}/credentials/${credentialId}`,{method:'DELETE'}),
};


/* ---------- Phase E: พื้นที่ทำงานองค์กร ---------- */

export interface TagDto { id: string; name: string }

export interface AccessGrantDto {
  userId: string;
  user: {
    id: string;
    displayName: string;
    email: string;
    /** INTERNAL | EXTERNAL - ตัวตนของผู้รับสิทธิ์ต้องไม่กำกวมในหน้าจัดการ */
    userType: string;
    organizationName: string | null;
  };
  accessLevel: 'EDITOR' | 'VIEWER';
  allowDownload: boolean;
  /** null = ไม่หมดอายุ */
  expiresAt: string | null;
  /** สิทธิ์ที่หมดอายุยังอยู่ในรายการเพื่อการตรวจสอบ แต่ไม่มีผลแล้ว */
  isExpired: boolean;
  userStatus: string;
}

export interface AccessListDto {
  owner: { id: string; displayName: string; email: string };
  visibility: 'ORGANIZATION' | 'RESTRICTED';
  canManage: boolean;
  grants: AccessGrantDto[];
}

export interface SharedResourceDto extends ResourceDto {
  myAccessLevel: 'OWNER' | 'EDITOR' | 'VIEWER';
  myAllowDownload: boolean;
  sharedAt: string;
}

/** ข้อมูลเพิ่มเติมที่มีเฉพาะในผลการค้นหา */
/** สถานะการอ่านข้อความจากเอกสารของไฟล์หนึ่งชิ้น */
export interface OcrStateDto {
  eligible: boolean;
  reason: string | null;
  kind: 'IMAGE' | 'SCANNED_PDF' | null;
  status: string | null;
  /**
   * NATIVE_TEXT = ข้อความในไฟล์จริง
   * OCR = อ่านจากภาพ ซึ่งเป็นการคาดเดา
   * HUMAN_CORRECTED = มีคนตรวจแก้ผลของ OCR แล้ว
   */
  textSource: string | null;
  ocrRequested: boolean;
  ocrCompletedAt: string | null;
  ocrConfidence: number | null;
  ocrPageCount: number | null;
  truncated: boolean;
  engineAvailable: boolean;
}

/**
 * ข้อความของเอกสารพร้อมสถานะการตรวจแก้
 *
 * ไม่มีฟิลด์ใดในนี้เป็น HTML - ทั้ง text และ rawText เป็นข้อความล้วนเสมอ
 * หน้าจอจึงต้องแสดงมันด้วย {value} ของ React เท่านั้น ห้าม dangerouslySetInnerHTML
 * เพราะเนื้อหามาจากไฟล์ที่ผู้ใช้อัปโหลดเอง ซึ่งควบคุมไม่ได้ว่าข้างในมีอะไร
 */
export interface OcrTextDto {
  available: boolean;
  status: string | null;
  textSource: string | null;
  text: string;
  rawText: string;
  corrected: boolean;
  correctionRevision: number;
  correctedAt: string | null;
  correctedBy: { id: string; name: string } | null;
  characterCount: number;
  truncated: boolean;
  canEdit: boolean;
  maxCharacters: number;
  rawTextDiffersFromCorrection: boolean;
}

/** ประวัติการตรวจแก้หนึ่งรายการ - ไม่มีตัวข้อความ */
export interface CorrectionHistoryDto {
  revision: number;
  characterCount: number;
  createdAt: string;
  createdBy: { id: string; name: string };
}

/* ---------------- F15 ---------------- */

export interface SavedSearchDto {
  id: string;
  name: string;
  query: string;
  /** ตัวกรองในรูปเดียวกับที่อยู่บน URL */
  filters: Record<string, string | boolean>;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SmartViewDto {
  slug: string;
  name: string;
  description: string;
}

export interface DocumentCategoryDto {
  id: string;
  name: string;
  slug: string;
  isActive: boolean;
  sortOrder: number;
  resourceCount: number;
}

export interface ReviewQueueItemDto {
  resourceId: string;
  name: string;
  extension: string | null;
  ownerName: string;
  ocrConfidence: number | null;
  ocrPageCount: number | null;
  characterCount: number;
  indexedAt: string | null;
}

export interface ReviewQueueDto {
  items: ReviewQueueItemDto[];
  /** จำนวนที่เหลือจริงที่ผู้เรียกเห็นได้ ไม่ใช่ยอดรวมของทั้งระบบ */
  remaining: number;
}

export interface ReviewSummaryDto {
  needsReview: number;
  verified: number;
  corrected: number;
  failed: number;
}

/**
 * ผลของงานหลายรายการ
 *
 * แยกสามจำนวนตามความจริง ไม่ยุบเป็น "สำเร็จ/ไม่สำเร็จ" - "ข้าม" ไม่ใช่ความล้มเหลว
 * เช่นโฟลเดอร์ในงานที่ทำได้เฉพาะไฟล์ ผู้ใช้ควรเห็นความต่างนี้
 */
export interface BulkOutcomeDto {
  batchId: string;
  succeeded: number;
  skipped: number;
  failed: number;
  errors: Array<{ resourceId: string; code: string; message: string }>;
}

export interface SearchHitDto extends ResourceDto {
  /** NAME | TAG | REMARK | CONTENT - บอกว่าทำไมผลลัพธ์นี้ถึงขึ้นมา */
  matchReason: string | null;
  /** ข้อความล้วนรอบคำค้น มีเฉพาะเมื่อตรงเพราะเนื้อในเอกสาร */
  contentSnippet: string | null;
  /** ที่มาของข้อความที่ตรงกัน - ใช้บอกผู้ใช้ว่าผลนี้มาจากการอ่านภาพ */
  textSource?: string | null;
}

export interface SearchResultDto {
  items: SearchHitDto[];
  nextCursor: string | null;
  total: number;
}

export interface SearchFacetsDto {
  owners: Array<{ id: string; displayName: string; email: string; resourceCount: number }>;
  tags: Array<{ id: string; name: string; resourceCount: number }>;
}

export interface ActivityEntryDto {
  id: string;
  action: string;
  resourceId: string | null;
  actor: { id: string; displayName: string; email: string } | null;
  metadata: unknown;
  createdAt: string;
  /** เห็นเฉพาะผู้ดูแลระบบ */
  ipAddress?: string | null;
  userAgent?: string | null;
}

export interface ActivityPageDto { items: ActivityEntryDto[]; nextCursor: string | null }

export interface HandoverRow {
  user: { id: string; displayName: string; email: string; status: string };
  ownedTotal: number;
  ownedFolders: number;
  ownedFiles: number;
  needsHandover: boolean;
}

export interface HandoverPreviewDto {
  from: { id: string; displayName: string; email: string; status: string };
  to: { id: string; displayName: string; email: string; status: string };
  total: number;
  sample: Array<{ id: string; name: string; type: string; isLocked: boolean }>;
  truncated: boolean;
}

export interface OffboardingCheckDto {
  user: { id: string; displayName: string; email: string; status: string };
  ownedTotal: number;
  ownedFolders: number;
  ownedFiles: number;
  lockedByUser: number;
  requiresHandover: boolean;
}

type Ok<T> = { success: true; data: T };

export const workspaceApi = {
  /* รายการโปรด */
  favorites: () => apiFetch<Ok<ResourceDto[]>>('/favorites'),
  addFavorite: (id: string) => apiFetch<Ok<ResourceDto>>(`/resources/${id}/favorite`, { method: 'POST' }),
  removeFavorite: (id: string) => apiFetch<Ok<{ removed: boolean }>>(`/resources/${id}/favorite`, { method: 'DELETE' }),

  /* ปักหมุด */
  pins: () => apiFetch<Ok<ResourceDto[]>>('/pins'),
  pin: (id: string) => apiFetch<Ok<ResourceDto>>(`/resources/${id}/pin`, { method: 'POST' }),
  unpin: (id: string) => apiFetch<Ok<{ removed: boolean }>>(`/resources/${id}/pin`, { method: 'DELETE' }),

  /* แท็ก */
  tags: (q?: string) => apiFetch<Ok<Array<TagDto & { resourceCount: number }>>>(`/tags${q ? `?q=${encodeURIComponent(q)}` : ''}`),
  addTag: (id: string, name: string) => apiFetch<Ok<ResourceDto>>(`/resources/${id}/tags`, { method: 'POST', body: JSON.stringify({ name }) }),
  removeTag: (id: string, tagId: string) => apiFetch<Ok<ResourceDto>>(`/resources/${id}/tags/${tagId}`, { method: 'DELETE' }),

  /* หมายเหตุ */
  updateRemark: (id: string, remark: string | null) =>
    apiFetch<Ok<ResourceDto>>(`/resources/${id}/remark`, { method: 'PATCH', body: JSON.stringify({ remark }) }),

  /* ล็อก */
  lock: (id: string, reason: string | null) =>
    apiFetch<Ok<ResourceDto>>(`/resources/${id}/lock`, { method: 'POST', body: JSON.stringify({ reason }) }),
  unlock: (id: string) => apiFetch<Ok<ResourceDto>>(`/resources/${id}/lock`, { method: 'DELETE' }),

  /* การแชร์ภายใน */
  access: (id: string) => apiFetch<Ok<AccessListDto>>(`/resources/${id}/access`),
  grantAccess: (
    id: string,
    input: {
      userId: string;
      accessLevel: 'EDITOR' | 'VIEWER';
      allowDownload: boolean;
      /** เวลาสัมบูรณ์ (ISO) หรือ null เมื่อไม่หมดอายุ - หน้าจอเป็นผู้แปลตัวเลือกเป็นวันที่ */
      expiresAt?: string | null;
    },
  ) => apiFetch<Ok<AccessListDto>>(`/resources/${id}/access`, { method: 'POST', body: JSON.stringify(input) }),
  revokeAccess: (id: string, userId: string) =>
    apiFetch<Ok<AccessListDto>>(`/resources/${id}/access/${userId}`, { method: 'DELETE' }),
  sharedWithMe: () => apiFetch<Ok<SharedResourceDto[]>>('/shared'),
  shareTargets: (q: string, scope?: 'INTERNAL' | 'EXTERNAL') =>
    apiFetch<Ok<ShareTargetDto[]>>(
      `/share-targets?q=${encodeURIComponent(q)}${scope ? `&scope=${scope}` : ''}`,
    ),

  /* ค้นหา */
  search: (params: URLSearchParams) => apiFetch<Ok<SearchResultDto>>(`/search?${params.toString()}`),
  facets: () => apiFetch<Ok<SearchFacetsDto>>('/search/facets'),

  /* ประวัติ */
  resourceActivity: (id: string, cursor?: string) =>
    apiFetch<Ok<ActivityPageDto>>(`/resources/${id}/activity${cursor ? `?cursor=${cursor}` : ''}`),
  activity: (params: URLSearchParams) => apiFetch<Ok<ActivityPageDto>>(`/activity?${params.toString()}`),
  activityActions: () => apiFetch<Ok<Array<{ action: string; count: number }>>>('/activity/actions'),

  /* ส่งมอบความรับผิดชอบ */
  handoverOverview: () => apiFetch<Ok<HandoverRow[]>>('/handover/overview'),
  handoverPreview: (fromUserId: string, toUserId: string) =>
    apiFetch<Ok<HandoverPreviewDto>>(`/handover/preview?fromUserId=${fromUserId}&toUserId=${toUserId}`),
  handoverTransfer: (fromUserId: string, toUserId: string) =>
    apiFetch<Ok<{ transferred: number; from: { displayName: string }; to: { displayName: string } }>>('/handover/transfer', {
      method: 'POST',
      body: JSON.stringify({ fromUserId, toUserId }),
    }),
  offboardingCheck: (userId: string) => apiFetch<Ok<OffboardingCheckDto>>(`/users/${userId}/offboarding-check`),

};

/* ---------- ผู้รับสิทธิ์ ---------- */

export interface ShareTargetDto {
  id: string;
  displayName: string;
  email: string;
  userType: string;
  organizationName: string | null;
}

/* ---------- พื้นที่เอกสารสำหรับลูกค้า ---------- */

/**
 * ข้อมูลที่ลูกค้าเห็น - จงใจแคบกว่า ResourceDto ของฝั่งภายในมาก
 * ไม่มีผู้ดูแล ไม่มีนโยบายการมองเห็น ไม่มีไดร์ฟ ไม่มีเลขเวอร์ชัน
 */
export interface PortalResourceDto {
  id: string;
  type: string;
  name: string;
  /** มีเฉพาะในผลการค้นหา - เส้นทางจากรากที่ถูกแชร์ให้ลงมาถึงรายการนี้ */
  path?: Array<{ id: string; name: string }>;
  /** มีเฉพาะในผลการค้นหา - ป้ายบอกว่าตรงกับชื่อไฟล์หรือเนื้อหาเอกสาร */
  matchLabel?: string;
  /** ข้อความล้วนรอบคำค้น มีเฉพาะเมื่อตรงเพราะเนื้อในเอกสาร */
  contentSnippet?: string | null;
  mimeType: string | null;
  extension: string | null;
  size: number | null;
  externalUrl: string | null;
  sourceLabel: string | null;
  itemCount: number;
  uploadedAt: string;
  uploadedBy: string | null;
  capabilities: {
    canView: boolean;
    canDownload: boolean;
    canUpload: boolean;
    canRename: boolean;
    canMove: boolean;
    canDelete: boolean;
    canShare: boolean;
  };
}

export interface PortalHomeDto {
  shared: PortalResourceDto[];
  recentUploads: PortalResourceDto[];
  uploadFolders: PortalResourceDto[];
}

export interface PortalFolderDto {
  folder: PortalResourceDto;
  breadcrumb: Array<{ id: string; name: string }>;
  items: PortalResourceDto[];
}

/**
 * เวอร์ชันที่ลูกค้าเห็น - อ่านอย่างเดียว
 *
 * ที่อยู่ของเวอร์ชันคือ "เลขลำดับภายในไฟล์" ไม่ใช่รหัสของแถวเวอร์ชัน
 * จึงไม่มีรหัสระดับระบบให้เดา และเลขนี้มีความหมายเฉพาะเมื่อคู่กับไฟล์ที่เข้าถึงได้แล้ว
 */
/** หนึ่งรายการในประวัติการอัปโหลดของลูกค้า */
export interface UploadHistoryItem {
  id: string;
  name: string;
  mimeType: string | null;
  extension: string | null;
  size: number | null;
  uploadedAt: string;
  /** AVAILABLE | MANAGED_BY_STAFF | UNAVAILABLE */
  state: string;
  stateLabel: string;
  /** null เมื่อไฟล์อยู่นอกขอบเขตที่ลูกค้าเข้าถึงได้ - ตำแหน่งภายในไม่ถูกเปิดเผย */
  destination: Array<{ id: string; name: string }> | null;
  canPreview: boolean;
  canDownload: boolean;
}

export interface UploadHistoryPage {
  items: UploadHistoryItem[];
  nextCursor: string | null;
  total: number;
}

export interface PortalVersionDto {
  versionNumber: number;
  createdAt: string;
  size: number;
  uploadedBy: string | null;
  isCurrent: boolean;
  canDownload: boolean;
}

/** สรุปสิทธิ์ของลูกค้าหนึ่งราย สำหรับหน้าผู้ดูแล */
export interface ClientGrantDto {
  resourceId: string;
  resourceName: string;
  resourceType: string;
  role: 'VIEWER' | 'CONTRIBUTOR';
  allowDownload: boolean;
  expiresAt: string | null;
  isExpired: boolean;
  sharedAt: string;
}

export interface ClientPortalSummary {
  googleLinked: boolean;
  activeGrants: number;
  grants: ClientGrantDto[];
}

/**
 * เส้นทางของลูกค้าแยกจาก API ภายในทั้งชุด
 * ไม่มีฟังก์ชันใดที่ลบ เปลี่ยนชื่อ ย้าย หรือแชร์ต่อ - ไม่ใช่เพราะซ่อนไว้ แต่เพราะไม่มีอยู่จริง
 */
export const portalApi = {
  home: () => apiFetch<Ok<PortalHomeDto>>('/portal/resources'),
  folder: (id: string) => apiFetch<Ok<PortalFolderDto>>(`/portal/folders/${id}`),
  resource: (id: string) =>
    apiFetch<Ok<{ resource: PortalResourceDto; breadcrumb: Array<{ id: string; name: string }> }>>(
      `/portal/resources/${id}`,
    ),
  search: (q: string) => apiFetch<Ok<PortalResourceDto[]>>(`/portal/search?q=${encodeURIComponent(q)}`),
  versions: (id: string) => apiFetch<Ok<PortalVersionDto[]>>(`/portal/resources/${id}/versions`),
  uploads: (filter: { q?: string; extension?: string; limit?: number; cursor?: string } = {}) => {
    const params = new URLSearchParams();
    if (filter.q) params.set('q', filter.q);
    if (filter.extension) params.set('extension', filter.extension);
    params.set('limit', String(filter.limit ?? 25));
    if (filter.cursor) params.set('cursor', filter.cursor);
    return apiFetch<Ok<UploadHistoryPage>>(`/portal/uploads?${params.toString()}`);
  },
  uploadTypes: () => apiFetch<Ok<string[]>>('/portal/uploads/types'),
  contentUrl: (id: string) => `/api/portal/resources/${id}/content`,
  downloadUrl: (id: string) => `/api/portal/resources/${id}/download`,
  versionContentUrl: (id: string, versionNumber: number) =>
    `/api/portal/resources/${id}/versions/${versionNumber}/content`,
  versionDownloadUrl: (id: string, versionNumber: number) =>
    `/api/portal/resources/${id}/versions/${versionNumber}/download`,
};

/** ชุดค้นหาที่บันทึกไว้ - เป็นของส่วนตัวของแต่ละคน */
export const savedSearchApi = {
  list: () => apiFetch<Ok<SavedSearchDto[]>>('/saved-searches'),
  get: (id: string) => apiFetch<Ok<SavedSearchDto>>(`/saved-searches/${id}`),
  create: (input: { name: string; query?: string; filters?: Record<string, unknown> }) =>
    apiFetch<Ok<SavedSearchDto>>('/saved-searches', { method: 'POST', body: JSON.stringify(input) }),
  update: (id: string, input: { name?: string; query?: string; filters?: Record<string, unknown> }) =>
    apiFetch<Ok<SavedSearchDto>>(`/saved-searches/${id}`, { method: 'PATCH', body: JSON.stringify(input) }),
  remove: (id: string) =>
    apiFetch<Ok<{ deleted: boolean }>>(`/saved-searches/${id}`, { method: 'DELETE' }),
};

/** มุมมองอัจฉริยะ - ชุดเงื่อนไขสำเร็จรูป ไม่ใช่โฟลเดอร์ */
export const smartViewApi = {
  list: () => apiFetch<Ok<SmartViewDto[]>>('/smart-views'),
  run: (slug: string, params: URLSearchParams) =>
    apiFetch<Ok<{ view: { slug: string; name: string }; items: SearchHitDto[]; nextCursor: string | null }>>(
      `/smart-views/${slug}?${params.toString()}`,
    ),
};

/** คิวตรวจผลของ OCR */
export const ocrReviewApi = {
  queue: (params: URLSearchParams) =>
    apiFetch<Ok<ReviewQueueDto>>(`/ocr-review/queue?${params.toString()}`),
  /** ยืนยันว่าเครื่องอ่านถูกแล้ว โดยไม่แก้ข้อความ - ที่มาของข้อความยังเป็น OCR */
  verify: (resourceId: string) =>
    apiFetch<Ok<{ resourceId: string; reviewStatus: string; reviewedAt: string }>>(
      `/resources/${resourceId}/ocr-review/verify`,
      { method: 'POST' },
    ),
  summary: () => apiFetch<Ok<ReviewSummaryDto>>('/ocr-review/summary'),
};

/** ประเภทเอกสาร */
export const categoryApi = {
  list: (includeInactive = false) =>
    apiFetch<Ok<DocumentCategoryDto[]>>(
      `/document-categories${includeInactive ? '?includeInactive=true' : ''}`,
    ),
  create: (input: { name: string; sortOrder?: number }) =>
    apiFetch<Ok<DocumentCategoryDto>>('/document-categories', { method: 'POST', body: JSON.stringify(input) }),
  update: (id: string, input: { name?: string; isActive?: boolean; sortOrder?: number }) =>
    apiFetch<Ok<DocumentCategoryDto>>(`/document-categories/${id}`, { method: 'PATCH', body: JSON.stringify(input) }),
  remove: (id: string) =>
    apiFetch<Ok<{ deleted: boolean }>>(`/document-categories/${id}`, { method: 'DELETE' }),
  seedDefaults: () =>
    apiFetch<Ok<{ created: number }>>('/document-categories/seed-defaults', { method: 'POST' }),
};

/** งานที่ทำกับหลายรายการพร้อมกัน */
export const bulkApi = {
  addTag: (resourceIds: string[], tagName: string) =>
    apiFetch<Ok<BulkOutcomeDto>>('/resources/bulk/tags', {
      method: 'POST',
      body: JSON.stringify({ resourceIds, tagName }),
    }),
  removeTag: (resourceIds: string[], tagId: string) =>
    apiFetch<Ok<BulkOutcomeDto>>('/resources/bulk/tags', {
      method: 'DELETE',
      body: JSON.stringify({ resourceIds, tagId }),
    }),
  setCategory: (resourceIds: string[], documentCategoryId: string | null) =>
    apiFetch<Ok<BulkOutcomeDto>>('/resources/bulk/category', {
      method: 'POST',
      body: JSON.stringify({ resourceIds, documentCategoryId }),
    }),
  setOwner: (resourceIds: string[], newOwnerId: string) =>
    apiFetch<Ok<BulkOutcomeDto>>('/resources/bulk/owner', {
      method: 'POST',
      body: JSON.stringify({ resourceIds, newOwnerId }),
    }),
  /** กำหนดนโยบายการเก็บรักษาให้หลายรายการ */
  setRetention: (resourceIds: string[], policyId: string | null) =>
    apiFetch<Ok<BulkOutcomeDto>>('/resources/bulk/retention', {
      method: 'POST',
      body: JSON.stringify({ resourceIds, policyId }),
    }),
  /** เก็บหลายรายการเข้าคลัง */
  archive: (resourceIds: string[]) =>
    apiFetch<Ok<BulkOutcomeDto>>('/resources/bulk/archive', {
      method: 'POST',
      body: JSON.stringify({ resourceIds }),
    }),
};

/* ---------------- F16 ---------------- */

export interface RetentionPolicyDto {
  id: string;
  name: string;
  description: string | null;
  /** null เมื่อเก็บถาวร */
  retentionDays: number | null;
  retainForever: boolean;
  isActive: boolean;
  sortOrder: number;
  resourceCount: number;
}

export interface LegalHoldDto {
  id: string;
  resourceId: string;
  resourceName: string;
  /** null เมื่อผู้เรียกไม่มีสิทธิ์จัดการการระงับ - รู้ว่าถูกระงับ แต่ไม่รู้ว่าเพราะอะไร */
  reason: string | null;
  caseReference: string | null;
  createdBy: { id: string; displayName: string };
  createdAt: string;
  releasedBy: { id: string; displayName: string } | null;
  releasedAt: string | null;
  releaseReason: string | null;
  isActive: boolean;
}

/** เหตุผลที่ลบถาวรไม่ได้ - ข้อความปลอดภัย ไม่มีรายละเอียดของการระงับ */
export interface DeleteBlockDto {
  kind: 'LEGAL_HOLD' | 'RETAIN_FOREVER' | 'RETENTION_ACTIVE';
  until?: string;
}

/** นโยบายการเก็บรักษา - ไม่ใช่เรื่องเดียวกับอายุของชุดสำรอง (F6) */
export const retentionApi = {
  list: (includeInactive = false) =>
    apiFetch<Ok<RetentionPolicyDto[]>>(
      `/retention-policies${includeInactive ? '?includeInactive=true' : ''}`,
    ),
  create: (input: {
    name: string;
    description?: string | null;
    retentionDays?: number | null;
    retainForever?: boolean;
  }) =>
    apiFetch<Ok<RetentionPolicyDto>>('/retention-policies', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  update: (id: string, input: Record<string, unknown>) =>
    apiFetch<Ok<RetentionPolicyDto>>(`/retention-policies/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    }),
  remove: (id: string) =>
    apiFetch<Ok<{ deleted: boolean }>>(`/retention-policies/${id}`, { method: 'DELETE' }),
  /** คำนวณวันหมดอายุใหม่ให้เอกสารที่ใช้นโยบายนี้ - ต้องกดเอง ไม่ใช่ผลข้างเคียงของการแก้นิยาม */
  reapply: (id: string) =>
    apiFetch<Ok<{ updated: number }>>(`/retention-policies/${id}/reapply`, { method: 'POST' }),
  seedDefaults: () =>
    apiFetch<Ok<{ created: number }>>('/retention-policies/seed-defaults', { method: 'POST' }),
  /** กำหนดนโยบายให้เอกสารหนึ่งฉบับ - policyId = null คือล้างนโยบายออก */
  assign: (resourceId: string, input: { policyId: string | null; startAt?: string | null }) =>
    apiFetch<Ok<{ resourceId: string; retentionUntil: string | null; retentionForever: boolean }>>(
      `/resources/${resourceId}/retention`,
      { method: 'PUT', body: JSON.stringify(input) },
    ),
};

/** คลังเอกสาร - ไม่ใช่ถังขยะ */
export const archiveApi = {
  archive: (resourceId: string) =>
    apiFetch<ResourceResponse>(`/resources/${resourceId}/archive`, { method: 'POST' }),
  unarchive: (resourceId: string) =>
    apiFetch<ResourceResponse>(`/resources/${resourceId}/unarchive`, { method: 'POST' }),
};

/** การระงับการลบ */
export const legalHoldApi = {
  list: (includeReleased = false) =>
    apiFetch<Ok<LegalHoldDto[]>>(`/legal-holds${includeReleased ? '?includeReleased=true' : ''}`),
  forResource: (resourceId: string) =>
    apiFetch<Ok<LegalHoldDto[]>>(`/resources/${resourceId}/legal-holds`),
  place: (resourceId: string, input: { reason: string; caseReference?: string | null }) =>
    apiFetch<Ok<LegalHoldDto>>(`/resources/${resourceId}/legal-hold`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  release: (holdId: string, input: { releaseReason?: string | null } = {}) =>
    apiFetch<Ok<LegalHoldDto>>(`/legal-holds/${holdId}/release`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
};

/* ---------------- F17 ---------------- */

export interface AuditActorDto {
  id: string | null;
  displayName: string;
  email: string | null;
  type: 'INTERNAL' | 'EXTERNAL' | 'SERVICE' | 'SYSTEM' | 'INTEGRATION';
}

export interface AuditResourceDto {
  id: string;
  /** null เมื่อทรัพยากรถูกลบไปแล้ว */
  name: string | null;
  type: string | null;
  deleted: boolean;
}

export interface AuditEventDto {
  id: string;
  createdAt: string;
  /** รหัสดิบ - แสดงในรายละเอียดสำหรับผู้ดูแล ไม่ใช่ในตารางหลัก */
  action: string;
  label: string;
  category: string;
  tone: string;
  actor: AuditActorDto;
  resource: AuditResourceDto | null;
  ipAddress: string | null;
  userAgent: string | null;
  /** ผ่านบัญชีอนุญาตของเหตุการณ์นั้นแล้ว ไม่ใช่ metadata ดิบ */
  details: Record<string, string | number | boolean>;
}

export interface AuditPageDto {
  items: AuditEventDto[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface AuditCatalogDto {
  categories: Array<{ code: string; label: string }>;
  events: Array<{ code: string; label: string; category: string }>;
  presets: Array<{ slug: string; name: string; description: string }>;
  canView: boolean;
  canExport: boolean;
}

/**
 * เครื่องมือตรวจสอบ
 *
 * อ่านอย่างเดียวทั้งหมด ยกเว้นการส่งออกซึ่งไม่แก้บันทึกเดิม
 * แต่เพิ่มบันทึกใหม่ว่ามีการส่งออกเกิดขึ้น
 */
export const auditApi = {
  catalog: () => apiFetch<Ok<AuditCatalogDto>>('/audit/catalog'),
  events: (params: URLSearchParams) => apiFetch<Ok<AuditPageDto>>(`/audit/events?${params.toString()}`),
  event: (id: string) => apiFetch<Ok<AuditEventDto>>(`/audit/events/${id}`),
  /** ไทม์ไลน์ของทรัพยากรหนึ่งชิ้น */
  resource: (resourceId: string, params: URLSearchParams) =>
    apiFetch<Ok<AuditPageDto>>(`/audit/resources/${resourceId}?${params.toString()}`),
  /** การส่งออกดึงเป็นไฟล์ จึงผ่าน authorizedFetch ไม่ใช่ apiFetch */
  exportPath: '/api/audit/export',
};

/* ------------------------------------------------------------------ */
/* ลิงก์แชร์ภายนอก (F18)                                                 */
/* ------------------------------------------------------------------ */

export type PublicShareStatus =
  | 'ACTIVE'
  | 'EXPIRED'
  | 'REVOKED'
  | 'LIMIT_REACHED'
  | 'RESOURCE_UNAVAILABLE';

/**
 * ลิงก์แชร์ในมุมมองของคนภายใน
 *
 * ไม่มี token และไม่มี passwordHash โดยตั้งใจ - เซิร์ฟเวอร์ไม่ส่งมาให้เลย
 * โทเคนดิบมีอยู่ครั้งเดียวใน `url` ที่คืนตอนสร้าง และไม่มีทางขอดูอีก
 */
export interface PublicShareLinkDto {
  id: string;
  resourceId: string;
  resourceName: string;
  resourceType: string;
  label: string | null;
  status: PublicShareStatus;
  allowPreview: boolean;
  allowDownload: boolean;
  passwordProtected: boolean;
  expiresAt: string | null;
  maxViews: number | null;
  viewCount: number;
  maxDownloads: number | null;
  downloadCount: number;
  createdAt: string;
  revokedAt: string | null;
  lastAccessedAt: string | null;
}

export interface CreatedShareDto {
  link: PublicShareLinkDto;
  /** ปรากฏครั้งเดียว - ถ้าผู้ใช้ปิดกล่องไปแล้ว ต้องสร้างลิงก์ใหม่ */
  url: string;
}

export interface CreateShareInput {
  allowPreview?: boolean;
  allowDownload?: boolean;
  expiresAt?: string | null;
  password?: string | null;
  maxViews?: number | null;
  maxDownloads?: number | null;
  label?: string | null;
}

export interface AdminShareRow extends PublicShareLinkDto {
  createdBy: { id: string; displayName: string; email: string };
}

export interface AdminSharePage {
  items: AdminShareRow[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface AdminShareSummary {
  active: number;
  expiringSoon: number;
  expired: number;
  revoked: number;
  downloadable: number;
  passwordProtected: number;
}

export const publicShareApi = {
  list: (resourceId: string) =>
    apiFetch<Ok<PublicShareLinkDto[]>>(`/resources/${resourceId}/public-shares`),

  create: (resourceId: string, input: CreateShareInput) =>
    apiFetch<Ok<CreatedShareDto>>(`/resources/${resourceId}/public-shares`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }),

  revoke: (shareLinkId: string) =>
    apiFetch<Ok<PublicShareLinkDto>>(`/public-share-links/${shareLinkId}`, { method: 'DELETE' }),

  adminList: (params: URLSearchParams) =>
    apiFetch<Ok<AdminSharePage>>(`/admin/public-shares?${params.toString()}`),

  adminSummary: () => apiFetch<Ok<AdminShareSummary>>('/admin/public-shares/summary'),
};

/* ---------------- ฝั่งแขก ---------------- */

export interface GuestItemDto {
  id: string;
  type: string;
  name: string;
  mimeType: string | null;
  extension: string | null;
  size: number | null;
}

export interface GuestShareDto {
  passwordRequired: boolean;
  resource?: GuestItemDto;
  allowPreview?: boolean;
  allowDownload?: boolean;
  expiresAt?: string | null;
}

export interface GuestFolderDto {
  folder: { id: string; name: string };
  breadcrumb: Array<{ id: string; name: string }>;
  items: GuestItemDto[];
}

/**
 * คำขอฝั่งแขกไม่แนบ token ของ S2 NAS
 *
 * ใช้ fetch ตรง ๆ แทน apiFetch เพราะ apiFetch จะแนบ Authorization และพยายาม
 * ต่ออายุ session เมื่อได้ 401 ซึ่งไม่มีความหมายเลยสำหรับคนที่ไม่มีบัญชี
 * และจะทำให้หน้าจอเด้งไปหน้าเข้าสู่ระบบทั้งที่ลิงก์ยังใช้ได้ปกติ
 *
 * ใบผ่านของแขก (ถ้ามี) เดินทางผ่าน header ของตัวเอง ไม่ปนกับ Authorization
 */
async function guestFetch<T>(path: string, pass: string | null, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...init,
    headers: {
      ...(pass ? { 'X-Guest-Pass': pass } : {}),
      ...init?.headers,
    },
  });

  const body = (await response.json().catch(() => null)) as
    | { success?: boolean; data?: T; error?: { code?: string; message?: string } }
    | null;

  if (!response.ok || !body?.success) {
    throw new ApiError(
      body?.error?.code ?? `HTTP_${response.status}`,
      body?.error?.message ?? 'ลิงก์นี้ไม่สามารถใช้งานได้แล้ว',
      response.status,
    );
  }
  return body.data as T;
}

export const guestShareApi = {
  open: (token: string, pass: string | null) =>
    guestFetch<GuestShareDto>(`/public/shares/${token}`, pass),

  verifyPassword: (token: string, password: string) =>
    guestFetch<{ pass: string | null }>(`/public/shares/${token}/verify-password`, null, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    }),

  children: (token: string, pass: string | null, folderId?: string) =>
    guestFetch<GuestFolderDto>(
      `/public/shares/${token}/children${folderId ? `?folderId=${encodeURIComponent(folderId)}` : ''}`,
      pass,
    ),

  /** เส้นทางของเนื้อหา - ต้องดึงผ่าน fetch ที่แนบใบผ่าน ไม่ใช่ใส่ใน src ตรง ๆ */
  contentPath: (token: string, resourceId?: string) =>
    `/api/public/shares/${token}/content${resourceId ? `?resourceId=${encodeURIComponent(resourceId)}` : ''}`,
  downloadPath: (token: string, resourceId?: string) =>
    `/api/public/shares/${token}/download${resourceId ? `?resourceId=${encodeURIComponent(resourceId)}` : ''}`,
};

/* ------------------------------------------------------------------ */
/* Google Drive (F19)                                                  */
/* ------------------------------------------------------------------ */

export type DriveConnectionState =
  | 'ACTIVE'
  | 'REAUTH_REQUIRED'
  | 'CREDENTIAL_UNREADABLE'
  | 'DISCONNECTED';

/**
 * การเชื่อมต่อในมุมมองของหน้าจอ
 *
 * ไม่มีฟิลด์ token ใด ๆ โดยตั้งใจ - เซิร์ฟเวอร์ไม่ส่งมาให้เลย
 * หน้าจอรู้ได้แค่ว่าเชื่อมต่ออยู่กับบัญชีไหนและสถานะเป็นอย่างไร
 */
export interface DriveConnectionDto {
  id: string;
  googleAccountEmail: string;
  state: DriveConnectionState;
  connectedAt: string;
  lastSuccessfulSyncAt: string | null;
  lastErrorCode: string | null;
  scope: string | null;
  /** ซิงก์ระยะยาวได้หรือไม่ - ขึ้นกับว่ามี refresh token หรือเปล่า */
  syncCapable: boolean;
  syncCount: number;
}

export interface DriveStatusDto {
  configured: boolean;
  encryptionReady: boolean;
  connection: DriveConnectionDto | null;
}

export type DriveEntryKind =
  | 'FOLDER'
  | 'BINARY'
  | 'GOOGLE_DOC'
  | 'GOOGLE_SHEET'
  | 'GOOGLE_SLIDES'
  | 'SHORTCUT'
  | 'UNSUPPORTED';

export interface DriveEntryDto {
  id: string;
  name: string;
  kind: DriveEntryKind;
  mimeType: string;
  size: number | null;
  modifiedTime: string | null;
  webViewLink: string | null;
}

export interface DriveFilePageDto {
  items: DriveEntryDto[];
  nextPageToken: string | null;
}

export interface DriveImportItemDto {
  googleFileId: string;
  name: string;
  outcome: 'IMPORTED' | 'SKIPPED' | 'FAILED';
  resourceId?: string;
  reason?: string;
}

export interface DriveImportSummaryDto {
  imported: number;
  skipped: number;
  failed: number;
  items: DriveImportItemDto[];
}

export type DriveSyncStatus =
  | 'SYNCED'
  | 'UPDATE_AVAILABLE'
  | 'PAUSED_LIFECYCLE'
  | 'PAUSED_LEGAL_HOLD'
  | 'SOURCE_MISSING'
  | 'ERROR'
  | 'REAUTH_REQUIRED'
  | 'DISCONNECTED'
  | 'DETACHED';

export interface ResourceSyncDto {
  id: string;
  status: DriveSyncStatus;
  mode: string;
  remoteName: string | null;
  remoteWebUrl: string | null;
  googleAccountEmail: string;
  lastCheckedAt: string | null;
  lastSyncedAt: string | null;
  message: string | null;
}

export interface DriveCheckResultDto {
  outcome: string;
  status: DriveSyncStatus;
  message: string;
}

export interface AdminDriveConnectionDto {
  id: string;
  googleAccountEmail: string;
  state: DriveConnectionState;
  connectedAt: string;
  lastSuccessfulSyncAt: string | null;
  lastErrorCode: string | null;
  user: { id: string; displayName: string; email: string };
  syncCount: number;
}

export interface AdminDriveOverviewDto {
  configured: boolean;
  encryptionReady: boolean;
  pollSeconds: number;
  failingSyncs: number;
  connections: AdminDriveConnectionDto[];
}

export const googleDriveApi = {
  status: () => apiFetch<Ok<DriveStatusDto>>('/integrations/google-drive/status'),

  /** คืน URL ให้หน้าจอพาผู้ใช้ไปเอง - ไม่ใช่ redirect เพราะคำขอนี้มาจาก fetch */
  connect: (forceConsent?: boolean) =>
    apiFetch<Ok<{ url: string }>>('/integrations/google-drive/connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(forceConsent === undefined ? {} : { forceConsent }),
    }),

  disconnect: (connectionId: string) =>
    apiFetch<Ok<{ preservedResources: number }>>('/integrations/google-drive/disconnect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ connectionId }),
    }),

  files: (params: URLSearchParams) =>
    apiFetch<Ok<DriveFilePageDto>>(`/integrations/google-drive/files?${params.toString()}`),

  import: (input: {
    fileIds: string[];
    destinationParentId: string | null;
    mode: 'IMPORT_ONCE' | 'SYNCED';
    driveScope?: 'MY_DRIVE' | 'SYSTEM_DRIVE';
  }) =>
    apiFetch<Ok<DriveImportSummaryDto>>('/integrations/google-drive/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }),

  resourceSync: (resourceId: string) =>
    apiFetch<Ok<ResourceSyncDto | null>>(`/resources/${resourceId}/google-drive`),

  checkSync: (resourceId: string) =>
    apiFetch<Ok<DriveCheckResultDto>>(`/resources/${resourceId}/google-drive/check-sync`, {
      method: 'POST',
    }),

  detach: (resourceId: string) =>
    apiFetch<Ok<{ detached: true }>>(`/resources/${resourceId}/google-drive/detach`, {
      method: 'POST',
    }),

  adminOverview: () => apiFetch<Ok<AdminDriveOverviewDto>>('/admin/integrations/google-drive'),
};

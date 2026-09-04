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
export interface SearchHitDto extends ResourceDto {
  /** NAME | TAG | REMARK | CONTENT - บอกว่าทำไมผลลัพธ์นี้ถึงขึ้นมา */
  matchReason: string | null;
  /** ข้อความล้วนรอบคำค้น มีเฉพาะเมื่อตรงเพราะเนื้อในเอกสาร */
  contentSnippet: string | null;
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

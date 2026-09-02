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
};

export interface AuthUser {
  id: string;
  email: string;
  displayName: string;
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
  isLocked: boolean; itemCount: number; createdAt: string; updatedAt: string;
  visibility: 'ORGANIZATION' | 'RESTRICTED';
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
  deletedAt: string | null;
  deletedBy: { id: string; displayName: string; email: string } | null;
  originalLocation: string;
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
  createFolder: (input: { name: string; parentId?: string | null; ownerId?: string; remark?: string | null }) => apiFetch<ResourceResponse>('/folders', { method: 'POST', body: JSON.stringify(input) }),
  update: (id: string, input: { name?: string; remark?: string | null }) => apiFetch<ResourceResponse>(`/resources/${id}`, { method: 'PATCH', body: JSON.stringify(input) }),
  move: (id: string, parentId: string | null) => apiFetch<ResourceResponse>(`/resources/${id}/move`, { method: 'PATCH', body: JSON.stringify({ parentId }) }),
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
  limit?: number;
  cursor?: string;
}

export const usersApi = {
  list: (filter: UserListFilter = {}) => {
    const params = new URLSearchParams();
    if (filter.q) params.set('q', filter.q);
    if (filter.status) params.set('status', filter.status);
    if (filter.roleCode) params.set('roleCode', filter.roleCode);
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
  trash: () => apiFetch<{ success: true; data: TrashEntryDto[] }>('/trash'),
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


/* ---------- Phase E: พื้นที่ทำงานองค์กร ---------- */

export interface TagDto { id: string; name: string }

export interface AccessGrantDto {
  userId: string;
  user: { id: string; displayName: string; email: string };
  accessLevel: 'EDITOR' | 'VIEWER';
  allowDownload: boolean;
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

export interface SearchResultDto {
  items: ResourceDto[];
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
  grantAccess: (id: string, input: { userId: string; accessLevel: 'EDITOR' | 'VIEWER'; allowDownload: boolean }) =>
    apiFetch<Ok<AccessListDto>>(`/resources/${id}/access`, { method: 'POST', body: JSON.stringify(input) }),
  revokeAccess: (id: string, userId: string) =>
    apiFetch<Ok<AccessListDto>>(`/resources/${id}/access/${userId}`, { method: 'DELETE' }),
  sharedWithMe: () => apiFetch<Ok<SharedResourceDto[]>>('/shared'),
  shareTargets: (q: string) => apiFetch<Ok<Array<{ id: string; displayName: string; email: string }>>>(`/share-targets?q=${encodeURIComponent(q)}`),

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

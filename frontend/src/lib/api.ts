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
  canDelete: boolean; canShare: boolean; canDownload: boolean; canUploadVersion: boolean; canTransferOwner: boolean;
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

export interface PublicUser { id: string; email: string; displayName: string; status: string }
export const usersApi = { list: () => apiFetch<{ success: true; data: PublicUser[] }>('/users') };


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

import { getAccessToken, type UploadResultDto } from './api';

export { UPLOAD_ERROR_TEXT, uploadErrorText } from './error-text';

/**
 * อัปโหลดไฟล์พร้อมความคืบหน้าจริง
 *
 * ใช้ XMLHttpRequest เพราะ fetch ยังไม่มี upload progress ที่ใช้งานได้จริงในเบราว์เซอร์ทั่วไป
 * เปอร์เซ็นต์ที่แสดงจึงมาจากไบต์ที่ส่งออกไปจริง ไม่ใช่ตัวเลขจำลอง
 *
 * เซิร์ฟเวอร์เป็นผู้กำหนด storageKey, checksum และ MIME เสมอ
 * ฝั่งเบราว์เซอร์ส่งได้เพียงตัวไฟล์ ปลายทาง และการตัดสินใจของผู้ใช้
 */
export interface UploadOptions {
  file: File;
  parentId: string | null;
  remark?: string | null;
  onNameConflict?: 'NEW_VERSION' | 'KEEP_BOTH';
  allowDuplicateContent?: boolean;
  onProgress?: (percent: number) => void;
  signal?: AbortSignal;
}

export class UploadError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: unknown;

  constructor(code: string, message: string, status: number, details?: unknown) {
    super(message);
    this.name = 'UploadError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function send(path: string, form: FormData, options: UploadOptions): Promise<UploadResultDto> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('POST', path);
    request.withCredentials = true;

    const token = getAccessToken();
    if (token) request.setRequestHeader('Authorization', `Bearer ${token}`);
    request.setRequestHeader('Accept', 'application/json');

    request.upload.addEventListener('progress', (event) => {
      if (!event.lengthComputable || !options.onProgress) return;
      options.onProgress(Math.round((event.loaded / event.total) * 100));
    });

    request.addEventListener('load', () => {
      let body: unknown = null;
      try {
        body = request.responseText ? JSON.parse(request.responseText) : null;
      } catch {
        body = null;
      }

      if (request.status >= 200 && request.status < 300) {
        const payload = body as { data?: UploadResultDto } | null;
        if (payload?.data) {
          resolve(payload.data);
          return;
        }
        reject(new UploadError('FILE_UPLOAD_FAILED', 'อัปโหลดไฟล์ไม่สำเร็จ', request.status));
        return;
      }

      const error = (body as { error?: { code?: string; message?: string; details?: unknown } } | null)?.error;
      reject(
        new UploadError(
          error?.code ?? 'FILE_UPLOAD_FAILED',
          error?.message ?? 'อัปโหลดไฟล์ไม่สำเร็จ',
          request.status,
          error?.details,
        ),
      );
    });

    request.addEventListener('error', () =>
      reject(new UploadError('NETWORK_ERROR', 'เชื่อมต่อเซิร์ฟเวอร์ไม่ได้', 0)),
    );
    request.addEventListener('abort', () =>
      reject(new UploadError('UPLOAD_CANCELLED', 'ยกเลิกการอัปโหลดแล้ว', 0)),
    );

    options.signal?.addEventListener('abort', () => request.abort(), { once: true });

    request.send(form);
  });
}

export function uploadFile(options: UploadOptions): Promise<UploadResultDto> {
  const form = new FormData();
  if (options.parentId) form.append('parentId', options.parentId);
  if (options.remark) form.append('remark', options.remark);
  if (options.onNameConflict) form.append('onNameConflict', options.onNameConflict);
  if (options.allowDuplicateContent) form.append('allowDuplicateContent', 'true');
  form.append('file', options.file, options.file.name);

  return send('/api/resources/upload', form, options);
}

/** อัปโหลดเวอร์ชันใหม่ของไฟล์ที่มีอยู่แล้ว */
export function uploadNewVersion(
  resourceId: string,
  options: Omit<UploadOptions, 'parentId'> & { parentId?: string | null },
): Promise<UploadResultDto> {
  const form = new FormData();
  if (options.remark) form.append('remark', options.remark);
  form.append('file', options.file, options.file.name);

  return send(`/api/resources/${resourceId}/versions`, form, { ...options, parentId: null });
}

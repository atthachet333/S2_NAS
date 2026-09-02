import { authorizedFetch, fileApi } from './api';
import { uploadErrorText } from './error-text';

/**
 * ดาวน์โหลดไฟล์ผ่าน endpoint ที่ตรวจสิทธิ์แล้ว
 *
 * ดึงเป็น blob ก่อนแล้วค่อยสั่งบันทึก เพื่อให้:
 * - สิทธิ์ถูกตรวจจริงทุกครั้ง (ไม่ใช่การเปิดลิงก์ตรงไปยังไฟล์)
 * - ข้อผิดพลาดจากเซิร์ฟเวอร์แสดงเป็นข้อความไทยได้ แทนที่จะเปิดแท็บว่าง
 * - ชื่อไฟล์ภาษาไทยถูกต้องเสมอ
 */
export async function downloadResource(
  resourceId: string,
  fileName: string,
  version?: number,
): Promise<void> {
  const response = await authorizedFetch(fileApi.downloadPath(resourceId, version));

  if (!response.ok) {
    let code = `HTTP_${response.status}`;
    try {
      const body = (await response.json()) as { error?: { code?: string; message?: string } };
      code = body.error?.code ?? code;
      throw new Error(uploadErrorText(code, body.error?.message));
    } catch (error) {
      if (error instanceof Error && error.message) throw error;
      throw new Error(uploadErrorText(code, 'ดาวน์โหลดไม่สำเร็จ'));
    }
  }

  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);

  const link = document.createElement('a');
  link.href = objectUrl;
  link.download = version ? withVersionSuffix(fileName, version) : fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();

  // ปล่อยหน่วยความจำหลังเบราว์เซอร์เริ่มบันทึกไฟล์แล้ว
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 10_000);
}

/** ดาวน์โหลด ZIP แบบสตรีมผ่าน endpoint ที่ยืนยันตัวตน โดยไม่เปิดเผย storage URL */
export async function downloadZip(resourceIds: string[], folder?: { id: string; name: string }): Promise<void> {
  const path = folder ? fileApi.folderZipPath(folder.id) : fileApi.selectionZipPath;
  const response = await authorizedFetch(path, folder ? undefined : {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/zip' },
    body: JSON.stringify({ resourceIds }),
  });
  if (!response.ok) {
    let message = 'ดาวน์โหลด ZIP ไม่สำเร็จ';
    try {
      const body = (await response.json()) as { error?: { code?: string; message?: string } };
      message = uploadErrorText(body.error?.code ?? `HTTP_${response.status}`, body.error?.message ?? message);
    } catch { /* response ที่ไม่ใช่ JSON ใช้ข้อความกลาง */ }
    throw new Error(message);
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = folder ? `${folder.name}.zip` : `S2-NAS-Download-${new Date().toISOString().slice(0, 10)}.zip`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function withVersionSuffix(fileName: string, version: number): string {
  const dot = fileName.lastIndexOf('.');
  if (dot <= 0) return `${fileName} (v${version})`;
  return `${fileName.slice(0, dot)} (v${version})${fileName.slice(dot)}`;
}

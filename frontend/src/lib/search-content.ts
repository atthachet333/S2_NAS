/**
 * การแสดงผลของการค้นหาจากเนื้อในเอกสาร
 *
 * ทุกอย่างที่นี่เป็นข้อความล้วน ตัวอย่างข้อความที่มาจากเซิร์ฟเวอร์ถูกแสดงผ่าน
 * การผูกค่าของ React ตามปกติ ซึ่ง escape ให้เองอยู่แล้ว
 *
 * ห้ามใช้ dangerouslySetInnerHTML กับข้อความที่มาจากเอกสารของผู้ใช้เด็ดขาด
 * การเน้นคำจึงทำด้วยการ "ตัดข้อความเป็นชิ้น ๆ แล้วให้ React วาดแต่ละชิ้น"
 * ไม่ใช่ด้วยการแทรกแท็กเข้าไปในสตริง
 */

export type MatchReason = 'NAME' | 'TAG' | 'REMARK' | 'CONTENT';

export const MATCH_REASON_LABEL: Record<MatchReason, string> = {
  NAME: 'ตรงกับชื่อไฟล์',
  TAG: 'ตรงกับแท็ก',
  REMARK: 'ตรงกับหมายเหตุ',
  CONTENT: 'ตรงกับเนื้อหาเอกสาร',
};

export function matchReasonLabel(reason: string | null | undefined): string | null {
  if (!reason) return null;
  return MATCH_REASON_LABEL[reason as MatchReason] ?? null;
}

export interface SnippetPart {
  text: string;
  highlight: boolean;
}

/**
 * ตัดตัวอย่างข้อความเป็นชิ้น ๆ ตามตำแหน่งที่ตรงกับคำค้น
 *
 * คืนอาร์เรย์ของชิ้นข้อความ ไม่ใช่ HTML - หน้าจอวาดแต่ละชิ้นเป็นโหนดข้อความของตัวเอง
 * จึงไม่มีทางที่เนื้อหาในเอกสารจะกลายเป็นแท็กที่เบราว์เซอร์ตีความ
 */
export function splitSnippet(snippet: string, term: string): SnippetPart[] {
  const needle = term.trim().toLocaleLowerCase();
  if (!needle) return [{ text: snippet, highlight: false }];

  const parts: SnippetPart[] = [];
  const haystack = snippet.toLocaleLowerCase();

  let cursor = 0;
  for (let guard = 0; guard < 50; guard += 1) {
    const at = haystack.indexOf(needle, cursor);
    if (at < 0) break;
    if (at > cursor) parts.push({ text: snippet.slice(cursor, at), highlight: false });
    parts.push({ text: snippet.slice(at, at + needle.length), highlight: true });
    cursor = at + needle.length;
  }

  if (cursor < snippet.length) parts.push({ text: snippet.slice(cursor), highlight: false });
  return parts.length > 0 ? parts : [{ text: snippet, highlight: false }];
}

/* ------------------------------------------------------------------ */
/* สถานะของดัชนี                                                       */
/* ------------------------------------------------------------------ */

export type IndexStatus = 'PENDING' | 'PROCESSING' | 'READY' | 'NO_TEXT' | 'UNSUPPORTED' | 'FAILED';

/**
 * ข้อความอธิบายสถานะ - เขียนจากมุมของผู้ใช้ ไม่ใช่จากมุมของระบบ
 *
 * "ไม่พบข้อความ" ตรงไปตรงมากว่า "สกัดไม่สำเร็จ" สำหรับเอกสารสแกน
 * เพราะไฟล์ไม่ได้เสีย เพียงแต่ระบบนี้ยังอ่านภาพไม่ได้
 */
export const INDEX_STATUS_LABEL: Record<IndexStatus, string> = {
  PENDING: 'รอประมวลผล',
  PROCESSING: 'กำลังประมวลผล',
  READY: 'พร้อมค้นหาเนื้อหา',
  NO_TEXT: 'ไม่พบข้อความในไฟล์',
  UNSUPPORTED: 'ไม่รองรับการค้นหาเนื้อหา',
  FAILED: 'ประมวลผลไม่สำเร็จ',
};

export function indexStatusLabel(status: string | null | undefined): string | null {
  if (!status) return null;
  return INDEX_STATUS_LABEL[status as IndexStatus] ?? null;
}

/* ------------------------------------------------------------------ */
/* ประวัติการอัปโหลดของลูกค้า                                          */
/* ------------------------------------------------------------------ */

export type UploadHistoryState = 'AVAILABLE' | 'MANAGED_BY_STAFF' | 'UNAVAILABLE';

/**
 * โทนสีของสถานะ
 *
 * "เจ้าหน้าที่รับเรื่องแล้ว" ไม่ใช่ความผิดพลาด จึงไม่ใช้สีเตือน
 * ลูกค้าที่ส่งเอกสารมาแล้วเห็นสีแดงจะเข้าใจว่าส่งไม่สำเร็จ ทั้งที่สำเร็จแล้ว
 */
export const UPLOAD_STATE_TONE: Record<UploadHistoryState, 'success' | 'muted' | 'danger'> = {
  AVAILABLE: 'success',
  MANAGED_BY_STAFF: 'muted',
  UNAVAILABLE: 'danger',
};

export function uploadStateTone(state: string | null | undefined): 'success' | 'muted' | 'danger' {
  return UPLOAD_STATE_TONE[(state ?? '') as UploadHistoryState] ?? 'muted';
}

/**
 * ข้อความและสถานะของการอ่านข้อความจากเอกสาร (OCR) ฝั่งหน้าจอ
 *
 * OCR เป็นการคาดเดาของเครื่อง หน้าจอจึงต้องไม่นำเสนอผลลัพธ์ราวกับเป็นความจริงที่ยืนยันแล้ว
 * และต้องไม่ชวนให้ผู้ใช้กดสิ่งที่ระบบทำให้ไม่ได้
 */

export type OcrStatus = 'PENDING' | 'PROCESSING' | 'READY' | 'NO_TEXT' | 'UNSUPPORTED' | 'FAILED';

export interface OcrStateDto {
  eligible: boolean;
  reason: string | null;
  kind: 'IMAGE' | 'SCANNED_PDF' | null;
  status: string | null;
  textSource: string | null;
  ocrRequested: boolean;
  ocrCompletedAt: string | null;
  ocrConfidence: number | null;
  ocrPageCount: number | null;
  truncated: boolean;
  engineAvailable: boolean;
}

export type OcrAction =
  | { kind: 'START'; label: string }
  | { kind: 'RETRY'; label: string }
  | { kind: 'BUSY'; label: string }
  | { kind: 'NONE'; label: string };

/**
 * ปุ่มที่ควรแสดงสำหรับเอกสารหนึ่งชิ้น
 *
 * เอกสารที่อ่านไปแล้วต้องไม่แสดงปุ่ม "สแกนข้อความ" ราวกับยังไม่เคยทำอะไร
 * ผู้ใช้ที่เห็นปุ่มเดิมหลังกดไปแล้วจะไม่รู้ว่าสำเร็จหรือไม่ และจะกดซ้ำโดยไม่จำเป็น
 */
export function ocrActionFor(state: OcrStateDto | null): OcrAction {
  if (!state) return { kind: 'NONE', label: '' };

  if (!state.engineAvailable) {
    // ไม่มีเครื่องมือในเครื่อง - บอกตรง ๆ ดีกว่าแสดงปุ่มที่กดแล้วล้มเหลวเสมอ
    return { kind: 'NONE', label: 'ระบบยังไม่ได้ตั้งค่าการอ่านข้อความจากเอกสาร' };
  }

  if (!state.eligible) return { kind: 'NONE', label: state.reason ?? 'ไม่รองรับการอ่านข้อความ' };

  if (state.status === 'PENDING' || state.status === 'PROCESSING') {
    return { kind: 'BUSY', label: 'กำลังสแกนข้อความ…' };
  }

  // อ่านไปแล้ว - เสนอ "สแกนใหม่" ไม่ใช่ปุ่มเดิม
  if ((state.textSource === 'OCR' || state.textSource === 'HUMAN_CORRECTED') && state.status === 'READY') {
    return { kind: 'RETRY', label: 'สแกนข้อความใหม่' };
  }
  if (state.ocrRequested && state.status === 'NO_TEXT') {
    return { kind: 'RETRY', label: 'สแกนข้อความใหม่' };
  }
  if (state.ocrRequested && state.status === 'FAILED') {
    return { kind: 'RETRY', label: 'ลองสแกนอีกครั้ง' };
  }

  return { kind: 'START', label: 'สแกนข้อความด้วย OCR' };
}

/** ข้อความสถานะที่แสดงคู่กับปุ่ม - เขียนจากมุมของผู้ใช้ ไม่ใช่จากมุมของระบบ */
export function ocrStatusLabel(state: OcrStateDto | null): string | null {
  if (!state || !state.eligible) return null;

  if (state.status === 'PENDING') return 'รอสแกนข้อความ';
  if (state.status === 'PROCESSING') return 'กำลังสแกนข้อความ';
  if (state.textSource === 'HUMAN_CORRECTED') return 'ตรวจแก้แล้ว';
  if (state.textSource === 'OCR' && state.status === 'READY') return 'สแกนข้อความแล้ว';
  if (state.ocrRequested && state.status === 'NO_TEXT') return 'สแกนแล้วแต่ไม่พบข้อความ';
  if (state.ocrRequested && state.status === 'FAILED') return 'สแกนไม่สำเร็จ';
  return 'พร้อมสแกนข้อความ';
}

/**
 * คำเตือนว่าข้อความจาก OCR อาจไม่ถูกต้อง
 *
 * แสดงเมื่อข้อความมาจากการอ่านภาพเท่านั้น ไม่แสดงกับข้อความที่ฝังอยู่ในไฟล์จริง
 * เพราะสองอย่างนี้เชื่อถือได้ไม่เท่ากัน และการเตือนกับทุกอย่างเท่ากับไม่ได้เตือนอะไรเลย
 */
export function ocrAccuracyNotice(textSource: string | null | undefined): string | null {
  return textSource === 'OCR' ? 'ข้อความจาก OCR อาจไม่ถูกต้องทั้งหมด' : null;
}

/** ข้อความที่ผ่านการตรวจแก้แล้ว บอกให้ผู้ใช้รู้ว่าเชื่อถือได้กว่าผลดิบ */
export function correctedNotice(textSource: string | null | undefined): string | null {
  return textSource === 'HUMAN_CORRECTED' ? 'ข้อความนี้ผ่านการตรวจแก้โดยผู้ใช้แล้ว' : null;
}

/**
 * ป้ายสั้น ๆ ในผลการค้นหา บอกที่มาของข้อความที่ตรงกัน
 *
 * "ตรวจแก้แล้ว" ต่างจาก "OCR" อย่างมีความหมาย - อันหนึ่งมีคนอ่านด้วยตาแล้วยืนยัน
 * อีกอันเป็นการเดาของเครื่องล้วน ๆ ผู้ใช้ควรเห็นความต่างนี้ก่อนเชื่อผลลัพธ์
 */
export function textSourceBadge(textSource: string | null | undefined): string | null {
  if (textSource === 'HUMAN_CORRECTED') return 'ตรวจแก้แล้ว';
  return textSource === 'OCR' ? 'OCR' : null;
}

/**
 * ข้อความอธิบายผลของ OCR สำหรับหน้ารายละเอียด
 * คืน null เมื่อไม่มีอะไรน่าบอก - ไม่เติมข้อความให้รกโดยไม่จำเป็น
 */
export function ocrSummary(state: OcrStateDto | null): string | null {
  if (!state) return null;
  if (state.textSource !== 'OCR' && state.textSource !== 'HUMAN_CORRECTED') return null;

  const parts: string[] = [];
  if (state.ocrPageCount !== null) parts.push(`${state.ocrPageCount} หน้า`);
  /**
   * ความมั่นใจเป็นข้อมูลวินิจฉัย ไม่ใช่การรับประกันความถูกต้อง
   * จึงเขียนว่า "ความมั่นใจของระบบ" ไม่ใช่ "ความแม่นยำ"
   */
  if (state.ocrConfidence !== null) parts.push(`ความมั่นใจของระบบ ${state.ocrConfidence}%`);
  if (state.truncated) parts.push('อ่านได้ไม่ครบทั้งฉบับ');

  return parts.length > 0 ? parts.join(' · ') : null;
}


/** ข้อความของเอกสารพร้อมข้อมูลการตรวจแก้ */
export interface OcrTextDto {
  available: boolean;
  status: string | null;
  textSource: string | null;
  /** ข้อความที่มีผลใช้งาน - ฉบับที่ตรวจแก้แล้วถ้ามี */
  text: string;
  /** ผลดิบของเครื่อง ใช้เทียบเคียง */
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

/** หนึ่งรายการในประวัติการตรวจแก้ - ไม่มีตัวข้อความ มีแต่ว่าใครแก้เมื่อไร */
export interface CorrectionHistoryDto {
  revision: number;
  characterCount: number;
  createdAt: string;
  createdBy: { id: string; name: string };
}

import { ApiError } from './api';

/**
 * แยกแยะสาเหตุที่คำขอไม่สำเร็จ (F24-K)
 *
 * **ทำไมต้องแยก:** ทั้งห้ากรณีนี้ทำให้หน้าจอว่างเหมือนกัน แต่สิ่งที่ผู้ใช้ควรทำต่อ
 * ต่างกันสิ้นเชิง คนที่เน็ตหลุดต้องไปหาสัญญาณ คนที่เซิร์ฟเวอร์ล่มต้องแจ้งผู้ดูแล
 * คนที่หมดเวลาใช้งานต้องเข้าระบบใหม่ และคนที่ฟีเจอร์ยังไม่เปิดต้องรอผู้ดูแลติดตั้ง
 *
 * **กฎที่สำคัญที่สุด: ห้ามบอกว่าเครื่องออฟไลน์เพียงเพราะคำขอล้มเหลว**
 * เซิร์ฟเวอร์ล่มขณะที่เน็ตของผู้ใช้ปกติดี เป็นกรณีที่พบบ่อยกว่าเน็ตหลุดเสียอีก
 * การกล่าวโทษเครื่องของผู้ใช้จะทำให้เขาเสียเวลาไปรีสตาร์ตเราเตอร์โดยเปล่าประโยชน์
 */
export type NetworkFailure =
  /** เบราว์เซอร์ยืนยันว่าเครื่องไม่ได้ต่อเครือข่าย */
  | 'DEVICE_OFFLINE'
  /** เครื่องออนไลน์ แต่ติดต่อเซิร์ฟเวอร์ไม่ได้ หรือเซิร์ฟเวอร์ตอบผิดพลาดภายใน */
  | 'BACKEND_UNAVAILABLE'
  /** ต้องเข้าสู่ระบบใหม่ */
  | 'SESSION_EXPIRED'
  /** ฟีเจอร์ยังไม่เปิดใช้งานหรือยังไม่พร้อม */
  | 'FEATURE_UNAVAILABLE'
  /** คำขอผิดพลาดตามปกติของธุรกิจ เช่น ข้อมูลไม่ถูกต้อง หรือไม่มีสิทธิ์ */
  | 'REQUEST_ERROR';

export interface FailureContext {
  /** เบราว์เซอร์เชื่อว่ามีเส้นทางออกเครือข่ายหรือไม่ */
  online: boolean;
}

/** รหัสที่หมายถึงฟีเจอร์ยังไม่พร้อม ไม่ใช่ความผิดพลาดของผู้ใช้หรือเครือข่าย */
const FEATURE_CODES = new Set([
  'ASSISTANT_DISABLED',
  'ASSISTANT_NOT_READY',
  'ASSISTANT_MODEL_UNAVAILABLE',
  'SEMANTIC_SEARCH_UNAVAILABLE',
  'SMART_FILING_DISABLED',
  'SMART_FILING_TEXT_NOT_READY',
]);

export function classifyFailure(error: unknown, context: FailureContext): NetworkFailure {
  /**
   * ค่าเท็จของ navigator.onLine เชื่อถือได้ ส่วนค่าจริงเชื่อถือไม่ได้
   *
   * ถ้าเบราว์เซอร์บอกว่าออฟไลน์ ก็ออฟไลน์แน่ แต่การบอกว่าออนไลน์ไม่ได้แปลว่า
   * ไปถึงเซิร์ฟเวอร์ของเราได้ จึงตรวจข้อนี้ก่อน แล้วที่เหลือดูจากตัวข้อผิดพลาดเอง
   */
  if (!context.online) return 'DEVICE_OFFLINE';

  if (error instanceof ApiError) {
    if (error.status === 401) return 'SESSION_EXPIRED';
    if (FEATURE_CODES.has(error.code)) return 'FEATURE_UNAVAILABLE';
    // สถานะ 0 คือคำขอไปไม่ถึงเซิร์ฟเวอร์เลย ส่วน 5xx คือไปถึงแล้วแต่เซิร์ฟเวอร์พัง
    if (error.status === 0 || error.code === 'NETWORK_ERROR') return 'BACKEND_UNAVAILABLE';
    if (error.status >= 500) return 'BACKEND_UNAVAILABLE';
    return 'REQUEST_ERROR';
  }

  // ข้อผิดพลาดที่ไม่ใช่ของ API เช่น fetch ล้มเหลวดิบ ๆ ถือว่าไปไม่ถึงเซิร์ฟเวอร์
  return 'BACKEND_UNAVAILABLE';
}

const MESSAGES: Record<NetworkFailure, string> = {
  DEVICE_OFFLINE: 'อุปกรณ์ของคุณไม่ได้เชื่อมต่ออินเทอร์เน็ต',
  BACKEND_UNAVAILABLE: 'ติดต่อเซิร์ฟเวอร์ไม่ได้ในขณะนี้',
  SESSION_EXPIRED: 'เซสชันหมดอายุ กรุณาเข้าสู่ระบบอีกครั้ง',
  FEATURE_UNAVAILABLE: 'ฟีเจอร์นี้ยังไม่พร้อมใช้งาน',
  REQUEST_ERROR: 'ดำเนินการไม่สำเร็จ',
};

export function failureMessage(failure: NetworkFailure): string {
  return MESSAGES[failure];
}

/** การกระทำนี้ควรถูกกันไว้ก่อนยิงคำขอหรือไม่ - จริงเฉพาะเมื่อรู้แน่ว่าออฟไลน์ */
export function shouldBlockWrite(online: boolean): boolean {
  return !online;
}

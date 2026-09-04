/**
 * ข้อความและกติกาของการเข้าสู่ระบบด้วย Google ฝั่งหน้าจอ
 *
 * backend ส่งกลับมาเฉพาะ "รหัสเหตุผล" ที่ปลอดภัย ไม่ใช่ข้อความดิบจาก Google
 * หน้าจอเป็นผู้แปลรหัสเป็นภาษาที่ผู้ใช้อ่านแล้วรู้ว่าต้องทำอะไรต่อ
 */

export type GoogleLoginErrorCode =
  | 'ACCOUNT_NOT_ALLOWED'
  | 'ACCOUNT_DISABLED'
  | 'IDENTITY_CONFLICT'
  | 'GOOGLE_AUTH_FAILED'
  | 'GOOGLE_TOKEN_INVALID'
  | 'GOOGLE_EMAIL_UNVERIFIED'
  | 'GOOGLE_STATE_INVALID'
  | 'GOOGLE_STATE_EXPIRED'
  | 'GOOGLE_NOT_CONFIGURED';

const MESSAGES: Record<GoogleLoginErrorCode, string> = {
  ACCOUNT_NOT_ALLOWED: 'บัญชี Google นี้ยังไม่ได้รับอนุญาตให้ใช้งาน S2 NAS กรุณาติดต่อผู้ดูแลระบบ',
  ACCOUNT_DISABLED: 'บัญชีนี้ถูกปิดการใช้งาน',
  IDENTITY_CONFLICT: 'บัญชี Google นี้เชื่อมกับผู้ใช้อื่นอยู่แล้ว กรุณาติดต่อผู้ดูแลระบบ',
  GOOGLE_AUTH_FAILED: 'ไม่สามารถเข้าสู่ระบบด้วย Google ได้ กรุณาลองใหม่',
  GOOGLE_TOKEN_INVALID: 'ไม่สามารถยืนยันข้อมูลจาก Google ได้ กรุณาลองใหม่',
  GOOGLE_EMAIL_UNVERIFIED: 'อีเมลของบัญชี Google นี้ยังไม่ได้รับการยืนยัน',
  GOOGLE_STATE_INVALID: 'คำขอเข้าสู่ระบบไม่ถูกต้อง กรุณาลองใหม่',
  GOOGLE_STATE_EXPIRED: 'คำขอเข้าสู่ระบบหมดอายุ กรุณาลองใหม่',
  GOOGLE_NOT_CONFIGURED: 'ยังไม่ได้เปิดใช้งานการเข้าสู่ระบบด้วย Google',
};

/**
 * แปลรหัสเหตุผลเป็นข้อความไทย
 *
 * รหัสที่ไม่รู้จักตกไปที่ข้อความกลาง ไม่ใช่แสดงรหัสดิบให้ผู้ใช้เดาเอง
 */
export function googleLoginMessage(code: string | null | undefined): string | null {
  if (!code) return null;
  return MESSAGES[code as GoogleLoginErrorCode] ?? MESSAGES.GOOGLE_AUTH_FAILED;
}

/** ปลายทางเริ่มต้นขั้นตอน - backend เป็นผู้จัดการ state/PKCE ทั้งหมด */
export function googleStartUrl(returnTo?: string): string {
  const path = '/api/auth/google/start';
  if (!returnTo) return path;
  return `${path}?returnTo=${encodeURIComponent(returnTo)}`;
}

/** ตัวพาเปลี่ยนหน้าจริงของเบราว์เซอร์ - แยกออกมาเพื่อให้ทดสอบได้โดยไม่ต้องออกจากหน้า */
export type TopLevelNavigator = (url: string) => void;

const browserNavigate: TopLevelNavigator = (url) => {
  window.location.assign(url);
};

/**
 * เริ่มขั้นตอนเข้าสู่ระบบด้วย Google
 *
 * ต้องเป็นการ "เปลี่ยนหน้าทั้งหน้า" เท่านั้น ห้ามใช้ fetch/XHR เด็ดขาด
 *
 * /api/auth/google/start ตอบกลับด้วย 302 ไปยัง accounts.google.com
 * ถ้าเรียกผ่าน fetch เบราว์เซอร์จะตามรีไดเรกต์อยู่เบื้องหลังแล้วคืนผลลัพธ์มาให้โค้ด
 * ผู้ใช้จะยังคงค้างอยู่ที่หน้าเข้าสู่ระบบ และไม่มีวันได้เห็นหน้าของ Google เลย
 *
 * ด้วยเหตุผลเดียวกัน จึงไม่ใช้ <a href> ที่ re-render ตัวเองระหว่างคลิก
 * เพราะการเปลี่ยน DOM ของอิลิเมนต์ที่กำลังถูกคลิกอาจทำให้เบราว์เซอร์ยกเลิกการนำทางเริ่มต้น
 */
export function startGoogleLogin(returnTo?: string, navigate: TopLevelNavigator = browserNavigate): void {
  navigate(googleStartUrl(returnTo));
}

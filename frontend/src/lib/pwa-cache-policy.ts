/**
 * สิ่งที่ได้รับอนุญาตให้อยู่ใน Cache Storage (F24-B)
 *
 * **ทำไมต้องเป็นโมดูลแยก ไม่ใช่แค่ค่าตั้งใน vite.config:** ค่าตั้งของ Workbox
 * บอกว่าเราตั้งใจเก็บอะไร แต่ไม่ได้พิสูจน์ว่าสิ่งที่ลงไปอยู่บนเครื่องผู้ใช้จริง ๆ
 * คือสิ่งนั้น กฎในไฟล์นี้เป็นตัวตัดสินที่ตรวจสอบย้อนกลับได้ ทั้งจากชุดทดสอบ
 * และจากการอ่าน Cache Storage จริงในเบราว์เซอร์
 *
 * **หลักการ:** อนุญาตเฉพาะสิ่งที่รู้จักว่าปลอดภัย ไม่ใช่ห้ามเฉพาะสิ่งที่นึกออกว่าอันตราย
 * รายการห้ามจะพลาดเสมอเมื่อมีปลายทางใหม่เพิ่มเข้ามา รายการอนุญาตจะปฏิเสธของใหม่
 * โดยอัตโนมัติจนกว่าจะมีคนตัดสินใจว่ามันปลอดภัยจริง
 */

/** นามสกุลของไฟล์เปลือกแอป - ไม่มีไฟล์ไหนมีข้อมูลของผู้ใช้อยู่ข้างใน */
const SHELL_EXTENSIONS = ['.js', '.css', '.woff2', '.svg', '.ico', '.webmanifest'];

/** ไอคอนและโลโก้ของแบรนด์ที่อนุญาตให้เก็บได้ - เป็นภาพนิ่งของระบบ ไม่ใช่เอกสารของใคร */
const ALLOWED_IMAGES = [
  '/icon-144x144.png',
  '/pwa-192x192.png',
  '/pwa-512x512.png',
  '/pwa-maskable-512x512.png',
  '/apple-touch-icon.png',
  '/favicon.png',
  '/favicon-32x32.png',
  '/favicon-16x16.png',
  '/favicon-48x48.png',
  '/s2-nas-logo.png',
];

/** เปลือกหน้าจอที่ใช้ตอนออฟไลน์ */
const ALLOWED_DOCUMENTS = ['/', '/index.html'];

export interface CacheViolation {
  url: string;
  reason: string;
}

/**
 * เส้นทางที่มีข้อมูลของผู้ใช้อยู่ ห้ามปรากฏใน Cache Storage ไม่ว่ากรณีใด
 *
 * ใช้เพื่อบอก "เหตุผล" ที่อ่านเข้าใจได้เวลาตรวจเจอ ไม่ได้ใช้เป็นตัวตัดสินหลัก
 * ตัวตัดสินหลักคือรายการอนุญาตด้านบน
 */
const SENSITIVE_HINTS: Array<{ test: (path: string) => boolean; reason: string }> = [
  { test: (p) => p.startsWith('/api/'), reason: 'คำตอบของ API มีข้อมูลของผู้ใช้' },
  { test: (p) => p.includes('/download'), reason: 'ไบต์ของเอกสารที่ตรวจสิทธิ์แล้ว' },
  { test: (p) => p.includes('/content') || p.includes('/preview') || p.includes('/thumbnail'), reason: 'เนื้อหาหรือภาพตัวอย่างของเอกสาร' },
  { test: (p) => p.startsWith('/s/'), reason: 'ลิงก์แชร์ภายนอกชี้ไปยังเอกสารจริง' },
];

/** แยกเฉพาะส่วนเส้นทางออกมา รองรับทั้ง URL เต็มและเส้นทางล้วน */
function pathOf(url: string): string {
  try {
    return new URL(url, 'http://s2-nas.invalid').pathname;
  } catch {
    return url;
  }
}

/** รายการนี้อนุญาตให้เก็บไว้ได้หรือไม่ */
export function isCacheableShellAsset(url: string): boolean {
  const path = pathOf(url);
  if (ALLOWED_DOCUMENTS.includes(path)) return true;
  if (ALLOWED_IMAGES.includes(path)) return true;
  // ชุดอักษรเวียดนามไม่ถูกใช้ จึงไม่ควรถูกเก็บแม้จะเป็นฟอนต์ก็ตาม
  if (path.includes('vietnamese')) return false;
  return SHELL_EXTENSIONS.some((extension) => path.endsWith(extension));
}

/**
 * ตรวจรายการที่อยู่ใน Cache Storage จริง แล้วคืนสิ่งที่ไม่ควรอยู่ตรงนั้น
 *
 * ผลลัพธ์ว่างเปล่าคือสิ่งที่ต้องได้หลังใช้งานครบทุกฟีเจอร์แล้ว
 */
export function findForbiddenCacheEntries(urls: readonly string[]): CacheViolation[] {
  const violations: CacheViolation[] = [];
  for (const url of urls) {
    if (isCacheableShellAsset(url)) continue;
    const path = pathOf(url);
    const hint = SENSITIVE_HINTS.find((entry) => entry.test(path));
    violations.push({
      url,
      reason: hint ? hint.reason : 'ไม่อยู่ในรายการทรัพยากรเปลือกแอปที่อนุญาต',
    });
  }
  return violations;
}

/**
 * คำขอนี้ถูกส่งผ่านไปยังเครือข่ายโดยไม่แตะแคชใช่หรือไม่
 *
 * ใช้ยืนยันว่าเส้นทางที่อ่อนไหวถูกกันออกตั้งแต่ระดับการตัดสินใจ ไม่ใช่กันตอนเขียนลงดิสก์
 */
export function mustBypassCache(url: string): boolean {
  const path = pathOf(url);
  return SENSITIVE_HINTS.some((entry) => entry.test(path)) || !isCacheableShellAsset(url);
}

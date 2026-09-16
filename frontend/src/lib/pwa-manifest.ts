/**
 * เอกลักษณ์ของ S2 NAS ในฐานะแอปที่ติดตั้งได้ (F24-B)
 *
 * **ทำไมอยู่ที่นี่ ไม่ใช่ใน vite.config:** ค่าที่ฝังอยู่ในไฟล์ตั้งค่าของเครื่องมือ build
 * ทดสอบไม่ได้ ต้องรอให้ build เสร็จแล้วไปอ่านผลลัพธ์ ซึ่งแปลว่าความผิดพลาดอย่าง
 * ไอคอนหาย หรือ start_url ผิด จะถูกพบหลังจากมันไปอยู่บนเครื่องผู้ใช้แล้ว
 * การประกาศไว้เป็นข้อมูลธรรมดาทำให้ตรวจได้ตั้งแต่ก่อน build
 *
 * ค่าสีมาจากโทเค็นธีมที่ใช้อยู่แล้ว ไม่ได้สร้างชุดสีใหม่ขึ้นมาอีกชุด:
 * theme_color คือสีของแถบหัวเรื่องในธีมสว่าง (--s2-header)
 * background_color คือสีพื้นของแอป (--s2-bg) เพื่อให้หน้าจอตอนเปิดต่อเนื่องกับแอปจริง
 */

export interface PwaIcon {
  src: string;
  sizes: string;
  type: string;
  purpose: 'any' | 'maskable';
}

export interface PwaManifest {
  name: string;
  short_name: string;
  description: string;
  lang: string;
  dir: 'ltr' | 'rtl';
  display: 'standalone' | 'fullscreen' | 'minimal-ui' | 'browser';
  start_url: string;
  scope: string;
  orientation: 'any' | 'portrait' | 'landscape';
  theme_color: string;
  background_color: string;
  icons: PwaIcon[];
}

export const S2_NAS_MANIFEST: PwaManifest = {
  name: 'S2 NAS',
  short_name: 'S2 NAS',
  description: 'ระบบจัดเก็บเอกสารและไฟล์บนเซิร์ฟเวอร์',
  lang: 'th',
  dir: 'ltr',
  display: 'standalone',
  start_url: '/',
  scope: '/',
  /**
   * ไม่ล็อกแนวการแสดงผล
   *
   * โทรศัพท์ใช้แนวตั้งเป็นหลักก็จริง แต่การอ่านเอกสารและตารางบนแท็บเล็ต
   * ได้ประโยชน์จากแนวนอนชัดเจน การบังคับแนวตั้งจะกันผู้ใช้ออกจากสิ่งที่เขาต้องการทำ
   */
  orientation: 'any',
  theme_color: '#ffffff',
  background_color: '#edf1f7',
  icons: [
    { src: '/pwa-192x192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: '/pwa-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: '/pwa-maskable-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ],
};

/**
 * รูปแบบไฟล์ที่อนุญาตให้เก็บล่วงหน้า และรูปแบบที่ต้องไม่ถูกเก็บ
 *
 * ประกาศไว้เป็นข้อมูลเพื่อให้ชุดทดสอบตรวจค่าตั้งของ Workbox ได้ว่าตรงกับเจตนา
 */
export const PRECACHE_GLOBS = [
  '**/*.{js,css,html}',
  'assets/**/*.woff2',
  'apple-touch-icon.png',
  'favicon*.{png,svg,ico}',
  's2-nas-logo.png',
] as const;

export const PRECACHE_IGNORES = ['**/*vietnamese*', '**/node_modules/**'] as const;

/** เส้นทางที่ห้ามตกไปใช้เปลือกแอปแทนคำตอบจริง */
export const NAVIGATION_DENYLIST = [/^\/api\//, /^\/s\//] as const;

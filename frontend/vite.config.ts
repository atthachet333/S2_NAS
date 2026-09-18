import path from 'node:path';
import { defineConfig, type PluginOption } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';
import {
  NAVIGATION_DENYLIST, PRECACHE_GLOBS, PRECACHE_IGNORES, S2_NAS_MANIFEST,
} from './src/lib/pwa-manifest';

const FRONTEND_PORT = 8888;
const BACKEND_PORT = 8889;
const BACKEND_URL = `http://localhost:${BACKEND_PORT}`;

const LINE = '='.repeat(60);
const c = (code: string, text: string) =>
  process.stdout.isTTY && !process.env.NO_COLOR ? `\u001b[${code}m${text}\u001b[0m` : text;

/** แสดง banner ของ S2 NAS ใน CMD / Terminal ตอน Frontend start */
function s2nasBanner(): PluginOption {
  return {
    name: 's2-nas-banner',
    apply: 'serve',
    configureServer(server) {
      server.httpServer?.once('listening', () => {
        const out = [
          '',
          c('36', LINE),
          ' ' + c('1', 'S2 NAS'),
          ' ระบบจัดเก็บเอกสารและไฟล์บนเซิร์ฟเวอร์',
          c('36', LINE),
          '',
          `${c('36', '[FRONTEND]')} URL        : http://localhost:${FRONTEND_PORT}`,
          `${c('36', '[BACKEND]')}  API        : ${BACKEND_URL}/api`,
          `${c('36', '[PROXY]')}    /api       : ${BACKEND_URL}`,
          '',
          `${c('32', '[S2 NAS]')} Frontend ready`,
          c('36', LINE),
          '',
        ].join('\n');
        process.stdout.write(out + '\n');
      });
    },
  };
}

/**
 * S2 NAS ในฐานะแอปที่ติดตั้งได้ (F24-B)
 *
 * **กฎข้อเดียวที่สำคัญที่สุดของไฟล์นี้: ห้าม service worker แตะ /api เด็ดขาด**
 *
 * โทเค็นของระบบนี้เดินทางใน Authorization header ไม่ใช่คุกกี้ คำตอบของ /api
 * จึงไม่มีอะไรผูกกับผู้ใช้ในตัวคำขอที่แคชจะแยกออกได้ ถ้า service worker เก็บคำตอบไว้
 * ผู้ใช้คนถัดไปบนเครื่องเดียวกันอาจได้เห็นเอกสารของคนก่อนหน้า และการออกจากระบบ
 * จะไม่ลบสิ่งที่ถูกเก็บไว้แล้ว นี่คือเหตุผลที่ไม่มี runtimeCaching สำหรับ /api เลย
 * แม้แต่แบบ NetworkFirst ซึ่งดูปลอดภัยแต่ยังเขียนลงดิสก์อยู่ดี
 *
 * สิ่งที่เก็บได้คือเปลือกแอปล้วน ๆ: โค้ด สไตล์ ฟอนต์ และไอคอน ทั้งหมดไม่มีข้อมูลผู้ใช้
 */
const pwa = VitePWA({
  registerType: 'prompt',
  // ลงทะเบียนเองในโค้ดแอป เพื่อคุมจังหวะการอัปเดตไม่ให้ไปขัดการอัปโหลดที่ทำอยู่
  injectRegister: null,
  includeAssets: [],
  // เอกลักษณ์ของแอปถูกประกาศไว้ที่เดียวใน src/lib/pwa-manifest.ts เพื่อให้ตรวจได้ด้วยชุดทดสอบ
  manifest: S2_NAS_MANIFEST,
  workbox: {
    /**
     * เก็บล่วงหน้าเฉพาะเปลือกแอป
     *
     * ฟอนต์เก็บเฉพาะ woff2 เพราะเบราว์เซอร์ทุกตัวที่รันแอปนี้ได้รองรับ woff2 อยู่แล้ว
     * ไฟล์ woff รุ่นเก่าอีก 20 ไฟล์จึงเป็นน้ำหนักเปล่า ๆ บนเครื่องผู้ใช้
     */
    /**
     * ไม่ใส่ pwa-*.png ตรงนี้ เพราะปลั๊กอินเพิ่มไอคอนของ manifest ให้อยู่แล้ว
     * การใส่ซ้ำทำให้ไฟล์เดียวถูกระบุสองรอบในรายการติดตั้ง
     */
    globPatterns: [...PRECACHE_GLOBS],
    // ชุดอักษรเวียดนามไม่ถูกใช้ในระบบไทย/อังกฤษนี้ ไม่ต้องส่งไปกินที่บนเครื่องผู้ใช้
    globIgnores: [...PRECACHE_IGNORES],
    navigateFallback: '/index.html',
    /**
     * คำขอที่ต้องไม่ถูกตอบด้วยเปลือกแอป
     *
     * ถ้า /api ตกไปใช้ navigateFallback ขณะออฟไลน์ ผู้เรียกจะได้ HTML แทน JSON
     * แล้วตีความว่าเซิร์ฟเวอร์ตอบอะไรแปลก ๆ แทนที่จะรู้ว่าเครือข่ายหลุด
     */
    navigateFallbackDenylist: [...NAVIGATION_DENYLIST],
    // ไม่มี runtimeCaching โดยตั้งใจ - ดูคำอธิบายด้านบน
    runtimeCaching: [],
    cleanupOutdatedCaches: true,
    clientsClaim: false,
    skipWaiting: false,
    maximumFileSizeToCacheInBytes: 3 * 1024 * 1024,
  },
  devOptions: {
    // ปิดใน dev เพื่อไม่ให้ service worker เก่าค้างระหว่างพัฒนา เปิดเฉพาะตอนต้องทดสอบ
    enabled: false,
  },
});

export default defineConfig({
  plugins: [react(), tailwindcss(), s2nasBanner(), pwa],
  resolve: {
    alias: { '@': path.resolve(import.meta.dirname, 'src') },
  },
  server: {
    port: FRONTEND_PORT,
    strictPort: true,
    host: true,
    proxy: {
      '/api': {
        target: BACKEND_URL,
        changeOrigin: true,
      },
    },
  },
  /**
   * โหมด preview ให้บริการไฟล์ที่ build แล้ว จึงเป็นที่เดียวที่ทดสอบ service worker ได้จริง
   * ต้องส่งต่อ /api เหมือนโหมดพัฒนา มิฉะนั้นแอปที่ preview จะเข้าสู่ระบบไม่ได้เลย
   */
  preview: {
    port: FRONTEND_PORT,
    strictPort: true,
    host: true,
    allowedHosts: ['s2anas.s2aconsultant.com'],
    proxy: { '/api': { target: BACKEND_URL, changeOrigin: true } },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    rollupOptions: {
      output: {
        /**
         * แยกไลบรารีพื้นฐานออกจากโค้ดของแอป (F24-B)
         *
         * ไลบรารีเหล่านี้เปลี่ยนปีละไม่กี่ครั้ง ส่วนโค้ดแอปเปลี่ยนทุกครั้งที่ปล่อยของ
         * การแยกกันทำให้การอัปเดตแอปไม่ทำให้ผู้ใช้ต้องโหลด React ใหม่ทั้งก้อน
         * ซึ่งสำคัญเป็นพิเศษกับแอปที่ติดตั้งไว้บนมือถือและอัปเดตผ่านเครือข่ายมือถือ
         */
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (/[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)) return 'vendor-react';
          if (id.includes('@tanstack')) return 'vendor-query';
          if (id.includes('react-router')) return 'vendor-router';
          if (id.includes('lucide-react')) return 'vendor-icons';
          return undefined;
        },
      },
    },
  },
});

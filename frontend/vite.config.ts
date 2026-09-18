import path from 'node:path';
import { defineConfig, type PluginOption } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';
import {
  NAVIGATION_DENYLIST,
  PRECACHE_GLOBS,
  PRECACHE_IGNORES,
  S2_NAS_MANIFEST,
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

const pwa = VitePWA({
  registerType: 'prompt',
  injectRegister: null,
  includeAssets: [],
  manifest: S2_NAS_MANIFEST,
  workbox: {
    globPatterns: [...PRECACHE_GLOBS],
    globIgnores: [...PRECACHE_IGNORES],
    navigateFallback: '/index.html',
    navigateFallbackDenylist: [...NAVIGATION_DENYLIST],
    runtimeCaching: [],
    cleanupOutdatedCaches: true,
    clientsClaim: false,
    skipWaiting: false,
    maximumFileSizeToCacheInBytes: 3 * 1024 * 1024,
  },
  devOptions: {
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
  preview: {
    port: FRONTEND_PORT,
    strictPort: true,
    host: true,
    allowedHosts: ['s2anas.s2aconsultant.com'],
    proxy: {
      '/api': {
        target: BACKEND_URL,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    rollupOptions: {
      output: {
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

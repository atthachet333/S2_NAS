import path from 'node:path';
import { defineConfig, type PluginOption } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

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

export default defineConfig({
  plugins: [react(), tailwindcss(), s2nasBanner()],
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
  preview: { port: FRONTEND_PORT, strictPort: true },
  build: { outDir: 'dist', sourcemap: false },
});

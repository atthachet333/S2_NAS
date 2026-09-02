import type { FastifyInstance } from 'fastify';
import { env } from '../config/env.js';
import { color } from '../core/banner.js';

/**
 * Request log สำหรับ CMD / Terminal
 *
 * Development:
 *   [12:35:20] INFO  GET /api/documents 200 32ms
 *
 * ห้าม log: password, JWT, refresh token, ข้อมูล sensitive
 */
const HIDDEN_PATHS = new Set<string>(['/favicon.ico']);

function timestamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function paintStatus(status: number): string {
  if (status >= 500) return color.red(String(status));
  if (status >= 400) return color.amber(String(status));
  if (status >= 300) return color.blue(String(status));
  return color.green(String(status));
}

function paintLevel(status: number): string {
  if (status >= 500) return color.red('ERROR');
  if (status >= 400) return color.amber('WARN ');
  return color.green('INFO ');
}

export async function registerRequestLogging(app: FastifyInstance): Promise<void> {
  app.addHook('onResponse', async (request, reply) => {
    if (HIDDEN_PATHS.has(request.url)) return;

    const ms = Math.round(reply.elapsedTime);
    const method = request.method.padEnd(6, ' ');
    const url = request.url.split('?')[0] ?? request.url;
    const status = reply.statusCode;

    if (env.isProduction) {
      request.log.info(
        { method: request.method, url, status, durationMs: ms },
        'request completed',
      );
      return;
    }

    process.stdout.write(
      `${color.dim('[' + timestamp() + ']')} ${paintLevel(status)} ` +
        `${color.bold(method)} ${url} ${paintStatus(status)} ${color.dim(ms + 'ms')}\n`,
    );
  });
}

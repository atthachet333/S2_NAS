import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const distRoot = path.join(here, 'dist');
const port = Number(process.env.FRONTEND_PORT ?? 8888);
const host = process.env.FRONTEND_HOST ?? '0.0.0.0';
const backend = new URL(process.env.BACKEND_ORIGIN ?? 'http://127.0.0.1:8889');
const allowedHosts = new Set([
  'localhost', '127.0.0.1', '[::1]', 's2anas.s2aconsultant.com',
  ...(process.env.FRONTEND_ALLOWED_HOSTS ?? '').split(',').map((value) => value.trim()).filter(Boolean),
].map((value) => value.toLowerCase()));

const contentTypes = new Map([
  ['.html', 'text/html; charset=utf-8'], ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'], ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'], ['.png', 'image/png'], ['.ico', 'image/x-icon'],
  ['.webmanifest', 'application/manifest+json'], ['.woff2', 'font/woff2'],
]);

function setSecurityHeaders(response) {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Referrer-Policy', 'same-origin');
  response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
}

function validHost(request) {
  const raw = request.headers.host ?? '';
  const hostname = raw.startsWith('[') ? raw.slice(0, raw.indexOf(']') + 1) : raw.split(':')[0];
  return allowedHosts.has(hostname.toLowerCase());
}

function proxyApi(request, response) {
  const headers = { ...request.headers, host: backend.host };
  delete headers['cf-connecting-ip'];
  const upstream = http.request({
    protocol: backend.protocol, hostname: backend.hostname, port: backend.port,
    method: request.method, path: request.url, headers,
  }, (upstreamResponse) => {
    response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
    upstreamResponse.pipe(response);
  });
  upstream.on('error', () => {
    if (!response.headersSent) response.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ error: 'BACKEND_UNAVAILABLE' }));
  });
  request.pipe(upstream);
}

async function staticPath(urlPath) {
  let decoded;
  try { decoded = decodeURIComponent(urlPath); } catch { return null; }
  const relative = decoded.replace(/^\/+/, '');
  const target = path.resolve(distRoot, relative);
  const relation = path.relative(distRoot, target);
  if (relation.startsWith('..') || path.isAbsolute(relation)) return null;
  try {
    const stat = await fsp.stat(target);
    return stat.isFile() ? target : null;
  } catch { return null; }
}

function sendFile(request, response, filePath) {
  setSecurityHeaders(response);
  response.setHeader('Content-Type', contentTypes.get(path.extname(filePath).toLowerCase()) ?? 'application/octet-stream');
  const name = path.basename(filePath);
  response.setHeader('Cache-Control', name === 'sw.js' || name === 'index.html'
    ? 'no-cache'
    : /-[A-Za-z0-9_-]{8,}\./.test(name) ? 'public, max-age=31536000, immutable' : 'public, max-age=3600');
  if (request.method === 'HEAD') return response.end();
  fs.createReadStream(filePath).on('error', () => {
    if (!response.headersSent) response.writeHead(500);
    response.end();
  }).pipe(response);
}

await fsp.access(path.join(distRoot, 'index.html'), fs.constants.R_OK).catch(() => {
  throw new Error('frontend/dist/index.html is missing; run npm --prefix frontend run build first');
});

const server = http.createServer(async (request, response) => {
  if (!validHost(request)) {
    setSecurityHeaders(response);
    response.writeHead(421, { 'Content-Type': 'text/plain; charset=utf-8' });
    return response.end('Misdirected Request');
  }
  const url = new URL(request.url ?? '/', 'http://local.invalid');
  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return proxyApi(request, response);
  if (!['GET', 'HEAD'].includes(request.method ?? '')) {
    response.writeHead(405, { Allow: 'GET, HEAD' });
    return response.end();
  }
  if (url.pathname.endsWith('.map')) {
    response.writeHead(404);
    return response.end();
  }
  const file = await staticPath(url.pathname);
  if (file) return sendFile(request, response, file);
  const acceptsHtml = (request.headers.accept ?? '').includes('text/html');
  if (acceptsHtml && !path.posix.extname(url.pathname)) {
    return sendFile(request, response, path.join(distRoot, 'index.html'));
  }
  setSecurityHeaders(response);
  response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  response.end('Not Found');
});

server.listen(port, host, () => {
  process.stdout.write(`[S2 NAS] production frontend listening on http://${host}:${port}\n`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}

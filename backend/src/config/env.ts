import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { z } from 'zod';

const here = path.dirname(fileURLToPath(import.meta.url));
export const BACKEND_ROOT = path.resolve(here, '..', '..');

dotenv.config({ path: path.join(BACKEND_ROOT, '.env') });

const booleanish = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

  BACKEND_PORT: z.coerce.number().int().min(1).max(65535).default(8889),
  BACKEND_HOST: z.string().min(1).default('0.0.0.0'),

  CORS_ORIGIN: z.string().default('http://localhost:8888'),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required').optional(),

  S2_NAS_STORAGE_ROOT: z.string().min(1).default('./storage'),
  MAX_UPLOAD_SIZE_MB: z.coerce.number().int().positive().default(100),
  S2_NAS_MAX_UPLOAD_BYTES: z.coerce.number().int().positive().optional(),
  S2_NAS_ZIP_MAX_RESOURCES: z.coerce.number().int().positive().default(1000),
  S2_NAS_ZIP_MAX_BYTES: z.coerce.number().int().positive().default(2 * 1024 * 1024 * 1024),
  S2_NAS_TRASH_RETENTION_DAYS: z.coerce.number().int().nonnegative().default(30),

  JWT_ACCESS_SECRET: z.string().default(''),
  JWT_REFRESH_SECRET: z.string().default(''),
  JWT_ACCESS_EXPIRES_IN: z.string().default('15m'),
  JWT_REFRESH_EXPIRES_IN: z.string().default('7d'),

  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
    .default('info'),

  STRICT_DB_STARTUP: booleanish.default('false'),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('\n');
  // ห้ามให้ backend start แบบเงียบ ๆ เมื่อ environment ไม่ถูกต้อง
  console.error('\n[CONFIG] Environment ไม่ถูกต้อง:\n' + issues + '\n');
  process.exit(1);
}

const raw = parsed.data;

if (raw.NODE_ENV === 'production' && (raw.JWT_ACCESS_SECRET.length < 32 || raw.JWT_REFRESH_SECRET.length < 32)) {
  console.error('\n[CONFIG] JWT secrets ต้องยาวอย่างน้อย 32 ตัวอักษรใน production\n');
  process.exit(1);
}

/** Storage root ที่ resolve เป็น absolute path แล้ว (ใช้ภายใน backend เท่านั้น) */
const storageRoot = path.isAbsolute(raw.S2_NAS_STORAGE_ROOT)
  ? path.normalize(raw.S2_NAS_STORAGE_ROOT)
  : path.resolve(BACKEND_ROOT, raw.S2_NAS_STORAGE_ROOT);

export const env = {
  ...raw,
  STORAGE_ROOT: storageRoot,
  MAX_UPLOAD_SIZE_BYTES: raw.S2_NAS_MAX_UPLOAD_BYTES ?? raw.MAX_UPLOAD_SIZE_MB * 1024 * 1024,
  isProduction: raw.NODE_ENV === 'production',
  isDevelopment: raw.NODE_ENV === 'development',
  isTest: raw.NODE_ENV === 'test',
  corsOrigins: raw.CORS_ORIGIN.split(',')
    .map((o) => o.trim())
    .filter(Boolean),
} as const;

export type Env = typeof env;

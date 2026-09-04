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
  /** อายุของแต่ละรายการในถังขยะ นับจาก deletedAt ของรายการนั้นเอง (0 = ปิดการเก็บกวาดอัตโนมัติ) */
  S2_NAS_TRASH_RETENTION_DAYS: z.coerce.number().int().nonnegative().default(14),

  /* ---- การสกัดข้อความในเอกสารเพื่อค้นหา (F12) ---- */

  /**
   * ไฟล์ที่ใหญ่กว่านี้จะไม่ถูกสกัดข้อความ
   *
   * ไม่ใช่ข้อจำกัดของการอัปโหลด - ไฟล์ยังอัปโหลดและดาวน์โหลดได้ตามปกติ
   * เพียงแต่ค้นจากเนื้อในไม่ได้ ค่านี้กันไม่ให้ไฟล์ก้อนเดียวกินหน่วยความจำของเซิร์ฟเวอร์
   */
  S2_NAS_EXTRACT_MAX_FILE_BYTES: z.coerce.number().int().positive().default(64 * 1024 * 1024),
  /** ข้อความที่ยาวเกินนี้จะถูกตัด และแถวดัชนีจะถูกทำเครื่องหมายว่า truncated */
  S2_NAS_EXTRACT_MAX_TEXT_CHARS: z.coerce.number().int().positive().default(400_000),
  /** เวลาสูงสุดต่อหนึ่งไฟล์ - ไฟล์ที่ทำให้ตัวสกัดค้างต้องไม่หยุดคิวทั้งคิว */
  S2_NAS_EXTRACT_MAX_SECONDS: z.coerce.number().int().positive().default(60),
  /** จำนวนงานที่ทำพร้อมกัน - ตั้งใจให้ต่ำ การค้นหาสำคัญน้อยกว่าการที่ระบบยังรับงานได้ */
  S2_NAS_EXTRACT_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(2),
  /** ระยะห่างของการตรวจคิว (วินาที) */
  S2_NAS_EXTRACT_POLL_SECONDS: z.coerce.number().int().positive().default(15),
  /** 0 = ปิดการสกัดข้อความทั้งหมด (ระบบยังทำงานได้ครบ เพียงแต่ค้นจากเนื้อในไม่ได้) */
  S2_NAS_EXTRACT_ENABLED: z.coerce.number().int().min(0).max(1).default(1),

  /**
   * รากของชุดสำรองข้อมูล - ต้องอยู่นอก S2_NAS_STORAGE_ROOT เสมอ
   * มิฉะนั้นการสำรอง storage จะไล่สำรองชุดสำรองของตัวเองซ้อนกันไปเรื่อย ๆ
   */
  S2_NAS_BACKUP_ROOT: z.string().min(1).default('./backups'),
  /** พื้นที่พักสำหรับ restore แบบ staged - ไม่ใช่พื้นที่ใช้งานจริง */
  S2_NAS_RESTORE_STAGE_ROOT: z.string().min(1).optional(),
  /** โฟลเดอร์ของ MariaDB client (mariadb-dump / mariadb) - ไม่พึ่ง PATH ของเครื่อง */
  S2_NAS_MARIADB_BIN: z.string().optional(),
  /**
   * คำนำหน้าชื่อฐานข้อมูลสำหรับ staged restore
   * บัญชีของแอปสร้างฐานข้อมูลได้เฉพาะบาง namespace เท่านั้น จึงต้องตั้งค่าได้
   */
  S2_NAS_RESTORE_DB_PREFIX: z.string().min(1).default('test_s2nas_restore_'),

  /* ---- การสำรองข้อมูลอัตโนมัติ (ค่าเริ่มต้น ปรับต่อได้ที่หน้าตั้งค่า) ---- */
  S2_NAS_BACKUP_ENABLED: booleanish.default('true'),
  S2_NAS_BACKUP_TIME: z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/).default('02:00'),
  /** โซนเวลาที่ใช้ตีความเวลาสำรองข้อมูล - ห้ามสมมติว่าเป็น UTC */
  S2_NAS_BACKUP_TIMEZONE: z.string().min(1).default('Asia/Bangkok'),
  S2_NAS_BACKUP_RETENTION_DAYS: z.coerce.number().int().positive().default(30),
  S2_NAS_BACKUP_MIN_KEEP_COUNT: z.coerce.number().int().positive().default(7),
  /**
   * เวลาที่ยอมให้ "ตามเก็บ" งานที่พลาดไปเพราะเซิร์ฟเวอร์ดับ
   * ถ้าพลาดไปนานกว่านี้ ให้รอรอบถัดไปแทนการสำรองย้อนหลังแบบไม่มีความหมาย
   */
  S2_NAS_BACKUP_CATCHUP_GRACE_HOURS: z.coerce.number().int().nonnegative().default(6),
  /** เตือนเมื่อไม่มีชุดสำรองที่สำเร็จภายในกี่ชั่วโมง */
  S2_NAS_BACKUP_STALE_HOURS: z.coerce.number().int().positive().default(48),

  /* ---- สำเนานอกเครื่อง (deployment configuration ไม่ใช่ค่าที่แก้ผ่านหน้าเว็บ) ---- */
  S2_NAS_OFFSITE_COPY_ENABLED: booleanish.default('false'),
  S2_NAS_OFFSITE_BACKUP_ROOT: z.string().optional(),
  S2_NAS_OFFSITE_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),

  /* ---- เข้าสู่ระบบด้วย Google (ยืนยันตัวตนอย่างเดียว) ---- */
  GOOGLE_OAUTH_CLIENT_ID: z.string().optional(),
  /** ความลับนี้ต้องอยู่ฝั่ง backend เท่านั้น ห้ามส่งออกไปที่เบราว์เซอร์ */
  GOOGLE_OAUTH_CLIENT_SECRET: z.string().optional(),
  GOOGLE_OAUTH_REDIRECT_URI: z.string().optional(),
  /** ที่อยู่ของหน้าเว็บ ใช้พาผู้ใช้กลับหลังจบขั้นตอนกับ Google */
  S2_NAS_APP_ORIGIN: z.string().default('http://localhost:8888'),

  /* ---- ล็อกข้ามอินสแตนซ์ ---- */
  /** เวลารอล็อกสูงสุด - สั้นโดยตั้งใจ ตอบว่าไม่ว่างดีกว่าค้างรอ */
  S2_NAS_BACKUP_LOCK_TIMEOUT_SECONDS: z.coerce.number().int().min(1).max(60).default(10),

  /* ---- การซ้อมกู้คืน ---- */
  S2_NAS_RESTORE_REHEARSAL_ENABLED: booleanish.default('true'),
  /** 0 = อาทิตย์ ... 6 = เสาร์ ตามโซนเวลาเดียวกับตารางสำรองข้อมูล */
  S2_NAS_RESTORE_REHEARSAL_DAY: z.coerce.number().int().min(0).max(6).default(0),
  S2_NAS_RESTORE_REHEARSAL_TIME: z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/).default('03:30'),
  /** เตือนเมื่อไม่มีการซ้อมกู้คืนสำเร็จภายในกี่วัน */
  S2_NAS_REHEARSAL_STALE_DAYS: z.coerce.number().int().positive().default(14),
  /** พื้นที่พักของการซ้อม - ต้องแยกจาก storage, backup และ offsite */
  S2_NAS_REHEARSAL_STAGE_ROOT: z.string().optional(),

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

/** รากของชุดสำรอง resolve เป็น absolute path แล้ว (ใช้ภายใน backend เท่านั้น) */
const backupRoot = path.isAbsolute(raw.S2_NAS_BACKUP_ROOT)
  ? path.normalize(raw.S2_NAS_BACKUP_ROOT)
  : path.resolve(BACKEND_ROOT, raw.S2_NAS_BACKUP_ROOT);

const restoreStageRoot = raw.S2_NAS_RESTORE_STAGE_ROOT
  ? (path.isAbsolute(raw.S2_NAS_RESTORE_STAGE_ROOT)
      ? path.normalize(raw.S2_NAS_RESTORE_STAGE_ROOT)
      : path.resolve(BACKEND_ROOT, raw.S2_NAS_RESTORE_STAGE_ROOT))
  : path.join(backupRoot, '_restore-stage');

/**
 * ชุดสำรองต้องไม่อยู่ใต้ storage ที่กำลังถูกสำรอง
 * ถ้าปล่อยผ่าน การสำรองครั้งที่สองจะกินชุดสำรองครั้งแรกเข้าไปด้วย และโตแบบทวีคูณ
 */
const withinStorage = (target: string): boolean => {
  const rel = path.relative(storageRoot, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

/** ทั้งสองรากต้องไม่ซ้อนกันไม่ว่าทางใด - ซ้อนกันเมื่อไรก็คัดลอกตัวเองไม่รู้จบเมื่อนั้น */
const nested = (a: string, b: string): boolean => {
  const rel = path.relative(a, b);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

if (withinStorage(backupRoot) || nested(backupRoot, storageRoot)) {
  console.error('\n[CONFIG] S2_NAS_BACKUP_ROOT ต้องไม่ซ้อนกับ S2_NAS_STORAGE_ROOT ไม่ว่าทางใด\n');
  process.exit(1);
}

const rehearsalStageRoot = raw.S2_NAS_REHEARSAL_STAGE_ROOT
  ? (path.isAbsolute(raw.S2_NAS_REHEARSAL_STAGE_ROOT)
      ? path.normalize(raw.S2_NAS_REHEARSAL_STAGE_ROOT)
      : path.resolve(BACKEND_ROOT, raw.S2_NAS_REHEARSAL_STAGE_ROOT))
  : path.join(backupRoot, '_rehearsal-stage');

const offsiteRoot = raw.S2_NAS_OFFSITE_BACKUP_ROOT
  ? (path.isAbsolute(raw.S2_NAS_OFFSITE_BACKUP_ROOT)
      ? path.normalize(raw.S2_NAS_OFFSITE_BACKUP_ROOT)
      : path.resolve(BACKEND_ROOT, raw.S2_NAS_OFFSITE_BACKUP_ROOT))
  : null;

/**
 * ปลายทางนอกเครื่องต้องไม่ซ้อนกับ storage หรือ backup root
 * ถ้าซ้อน การคัดลอกออกนอกเครื่องจะคัดลอกตัวมันเองซ้ำไปเรื่อย ๆ
 */
if (offsiteRoot && (nested(offsiteRoot, storageRoot) || nested(storageRoot, offsiteRoot) ||
    nested(offsiteRoot, backupRoot) || nested(backupRoot, offsiteRoot))) {
  console.error('\n[CONFIG] S2_NAS_OFFSITE_BACKUP_ROOT ต้องไม่ซ้อนกับ storage หรือ backup root\n');
  process.exit(1);
}

/**
 * พื้นที่พักของการซ้อมต้องไม่ทับ storage จริงเด็ดขาด
 * มิฉะนั้นการซ้อมกู้คืนจะเขียนทับไฟล์ที่ใช้งานอยู่ ซึ่งเป็นสิ่งที่การซ้อมต้องไม่ทำ
 */
if (nested(rehearsalStageRoot, storageRoot) || nested(storageRoot, rehearsalStageRoot) ||
    (offsiteRoot && (nested(rehearsalStageRoot, offsiteRoot) || nested(offsiteRoot, rehearsalStageRoot)))) {
  console.error('\n[CONFIG] พื้นที่พักของการซ้อมกู้คืนต้องไม่ซ้อนกับ storage หรือปลายทางนอกเครื่อง\n');
  process.exit(1);
}

export const env = {
  ...raw,
  STORAGE_ROOT: storageRoot,
  BACKUP_ROOT: backupRoot,
  RESTORE_STAGE_ROOT: restoreStageRoot,
  OFFSITE_BACKUP_ROOT: offsiteRoot,
  REHEARSAL_STAGE_ROOT: rehearsalStageRoot,
  MAX_UPLOAD_SIZE_BYTES: raw.S2_NAS_MAX_UPLOAD_BYTES ?? raw.MAX_UPLOAD_SIZE_MB * 1024 * 1024,
  isProduction: raw.NODE_ENV === 'production',
  isDevelopment: raw.NODE_ENV === 'development',
  isTest: raw.NODE_ENV === 'test',
  corsOrigins: raw.CORS_ORIGIN.split(',')
    .map((o) => o.trim())
    .filter(Boolean),
} as const;

export type Env = typeof env;

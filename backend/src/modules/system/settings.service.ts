import { z } from 'zod';
import { prisma } from '../../core/prisma.js';
import { env } from '../../config/env.js';
import { logger } from '../../core/logger.js';
import { AppError, badRequest } from '../../core/errors.js';
import type { AuthUser } from '../auth/auth.service.js';

/**
 * ค่าตั้งค่าการทำงานของระบบ
 *
 * ลำดับการตัดสินค่า: ค่าที่บันทึกในฐานข้อมูล → ค่าจาก environment → ค่าเริ่มต้นที่ปลอดภัย
 * environment ยังคงเป็นฐานเสมอ การลบค่าที่ตั้งไว้จึงกลับไปใช้ค่าเดิมของเครื่องนั้นได้ทันที
 *
 * นี่คือ "ค่าการทำงาน" เท่านั้น ความลับและค่าที่ระบบใช้ระบุตัวตน (DATABASE_URL, JWT secret,
 * storage path, backup path, credential ของ integration) ไม่อยู่ในรายการนี้และต้องไม่ถูกเพิ่มเข้ามา
 * ค่าที่แก้ผ่านหน้าเว็บได้ต้องเป็นค่าที่ตั้งผิดแล้วยังกู้คืนได้โดยไม่ต้องเข้าเครื่อง
 */

/** ชนิดของค่าที่รองรับ - เก็บเป็นสตริงในฐานข้อมูลเสมอ แต่ตีความตามชนิดที่ประกาศไว้ */
export type SettingValueType = 'NUMBER' | 'BOOLEAN' | 'TIME';

/**
 * ชนิดของแต่ละคีย์ ประกาศไว้ที่เดียว
 * ทำให้ getSetting คืนชนิดที่ถูกต้องโดยผู้เรียกไม่ต้อง cast เอง
 */
export interface SettingValues {
  TRASH_RETENTION_DAYS: number;
  MAX_UPLOAD_SIZE_MB: number;
  ZIP_MAX_RESOURCES: number;
  ZIP_MAX_BYTES: number;
  BACKUP_ENABLED: boolean;
  BACKUP_TIME: string;
  BACKUP_RETENTION_DAYS: number;
  BACKUP_MIN_KEEP_COUNT: number;
  OFFSITE_COPY_ENABLED: boolean;
  RESTORE_REHEARSAL_ENABLED: boolean;
  RESTORE_REHEARSAL_DAY: number;
  RESTORE_REHEARSAL_TIME: string;
}

export type SettingKey = keyof SettingValues;
export type SettingValue = SettingValues[SettingKey];
export type SettingSource = 'DATABASE' | 'ENVIRONMENT' | 'DEFAULT';

export interface SettingDefinition {
  key: SettingKey;
  section: 'UPLOAD' | 'TRASH' | 'ZIP' | 'BACKUP';
  label: string;
  description: string;
  valueType: SettingValueType;
  unit: 'DAYS' | 'MEGABYTES' | 'ITEMS' | 'BYTES' | 'NONE';
  schema: z.ZodType<SettingValue>;
  envKey: string;
  envValue: () => SettingValue;
  fallback: SettingValue;
  hotReload: 'FULL' | 'LOWER_ONLY';
  restartNote?: string;
}

/**
 * ขอบเขตของแต่ละค่าไม่ได้กันแค่ชนิดข้อมูล แต่กันค่าที่ "ถูกชนิดแต่ทำระบบพัง" ด้วย
 * เช่น 0 วันในถังขยะ (ลบทิ้งทันที) หรือ ZIP ที่ใหญ่จนเซิร์ฟเวอร์ทำงานค้าง
 */
const positiveInt = (max: number) =>
  z
    .number({ invalid_type_error: 'ต้องเป็นตัวเลข' })
    .int('ต้องเป็นจำนวนเต็ม')
    .min(1, 'ต้องมากกว่า 0')
    .max(max, `ต้องไม่เกิน ${max}`)
    .refine(Number.isSafeInteger, 'ตัวเลขเกินช่วงที่ระบบรองรับ');

/** เวลาแบบ 24 ชั่วโมง HH:mm - ปฏิเสธ 25:00, 12:99 และข้อความที่ไม่ใช่เวลา */
export const timeOfDaySchema = z
  .string({ invalid_type_error: 'ต้องเป็นเวลาในรูปแบบ HH:mm' })
  .regex(/^([01]\d|2[0-3]):([0-5]\d)$/, 'ต้องเป็นเวลาในรูปแบบ HH:mm (24 ชั่วโมง)');

const booleanSchema = z.boolean({ invalid_type_error: 'ต้องเป็น true หรือ false' });

const DEFINITIONS: Record<SettingKey, SettingDefinition> = {
  TRASH_RETENTION_DAYS: {
    key: 'TRASH_RETENTION_DAYS', section: 'TRASH', valueType: 'NUMBER',
    label: 'ลบถาวรอัตโนมัติหลัง',
    description: 'แต่ละรายการในถังขยะจะถูกลบถาวรเมื่อครบกำหนด นับจากวันที่รายการนั้นถูกลบ',
    unit: 'DAYS', schema: positiveInt(365),
    envKey: 'S2_NAS_TRASH_RETENTION_DAYS', envValue: () => env.S2_NAS_TRASH_RETENTION_DAYS,
    fallback: 14, hotReload: 'FULL',
  },
  MAX_UPLOAD_SIZE_MB: {
    key: 'MAX_UPLOAD_SIZE_MB', section: 'UPLOAD', valueType: 'NUMBER',
    label: 'ขนาดไฟล์สูงสุดต่อไฟล์',
    description: 'ไฟล์ที่ใหญ่กว่านี้จะถูกปฏิเสธตั้งแต่ตอนรับข้อมูล ไม่ถูกเขียนลงดิสก์',
    unit: 'MEGABYTES', schema: positiveInt(10_240),
    envKey: 'MAX_UPLOAD_SIZE_MB', envValue: () => env.MAX_UPLOAD_SIZE_MB,
    fallback: 100,
    /**
     * ขีดจำกัดระดับ transport (bodyLimit ของ Fastify และ limits.fileSize ของ multipart)
     * ถูกผูกไว้ตั้งแต่ตอน start server จึงลดได้ทันที แต่เพิ่มเกินค่าตอน start ไม่ได้
     */
    hotReload: 'LOWER_ONLY',
    restartNote: 'ลดค่าได้ทันที แต่การเพิ่มให้เกินค่าที่ตั้งไว้ตอนเริ่มระบบต้องรีสตาร์ท backend ก่อน',
  },
  ZIP_MAX_RESOURCES: {
    key: 'ZIP_MAX_RESOURCES', section: 'ZIP', valueType: 'NUMBER',
    label: 'จำนวนทรัพยากรสูงสุดต่อหนึ่ง ZIP',
    description: 'กันไม่ให้คำขอเดียวไล่เก็บทั้งไดร์ฟจนเซิร์ฟเวอร์ทำงานค้าง',
    unit: 'ITEMS', schema: positiveInt(100_000),
    envKey: 'S2_NAS_ZIP_MAX_RESOURCES', envValue: () => env.S2_NAS_ZIP_MAX_RESOURCES,
    fallback: 1000, hotReload: 'FULL',
  },
  ZIP_MAX_BYTES: {
    key: 'ZIP_MAX_BYTES', section: 'ZIP', valueType: 'NUMBER',
    label: 'ขนาดรวมสูงสุดต่อหนึ่ง ZIP',
    description: 'ขนาดรวมของทุกไฟล์ในคำขอเดียว ก่อนบีบอัด',
    unit: 'BYTES',
    // เพดาน 1 TB อยู่ต่ำกว่า Number.MAX_SAFE_INTEGER มาก จึงบวกลบได้โดยไม่ล้น
    schema: positiveInt(1024 ** 4),
    envKey: 'S2_NAS_ZIP_MAX_BYTES', envValue: () => env.S2_NAS_ZIP_MAX_BYTES,
    fallback: 2 * 1024 * 1024 * 1024, hotReload: 'FULL',
  },

  /* ---------------- การสำรองข้อมูลอัตโนมัติ (F6) ---------------- */

  BACKUP_ENABLED: {
    key: 'BACKUP_ENABLED', section: 'BACKUP', valueType: 'BOOLEAN',
    label: 'สำรองข้อมูลอัตโนมัติ',
    description: 'เปิดตารางเวลาสำรองข้อมูลรายวัน การปิดไว้ไม่กระทบการสั่งสำรองเอง',
    unit: 'NONE', schema: booleanSchema,
    envKey: 'S2_NAS_BACKUP_ENABLED', envValue: () => env.S2_NAS_BACKUP_ENABLED,
    fallback: true, hotReload: 'FULL',
  },
  BACKUP_TIME: {
    key: 'BACKUP_TIME', section: 'BACKUP', valueType: 'TIME',
    label: 'เวลาสำรองข้อมูล',
    description: 'เวลาตามโซนเวลาที่ตั้งไว้ของระบบ ไม่ใช่ UTC',
    unit: 'NONE', schema: timeOfDaySchema,
    envKey: 'S2_NAS_BACKUP_TIME', envValue: () => env.S2_NAS_BACKUP_TIME,
    fallback: '02:00', hotReload: 'FULL',
  },
  BACKUP_RETENTION_DAYS: {
    key: 'BACKUP_RETENTION_DAYS', section: 'BACKUP', valueType: 'NUMBER',
    label: 'เก็บชุดสำรองไว้',
    description: 'ชุดสำรองในเครื่องที่เก่ากว่านี้จะถูกลบ แต่ยังคงจำนวนขั้นต่ำไว้เสมอ',
    unit: 'DAYS', schema: positiveInt(3650),
    envKey: 'S2_NAS_BACKUP_RETENTION_DAYS', envValue: () => env.S2_NAS_BACKUP_RETENTION_DAYS,
    fallback: 30, hotReload: 'FULL',
  },
  BACKUP_MIN_KEEP_COUNT: {
    key: 'BACKUP_MIN_KEEP_COUNT', section: 'BACKUP', valueType: 'NUMBER',
    label: 'เก็บชุดสำรองอย่างน้อย',
    description: 'จำนวนชุดสำรองที่ต้องเหลือไว้เสมอ แม้ทุกชุดจะเก่ากว่ากำหนดแล้วก็ตาม',
    unit: 'ITEMS', schema: positiveInt(365),
    envKey: 'S2_NAS_BACKUP_MIN_KEEP_COUNT', envValue: () => env.S2_NAS_BACKUP_MIN_KEEP_COUNT,
    fallback: 7, hotReload: 'FULL',
  },
  OFFSITE_COPY_ENABLED: {
    key: 'OFFSITE_COPY_ENABLED', section: 'BACKUP', valueType: 'BOOLEAN',
    label: 'คัดลอกออกไปเก็บนอกเครื่อง',
    description: 'คัดลอกชุดสำรองไปยังปลายทางนอกเครื่องที่ตั้งค่าไว้ แล้วตรวจสอบซ้ำที่ปลายทาง',
    unit: 'NONE', schema: booleanSchema,
    envKey: 'S2_NAS_OFFSITE_COPY_ENABLED', envValue: () => env.S2_NAS_OFFSITE_COPY_ENABLED,
    fallback: false, hotReload: 'FULL',
  },

  /* ---------------- การซ้อมกู้คืน (F7) ---------------- */

  RESTORE_REHEARSAL_ENABLED: {
    key: 'RESTORE_REHEARSAL_ENABLED', section: 'BACKUP', valueType: 'BOOLEAN',
    label: 'ทดสอบกู้คืนอัตโนมัติ',
    description: 'กู้คืนชุดสำรองล่าสุดลงพื้นที่พักเพื่อพิสูจน์ว่ายังกู้คืนได้จริง ไม่แตะระบบที่ใช้งานอยู่',
    unit: 'NONE', schema: booleanSchema,
    envKey: 'S2_NAS_RESTORE_REHEARSAL_ENABLED', envValue: () => env.S2_NAS_RESTORE_REHEARSAL_ENABLED,
    fallback: true, hotReload: 'FULL',
  },
  RESTORE_REHEARSAL_DAY: {
    key: 'RESTORE_REHEARSAL_DAY', section: 'BACKUP', valueType: 'NUMBER',
    label: 'วันที่ทดสอบกู้คืน',
    description: '0 = อาทิตย์ ถึง 6 = เสาร์ ตามโซนเวลาเดียวกับตารางสำรองข้อมูล',
    unit: 'NONE',
    // 0 เป็นค่าที่ถูกต้อง (วันอาทิตย์) จึงใช้ช่วง 0-6 ไม่ใช่ positiveInt
    schema: z.number().int('ต้องเป็นจำนวนเต็ม').min(0, 'ต้องอยู่ระหว่าง 0-6').max(6, 'ต้องอยู่ระหว่าง 0-6'),
    envKey: 'S2_NAS_RESTORE_REHEARSAL_DAY', envValue: () => env.S2_NAS_RESTORE_REHEARSAL_DAY,
    fallback: 0, hotReload: 'FULL',
  },
  RESTORE_REHEARSAL_TIME: {
    key: 'RESTORE_REHEARSAL_TIME', section: 'BACKUP', valueType: 'TIME',
    label: 'เวลาทดสอบกู้คืน',
    description: 'ควรตั้งให้ห่างจากเวลาสำรองข้อมูล เพราะทั้งสองงานใช้ทรัพยากรหนักและกันกันเอง',
    unit: 'NONE', schema: timeOfDaySchema,
    envKey: 'S2_NAS_RESTORE_REHEARSAL_TIME', envValue: () => env.S2_NAS_RESTORE_REHEARSAL_TIME,
    fallback: '03:30', hotReload: 'FULL',
  },
};

export const SETTING_KEYS = Object.keys(DEFINITIONS) as SettingKey[];

export function settingDefinition(key: SettingKey): SettingDefinition {
  return DEFINITIONS[key];
}

export function isSettingKey(value: string): value is SettingKey {
  return Object.hasOwn(DEFINITIONS, value);
}

/* ------------------------------------------------------------------ */
/* การอ่านค่า                                                          */
/* ------------------------------------------------------------------ */

/**
 * แคชค่าที่ตัดสินแล้ว
 *
 * ค่าเหล่านี้ถูกอ่านในเส้นทางของทุกคำขออัปโหลดและทุกคำขอ ZIP
 * การยิงฐานข้อมูลทุกครั้งจึงไม่คุ้ม แต่ต้องล้างแคชทันทีที่มีการบันทึก ไม่ใช่รอหมดอายุ
 *
 * ข้อจำกัด: แคชอยู่ในหน่วยความจำของ process เดียว ถ้าวันหนึ่งรันหลาย process
 * ต้องเปลี่ยนไปใช้การแจ้งเตือนข้าม process แทน
 */
let cache: Map<SettingKey, string> | null = null;

export function invalidateSettingsCache(): void {
  cache = null;
}

async function loadOverrides(): Promise<Map<SettingKey, string>> {
  if (cache) return cache;
  try {
    const rows = await prisma.systemSetting.findMany({
      where: { key: { in: SETTING_KEYS } },
      select: { key: true, value: true },
    });
    cache = new Map(rows.filter((row) => isSettingKey(row.key)).map((row) => [row.key as SettingKey, row.value]));
  } catch (error) {
    /**
     * อ่านค่าที่ตั้งไว้ไม่ได้ ต้องไม่ทำให้การอัปโหลดหรือ ZIP ล้มทั้งหมด
     * ถอยไปใช้ค่าจาก environment ซึ่งเป็นค่าที่ระบบเคยทำงานได้อยู่แล้ว แต่ต้องบันทึกไว้ให้เห็น
     */
    logger.warn({ err: error }, '[SETTINGS] อ่านค่าตั้งค่าจากฐานข้อมูลไม่สำเร็จ ใช้ค่าจาก environment แทน');
    return new Map();
  }
  return cache;
}

/** ค่าที่ environment ให้มา แยกได้ว่าเป็นค่าที่ตั้งไว้จริง หรือเป็นค่าเริ่มต้นของระบบ */
function environmentSource(definition: SettingDefinition): SettingSource {
  return process.env[definition.envKey] === undefined ? 'DEFAULT' : 'ENVIRONMENT';
}

/** แปลงค่าที่เก็บเป็นสตริงกลับเป็นชนิดที่ประกาศไว้ */
function deserialize(definition: SettingDefinition, stored: string): unknown {
  if (definition.valueType === 'NUMBER') return Number(stored);
  if (definition.valueType === 'BOOLEAN') return stored === 'true';
  return stored;
}

export function serializeSettingValue(value: SettingValue): string {
  return typeof value === 'boolean' ? String(value) : String(value);
}

function resolve(
  definition: SettingDefinition,
  override: string | undefined,
): { value: SettingValue; source: SettingSource } {
  if (override !== undefined) {
    const parsed = definition.schema.safeParse(deserialize(definition, override));
    if (parsed.success) return { value: parsed.data, source: 'DATABASE' };
    /**
     * ค่าที่บันทึกไว้ใช้ไม่ได้ (เช่น ขอบเขตถูกแก้ให้แคบลงภายหลัง)
     * ไม่ใช้ค่าที่พังนั้นและไม่ทำให้ระบบล้ม แต่ต้องบอกให้ผู้ดูแลรู้
     */
    logger.warn(`[SETTINGS] ค่าที่บันทึกไว้ของ ${definition.key} ใช้ไม่ได้ ถอยไปใช้ค่าจาก environment`);
  }

  const parsedEnv = definition.schema.safeParse(definition.envValue());
  if (parsedEnv.success) return { value: parsedEnv.data, source: environmentSource(definition) };
  return { value: definition.fallback, source: 'DEFAULT' };
}

/** ค่าที่มีผลจริงของหนึ่งค่าตั้งค่า พร้อมชนิดที่ถูกต้องตามคีย์ */
export async function getSetting<K extends SettingKey>(key: K): Promise<SettingValues[K]> {
  const overrides = await loadOverrides();
  return resolve(DEFINITIONS[key], overrides.get(key)).value as SettingValues[K];
}

export interface SettingView {
  key: SettingKey;
  section: SettingDefinition['section'];
  label: string;
  description: string;
  valueType: SettingValueType;
  unit: SettingDefinition['unit'];
  value: SettingValue;
  source: SettingSource;
  /** ค่าที่จะกลับไปใช้ ถ้าลบค่าที่ตั้งไว้ออก */
  defaultValue: SettingValue;
  envKey: string;
  hotReload: SettingDefinition['hotReload'];
  restartNote?: string;
}

export async function listSettings(): Promise<SettingView[]> {
  const overrides = await loadOverrides();
  return SETTING_KEYS.map((key) => {
    const definition = DEFINITIONS[key];
    const resolved = resolve(definition, overrides.get(key));
    const fallback = resolve(definition, undefined);
    return {
      key,
      section: definition.section,
      label: definition.label,
      description: definition.description,
      valueType: definition.valueType,
      unit: definition.unit,
      value: resolved.value,
      source: resolved.source,
      defaultValue: fallback.value,
      envKey: definition.envKey,
      hotReload: definition.hotReload,
      ...(definition.restartNote ? { restartNote: definition.restartNote } : {}),
    };
  });
}

/* ------------------------------------------------------------------ */
/* การเขียนค่า                                                         */
/* ------------------------------------------------------------------ */

export interface SettingsAudit {
  ipAddress?: string;
  userAgent?: string;
}

function parseOrThrow(key: SettingKey, raw: unknown): SettingValue {
  const definition = DEFINITIONS[key];

  // ปฏิเสธ NaN และ Infinity ตั้งแต่ก่อนเข้า schema
  if (definition.valueType === 'NUMBER' && (typeof raw !== 'number' || !Number.isFinite(raw))) {
    throw badRequest('SETTING_VALUE_INVALID', `ค่าของ ${key} ต้องเป็นตัวเลข`, { key });
  }

  const parsed = definition.schema.safeParse(raw);
  if (!parsed.success) {
    throw badRequest('SETTING_VALUE_INVALID', `ค่าของ ${key} ไม่ถูกต้อง: ${parsed.error.issues[0]?.message ?? ''}`, {
      key,
    });
  }
  return parsed.data;
}

/**
 * บันทึกค่าหลายค่าพร้อมกัน
 *
 * ตรวจทุกค่าก่อนเขียนแม้แต่ค่าเดียว เพื่อไม่ให้ค่าหนึ่งผ่านแล้วอีกค่าล้ม
 * จนเหลือสถานะครึ่ง ๆ กลาง ๆ ที่ผู้ดูแลไม่ได้ตั้งใจ
 */
export async function updateSettings(
  user: AuthUser,
  updates: Record<string, unknown>,
  audit: SettingsAudit = {},
): Promise<SettingView[]> {
  const entries = Object.entries(updates);
  if (entries.length === 0) throw badRequest('SETTING_UPDATE_EMPTY', 'ไม่มีค่าที่จะบันทึก');

  const validated: Array<{ key: SettingKey; value: SettingValue }> = [];
  for (const [key, raw] of entries) {
    if (!isSettingKey(key)) {
      throw badRequest('SETTING_KEY_UNKNOWN', `ไม่รู้จักค่าตั้งค่า ${key}`, { key });
    }
    validated.push({ key, value: parseOrThrow(key, raw) });
  }

  const before = await listSettings();
  const previous = new Map(before.map((row) => [row.key, row.value]));

  await prisma.$transaction(async (tx) => {
    for (const { key, value } of validated) {
      const definition = DEFINITIONS[key];
      const stored = serializeSettingValue(value);
      await tx.systemSetting.upsert({
        where: { key },
        update: { value: stored, description: definition.description },
        create: { key, value: stored, description: definition.description },
      });
      await tx.activityLog.create({
        data: {
          userId: user.id,
          action: 'SYSTEM_SETTING_UPDATED',
          ipAddress: audit.ipAddress,
          userAgent: audit.userAgent?.slice(0, 500),
          // เก็บเฉพาะค่าการทำงาน ไม่มีความลับใด ๆ อยู่ในรายการที่แก้ได้
          metadata: { key, oldValue: previous.get(key) ?? null, newValue: value },
        },
      });
    }
  });

  invalidateSettingsCache();
  for (const { key, value } of validated) {
    logger.info(`[SETTINGS] ${key}: ${String(previous.get(key) ?? '-')} -> ${String(value)}`);
  }
  return listSettings();
}

/**
 * ลบค่าที่ตั้งไว้ ให้กลับไปใช้ค่าจาก environment
 *
 * ลบแถวทิ้งจริง ไม่เขียนค่าจาก environment ลงฐานข้อมูลแทน
 * มิฉะนั้นค่าจะถูกตรึงไว้ และการแก้ environment ในภายหลังจะไม่มีผลอีกเลย
 */
export async function resetSetting(
  user: AuthUser,
  key: string,
  audit: SettingsAudit = {},
): Promise<SettingView[]> {
  if (!isSettingKey(key)) throw badRequest('SETTING_KEY_UNKNOWN', `ไม่รู้จักค่าตั้งค่า ${key}`, { key });

  const before = await listSettings();
  const current = before.find((row) => row.key === key);
  if (current?.source !== 'DATABASE') {
    throw new AppError('SETTING_NOT_OVERRIDDEN', 'ค่านี้ใช้ค่าเริ่มต้นของระบบอยู่แล้ว', 409, { key });
  }

  await prisma.$transaction(async (tx) => {
    await tx.systemSetting.deleteMany({ where: { key } });
    await tx.activityLog.create({
      data: {
        userId: user.id,
        action: 'SYSTEM_SETTING_RESET',
        ipAddress: audit.ipAddress,
        userAgent: audit.userAgent?.slice(0, 500),
        metadata: { key, oldValue: current.value, newValue: current.defaultValue },
      },
    });
  });

  invalidateSettingsCache();
  logger.info(`[SETTINGS] ${key}: ${String(current.value)} -> ค่าเริ่มต้น (${String(current.defaultValue)})`);
  return listSettings();
}

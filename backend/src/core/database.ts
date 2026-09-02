import { env } from '../config/env.js';
import { prisma as sharedPrisma } from './prisma.js';

export type DatabaseStatus = 'CONNECTED' | 'DISCONNECTED' | 'NOT_CONFIGURED';

export interface DatabaseCheckResult {
  status: DatabaseStatus;
  provider: 'mariadb';
  message?: string;
  latencyMs?: number;
}

type PrismaLike = {
  $queryRawUnsafe: (q: string) => Promise<unknown>;
  $disconnect: () => Promise<void>;
};

/** ปิดบัง connection string ไม่ให้หลุดเข้า log */
const CONNECTION_STRING = new RegExp('mysql://[^ "\'\s]+', 'gi');

/** cache ผลตรวจสั้น ๆ เพื่อไม่ให้ทุก request ไปกระแทกฐานข้อมูล */
const CHECK_TTL_MS = 5_000;

let prisma: PrismaLike | null = sharedPrisma as unknown as PrismaLike;
let lastCheck: DatabaseCheckResult | null = null;
let lastCheckedAt = 0;
let inflight: Promise<DatabaseCheckResult> | null = null;

/**
 * โหลด Prisma Client แบบ lazy
 * Phase 1 ยังไม่มี model ครบ จึงยอมให้ client ยังไม่ถูก generate ได้
 * โดยไม่ทำให้ backend ล้ม แต่ต้องรายงานสถานะให้ชัดเจน
 */
async function getPrisma(): Promise<PrismaLike | null> {
  if (prisma) return prisma;
  try {
    const mod = (await import('@prisma/client')) as unknown as {
      PrismaClient: new (opts?: unknown) => PrismaLike;
    };
    // log: [] เพราะ backend พิมพ์ข้อความสถานะเองในรูปแบบของ S2 NAS
    prisma = new mod.PrismaClient({ log: [] });
    return prisma;
  } catch {
    return null;
  }
}

/**
 * ดึงบรรทัดที่อธิบายสาเหตุจริงจากข้อความ error ของ Prisma
 * ข้าม header ประเภท "Invalid prisma... invocation:" ที่ไม่ได้บอกสาเหตุ
 */
function firstMeaningfulLine(message: string): string {
  const lines = message
    .split(String.fromCharCode(10))
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => !line.startsWith('Invalid ') && !line.endsWith('invocation:'));

  return lines[0] ?? 'unknown error';
}

async function runCheck(): Promise<DatabaseCheckResult> {
  if (!env.DATABASE_URL) {
    return {
      status: 'NOT_CONFIGURED',
      provider: 'mariadb',
      message: 'ยังไม่ได้ตั้งค่า DATABASE_URL ใน .env',
    };
  }

  const client = await getPrisma();
  if (!client) {
    return {
      status: 'DISCONNECTED',
      provider: 'mariadb',
      message: 'ยังไม่ได้ generate Prisma Client (npm run prisma:generate)',
    };
  }

  const startedAt = performance.now();
  try {
    await client.$queryRawUnsafe('SELECT 1');
    return {
      status: 'CONNECTED',
      provider: 'mariadb',
      latencyMs: Math.round(performance.now() - startedAt),
    };
  } catch (error) {
    // ห้าม log connection string หรือรหัสผ่านฐานข้อมูล
    const raw = (error as Error).message ?? 'unknown error';
    const safe = firstMeaningfulLine(raw).replace(CONNECTION_STRING, 'mysql://[REDACTED]');
    return { status: 'DISCONNECTED', provider: 'mariadb', message: safe };
  }
}

/** ตรวจสอบการเชื่อมต่อฐานข้อมูล MariaDB */
export async function checkDatabase(force = false): Promise<DatabaseCheckResult> {
  const now = Date.now();
  if (!force && lastCheck && now - lastCheckedAt < CHECK_TTL_MS) {
    return lastCheck;
  }
  if (inflight) return inflight;

  inflight = runCheck()
    .then((result) => {
      lastCheck = result;
      lastCheckedAt = Date.now();
      return result;
    })
    .finally(() => {
      inflight = null;
    });

  return inflight;
}

export function getLastDatabaseCheck(): DatabaseCheckResult | null {
  return lastCheck;
}

export async function disconnectDatabase(): Promise<void> {
  if (prisma) {
    try {
      await prisma.$disconnect();
    } catch {
      /* ปิด connection ไม่สำเร็จไม่ควรทำให้ shutdown ล้ม */
    }
    prisma = null;
  }
}

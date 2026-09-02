import fs from 'node:fs/promises';
import path from 'node:path';
import { env } from '../config/env.js';
import { AppError } from './errors.js';

export type StorageStatus = 'READY' | 'READ_ONLY' | 'UNAVAILABLE';

export interface StorageCheckResult {
  status: StorageStatus;
  root: string;
  readable: boolean;
  writable: boolean;
  message?: string;
}

export interface StorageUsage {
  totalBytes: number;
  usedBytes: number;
  freeBytes: number;
}

/** โฟลเดอร์มาตรฐานที่ระบบต้องมีเสมอ */
const REQUIRED_DIRS = ['companies', 'recycle-bin', 'temp'];

let lastCheck: StorageCheckResult | null = null;
let lastCheckedAt = 0;
const CHECK_TTL_MS = 5_000;

/**
 * ตรวจสอบ storage ตอน start:
 * - โฟลเดอร์มีอยู่ (สร้างให้ถ้ายังไม่มี)
 * - อ่านได้
 * - เขียนได้ (ทดสอบเขียนไฟล์จริงแล้วลบทิ้ง)
 *
 * ถ้าเขียนไม่ได้ ต้องรายงานชัดเจน ห้ามปล่อยผ่านเงียบ ๆ
 */
export async function verifyStorage(force = false): Promise<StorageCheckResult> {
  const now = Date.now();
  if (!force && lastCheck && now - lastCheckedAt < CHECK_TTL_MS) {
    return lastCheck;
  }
  lastCheckedAt = now;

  const root = env.STORAGE_ROOT;
  const result: StorageCheckResult = {
    status: 'UNAVAILABLE',
    root,
    readable: false,
    writable: false,
  };

  try {
    await fs.mkdir(root, { recursive: true });
  } catch (error) {
    result.message = `ไม่สามารถสร้าง storage root ได้: ${(error as Error).message}`;
    lastCheck = result;
    return result;
  }

  try {
    await fs.access(root, (await import('node:fs')).constants.R_OK);
    await fs.readdir(root);
    result.readable = true;
  } catch (error) {
    result.message = `Storage root อ่านไม่ได้: ${(error as Error).message}`;
    lastCheck = result;
    return result;
  }

  const probe = path.join(root, `.s2nas-write-test-${process.pid}`);
  try {
    await fs.writeFile(probe, 'S2 NAS storage write test', 'utf8');
    await fs.readFile(probe, 'utf8');
    await fs.unlink(probe);
    result.writable = true;
  } catch (error) {
    result.status = 'READ_ONLY';
    result.message = `Storage root เขียนไม่ได้: ${(error as Error).message}`;
    lastCheck = result;
    return result;
  }

  try {
    for (const dir of REQUIRED_DIRS) {
      await fs.mkdir(path.join(root, dir), { recursive: true });
    }
  } catch (error) {
    result.status = 'READ_ONLY';
    result.message = `สร้างโฟลเดอร์มาตรฐานไม่สำเร็จ: ${(error as Error).message}`;
    lastCheck = result;
    return result;
  }

  result.status = 'READY';
  lastCheck = result;
  return result;
}

export function getLastStorageCheck(): StorageCheckResult | null {
  return lastCheck;
}

/** พื้นที่ดิสก์ของ volume ที่ storage root อยู่ */
export async function getStorageUsage(): Promise<StorageUsage | null> {
  try {
    const stats = await fs.statfs(env.STORAGE_ROOT);
    const totalBytes = stats.blocks * stats.bsize;
    const freeBytes = stats.bavail * stats.bsize;
    return { totalBytes, freeBytes, usedBytes: totalBytes - freeBytes };
  } catch {
    return null;
  }
}

/**
 * แปลง relative path ภายใน storage เป็น absolute path อย่างปลอดภัย
 * ป้องกัน path traversal เช่น ../../secret.pdf
 */
export function resolveInsideStorage(...segments: string[]): string {
  const target = path.resolve(env.STORAGE_ROOT, ...segments);
  const rootWithSep = env.STORAGE_ROOT.endsWith(path.sep)
    ? env.STORAGE_ROOT
    : env.STORAGE_ROOT + path.sep;

  if (target !== env.STORAGE_ROOT && !target.startsWith(rootWithSep)) {
    throw new AppError('INVALID_PATH', 'เส้นทางไฟล์ไม่ถูกต้อง', 400);
  }
  return target;
}

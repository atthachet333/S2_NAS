import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';

/**
 * Manifest ของชุดสำรอง
 *
 * เป็นสัญญาว่า "ชุดสำรองนี้ควรมีอะไรอยู่บ้าง" การตรวจสอบและการกู้คืนทุกครั้ง
 * เทียบกับเอกสารนี้ ไม่ใช่เทียบกับสิ่งที่บังเอิญอยู่ในโฟลเดอร์
 *
 * ห้ามมี absolute path, DATABASE_URL, รหัสผ่าน หรือความลับใด ๆ อยู่ในไฟล์นี้
 * เพราะชุดสำรองอาจถูกคัดลอกไปเก็บที่อื่นซึ่งควบคุมการเข้าถึงได้น้อยกว่า
 */

export const MANIFEST_VERSION = 1;

export interface ManifestObject {
  /** storageKey เชิงตรรกะ ใช้เป็นเส้นทางสัมพัทธ์ใต้ storage/ ของชุดสำรองด้วย */
  storageKey: string;
  size: number;
  checksum: string;
  resourceId: string;
  versionNumber: number | null;
}

export interface BackupManifest {
  manifestVersion: number;
  backupId: string;
  backupName: string;
  createdAt: string;
  appVersion: string;
  database: {
    fileName: string;
    bytes: number;
    checksum: string;
  };
  storage: {
    objectCount: number;
    bytes: number;
    objects: ManifestObject[];
  };
  /**
   * ตัวเลขคร่าว ๆ ณ เวลาที่สร้างชุดสำรอง - ใช้เพื่อให้มนุษย์อ่านเข้าใจภาพรวมเท่านั้น
   *
   * ไม่ใช่คำรับรองว่าตรงกับดัมป์ทุกแถว เพราะอ่านหลังดัมป์เสร็จ ระบบที่ยังรับงานอยู่
   * อาจมีข้อมูลเพิ่มระหว่างนั้น ความถูกต้องที่แท้จริงพิสูจน์ตอนกู้คืนด้วยการกระทบยอด
   * ระหว่างฐานข้อมูลที่กู้มากับไฟล์ที่กู้มา ไม่ใช่ด้วยตัวเลขในเอกสารนี้
   */
  counts: {
    resources: number;
    versions: number;
    trashedResources: number;
  };
  totalBytes: number;
}

export async function sha256File(filePath: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve());
  });
  return hash.digest('hex');
}

export function sha256Text(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/**
 * Manifest ถูกเขียนแบบ deterministic (คีย์เรียงคงที่, object เรียงตาม storageKey)
 * เพื่อให้ checksum ของ manifest เองเทียบซ้ำได้ ไม่แกว่งตามลำดับที่ query คืนมา
 */
export function serializeManifest(manifest: BackupManifest): string {
  const ordered: BackupManifest = {
    ...manifest,
    storage: {
      ...manifest.storage,
      objects: [...manifest.storage.objects].sort((a, b) => a.storageKey.localeCompare(b.storageKey)),
    },
  };
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

export async function writeManifest(filePath: string, manifest: BackupManifest): Promise<string> {
  const body = serializeManifest(manifest);
  await fsp.writeFile(filePath, body, 'utf8');
  return sha256Text(body);
}

export async function readManifest(filePath: string): Promise<BackupManifest> {
  const body = await fsp.readFile(filePath, 'utf8');
  return JSON.parse(body) as BackupManifest;
}

/** checksum ของ manifest ที่อยู่บนดิสก์ตอนนี้ - ใช้จับการถูกแก้ไขภายหลัง */
export async function manifestChecksum(filePath: string): Promise<string> {
  return sha256Text(await fsp.readFile(filePath, 'utf8'));
}

/**
 * storageKey ต้องเป็นเส้นทางสัมพัทธ์ที่ปลอดภัย
 *
 * ค่านี้ถูกนำไปต่อกับรากของชุดสำรองและพื้นที่พัก การปล่อยให้มี ".." หรือ path แบบ absolute
 * เท่ากับเปิดให้เขียนไฟล์นอกพื้นที่ที่ตั้งใจ ทั้งตอนสำรองและตอนกู้คืน
 */
export function isSafeStorageKey(storageKey: string): boolean {
  if (!storageKey || storageKey.length > 500) return false;
  if (storageKey.includes('\0')) return false;
  if (/^[a-zA-Z]:/.test(storageKey) || storageKey.startsWith('/') || storageKey.startsWith('\\')) return false;
  const segments = storageKey.split(/[\\/]/);
  return segments.every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

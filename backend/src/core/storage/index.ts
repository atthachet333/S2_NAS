import { env } from '../../config/env.js';
import { LocalStorageProvider } from './local.provider.js';
import { s3ProviderFromEnv } from './s3.provider.js';
import { withStorageTelemetry } from './telemetry.js';
import type { StorageProvider, StorageProviderKind } from './provider.js';

/**
 * ทะเบียนผู้ให้บริการพื้นที่จัดเก็บ (F23-B/D)
 *
 * **ผู้ให้บริการของแถวสำคัญกว่าผู้ให้บริการที่ตั้งค่าไว้** การอ่านวัตถุต้องใช้
 * ผู้ให้บริการที่บันทึกไว้กับเวอร์ชันนั้น ไม่ใช่ค่าเริ่มต้นปัจจุบันของระบบ
 * มิฉะนั้นวันที่สลับค่าเริ่มต้น ไฟล์เก่าทั้งหมดจะถูกไปหาผิดที่ทันที
 *
 * **ไม่มีการถอยไปหาผู้ให้บริการอื่นเด็ดขาด** ถ้าแถวบอกว่าอยู่บน S3 แล้วอ่านไม่เจอ
 * นั่นคือความไม่สอดคล้องที่ต้องถูกรายงาน ไม่ใช่สิ่งที่ควรกลบด้วยการลองหาที่อื่น
 * การถอยไปหาที่อื่นจะทำให้ระบบ "ทำงานได้" ทับความเสียหายที่กำลังลุกลาม
 */

const local = withStorageTelemetry(new LocalStorageProvider());

/**
 * ผู้ให้บริการ S3 ถูกสร้างเมื่อค่าตั้งครบเท่านั้น
 *
 * ค่าที่ไม่ครบถูกจับตั้งแต่ชั้นตรวจค่าตั้งแล้วเมื่อเลือกใช้ s3 ตรงนี้เป็นด่านสุดท้าย
 */
const s3Raw = s3ProviderFromEnv();
const s3 = s3Raw ? withStorageTelemetry(s3Raw) : null;

const providers: Record<StorageProviderKind, StorageProvider | null> = {
  LOCAL: local,
  S3: s3,
};

/**
 * ผู้ให้บริการที่ถูกแทนที่ระหว่างการทดสอบ
 *
 * **มีไว้เพื่ออะไร:** ชุดทดสอบต้องพิสูจน์เส้นทางจริงของธุรกิจที่วิ่งผ่านทะเบียนนี้
 * ไปยัง S3StorageProvider ตัวจริง โดยเปลี่ยนเฉพาะปลายทางของการเชื่อมต่อ
 * ถ้าไม่มีทางฉีดเข้ามา ชุดทดสอบจะต้องปลอมทั้งผู้ให้บริการ ซึ่งแปลว่าไม่ได้ทดสอบของจริง
 *
 * **ทำไมไม่ใช่ช่องโหว่:** ไม่มีโค้ดของระบบเรียกฟังก์ชันเหล่านี้เลย ไม่ผูกกับค่าตั้ง
 * ไม่ผูกกับคำขอจากภายนอก และเรียกได้เฉพาะโดยการ import จากโมดูลนี้โดยตรง
 */
const overrides: Partial<Record<StorageProviderKind, StorageProvider>> = {};

/** ชนิดที่การเขียนใหม่ใช้ - มาจากค่าตั้ง และเปลี่ยนได้เฉพาะในชุดทดสอบ */
let writeKind: StorageProviderKind = env.S2_NAS_STORAGE_PROVIDER === 's3' && s3 ? 'S3' : 'LOCAL';

export function storageProviderFor(kind?: StorageProviderKind | null): StorageProvider {
  const requested = kind ?? 'LOCAL';
  const provider = overrides[requested] ?? providers[requested];
  if (!provider) {
    throw new Error(`ยังไม่รองรับพื้นที่จัดเก็บชนิด ${requested}`);
  }
  return provider;
}

/** ผู้ให้บริการที่การเขียนใหม่ต้องใช้ - การอ่านของเก่าห้ามใช้ตัวนี้ */
export function writeStorageProvider(): StorageProvider {
  return storageProviderFor(writeKind);
}

/** ชนิดที่ต้องบันทึกลงแถวของวัตถุที่เพิ่งเขียน */
export function writeStorageProviderKind(): StorageProviderKind {
  return writeKind;
}

export function setStorageProviderForTesting(
  kind: StorageProviderKind,
  provider: StorageProvider | null,
): void {
  // ผู้ให้บริการที่ฉีดเข้ามาก็ถูกมองเห็นเหมือนกัน ชุดทดสอบจึงพิสูจน์เส้นทางเดียวกับของจริง
  if (provider) overrides[kind] = withStorageTelemetry(provider);
  else delete overrides[kind];
}

export function setWriteProviderForTesting(kind: StorageProviderKind): void {
  writeKind = kind;
}

/** สถานะของแต่ละผู้ให้บริการสำหรับหน้าตรวจสุขภาพ - ไม่มีค่าตั้งหรือความลับใด ๆ */
export async function storageProviderDiagnostics(): Promise<{
  defaultProvider: StorageProviderKind;
  providers: Record<StorageProviderKind, string>;
}> {
  const result = {} as Record<StorageProviderKind, string>;
  for (const kind of ['LOCAL', 'S3'] as StorageProviderKind[]) {
    const provider = overrides[kind] ?? providers[kind];
    result[kind] = provider ? (await provider.health()).status : 'NOT_CONFIGURED';
  }
  return { defaultProvider: writeKind, providers: result };
}

export type { StorageProvider, StorageProviderKind } from './provider.js';
export type { StorageHealth, StorageHealthStatus, StorageStat, StagedObject, StoredObject } from './provider.js';

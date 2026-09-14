import { logger } from '../logger.js';
import type { StorageProvider } from './provider.js';

/**
 * การมองเห็นปฏิบัติการกับพื้นที่จัดเก็บ (F23-G)
 *
 * **ทำไมห่อที่ทะเบียน ไม่ใช่แก้ในผู้ให้บริการแต่ละตัว:** ถ้าใส่การบันทึกลงในแต่ละ
 * ผู้ให้บริการ ผู้ให้บริการตัวใหม่ที่เพิ่มทีหลังจะเงียบโดยไม่มีใครสังเกต การห่อที่
 * ทางเข้าเดียวทำให้ทุกตัวถูกมองเห็นเท่ากันโดยอัตโนมัติ และตรรกะของผู้ให้บริการ
 * ยังคงเป็นเรื่องของการเก็บวัตถุล้วน ๆ ไม่ปนกับเรื่องการรายงาน
 *
 * **สิ่งที่บันทึก:** ชนิดผู้ให้บริการ ชื่อปฏิบัติการ เวลาที่ใช้ จำนวนไบต์ และสำเร็จหรือไม่
 *
 * **สิ่งที่ห้ามบันทึกเด็ดขาด:** คีย์ของวัตถุ เส้นทางบนดิสก์ ชื่อถัง ปลายทาง กุญแจ
 * หรือเนื้อหาของเอกสาร คีย์มีรหัสทรัพยากรอยู่ข้างใน และปูมมักถูกส่งต่อไปยังระบบ
 * รวมปูมที่มีคนเข้าถึงได้กว้างกว่าตัวระบบเอง จึงไม่ใส่ตั้งแต่ต้นทาง
 *
 * **ข้อจำกัดที่ต้องรู้:** สำหรับปฏิบัติการที่คืนสตรีม เวลาที่วัดคือเวลาจนกว่าสตรีม
 * จะพร้อม ไม่ใช่เวลาที่ถ่ายโอนข้อมูลจบ เพราะการถ่ายโอนเกิดขึ้นหลังจากนั้นในมือผู้เรียก
 */

/** ปฏิบัติการที่ต้องถูกมองเห็น - ที่ไม่อยู่ในรายการนี้เป็นการคำนวณในหน่วยความจำล้วน */
const OBSERVED = new Set([
  'prepare', 'put', 'commitStaged', 'getStream', 'getRangeStream',
  'stat', 'exists', 'delete', 'copy', 'removeResourceScope', 'health',
]);

/** ดึงจำนวนไบต์จากผลลัพธ์เท่าที่รู้ได้จริง ไม่เดา */
function bytesOf(operation: string, args: unknown[], result: unknown): number | undefined {
  if (operation === 'getRangeStream') {
    const [, start, end] = args as [string, number, number];
    return typeof start === 'number' && typeof end === 'number' ? end - start + 1 : undefined;
  }
  const size = (result as { size?: unknown } | null)?.size;
  return typeof size === 'number' ? size : undefined;
}

export function withStorageTelemetry(provider: StorageProvider): StorageProvider {
  return new Proxy(provider, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== 'function' || typeof property !== 'string' || !OBSERVED.has(property)) {
        return value;
      }
      return function observed(this: unknown, ...args: unknown[]) {
        const startedAt = process.hrtime.bigint();
        const elapsed = () => Number(process.hrtime.bigint() - startedAt) / 1e6;
        const base = { provider: target.kind, operation: property };
        try {
          const outcome = (value as (...rest: unknown[]) => unknown).apply(target, args);
          if (!(outcome instanceof Promise)) return outcome;
          return outcome.then(
            (resolved) => {
              logger.debug({
                ...base, durationMs: Math.round(elapsed()), outcome: 'SUCCESS',
                ...(bytesOf(property, args, resolved) === undefined
                  ? {} : { bytes: bytesOf(property, args, resolved) }),
              }, '[STORAGE] ปฏิบัติการสำเร็จ');
              return resolved;
            },
            (error: unknown) => {
              // บันทึกเฉพาะรหัสข้อผิดพลาด ไม่ใช่ข้อความที่อาจมีคีย์หรือเส้นทางติดมา
              const code = (error as { code?: unknown })?.code;
              logger.warn({
                ...base, durationMs: Math.round(elapsed()), outcome: 'FAILURE',
                ...(typeof code === 'string' ? { failure: code } : {}),
              }, '[STORAGE] ปฏิบัติการล้มเหลว');
              throw error;
            },
          );
        } catch (error) {
          const code = (error as { code?: unknown })?.code;
          logger.warn({
            ...base, durationMs: Math.round(elapsed()), outcome: 'FAILURE',
            ...(typeof code === 'string' ? { failure: code } : {}),
          }, '[STORAGE] ปฏิบัติการล้มเหลว');
          throw error;
        }
      };
    },
  });
}

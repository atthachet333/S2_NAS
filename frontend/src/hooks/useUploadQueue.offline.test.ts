import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from './useToast.tsx';
import { UploadQueueProvider, useUploadQueue } from './useUploadQueue.tsx';
import type { UploadQueueValue } from './uploadQueueContext';

/**
 * การอัปโหลดขณะออฟไลน์ (F24-D)
 *
 * **สิ่งที่ตัดสินใจไว้และชุดนี้บังคับ:** ระบบปฏิเสธงานตั้งแต่ต้นทาง ไม่เก็บไว้ส่งทีหลัง
 * เพราะไฟล์ที่ค้างอยู่ในหน้าเว็บจะหายไปทันทีที่ผู้ใช้ปิดแท็บ ซึ่งบนมือถือเกิดขึ้นตลอดเวลา
 * การแสดงไฟล์ค้างในคิวจะสื่อว่าระบบรับเรื่องไว้แล้ว ทั้งที่รักษาสัญญานั้นไม่ได้
 *
 * **ด่านอยู่ที่ enqueue** ซึ่งเป็นทางผ่านของทุกเส้นทางอัปโหลด ทั้งปุ่ม แผ่นบนมือถือ
 * การลากมาวาง และเมนูคลิกขวา ชุดนี้จึงครอบคลุมทุกทางพร้อมกัน
 */
let savedNavigator: PropertyDescriptor | undefined;
let savedWindow: unknown;

/**
 * การแจ้งเตือนของระบบใช้ window.setTimeout เพื่อหน่วงเวลาปิดข้อความ
 * ชุดทดสอบนี้ไม่มี DOM จริง จึงต้องมี window เท่าที่เส้นทางนี้ใช้จริง
 */
function installWindow(): void {
  savedWindow = (globalThis as { window?: unknown }).window;
  (globalThis as { window?: unknown }).window = {
    setTimeout: (fn: () => void, ms?: number) => setTimeout(fn, ms),
    clearTimeout: (id: never) => clearTimeout(id),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
}

function setOnline(online: boolean): void {
  Object.defineProperty(globalThis, 'navigator', {
    value: { onLine: online }, configurable: true, writable: true, enumerable: false,
  });
}

function renderQueue(): { queue: () => UploadQueueValue; unmount: () => void } {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let latest!: UploadQueueValue;
  function Probe() {
    latest = useUploadQueue();
    return null;
  }
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(
      createElement(QueryClientProvider, { client },
        createElement(ToastProvider, null,
          createElement(UploadQueueProvider, null, createElement(Probe)))),
    );
  });
  return { queue: () => latest, unmount: () => act(() => { tree.unmount(); }) };
}

const fileOf = (name: string, size = 1024): File =>
  ({ name, size, type: 'application/pdf' }) as unknown as File;

describe('F24-D การอัปโหลดขณะออฟไลน์', { concurrency: 1 }, () => {
  beforeEach(() => {
    savedNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    installWindow();
  });

  afterEach(() => {
    if (savedNavigator) Object.defineProperty(globalThis, 'navigator', savedNavigator);
    (globalThis as { window?: unknown }).window = savedWindow;
  });

  test('ออฟไลน์แล้วไม่มีไฟล์ใดเข้าคิว', () => {
    setOnline(false);
    const hook = renderQueue();
    act(() => { hook.queue().enqueue([fileOf('เอกสาร.pdf')], { parentId: null, parentName: 'ไดร์ฟของฉัน' }); });
    assert.equal(hook.queue().items.length, 0, 'ห้ามรับงานไว้ทั้งที่ส่งไม่ได้');
    hook.unmount();
  });

  /** ปฏิเสธทั้งชุด ไม่ใช่รับบางไฟล์ */
  test('ปฏิเสธทั้งชุดเมื่อเลือกหลายไฟล์', () => {
    setOnline(false);
    const hook = renderQueue();
    act(() => {
      hook.queue().enqueue(
        [fileOf('a.pdf'), fileOf('b.jpg'), fileOf('c.docx')],
        { parentId: 'f1', parentName: 'ภาษี' },
      );
    });
    assert.equal(hook.queue().items.length, 0);
    hook.unmount();
  });

  /** กลับมาออนไลน์แล้วต้องรับงานได้ตามปกติ */
  test('ออนไลน์แล้วรับงานเข้าคิวตามเดิม', () => {
    setOnline(true);
    const hook = renderQueue();
    act(() => { hook.queue().enqueue([fileOf('เอกสาร.pdf')], { parentId: null, parentName: 'ไดร์ฟของฉัน' }); });
    assert.equal(hook.queue().items.length, 1);
    assert.equal(hook.queue().items[0]!.file.name, 'เอกสาร.pdf');
    hook.unmount();
  });

  /**
   * สภาพแวดล้อมที่ไม่มี navigator ต้องไม่ถูกปิดกั้น
   *
   * ค่าที่อ่านไม่ได้ ไม่ใช่หลักฐานว่าออฟไลน์ การปิดกั้นไว้ก่อนจะทำให้ระบบใช้ไม่ได้
   * ในที่ที่จริง ๆ แล้วใช้ได้
   */
  test('ไม่รู้สถานะเครือข่าย ก็ไม่ปิดกั้นการอัปโหลด', () => {
    Object.defineProperty(globalThis, 'navigator', {
      value: {}, configurable: true, writable: true, enumerable: false,
    });
    const hook = renderQueue();
    act(() => { hook.queue().enqueue([fileOf('x.pdf')], { parentId: null, parentName: 'ไดร์ฟของฉัน' }); });
    assert.equal(hook.queue().items.length, 1, 'ไม่รู้ ไม่เท่ากับ ออฟไลน์');
    hook.unmount();
  });

  /**
   * กลับมาออนไลน์แล้วต้องไม่ส่งของที่เคยถูกปฏิเสธไปเอง
   *
   * **ความเสี่ยงที่กันไว้:** ถ้าระบบจำไฟล์ที่ถูกปฏิเสธไว้แล้วส่งเองตอนเน็ตกลับมา
   * ผู้ใช้ที่เปลี่ยนใจไปแล้ว หรือเลือกไฟล์ผิดตั้งแต่แรก จะพบว่ามีไฟล์ถูกอัปโหลด
   * ขึ้นไปโดยที่เขาไม่ได้สั่งในจังหวะนั้น การอัปโหลดต้องเกิดจากการกระทำของผู้ใช้เสมอ
   */
  test('กลับมาออนไลน์แล้วไม่ส่งของที่เคยถูกปฏิเสธโดยอัตโนมัติ', () => {
    setOnline(false);
    const hook = renderQueue();
    act(() => { hook.queue().enqueue([fileOf('ถูกปฏิเสธ.pdf')], { parentId: null, parentName: 'ไดร์ฟของฉัน' }); });
    assert.equal(hook.queue().items.length, 0, 'ตอนออฟไลน์ต้องไม่มีอะไรค้างไว้');

    // เน็ตกลับมา - ระบบต้องไม่มีอะไรให้ส่ง เพราะไม่เคยเก็บไว้ตั้งแต่แรก
    setOnline(true);
    act(() => { (globalThis as { window?: { dispatchEvent?: (e: Event) => void } }).window?.dispatchEvent?.(new Event('online')); });
    assert.equal(hook.queue().items.length, 0, 'ห้ามส่งของเก่าเองเมื่อกลับมาออนไลน์');
    hook.unmount();
  });

  /** หลายไฟล์ต้องเข้าคิวครบทุกไฟล์ แยกรายการกัน */
  test('เลือกหลายไฟล์ตอนออนไลน์ เข้าคิวครบทุกไฟล์', () => {
    setOnline(true);
    const hook = renderQueue();
    act(() => {
      hook.queue().enqueue(
        [fileOf('รูป.jpg'), fileOf('เอกสาร.pdf'), fileOf('ตาราง.xlsx')],
        { parentId: 'f1', parentName: 'ภาษี' },
      );
    });
    const names = hook.queue().items.map((item) => item.file.name);
    assert.deepEqual(names, ['รูป.jpg', 'เอกสาร.pdf', 'ตาราง.xlsx']);
    // ทุกไฟล์เป็นรายการของตัวเอง จึงล้มเหลวหรือสำเร็จแยกกันได้
    assert.equal(new Set(hook.queue().items.map((item) => item.id)).size, 3);
    hook.unmount();
  });
});

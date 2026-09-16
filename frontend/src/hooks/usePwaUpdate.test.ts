import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from './useToast.tsx';
import { UploadQueueProvider } from './useUploadQueue.tsx';
import { usePwaUpdate, type PwaUpdateState } from './usePwaUpdate.ts';

/**
 * service worker เป็นส่วนเสริม ไม่ใช่เงื่อนไขของการทำงาน (F24-B)
 *
 * **สิ่งที่ชุดนี้พิสูจน์:** แอปต้องใช้งานได้ตามปกติในทุกกรณีที่ลงทะเบียนไม่สำเร็จ
 * ซึ่งเกิดได้จริงหลายทาง: เปิดผ่าน http ที่ไม่ใช่ localhost, โหมดส่วนตัวของบางเบราว์เซอร์,
 * นโยบายขององค์กรที่ปิด service worker, หรือเบราว์เซอร์เก่าที่ไม่รองรับเลย
 *
 * ในสภาพแวดล้อมของชุดทดสอบไม่มีโมดูลเสมือนของ PWA อยู่จริง การนำเข้าจึงล้มเหลว
 * ซึ่งตรงกับกรณี "ลงทะเบียนไม่ได้" พอดี และเป็นสิ่งที่เราต้องการทดสอบ
 */
function renderUpdateHook(): { state: () => PwaUpdateState; unmount: () => void } {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let latest!: PwaUpdateState;
  function Probe() {
    latest = usePwaUpdate();
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
  return { state: () => latest, unmount: () => act(() => { tree.unmount(); }) };
}

describe('F24-B การลงทะเบียน service worker ที่ล้มเหลว', { concurrency: 1 }, () => {
  /** ไม่มี service worker ก็ต้องเรนเดอร์ผ่าน ไม่โยนข้อยกเว้นออกมา */
  test('แอปทำงานต่อได้เมื่อลงทะเบียนไม่สำเร็จ', () => {
    const hook = renderUpdateHook();
    assert.equal(hook.state().updateAvailable, false);
    assert.equal(hook.state().pendingActivation, false);
    hook.unmount();
  });

  /** ไม่มีเวอร์ชันใหม่ให้เสนอ ก็ต้องไม่มีคำเชิญให้อัปเดตโผล่มา */
  test('ไม่เสนอการอัปเดตทั้งที่ยังลงทะเบียนไม่ได้', () => {
    const hook = renderUpdateHook();
    act(() => { hook.state().applyUpdate(); });
    assert.equal(hook.state().updateAvailable, false, 'ไม่มีเวอร์ชันใหม่ จึงไม่มีอะไรให้แสดง');
    hook.unmount();
  });

  /** คิวว่างอยู่ จึงพร้อมอัปเดตในทางหลักการ แม้ยังไม่มีเวอร์ชันใหม่ */
  test('รายงานความพร้อมตามคิวอัปโหลดจริง', () => {
    const hook = renderUpdateHook();
    assert.equal(hook.state().readiness.canActivate, true, 'คิวว่าง จึงไม่มีอะไรขวาง');
    hook.unmount();
  });

  /** ปิดคำเชิญแล้วต้องไม่กลับมาเอง */
  test('ปิดคำเชิญได้โดยไม่พัง', () => {
    const hook = renderUpdateHook();
    act(() => { hook.state().dismiss(); });
    assert.equal(hook.state().updateAvailable, false);
    hook.unmount();
  });
});

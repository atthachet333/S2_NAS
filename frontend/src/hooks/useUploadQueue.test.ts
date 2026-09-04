import assert from 'node:assert/strict';
import { describe, mock, test } from 'node:test';
import { createElement } from 'react';
import TestRenderer, { type ReactTestRenderer } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from './useToast.tsx';
import { UploadQueueProvider } from './useUploadQueue.tsx';

/**
 * ตัวจับเวลาของคิวอัปโหลด
 *
 * ประเด็นที่ต้องกันไว้คือ "ตัวจับเวลาซ้อนกัน" - ถ้าทุกครั้งที่ re-render สร้างตัวจับเวลาใหม่
 * แถวเดียวจะถูกกวาดหลายรอบ และตัวจับเวลาเก่าจะรั่วค้างไว้เรื่อย ๆ
 * การออกแบบใช้ตัวจับเวลาตัวเดียวกวาดทั้งคิว ชุดทดสอบนี้ยืนยันข้อนั้น
 */
function renderProvider(): { tree: ReactTestRenderer; client: QueryClient } {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let tree!: ReactTestRenderer;
  TestRenderer.act(() => {
    tree = TestRenderer.create(
      createElement(
        QueryClientProvider,
        { client },
        createElement(ToastProvider, null, createElement(UploadQueueProvider, null, null)),
      ),
    );
  });
  return { tree, client };
}

describe('ตัวจับเวลาเก็บกวาดคิวอัปโหลด', () => {
  test('สร้างตัวจับเวลาเพียงตัวเดียว ไม่ว่าจะ re-render กี่ครั้ง', (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const spy = t.mock.method(globalThis, 'setInterval');

    const { tree } = renderProvider();
    assert.equal(spy.mock.callCount(), 1, 'ต้องมีตัวจับเวลาเดียวตอน mount');

    // re-render ซ้ำหลายรอบ ต้องไม่เพิ่มตัวจับเวลา
    for (let round = 0; round < 3; round += 1) {
      TestRenderer.act(() => {
        tree.update(
          createElement(
            QueryClientProvider,
            { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) },
            createElement(ToastProvider, null, createElement(UploadQueueProvider, null, null)),
          ),
        );
      });
    }

    assert.equal(spy.mock.callCount(), 1, 'ห้ามมีตัวจับเวลาซ้อนกันหลังจาก re-render');
    TestRenderer.act(() => tree.unmount());
  });

  test('ตัวจับเวลาถูกเก็บกวาดตอน unmount ไม่ทิ้งไว้ให้รั่ว', (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const clearSpy = t.mock.method(globalThis, 'clearInterval');

    const { tree } = renderProvider();
    TestRenderer.act(() => tree.unmount());

    assert.ok(clearSpy.mock.callCount() >= 1, 'ต้องเรียก clearInterval ตอน unmount');
  });
});

mock.reset();

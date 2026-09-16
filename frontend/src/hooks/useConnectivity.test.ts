import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { readOnline, useConnectivity, type ConnectivityState } from './useConnectivity.ts';

/**
 * สถานะการเชื่อมต่อ (F24-B)
 *
 * **สิ่งที่ชุดนี้กันไว้:** การสรุปว่า "ออนไลน์ = ใช้งานได้" navigator.onLine บอกแค่ว่า
 * เครื่องมีเส้นทางออกเครือข่าย ไม่ได้บอกว่าเซิร์ฟเวอร์ของเราตอบอยู่ ชุดนี้จึงยืนยัน
 * ว่าเราอ่านค่านั้นตามความหมายจริงของมัน และทำงานได้แม้ในที่ที่ไม่มี window เลย
 */

interface FakeWindow {
  addEventListener: (type: string, handler: () => void) => void;
  removeEventListener: (type: string, handler: () => void) => void;
  setTimeout: typeof setTimeout;
  clearTimeout: typeof clearTimeout;
  fire: (type: string) => void;
  listenerCount: () => number;
}

function makeWindow(): FakeWindow {
  const handlers = new Map<string, Set<() => void>>();
  return {
    addEventListener(type, handler) {
      if (!handlers.has(type)) handlers.set(type, new Set());
      handlers.get(type)!.add(handler);
    },
    removeEventListener(type, handler) {
      handlers.get(type)?.delete(handler);
    },
    setTimeout: ((fn: () => void, ms?: number) => setTimeout(fn, ms)) as typeof setTimeout,
    clearTimeout: ((id: never) => clearTimeout(id)) as typeof clearTimeout,
    fire(type) {
      for (const handler of handlers.get(type) ?? []) handler();
    },
    listenerCount() {
      let total = 0;
      for (const set of handlers.values()) total += set.size;
      return total;
    },
  };
}

const globals = globalThis as unknown as { window?: unknown; navigator?: unknown };
let savedNavigator: PropertyDescriptor | undefined;
let savedWindow: unknown;
let fakeWindow: FakeWindow;

/**
 * navigator ของ Node เป็นคุณสมบัติแบบอ่านอย่างเดียว กำหนดค่าทับตรง ๆ ไม่ได้
 * ต้องนิยามใหม่ทั้งตัวคุณสมบัติแทน
 */
function setNavigator(value: unknown): void {
  Object.defineProperty(globalThis, 'navigator', {
    value, configurable: true, writable: true, enumerable: false,
  });
}

function renderHook(): { state: () => ConnectivityState; unmount: () => void } {
  let latest!: ConnectivityState;
  function Probe() {
    latest = useConnectivity();
    return null;
  }
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => { tree = TestRenderer.create(createElement(Probe)); });
  return { state: () => latest, unmount: () => act(() => { tree.unmount(); }) };
}

describe('F24-B สถานะการเชื่อมต่อ', { concurrency: 1 }, () => {
  beforeEach(() => {
    savedWindow = globals.window;
    savedNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    fakeWindow = makeWindow();
    globals.window = fakeWindow;
    setNavigator({ onLine: true });
  });

  afterEach(() => {
    globals.window = savedWindow;
    if (savedNavigator) Object.defineProperty(globalThis, 'navigator', savedNavigator);
  });

  test('เริ่มต้นตามค่าที่เบราว์เซอร์บอก', () => {
    const hook = renderHook();
    assert.equal(hook.state().online, true);
    assert.equal(hook.state().reconnected, false);
    hook.unmount();
  });

  test('เหตุการณ์ offline ทำให้สถานะเป็นออฟไลน์', () => {
    const hook = renderHook();
    act(() => { fakeWindow.fire('offline'); });
    assert.equal(hook.state().online, false);
    hook.unmount();
  });

  /**
   * "กลับมาออนไลน์แล้ว" ต้องแสดงเฉพาะเมื่อเคยหลุดไปจริง
   *
   * ถ้าแสดงทุกครั้งที่ได้รับเหตุการณ์ online ผู้ใช้ที่ไม่เคยหลุดเลยจะเห็นข้อความ
   * ยืนยันการกลับมาเชื่อมต่อโดยไม่มีเหตุ ซึ่งทำให้ข้อความนั้นหมดความหมาย
   */
  test('รายงานว่ากลับมาเชื่อมต่อได้ เฉพาะเมื่อเคยหลุดไปก่อน', () => {
    const hook = renderHook();

    act(() => { fakeWindow.fire('online'); });
    assert.equal(hook.state().reconnected, false, 'ไม่เคยหลุด จึงไม่ใช่การกลับมา');

    act(() => { fakeWindow.fire('offline'); });
    act(() => { fakeWindow.fire('online'); });
    assert.equal(hook.state().online, true);
    assert.equal(hook.state().reconnected, true, 'หลุดแล้วกลับมา ต้องรายงาน');

    hook.unmount();
  });

  /** ถอด listener ตอนเลิกใช้ มิฉะนั้นจะสะสมทุกครั้งที่เปลี่ยนหน้า */
  test('เก็บกวาด listener ตอน unmount', () => {
    const hook = renderHook();
    assert.equal(fakeWindow.listenerCount(), 2, 'ต้องมี online และ offline');
    hook.unmount();
    assert.equal(fakeWindow.listenerCount(), 0);
  });

  /** เซิร์ฟเวอร์เรนเดอร์หรือสภาพแวดล้อมทดสอบที่ไม่มี navigator ต้องไม่พัง */
  test('ไม่มี navigator ก็ถือว่าออนไลน์ไว้ก่อน', () => {
    setNavigator(undefined);
    assert.equal(readOnline(), true, 'ไม่รู้ ไม่ควรปิดการใช้งานทุกอย่างทิ้ง');
  });

  test('navigator.onLine เป็นเท็จ คือออฟไลน์', () => {
    setNavigator({ onLine: false });
    assert.equal(readOnline(), false);
  });
});

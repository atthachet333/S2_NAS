import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { MobileUploadSheet } from './MobileUploadSheet.tsx';
import { UPLOAD_EVENTS } from '@/lib/upload-inputs';

/**
 * ตัวเลือกการอัปโหลดบนมือถือขณะออฟไลน์ (F24-D)
 *
 * **ทำไมต้องตรวจที่แผ่นนี้ด้วย ทั้งที่ enqueue กันไว้แล้ว:** ด่านที่ enqueue กันไม่ให้
 * ไฟล์เข้าคิวได้จริง แต่ถ้าปุ่มยังกดได้อยู่ ผู้ใช้จะเปิดตัวเลือกไฟล์ เลือกไฟล์จนเสร็จ
 * แล้วค่อยได้รับแจ้งว่าทำไม่ได้ ซึ่งเสียเวลาไปทั้งกระบวนการ การปิดปุ่มตั้งแต่ต้น
 * บอกความจริงให้เร็วที่สุดเท่าที่บอกได้
 */
let savedNavigator: PropertyDescriptor | undefined;
let savedWindow: unknown;

function setOnline(online: boolean): void {
  Object.defineProperty(globalThis, 'navigator', {
    value: { onLine: online }, configurable: true, writable: true, enumerable: false,
  });
}

/** แผ่นนี้ผูกกับ useConnectivity ซึ่งต้องมี window ให้ติดตั้งตัวรับเหตุการณ์ */
function installWindow(): { dispatched: string[] } {
  const dispatched: string[] = [];
  savedWindow = (globalThis as { window?: unknown }).window;
  (globalThis as { window?: unknown }).window = {
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    setTimeout: (fn: () => void, ms?: number) => setTimeout(fn, ms),
    clearTimeout: (id: never) => clearTimeout(id),
    dispatchEvent: (event: Event) => { dispatched.push(event.type); return true; },
  };
  return { dispatched };
}

function render(): { tree: TestRenderer.ReactTestRenderer; buttons: () => Array<{ label: string; disabled: boolean; click: () => void }> } {
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(createElement(MobileUploadSheet, { open: true, onClose: () => undefined }));
  });
  const buttons = () => tree.root
    .findAll((node) => node.type === 'button' && String(node.props.className ?? '').includes('min-h-[48px]'))
    .map((node) => {
      const texts: string[] = [];
      const walk = (child: unknown): void => {
        if (typeof child === 'string') { texts.push(child); return; }
        if (Array.isArray(child)) { child.forEach(walk); return; }
        const item = child as { props?: { children?: unknown } } | null;
        if (item && typeof item === 'object' && item.props) walk(item.props.children);
      };
      walk(node.props.children);
      return {
        label: texts.join(' ').trim(),
        disabled: node.props.disabled === true,
        click: () => act(() => { node.props.onClick(); }),
      };
    });
  return { tree, buttons };
}

describe('F24-D แผ่นอัปโหลดบนมือถือ', { concurrency: 1 }, () => {
  let harness: { dispatched: string[] };

  beforeEach(() => {
    savedNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    harness = installWindow();
  });

  afterEach(() => {
    if (savedNavigator) Object.defineProperty(globalThis, 'navigator', savedNavigator);
    (globalThis as { window?: unknown }).window = savedWindow;
  });

  test('ออนไลน์: เลือกไฟล์ รูปภาพ และถ่ายเอกสาร ใช้ได้ทั้งสามทาง', () => {
    setOnline(true);
    const { buttons } = render();
    const options = buttons();
    assert.ok(options.some((b) => b.label.includes('เลือกไฟล์')));
    assert.ok(options.some((b) => b.label.includes('เลือกรูปภาพ')));
    assert.ok(options.some((b) => b.label.includes('ถ่ายเอกสาร')));
    assert.deepEqual(options.filter((b) => b.disabled).map((b) => b.label), [],
      'ออนไลน์แล้วต้องไม่มีตัวเลือกใดถูกปิด');
  });

  /** ทั้งสามทางต้องถูกปิดพร้อมกัน ไม่ใช่ปิดแค่บางทาง */
  test('ออฟไลน์: ปิดทั้งสามทาง', () => {
    setOnline(false);
    const { buttons } = render();
    const options = buttons().filter((b) =>
      ['เลือกไฟล์', 'เลือกรูปภาพ', 'ถ่ายเอกสาร'].some((name) => b.label.includes(name)));
    assert.equal(options.length, 3, 'ต้องมีครบสามทางให้ตรวจ');
    for (const option of options) {
      assert.equal(option.disabled, true, `ต้องปิด: ${option.label}`);
    }
  });

  test('ออฟไลน์: อธิบายว่าทำไมทำไม่ได้ และไม่สัญญาว่าจะส่งให้ทีหลัง', () => {
    setOnline(false);
    const { tree } = render();
    const texts: string[] = [];
    const walk = (node: unknown): void => {
      if (typeof node === 'string') { texts.push(node); return; }
      if (Array.isArray(node)) { node.forEach(walk); return; }
      const item = node as { children?: unknown } | null;
      if (item && typeof item === 'object' && 'children' in item) walk(item.children);
    };
    walk(tree.toJSON());
    const all = texts.join(' ');
    assert.ok(all.includes('ขณะนี้ออฟไลน์'), all.slice(0, 200));
    assert.ok(all.includes('ระบบไม่เก็บไฟล์ไว้ส่งให้ภายหลัง'),
      'ต้องบอกตรง ๆ ว่าไม่มีการเก็บไว้ส่งทีหลัง');
  });

  /**
   * ปุ่มที่ถูกปิดต้องไม่ยิงเหตุการณ์เปิดตัวเลือกไฟล์
   *
   * ถ้ายิงออกไป หน้าไดร์ฟจะเปิดตัวเลือกไฟล์ของระบบขึ้นมา ทั้งที่อัปโหลดไม่ได้
   */
  test('ออฟไลน์: ไม่มีเหตุการณ์เปิดตัวเลือกไฟล์ถูกส่งออกไป', () => {
    setOnline(false);
    const { buttons } = render();
    for (const option of buttons()) {
      if (option.disabled) continue;
      option.click();
    }
    const uploadEvents = Object.values(UPLOAD_EVENTS);
    assert.deepEqual(harness.dispatched.filter((type) => uploadEvents.includes(type as never)), [],
      'ห้ามสั่งเปิดตัวเลือกไฟล์ขณะออฟไลน์');
  });
});

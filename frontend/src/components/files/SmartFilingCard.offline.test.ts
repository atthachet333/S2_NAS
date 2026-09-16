import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { createElement } from 'react';
import TestRenderer, { act, type ReactTestInstance } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SmartFilingCard } from './SmartFilingCard.tsx';
import { ASSISTANT_OFFLINE_TEXT } from '@/components/assistant/AssistantPanel';
import type { SmartFilingSuggestionDto } from '@/lib/api';

const srcDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * การจัดเก็บอัจฉริยะขณะออฟไลน์ (F24-I)
 *
 * **ทำไมต้องปิดทุกปุ่มพร้อมกัน:** การวิเคราะห์ การยืนยันย้าย และการเลือกไว้ที่เดิม
 * ล้วนต้องคุยกับเซิร์ฟเวอร์ ถ้าปิดแค่บางปุ่ม ผู้ใช้จะกดปุ่มที่เหลือแล้วรอคำตอบ
 * ที่ไม่มีวันมา หรือแย่กว่านั้นคือเห็นข้อความผิดพลาดที่ไม่ได้บอกสาเหตุจริง
 */
let savedNavigator: PropertyDescriptor | undefined;
let savedWindow: unknown;

function setOnline(online: boolean): void {
  Object.defineProperty(globalThis, 'navigator', {
    value: { onLine: online }, configurable: true, writable: true, enumerable: false,
  });
}

function installWindow(): void {
  savedWindow = (globalThis as { window?: unknown }).window;
  (globalThis as { window?: unknown }).window = {
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    setTimeout: (fn: () => void, ms?: number) => setTimeout(fn, ms),
    clearTimeout: (id: never) => clearTimeout(id),
  };
}

function suggestionOf(overrides: Partial<SmartFilingSuggestionDto> = {}): SmartFilingSuggestionDto {
  return {
    suggestionId: 's1', status: 'READY', resultLevel: 'CLIENT_ONLY',
    client: { folderId: 'c1', label: '1. ลูกค้าทดสอบ', confidence: 'HIGH' },
    destination: { folderId: 'c1', pathLabel: '1. ลูกค้าทดสอบ', confidence: 'LOW' },
    alternatives: [], reasons: [], signals: [], stale: false,
    ...overrides,
  };
}

function render(data: SmartFilingSuggestionDto): {
  buttons: () => ReactTestInstance[];
  texts: () => string;
} {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['smart-filing', 'r1'], data);
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(createElement(QueryClientProvider, { client },
      createElement(SmartFilingCard, { resourceId: 'r1', currentParentId: null })));
  });
  const texts = () => {
    const out: string[] = [];
    const walk = (node: unknown): void => {
      if (typeof node === 'string') { out.push(node); return; }
      if (Array.isArray(node)) { node.forEach(walk); return; }
      const item = node as { children?: unknown } | null;
      if (item && typeof item === 'object' && 'children' in item) walk(item.children);
    };
    walk(tree.toJSON());
    return out.join(' ');
  };
  return { buttons: () => tree.root.findAllByType('button'), texts };
}

describe('F24-I จัดเก็บอัจฉริยะขณะออฟไลน์', { concurrency: 1 }, () => {
  beforeEach(() => {
    savedNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    installWindow();
  });

  afterEach(() => {
    if (savedNavigator) Object.defineProperty(globalThis, 'navigator', savedNavigator);
    (globalThis as { window?: unknown }).window = savedWindow;
  });

  test('ออฟไลน์: ทุกปุ่มที่ต้องใช้เซิร์ฟเวอร์ถูกปิด', () => {
    setOnline(false);
    const view = render(suggestionOf());
    const enabled = view.buttons().filter((button) => button.props.disabled !== true);
    assert.deepEqual(enabled, [], 'ไม่ควรเหลือปุ่มที่กดได้เลยขณะออฟไลน์');
  });

  test('ออฟไลน์: บอกเหตุผลให้ผู้ใช้เห็น', () => {
    setOnline(false);
    const view = render(suggestionOf());
    assert.ok(view.texts().includes('ต้องเชื่อมต่ออินเทอร์เน็ต'), view.texts().slice(0, 200));
  });

  test('ออนไลน์: ปุ่มกลับมาใช้งานได้ตามปกติ', () => {
    setOnline(true);
    const view = render(suggestionOf());
    const enabled = view.buttons().filter((button) => button.props.disabled !== true);
    assert.ok(enabled.length > 0, 'ออนไลน์แล้วต้องมีปุ่มให้ใช้');
  });

  /**
   * CLIENT_ONLY เป็นผลลัพธ์ที่พบบ่อยที่สุดและเป็นผลที่ถูกต้อง
   * ต้องไม่ถูกนำเสนอเหมือนความล้มเหลว
   */
  test('CLIENT_ONLY อ่านแล้วรู้ว่าระบบรู้อะไรและไม่รู้อะไร', () => {
    setOnline(true);
    const all = render(suggestionOf({ resultLevel: 'CLIENT_ONLY' })).texts();
    assert.ok(all.includes('พบลูกค้าที่น่าจะตรงกับเอกสารนี้'), all.slice(0, 200));
    assert.ok(all.includes('ยังไม่แน่ใจโฟลเดอร์ย่อย'), 'ต้องบอกด้วยว่ายังไม่รู้อะไร');
    assert.ok(!all.includes('ไม่สำเร็จ') && !all.includes('ผิดพลาด'),
      'ผลลัพธ์ที่ถูกต้องต้องไม่ถูกเขียนเหมือนข้อผิดพลาด');
  });

  /** ข้อเสนอที่ไม่เป็นปัจจุบันแล้วต้องกดย้ายต่อไม่ได้ */
  test('ข้อเสนอที่ล้าสมัยไม่ให้กดย้ายทันที', () => {
    setOnline(true);
    const view = render(suggestionOf({ stale: true }));
    const all = view.texts();
    assert.ok(all.includes('ไม่เป็นปัจจุบัน'), all.slice(0, 200));
    assert.ok(!all.includes('ย้ายเข้า'), 'ห้ามเสนอปุ่มย้ายจากข้อเสนอที่ล้าสมัย');
  });

  /** ความมั่นใจต้องอ่านออกเป็นคำ ไม่ใช่สื่อด้วยสีอย่างเดียว */
  test('ความมั่นใจสื่อด้วยข้อความ ไม่ใช่สีเพียงอย่างเดียว', () => {
    setOnline(true);
    const all = render(suggestionOf()).texts();
    assert.ok(/สูง|ปานกลาง|ต่ำ/.test(all), all.slice(0, 200));
  });
});

describe('F24-H ผู้ช่วยเอกสารขณะออฟไลน์', { concurrency: 1 }, () => {
  test('มีข้อความเดียวที่ใช้ร่วมกันทุกที่', () => {
    assert.equal(ASSISTANT_OFFLINE_TEXT, 'ต้องเชื่อมต่ออินเทอร์เน็ตเพื่อใช้งานผู้ช่วยเอกสาร');
  });

  /**
   * ด่านอยู่ที่ ask ซึ่งเป็นทางผ่านเดียวของทั้งปุ่มถามและปุ่มคำถามสำเร็จรูป
   * ถ้าด่านอยู่ที่ปุ่มอย่างเดียว ปุ่มคำถามสำเร็จรูปจะหลุดออกไปได้
   */
  test('กันการส่งคำถามไว้ที่ทางผ่านเดียว ไม่ใช่ที่ปุ่ม', () => {
    const source = fs.readFileSync(path.join(srcDir, 'components', 'assistant', 'AssistantPanel.tsx'), 'utf8');
    const askBody = source.slice(source.indexOf('async function ask('), source.indexOf('if (!open) return null;'));
    assert.ok(askBody.includes('navigator.onLine === false'), 'ฟังก์ชัน ask ต้องตรวจสถานะเครือข่ายเอง');
    assert.ok(askBody.includes('ASSISTANT_OFFLINE_TEXT'), 'และต้องบอกเหตุผลด้วยข้อความเดียวกัน');
    assert.ok(!/queue|pending|retryLater/i.test(askBody), 'ห้ามเก็บคำถามไว้ถามให้ทีหลัง');
  });
});

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { ToastProvider } from '@/hooks/useToast';
import { PreviewModal } from './PreviewModal.tsx';
import type { DriveEntry } from '@/lib/drive';

/**
 * หน้าตัวอย่างไฟล์บนมือถือ (F24-F)
 *
 * **สิ่งที่ชุดนี้กันไว้เป็นหลัก:** การทำให้ผู้ใช้เข้าใจว่ามีสำเนาเอกสารอยู่ในเครื่อง
 * service worker ของระบบนี้เก็บเฉพาะเปลือกแอป ไม่มีไบต์ของเอกสารเลยแม้แต่ไฟล์เดียว
 * ตอนออฟไลน์จึงต้องบอกตรง ๆ ว่าเปิดไม่ได้ ไม่ใช่หมุนตัวโหลดค้างไว้ให้เดาเอาเอง
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

function entryOf(overrides: Partial<DriveEntry> = {}): DriveEntry {
  return {
    id: 'r1', kind: 'file', resourceType: 'FILE', name: 'ใบเสนอราคา.pdf',
    sizeBytes: 2048, ownerId: 'u1', ownerName: 'ผู้ดูแล', ownerEmail: 'owner@example.invalid',
    modifiedAt: new Date().toISOString(), createdAt: new Date().toISOString(),
    mimeType: 'application/pdf', uploadedBy: null, currentVersion: 1,
    classification: 'INTERNAL', classifiedAt: null, classificationRestrictions: null,
    visibility: 'ORGANIZATION', driveRoot: 'MY_DRIVE', favorite: false, pinned: false,
    parentId: null, isLocked: false, tags: [], lockReason: null, lockedAt: null, lockedByName: null,
    capabilities: { canDownload: true } as unknown as DriveEntry['capabilities'],
    ...overrides,
  };
}

function render(entry: DriveEntry): { texts: () => string; labels: () => string[] } {
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(createElement(ToastProvider, null,
      createElement(PreviewModal, { entry, onClose: () => undefined })));
  });
  const collect = (): string => {
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
  const labels = () => tree.root
    .findAll((node) => node.type === 'button' && typeof node.props['aria-label'] === 'string')
    .map((node) => node.props['aria-label'] as string);
  return { texts: collect, labels };
}

describe('F24-F หน้าตัวอย่างไฟล์', { concurrency: 1 }, () => {
  beforeEach(() => {
    savedNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    installWindow();
  });

  afterEach(() => {
    if (savedNavigator) Object.defineProperty(globalThis, 'navigator', savedNavigator);
    (globalThis as { window?: unknown }).window = savedWindow;
  });

  test('ออฟไลน์: บอกว่าต้องเชื่อมต่ออินเทอร์เน็ต ไม่หมุนตัวโหลดค้างไว้', () => {
    setOnline(false);
    const view = render(entryOf());
    const all = view.texts();
    assert.ok(all.includes('ต้องเชื่อมต่ออินเทอร์เน็ตเพื่อเปิดไฟล์'), all.slice(0, 200));
    assert.ok(!all.includes('กำลังโหลดตัวอย่าง'), 'ห้ามแสดงว่ากำลังโหลดทั้งที่โหลดไม่ได้');
  });

  /** ดาวน์โหลดตอนออฟไลน์ก็ล้มเหลวแน่นอน จึงไม่ควรเสนอปุ่มให้กด */
  test('ออฟไลน์: ไม่เสนอปุ่มดาวน์โหลดที่กดแล้วล้มเหลวแน่นอน', () => {
    setOnline(false);
    const view = render(entryOf());
    assert.ok(!view.texts().includes('คุณไม่มีสิทธิ์ดาวน์โหลด'),
      'ข้อความเรื่องสิทธิ์ไม่เกี่ยวกับกรณีออฟไลน์');
  });

  /**
   * ปุ่มบนแถบหัวเรื่องเหลือแต่ไอคอนบนจอแคบ จึงต้องมีชื่อของตัวเอง
   *
   * ข้อบกพร่องเดิม: ป้ายข้อความถูกซ่อนด้วย hidden sm:inline โดยไม่มี aria-label
   * ปุ่มดาวน์โหลดและปุ่มรายละเอียดจึงไม่มีชื่อให้ตัวอ่านหน้าจอเลยบนมือถือ
   */
  test('ปุ่มไอคอนบนแถบหัวเรื่องมีชื่อสำหรับตัวอ่านหน้าจอ', () => {
    setOnline(true);
    const view = render(entryOf());
    const labels = view.labels();
    assert.ok(labels.some((label) => label.includes('ปิดตัวอย่าง')), JSON.stringify(labels));
    assert.ok(labels.some((label) => label.includes('ต้นฉบับ') || label.includes('ดาวน์โหลด')),
      `ปุ่มดาวน์โหลดต้องมีชื่อ: ${JSON.stringify(labels)}`);
  });

  /** ไม่มีสิทธิ์ดาวน์โหลด ต้องไม่มีปุ่มดาวน์โหลดโผล่มา */
  test('ไม่มีสิทธิ์ดาวน์โหลดก็ไม่มีปุ่มดาวน์โหลด', () => {
    setOnline(true);
    const view = render(entryOf({ capabilities: { canDownload: false } as unknown as DriveEntry['capabilities'] }));
    const labels = view.labels();
    assert.ok(!labels.some((label) => label.includes('ต้นฉบับ')), JSON.stringify(labels));
  });

  /** ชนิดไฟล์ที่เปิดตัวอย่างไม่ได้ ต้องบอกตรง ๆ แทนที่จะค้าง */
  test('ชนิดที่ไม่รองรับแสดงทางออกแทนการค้าง', () => {
    setOnline(true);
    const view = render(entryOf({ name: 'ข้อมูล.zip', mimeType: 'application/zip' }));
    const all = view.texts();
    assert.ok(all.includes('ไม่รองรับการแสดงตัวอย่าง'), all.slice(0, 200));
  });
});

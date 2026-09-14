import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createElement } from 'react';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SmartFilingCard } from './SmartFilingCard.tsx';
import type { SmartFilingSuggestionDto } from '@/lib/api';

/**
 * การ์ดจัดเก็บอัจฉริยะต้องพูดความจริงเกี่ยวกับสิ่งที่ระบบรู้ (F22-F)
 *
 * **เหตุผลที่ชุดนี้มีอยู่:** วัดกับคลังเอกสารจริงแล้วพบว่า 88% ของกรณีที่มีข้อเสนอ
 * จบที่ระดับ "รู้ลูกค้า แต่ไม่รู้โฟลเดอร์ย่อย" หน้าจอที่บอกเป็นนัยว่ารู้ปลายทางเต็มรูปแบบ
 * จะทำให้ผู้ใช้เชื่อผิดในกรณีที่พบบ่อยที่สุด ชุดนี้จึงกันไม่ให้ข้อความแบบนั้นหลุดเข้ามา
 *
 * ไม่ต่อเน็ตจริง - ใส่ผลลัพธ์ลง query cache โดยตรงแล้วตรวจสิ่งที่เรนเดอร์ออกมา
 */

function suggestionOf(overrides: Partial<SmartFilingSuggestionDto>): SmartFilingSuggestionDto {
  return {
    suggestionId: 's1', status: 'READY', resultLevel: 'CLIENT_ONLY',
    client: { folderId: 'c1', label: '1. อัลฟ่าทดสอบ', confidence: 'HIGH' },
    destination: { folderId: 'c1', pathLabel: '1. อัลฟ่าทดสอบ', confidence: 'LOW' },
    alternatives: [], reasons: [], signals: [], stale: false,
    ...overrides,
  };
}

function render(data: SmartFilingSuggestionDto | null): { texts: string[]; tree: ReactTestRenderer } {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['smart-filing', 'r1'], data);
  let tree!: ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(createElement(QueryClientProvider, { client },
      createElement(SmartFilingCard, { resourceId: 'r1', currentParentId: null })));
  });
  const texts: string[] = [];
  const walk = (node: unknown): void => {
    if (typeof node === 'string') { texts.push(node); return; }
    if (Array.isArray(node)) { node.forEach(walk); return; }
    const item = node as { children?: unknown } | null;
    if (item && typeof item === 'object' && 'children' in item) walk(item.children);
  };
  walk(tree.toJSON());
  // ยุบช่องว่างซ้ำ - JSX แยกข้อความเป็นหลายโหนด ทำให้เกิดช่องว่างติดกันโดยไม่ได้ตั้งใจ
  return { texts, tree };
}

describe('F22 smart filing card', { concurrency: 1 }, () => {
  /**
   * กรณีที่พบบ่อยที่สุด - รู้ลูกค้าแต่ไม่รู้โฟลเดอร์ย่อย
   *
   * ต้องบอกตรง ๆ ว่ายังไม่แน่ใจโฟลเดอร์ย่อย และปุ่มย้ายต้องระบุว่าย้ายเข้าโฟลเดอร์ลูกค้า
   * ไม่ใช่ทำให้ดูเหมือนรู้ปลายทางที่ลึกกว่านั้น
   */
  test('a client-only result says plainly that the subfolder is unknown', () => {
    const { texts } = render(suggestionOf({ resultLevel: 'CLIENT_ONLY' }));
    const joined = texts.join(' ').replace(/\s+/gu, ' ');
    assert.match(joined, /ยังไม่แน่ใจโฟลเดอร์ย่อย/u);
    assert.match(joined, /ย้ายเข้า 1\. อัลฟ่าทดสอบ/u, 'ปุ่มต้องระบุว่าย้ายเข้าโฟลเดอร์ลูกค้า');
    assert.match(joined, /ความมั่นใจลูกค้า สูง/u);
    // ต้องไม่มีข้อความที่บอกเป็นนัยว่ารู้ปลายทางเต็มรูปแบบ
    assert.doesNotMatch(joined, /แนะนำตำแหน่ง/u);
  });

  /** ความมั่นใจลูกค้ากับความมั่นใจตำแหน่งต้องไม่ถูกยุบเป็นค่าเดียว */
  test('client and destination confidence are shown separately', () => {
    const { texts } = render(suggestionOf({
      resultLevel: 'FULL_DESTINATION',
      client: { folderId: 'c1', label: '1. อัลฟ่าทดสอบ', confidence: 'HIGH' },
      destination: { folderId: 'f9', pathLabel: '1. อัลฟ่าทดสอบ / ปี 2569 / ภ.พ.30', confidence: 'HIGH' },
      reasons: ['เอกสารที่มีเลขประจำตัวผู้เสียภาษีเดียวกันถูกเก็บไว้ในโฟลเดอร์ลูกค้ารายนี้'],
    }));
    const joined = texts.join(' ').replace(/\s+/gu, ' ');
    assert.match(joined, /ความมั่นใจลูกค้า สูง/u);
    assert.match(joined, /ความมั่นใจตำแหน่ง สูง/u);
    assert.match(joined, /แนะนำตำแหน่ง/u);
    assert.match(joined, /ปี 2569 \/ ภ\.พ\.30/u, 'ต้องแสดงเส้นทางปลายทางที่แนะนำ');
    assert.match(joined, /เลขประจำตัวผู้เสียภาษีเดียวกัน/u, 'ต้องแสดงเหตุผล');
    assert.doesNotMatch(joined, /ยังไม่แน่ใจโฟลเดอร์ย่อย/u);
  });

  /** ไม่พบตำแหน่ง เป็นผลลัพธ์ปกติ ต้องไม่ถูกนำเสนอเป็นข้อผิดพลาด */
  test('no suggestion is presented as a normal outcome, not a failure', () => {
    const { texts } = render(suggestionOf({ resultLevel: 'NO_SUGGESTION', client: null, destination: null }));
    const joined = texts.join(' ').replace(/\s+/gu, ' ');
    assert.match(joined, /ยังไม่พบตำแหน่งที่เหมาะสม/u);
    assert.match(joined, /เอกสารนี้ยังอยู่ที่เดิม/u);
    assert.doesNotMatch(joined, /ผิดพลาด|ล้มเหลว/u, 'ต้องไม่ใช้ถ้อยคำแบบข้อผิดพลาด');
  });

  /** หลายความเป็นไปได้ - ต้องไม่มีผู้ชนะโดยปริยาย */
  test('an ambiguous result offers choices with no default winner', () => {
    const { texts } = render(suggestionOf({
      resultLevel: 'AMBIGUOUS', client: null, destination: null,
      alternatives: [
        { folderId: 'c1', pathLabel: '1. อัลฟ่าทดสอบ' },
        { folderId: 'c2', pathLabel: '24. ปิติชัย' },
      ],
    }));
    const joined = texts.join(' ').replace(/\s+/gu, ' ');
    assert.match(joined, /พบหลายตำแหน่งที่เป็นไปได้/u);
    assert.match(joined, /1\. อัลฟ่าทดสอบ/u);
    assert.match(joined, /24\. ปิติชัย/u);
    // ต้องไม่มีปุ่มย้ายตรง ๆ ที่เลือกให้แล้ว
    assert.doesNotMatch(joined, /ย้ายเข้าโฟลเดอร์/u);
  });

  /** ข้อเสนอที่ไม่เป็นปัจจุบันต้องกดย้ายไม่ได้ */
  test('a stale suggestion blocks the move and offers re-analysis', () => {
    const { texts } = render(suggestionOf({ stale: true }));
    const joined = texts.join(' ').replace(/\s+/gu, ' ');
    assert.match(joined, /ไม่เป็นปัจจุบัน/u);
    assert.match(joined, /วิเคราะห์ใหม่/u);
    assert.doesNotMatch(joined, /ย้ายเข้า/u, 'ข้อเสนอที่หมดอายุต้องไม่มีปุ่มย้าย');
  });

  /**
   * ข้อเสนอที่เพิ่งถูกใช้ต้องรายงานว่าย้ายแล้ว ไม่ใช่ว่าหมดอายุ
   *
   * การย้ายทำให้ตำแหน่งเอกสารต่างจากตอนวิเคราะห์ ข้อเสนอจึงเข้าเงื่อนไข "ไม่เป็นปัจจุบัน"
   * ทันทีที่ใช้สำเร็จ ผู้ใช้ที่เพิ่งกดยืนยันต้องไม่ถูกบอกว่าข้อเสนอหมดอายุ
   */
  test('a just-accepted suggestion reports the move, not staleness', () => {
    const { texts } = render(suggestionOf({ status: 'ACCEPTED', stale: true }));
    const joined = texts.join(' ').replace(/\s+/gu, ' ');
    assert.match(joined, /ย้ายเอกสารตามข้อเสนอแล้ว/u);
    assert.doesNotMatch(joined, /ไม่เป็นปัจจุบัน/u);
  });

  /** ยังไม่เคยวิเคราะห์ ก็ไม่ใช่ข้อผิดพลาด */
  test('an un-analysed resource shows a neutral starting state', () => {
    const { texts } = render(null);
    const joined = texts.join(' ').replace(/\s+/gu, ' ');
    assert.match(joined, /ยังไม่ได้วิเคราะห์/u);
    assert.match(joined, /วิเคราะห์ตำแหน่ง/u);
  });
});

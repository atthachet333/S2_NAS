import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { surfaceStructuredConflict } from './conflict.js';
import type { AssistantEvidence } from './rag.service.js';

const evidence = (id: string, resourceId: string, title: string, text: string): AssistantEvidence => ({
  id, resourceId, resourceVersionId: `${resourceId}-v1`, resourceVersion: 1, title,
  chunkIndex: null, startOffset: 0, endOffset: text.length, textSource: 'NATIVE_TEXT', text, score: 1,
});

describe('F21 structured conflict grounding', () => {
  test('QA explicitly reports two distinct delivery dates with both citations', () => {
    const result = surfaceStructuredConflict({
      question: 'กำหนดส่งมอบงานภายในวันที่เท่าไร', language: 'th', answer: 'กำหนดส่งมอบ 30 กันยายน 2569 [E1]',
      evidence: [
        evidence('E1', 'A', 'agreement-a.txt', 'กำหนดส่งมอบงานภายในวันที่ 30 กันยายน 2569'),
        evidence('E2', 'B', 'agreement-b.txt', 'กำหนดส่งมอบงานภายในวันที่ 15 ตุลาคม 2569'),
      ],
    });
    assert.equal(result.detected, true);
    assert.match(result.answer, /ข้อมูลไม่ตรงกัน/u);
    assert.match(result.answer, /30 กันยายน 2569 \[E1\]/u);
    assert.match(result.answer, /15 ตุลาคม 2569 \[E2\]/u);
    assert.deepEqual(result.evidenceIds, ['E1', 'E2']);
  });

  test('bilingual comparison preserves each evidence representation', () => {
    const result = surfaceStructuredConflict({
      question: 'Compare the delivery date stated in each document.', language: 'en', answer: 'partial',
      evidence: [
        evidence('E1', 'A', 'contract-th.txt', 'กำหนดส่งมอบงานภายในวันที่ 30 กันยายน 2569'),
        evidence('E2', 'B', 'contract-en.txt', 'Delivery is due on 15 October 2026.'),
      ],
    });
    assert.equal(result.detected, true);
    assert.match(result.answer, /30 กันยายน 2569 \[E1\]/u);
    assert.match(result.answer, /15 October 2026 \[E2\]/u);
  });

  test('equal values and complementary start/end fields are not called conflicts', () => {
    const same = [
      evidence('E1', 'A', 'a.txt', 'กำหนดส่งมอบงานภายในวันที่ 30 กันยายน 2569'),
      evidence('E2', 'B', 'b.txt', 'Delivery deadline: 30 September 2569'),
    ];
    assert.equal(surfaceStructuredConflict({ question: 'What is the delivery deadline?', language: 'en',
      answer: '30 September 2569 [E1]', evidence: same }).detected, false);
    assert.equal(surfaceStructuredConflict({ question: 'What are the start and end dates?', language: 'en',
      answer: 'two dates', evidence: same }).detected, false);
    assert.equal(surfaceStructuredConflict({ question: 'เปรียบเทียบวันที่และจำนวนเงิน', language: 'th',
      answer: 'หลายค่า', evidence: same }).detected, false);
  });

  test('does not compare identifiers belonging to different business fields', () => {
    const result = surfaceStructuredConflict({
      question: 'เลขที่สัญญาคืออะไร', language: 'th', answer: 'BROWSER-CT-441 [E2]',
      evidence: [
        evidence('E1', 'invoice', 'invoice.txt', 'ใบแจ้งหนี้เลขที่ BROWSER-INV-2569-77'),
        evidence('E2', 'contract', 'contract.txt', 'สัญญาเลขที่ BROWSER-CT-441'),
      ],
    });
    assert.equal(result.detected, false);
    assert.equal(result.answer, 'BROWSER-CT-441 [E2]');
  });
});

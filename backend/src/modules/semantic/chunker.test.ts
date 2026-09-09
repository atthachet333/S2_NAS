import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { chunkSemanticText } from './chunker.js';
import type { EmbeddingProvider } from './provider.js';

const fakeProvider: EmbeddingProvider = {
  info: {
    provider: 'local-onnx', modelId: 'fake', revision: 'test', modelVersion: 'fake-v1',
    dimensions: 384, dtype: 'fake', offlineRuntime: true, modelPath: 'none',
  },
  async initialize() {},
  async countTokens(text) { return Array.from(text).length + 2; },
  async embed() { return Array(384).fill(0); },
  async embedBatch(texts) { return texts.map(() => Array(384).fill(0)); },
  async dispose() {},
};

describe('semantic chunker', () => {
  it('keeps Thai surrogate/code-point boundaries and respects token limits', async () => {
    const source = 'เอกสารงบประมาณประจำปี 😀 มีรายละเอียดหลายส่วน\nการอนุมัติโครงการต้องผ่านกรรมการ';
    const result = await chunkSemanticText(source, fakeProvider, { maxTokens: 22, overlapTokens: 5, maxChunks: 20 });
    assert.ok(result.chunks.length > 2);
    assert.equal(result.truncated, false);
    for (const chunk of result.chunks) {
      assert.ok(chunk.tokenCount <= 22);
      assert.equal(source.slice(chunk.startOffset, chunk.endOffset), chunk.text);
      assert.equal(chunk.text.includes('\uFFFD'), false);
    }
  });

  it('reports truncation at the document chunk limit', async () => {
    const result = await chunkSemanticText('หนึ่ง สอง สาม สี่ ห้า หก เจ็ด แปด เก้า สิบ', fakeProvider, {
      maxTokens: 8, overlapTokens: 0, maxChunks: 2,
    });
    assert.equal(result.chunks.length, 2);
    assert.equal(result.truncated, true);
  });
});

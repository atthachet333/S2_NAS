import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { reciprocalRankFusion, RRF_K } from './ranking.js';

describe('semantic hybrid ranking', () => {
  test('uses deterministic rank fusion rather than raw score scales', () => {
    assert.equal(RRF_K, 60);
    assert.ok(reciprocalRankFusion({ lexicalRank: 1, semanticRank: 4 }) >
      reciprocalRankFusion({ lexicalRank: 8, semanticRank: 1 }));
    assert.equal(reciprocalRankFusion({}), 0);
  });
});

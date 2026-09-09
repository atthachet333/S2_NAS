/** RRF avoids comparing incompatible lexical ranks with cosine scores. */
export const RRF_K = 60;
export const LEXICAL_RRF_WEIGHT = 1.35;

export function reciprocalRankFusion(input: {
  lexicalRank?: number | null;
  semanticRank?: number | null;
}): number {
  return (input.lexicalRank ? LEXICAL_RRF_WEIGHT / (RRF_K + input.lexicalRank) : 0) +
    (input.semanticRank ? 1 / (RRF_K + input.semanticRank) : 0);
}

import type { EmbeddingProvider } from './provider.js';

export interface SemanticChunkDraft {
  text: string;
  startOffset: number;
  endOffset: number;
  tokenCount: number;
}

export interface ChunkOptions {
  maxTokens: number;
  overlapTokens: number;
  maxChunks: number;
}

function sentenceRanges(text: string): Array<{ start: number; end: number }> {
  const Segmenter = Intl.Segmenter;
  if (Segmenter) {
    const segmenter = new Segmenter(['th', 'en'], { granularity: 'sentence' });
    return Array.from(segmenter.segment(text), (part) => ({
      start: part.index,
      end: part.index + part.segment.length,
    })).filter((range) => range.end > range.start);
  }
  const ranges: Array<{ start: number; end: number }> = [];
  const regex = /[^\n.!?。！？]+(?:[\n.!?。！？]+|$)/gu;
  for (const match of text.matchAll(regex)) {
    ranges.push({ start: match.index, end: match.index + match[0].length });
  }
  return ranges;
}

function codePointOffsets(value: string): number[] {
  const offsets = [0];
  let offset = 0;
  for (const point of value) {
    offset += point.length;
    offsets.push(offset);
  }
  return offsets;
}

async function largestPrefix(
  text: string,
  start: number,
  end: number,
  maxTokens: number,
  provider: EmbeddingProvider,
): Promise<number> {
  const relative = codePointOffsets(text.slice(start, end));
  let low = 1;
  let high = relative.length - 1;
  let best = 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidateEnd = start + relative[middle]!;
    if (await provider.countTokens(text.slice(start, candidateEnd)) <= maxTokens) {
      best = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return start + relative[best]!;
}

async function overlapStart(
  text: string,
  start: number,
  end: number,
  overlapTokens: number,
  provider: EmbeddingProvider,
): Promise<number> {
  if (overlapTokens <= 0) return end;
  const relative = codePointOffsets(text.slice(start, end));
  let low = 0;
  let high = relative.length - 1;
  let best = relative.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = start + relative[middle]!;
    if (await provider.countTokens(text.slice(candidate, end)) <= overlapTokens) {
      best = middle;
      high = middle - 1;
    } else {
      low = middle + 1;
    }
  }
  return start + relative[best]!;
}

/** Token-budgeted chunking with sentence boundaries and code-point-safe fallback for Thai. */
export async function chunkSemanticText(
  source: string,
  provider: EmbeddingProvider,
  options: ChunkOptions,
): Promise<{ chunks: SemanticChunkDraft[]; truncated: boolean }> {
  const chunks: SemanticChunkDraft[] = [];
  const ranges = sentenceRanges(source);
  let rangeIndex = 0;
  let cursor = ranges[0]?.start ?? 0;

  while (cursor < source.length && chunks.length < options.maxChunks) {
    while (rangeIndex < ranges.length && ranges[rangeIndex]!.end <= cursor) rangeIndex += 1;
    let end = cursor;
    let nextRange = rangeIndex;

    while (nextRange < ranges.length) {
      const proposedEnd = ranges[nextRange]!.end;
      if (await provider.countTokens(source.slice(cursor, proposedEnd)) > options.maxTokens) break;
      end = proposedEnd;
      nextRange += 1;
    }

    if (end === cursor) {
      const boundary = ranges[rangeIndex]?.end ?? source.length;
      end = await largestPrefix(source, cursor, boundary, options.maxTokens, provider);
    }

    const text = source.slice(cursor, end).trim();
    if (text) {
      const leading = source.slice(cursor, end).indexOf(text);
      const startOffset = cursor + Math.max(0, leading);
      chunks.push({
        text,
        startOffset,
        endOffset: startOffset + text.length,
        tokenCount: await provider.countTokens(text),
      });
    }

    if (end >= source.length) break;
    const nextCursor = await overlapStart(source, cursor, end, options.overlapTokens, provider);
    cursor = nextCursor > cursor ? nextCursor : end;
  }

  const coveredTo = chunks.at(-1)?.endOffset ?? 0;
  return { chunks, truncated: coveredTo < source.trimEnd().length };
}

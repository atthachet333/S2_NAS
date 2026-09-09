import { createHash } from 'node:crypto';
import { SEMANTIC_MODEL_VERSION } from './provider.js';

export function normalizeSemanticText(text: string): string {
  // Preserve whitespace and offsets: snippets are sliced from this exact effective text.
  return text.normalize('NFC').replace(/\r\n?/g, '\n');
}

export function semanticTextFingerprint(text: string, modelVersion = SEMANTIC_MODEL_VERSION): string {
  return createHash('sha256').update(modelVersion).update('\0').update(normalizeSemanticText(text)).digest('hex');
}

export function semanticChunkFingerprint(text: string, modelVersion = SEMANTIC_MODEL_VERSION): string {
  return createHash('sha256').update(modelVersion).update('\0chunk\0').update(text).digest('hex');
}

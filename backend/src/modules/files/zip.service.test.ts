import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { assertZipLimits, safeArchiveSegment, type ZipPlanEntry } from './zip.service.js';

const entry = (archivePath: string, size = 0): ZipPlanEntry => ({
  resourceId: archivePath,
  archivePath,
  storageKey: size ? `resources/id/${archivePath}` : null,
  size,
  directory: size === 0,
});

describe('ZIP security and limits', () => {
  test('Thai archive names are preserved as Unicode', () => {
    assert.equal(safeArchiveSegment('เอกสาร ภาษี ๒๕๖๙'), 'เอกสาร ภาษี ๒๕๖๙');
  });

  test('path traversal and separators are rejected', () => {
    for (const name of ['..', '.', '../secret', 'a/b', 'a\\b']) {
      assert.throws(() => safeArchiveSegment(name));
    }
  });

  test('resource count limit is enforced centrally', () => {
    assert.throws(
      () => assertZipLimits([entry('a/'), entry('b/')], { maxResources: 1, maxBytes: 100 }),
      (error: unknown) => (error as { code?: string }).code === 'ZIP_TOO_LARGE',
    );
  });

  test('aggregate byte limit is enforced centrally', () => {
    assert.throws(
      () => assertZipLimits([entry('a.txt', 60), entry('b.txt', 41)], { maxResources: 10, maxBytes: 100 }),
      (error: unknown) => (error as { code?: string }).code === 'ZIP_TOO_LARGE',
    );
  });
});

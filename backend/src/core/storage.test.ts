import assert from 'node:assert/strict';
import path from 'node:path';
import { test, describe } from 'node:test';
import { env } from '../config/env.js';
import { resolveInsideStorage, verifyStorage } from './storage.js';
import { AppError } from './errors.js';

describe('storage: path traversal', () => {
  test('อนุญาตเส้นทางปกติภายใน storage', () => {
    const resolved = resolveInsideStorage('companies', 'abc', '2026', '09', 'invoice.pdf');
    assert.ok(resolved.startsWith(env.STORAGE_ROOT + path.sep));
    assert.ok(resolved.endsWith('invoice.pdf'));
  });

  test('ปฏิเสธ ../../file.pdf', () => {
    assert.throws(() => resolveInsideStorage('..', '..', 'file.pdf'), AppError);
  });

  test('ปฏิเสธเส้นทางที่ออกนอก storage root แม้ซ่อนอยู่กลางทาง', () => {
    assert.throws(
      () => resolveInsideStorage('companies', '..', '..', '..', 'secret.pdf'),
      AppError,
    );
  });

  test('ปฏิเสธ absolute path ที่อยู่นอก storage root', () => {
    assert.throws(() => resolveInsideStorage('C:\Windows\System32\config'), AppError);
  });
});

describe('storage: startup verification', () => {
  test('storage root ต้องอ่านและเขียนได้', async () => {
    const result = await verifyStorage(true);
    assert.equal(result.status, 'READY');
    assert.equal(result.readable, true);
    assert.equal(result.writable, true);
  });
});

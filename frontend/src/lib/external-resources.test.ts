import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { EXTERNAL_RESOURCE_META, externalResourceLabel, validateExternalUrl } from './external-resources.ts';

describe('external resource UI policy', () => {
  test('validates each Google URL against its selected type', () => {
    assert.equal(validateExternalUrl('GOOGLE_SHEET', 'https://docs.google.com/spreadsheets/d/id/edit'), null);
    assert.equal(validateExternalUrl('GOOGLE_DOC', 'https://docs.google.com/document/d/id/edit'), null);
    assert.equal(validateExternalUrl('GOOGLE_DRIVE', 'https://drive.google.com/drive/folders/id'), null);
    assert.equal(validateExternalUrl('GOOGLE_SHEET', 'https://docs.google.com/document/d/id/edit'), 'INVALID_EXTERNAL_RESOURCE_URL');
  });

  test('accepts HTTP(S) web links and rejects unsafe schemes', () => {
    assert.equal(validateExternalUrl('WEB_LINK', 'http://example.com'), null);
    assert.equal(validateExternalUrl('WEB_LINK', 'https://example.com'), null);
    for (const url of ['javascript:alert(1)', 'data:text/plain,test', 'file:///tmp/test', 'ftp://example.com']) {
      assert.equal(validateExternalUrl('WEB_LINK', url), 'UNSAFE_URL_SCHEME');
    }
  });

  test('exposes provider-specific Thai labels and creation messages', () => {
    assert.equal(externalResourceLabel('GOOGLE_SHEET'), 'Google Sheet');
    assert.equal(EXTERNAL_RESOURCE_META.WEB_LINK.toast, 'เพิ่มลิงก์แล้ว');
  });
});

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { safeGoogleDriveUrl } from './google-drive';

describe('Google Drive UI safety', () => {
  test('allows only HTTPS Drive and Docs links', () => {
    assert.equal(
      safeGoogleDriveUrl('https://drive.google.com/file/d/abc/view'),
      'https://drive.google.com/file/d/abc/view',
    );
    assert.equal(
      safeGoogleDriveUrl('https://docs.google.com/document/d/abc/edit'),
      'https://docs.google.com/document/d/abc/edit',
    );
    assert.equal(safeGoogleDriveUrl('http://drive.google.com/file/d/abc/view'), null);
    assert.equal(safeGoogleDriveUrl('https://drive.google.com.evil.example/file'), null);
    assert.equal(safeGoogleDriveUrl('javascript:alert(1)'), null);
    assert.equal(safeGoogleDriveUrl(null), null);
  });
});

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { IntegrationAppDto } from './api';
import { activeCredentialCount, INTEGRATION_SCOPE_OPTIONS, integrationStatus } from './integration-ui';

const credential = (revokedAt: string | null) => ({ id: crypto.randomUUID(), label: null, createdAt: new Date().toISOString(), lastUsedAt: null, expiresAt: null, revokedAt });
const app = (overrides: Partial<IntegrationAppDto> = {}): IntegrationAppDto => ({
  id: 'app', name: 'QA', code: 'QA_APP', description: null, isActive: true,
  scopes: ['resources:read'], lastUsedAt: null, createdAt: new Date().toISOString(),
  allowedRoot: { id: 'folder', name: 'TEST' }, credentials: [], _count: { credentials: 0 }, ...overrides,
});

describe('Connected Apps UI policy', () => {
  test('offers every least-privilege scope without a wildcard', () => {
    assert.deepEqual(INTEGRATION_SCOPE_OPTIONS, ['resources:read','resources:create','resources:upload','resources:update','resources:download','resources:metadata']);
    assert.equal(INTEGRATION_SCOPE_OPTIONS.some((scope) => scope.includes('*')), false);
  });
  test('does not claim an active app is connected when it has no usable credential', () => assert.equal(integrationStatus(app()).code, 'NO_CREDENTIAL'));
  test('renders disabled state independently of credential presence', () => assert.equal(integrationStatus(app({ isActive: false, credentials: [credential(null)] })).code, 'DISABLED'));
  test('counts only non-revoked credentials and exposes no secret field in the DTO', () => {
    const value = app({ credentials: [credential(null), credential(new Date().toISOString())] });
    assert.equal(activeCredentialCount(value), 1);
    assert.equal(JSON.stringify(value).includes('secret'), false);
  });
});

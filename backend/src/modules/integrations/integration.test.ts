import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { after, before, describe, test } from 'node:test';
import { buildApp } from '../../app.js';
import { prisma } from '../../core/prisma.js';
import { deleteStoredFile, removeResourceDirectory } from '../../core/file-storage.js';
import type { AuthUser } from '../auth/auth.service.js';
import { uploadFile, uploadVersion } from '../files/file.service.js';
import { createFolder } from '../resources/resource.service.js';
import {
  assertWithinScope,
  authenticateApiKey,
  createApp,
  createCredential,
  createMetadata,
  getApp,
  requireScope,
  revokeCredential,
  updateApp,
  validateIntegrationSourceUrl,
} from './integration.service.js';

describe('Phase F3 connected apps and Integration API', () => {
  const nonce = `${process.pid}-${Date.now()}`;
  const prefix = `f3-${nonce}`;
  const audit = {};
  let ownerId = '';
  let allowedRootId = '';
  let outsideRootId = '';
  let appId = '';
  let readOnlyAppId = '';
  let apiKey = '';
  let auth: Awaited<ReturnType<typeof authenticateApiKey>>;

  const owner = (): AuthUser => ({
    id: ownerId,
    email: `${prefix}@example.invalid`,
    displayName: 'F3 Test Owner',
    status: 'ACTIVE',
    mustChangePassword: false,
    roles: ['SUPER_ADMIN'],
    permissions: ['admin:access', 'resources:read', 'resources:write', 'resources:delete'],
  });

  before(async () => {
    const user = await prisma.user.create({ data: { email: `${prefix}@example.invalid`, displayName: 'F3 Test Owner', status: 'ACTIVE' } });
    ownerId = user.id;
    allowedRootId = (await createFolder(owner(), { name: `${prefix}-allowed` }, audit)).id;
    outsideRootId = (await createFolder(owner(), { name: `${prefix}-outside` }, audit)).id;
  });

  after(async () => {
    const apps = await prisma.integrationApp.findMany({ where: { code: { startsWith: `F3_${process.pid}_` } }, select: { id: true, actorUserId: true } });
    const appIds = apps.map((item) => item.id);
    const actorIds = apps.map((item) => item.actorUserId);
    const versions = await prisma.resourceVersion.findMany({ where: { createdByIntegrationAppId: { in: appIds } }, select: { storageKey: true, resourceId: true } });
    for (const version of versions) await deleteStoredFile(version.storageKey);
    for (const resourceId of new Set(versions.map((item) => item.resourceId))) await removeResourceDirectory(resourceId);
    await prisma.integrationIdempotency.deleteMany({ where: { appId: { in: appIds } } });
    await prisma.resourceVersion.deleteMany({ where: { createdByIntegrationAppId: { in: appIds } } });
    await prisma.activityLog.deleteMany({ where: { OR: [{ integrationAppId: { in: appIds } }, { userId: { in: [ownerId, ...actorIds] } }] } });
    await prisma.integrationCredential.deleteMany({ where: { appId: { in: appIds } } });
    await prisma.integrationApp.deleteMany({ where: { id: { in: appIds } } });
    const testUserIds = [ownerId, ...actorIds];
    const pending = await prisma.resource.findMany({ where: { createdById: { in: testUserIds } }, select: { id: true, parentId: true } });
    while (pending.length) {
      const parentIds = new Set(pending.map((item) => item.parentId).filter((value): value is string => Boolean(value)));
      const leaves = pending.filter((item) => !parentIds.has(item.id));
      if (!leaves.length) throw new Error('F3 test cleanup could not resolve the resource tree');
      await prisma.resource.deleteMany({ where: { id: { in: leaves.map((item) => item.id) } } });
      for (const leaf of leaves) pending.splice(pending.findIndex((item) => item.id === leaf.id), 1);
    }
    await prisma.user.deleteMany({ where: { id: { in: [ownerId, ...actorIds] } } });
  });

  test('creates an app with a dedicated service actor and unique code', async () => {
    const app = await createApp({
      name: 'F3 QA App', code: `F3_${process.pid}_MAIN`, allowedRootId,
      scopes: ['resources:read', 'resources:create', 'resources:upload', 'resources:update', 'resources:download'],
    }, owner(), audit);
    appId = app.id;
    assert.equal(app.actorUser.status, 'ACTIVE');
    assert.notEqual(app.actorUser.id, ownerId);
    await assert.rejects(() => createApp({ name: 'Duplicate', code: `F3_${process.pid}_MAIN`, allowedRootId, scopes: ['resources:read'] }, owner(), audit), (error: { code?: string }) => error.code === 'INTEGRATION_CODE_EXISTS');
  });

  test('returns a secret once and stores only its SHA-256 hash', async () => {
    const created = await createCredential(appId, { label: 'test harness' }, owner(), audit);
    apiKey = created.secret;
    assert.match(apiKey, /^s2nas_[0-9a-f-]{36}_[A-Za-z0-9_-]+$/u);
    const row = await prisma.integrationCredential.findUniqueOrThrow({ where: { id: created.credentialId } });
    assert.equal(row.secretHash.length, 64);
    assert.equal(row.secretHash.includes(apiKey), false);
    const detail = JSON.stringify(await getApp(appId));
    assert.equal(detail.includes(apiKey), false);
    assert.equal(detail.includes(row.secretHash), false);
  });

  test('authenticates a valid key without granting SUPER_ADMIN and rejects invalid input', async () => {
    auth = await authenticateApiKey(apiKey);
    assert.deepEqual(auth.user.roles, ['SERVICE']);
    assert.equal(auth.user.roles.includes('SUPER_ADMIN'), false);
    await assert.rejects(() => authenticateApiKey(`${apiKey}x`), (error: { code?: string }) => error.code === 'INTEGRATION_AUTH_FAILED');
  });

  test('enforces folder ancestry and least-privilege scopes', async () => {
    await assertWithinScope(auth.app, allowedRootId);
    await assert.rejects(() => assertWithinScope(auth.app, outsideRootId), (error: { code?: string }) => error.code === 'INTEGRATION_SCOPE_DENIED');
    const readOnly = await createApp({ name: 'Read only', code: `F3_${process.pid}_READ`, allowedRootId, scopes: ['resources:read'] }, owner(), audit);
    readOnlyAppId = readOnly.id;
    const key = (await createCredential(readOnly.id, {}, owner(), audit)).secret;
    const readAuth = await authenticateApiKey(key);
    assert.throws(() => requireScope(readAuth, 'resources:upload'), (error: { code?: string }) => error.code === 'INTEGRATION_PERMISSION_DENIED');
  });

  test('creates metadata with app-derived source and safe app-scoped idempotency', async () => {
    const input = { type: 'WEB_LINK' as const, name: `${prefix}-link`, parentId: allowedRootId, externalUrl: 'https://example.com/document', sourceEntityType: 'PAYSLIP', sourceEntityId: '123', sourceUrl: 'https://payroll.example.test/runs/123' };
    const first = await createMetadata(auth, input, 'metadata-retry');
    const retry = await createMetadata(auth, input, 'metadata-retry');
    assert.equal(first.id, retry.id);
    assert.equal(first.sourceType, 'EXTERNAL_UPLOAD');
    assert.equal(first.sourceSystem, `F3_${process.pid}_MAIN`);
    assert.equal(first.createdByIntegrationApp?.id, appId);
    assert.equal('storageKey' in first, false);
    await assert.rejects(() => createMetadata(auth, { ...input, remark: 'changed' }, 'metadata-retry'), (error: { code?: string }) => error.code === 'INTEGRATION_IDEMPOTENCY_CONFLICT');
    assert.throws(() => validateIntegrationSourceUrl('javascript:alert(1)'), (error: { code?: string }) => error.code === 'UNSAFE_URL_SCHEME');
  });

  test('isolates identical external IDs between apps', async () => {
    const secondKey = (await createCredential(readOnlyAppId, {}, owner(), audit)).secret;
    await updateApp(readOnlyAppId, { scopes: ['resources:read', 'resources:create'] }, owner(), audit);
    const secondAuth = await authenticateApiKey(secondKey);
    const resource = await createMetadata(secondAuth, { type: 'FOLDER', name: `${prefix}-same-id`, parentId: allowedRootId, sourceEntityType: 'PAYSLIP', sourceEntityId: '123' });
    assert.equal(resource.createdByIntegrationApp?.id, readOnlyAppId);
  });

  test('reuses secure upload and explicit version pipelines with integration provenance', async () => {
    const firstBytes = Buffer.from('F3 integration upload v1');
    const uploaded = await uploadFile(auth.user, Readable.from(firstBytes), {
      parentId: allowedRootId, fileName: `${prefix}.txt`, declaredMime: 'text/plain', allowDuplicateContent: true,
      sourceType: 'EXTERNAL_UPLOAD', sourceSystem: auth.app.code, integrationAppId: appId,
      sourceEntityType: 'EVIDENCE', sourceEntityId: 'upload-1', sourceUrl: 'https://source.example.test/evidence/1',
    }, audit);
    assert.equal(uploaded.resource.sourceSystem, auth.app.code);
    assert.equal(uploaded.resource.createdByIntegrationApp?.id, appId);
    assert.equal(uploaded.resource.currentVersion, 1);
    const stored = await prisma.resource.findUniqueOrThrow({ where: { id: uploaded.resource.id } });
    assert.equal(stored.checksum, crypto.createHash('sha256').update(firstBytes).digest('hex'));
    const versioned = await uploadVersion(auth.user, stored.id, Readable.from('F3 integration upload v2'), { declaredMime: 'text/plain', integrationAppId: appId }, audit);
    assert.equal(versioned.currentVersion, 2);
    const version = await prisma.resourceVersion.findFirstOrThrow({ where: { resourceId: stored.id, versionNumber: 2 } });
    assert.equal(version.createdByIntegrationAppId, appId);
  });

  test('revocation and app disablement take effect immediately', async () => {
    const revoked = await createCredential(appId, {}, owner(), audit);
    await revokeCredential(appId, revoked.credentialId, owner(), audit);
    await assert.rejects(() => authenticateApiKey(revoked.secret), (error: { code?: string }) => error.code === 'INTEGRATION_CREDENTIAL_REVOKED');
    const disabled = await createCredential(appId, {}, owner(), audit);
    await updateApp(appId, { isActive: false }, owner(), audit);
    await assert.rejects(() => authenticateApiKey(disabled.secret), (error: { code?: string }) => error.code === 'INTEGRATION_DISABLED');
    await updateApp(appId, { isActive: true }, owner(), audit);
  });

  test('applies the dedicated integration rate limit', async () => {
    const app = await buildApp();
    try {
      let lastStatus = 0;
      for (let index = 0; index < 121; index += 1) {
        lastStatus = (await app.inject({ method: 'GET', url: '/api/integrations/resources?parentId=x', headers: { authorization: 'Bearer invalid-rate-key' } })).statusCode;
      }
      assert.equal(lastStatus, 429);
    } finally {
      await app.close();
    }
  });
});

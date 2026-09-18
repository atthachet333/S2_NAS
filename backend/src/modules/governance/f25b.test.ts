import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { prisma } from '../../core/prisma.js';
import { AppError } from '../../core/errors.js';
import { createFolder } from '../resources/resource.service.js';
import { permanentlyDelete, trashResource } from '../files/trash.service.js';
import type { AuthUser } from '../auth/auth.service.js';
import {
  assignPolicy,
  compareRetention,
  createPolicy,
  executeReapplyPolicy,
  previewReapplyPolicy,
  updatePolicy,
} from './retention.service.js';
import { listLegalHoldHistory, placeLegalHold, releaseLegalHold } from './legal-hold.service.js';
import { safeDetails } from '../audit/audit.service.js';

const prefix = `f25b-${Date.now().toString(36)}`;
const audit = { ipAddress: '127.0.0.1', userAgent: 'f25b-test' };
const appError = (code: string) => (error: unknown) => error instanceof AppError && error.code === code;

const auth = (row: { id: string; email: string; displayName: string }, admin = false): AuthUser => ({
  ...row,
  type: 'INTERNAL',
  status: 'ACTIVE',
  mustChangePassword: false,
  roles: admin ? ['ADMIN'] : ['MEMBER'],
  permissions: [
    'resources:read',
    'resources:write',
    'resources:delete',
    ...(admin ? ['admin:access', 'system:retention:manage'] : []),
  ],
});

describe('F25-B governance hardening', () => {
  let admin: AuthUser;
  let editor: AuthUser;
  let adminId = '';
  let editorId = '';
  const resourceIds: string[] = [];
  const policyIds: string[] = [];

  const folder = async (suffix: string) => {
    const row = await createFolder(admin, { name: `${prefix}-${suffix}`, parentId: null }, audit);
    resourceIds.push(row.id);
    return row.id;
  };

  before(async () => {
    const [adminRow, editorRow] = await Promise.all([
      prisma.user.create({ data: { email: `${prefix}-admin@example.invalid`, displayName: 'F25B Admin', status: 'ACTIVE' } }),
      prisma.user.create({ data: { email: `${prefix}-editor@example.invalid`, displayName: 'F25B Editor', status: 'ACTIVE' } }),
    ]);
    adminId = adminRow.id;
    editorId = editorRow.id;
    admin = auth(adminRow, true);
    editor = auth(editorRow);
  });

  after(async () => {
    await prisma.legalHold.deleteMany({ where: { resourceId: { in: resourceIds } } });
    await prisma.activityLog.deleteMany({ where: { userId: { in: [adminId, editorId] } } });
    await prisma.resource.updateMany({ where: { id: { in: resourceIds } }, data: { retentionPolicyId: null } });
    await prisma.resource.deleteMany({ where: { id: { in: resourceIds } } });
    await prisma.retentionPolicy.deleteMany({ where: { id: { in: policyIds } } });
    await prisma.legalHoldHistory.deleteMany({ where: { createdById: { in: [adminId, editorId] } } });
    await prisma.user.deleteMany({ where: { id: { in: [adminId, editorId] } } });
  });

  test('comparison is deterministic: forever > later finite > earlier finite > none', () => {
    const early = new Date('2030-01-01T00:00:00Z');
    const late = new Date('2040-01-01T00:00:00Z');
    assert.equal(compareRetention({ policyId: null, until: null, forever: false }, { policyId: 'p', until: early, forever: false }), 'APPLIED');
    assert.equal(compareRetention({ policyId: 'p', until: early, forever: false }, { policyId: 'p', until: late, forever: false }), 'STRENGTHENED');
    assert.equal(compareRetention({ policyId: 'p', until: late, forever: false }, { policyId: 'p', until: early, forever: false }), 'WEAKENED');
    assert.equal(compareRetention({ policyId: 'p', until: early, forever: false }, { policyId: 'p', until: null, forever: true }), 'STRENGTHENED');
    assert.equal(compareRetention({ policyId: 'p', until: null, forever: true }, { policyId: 'p', until: late, forever: false }), 'WEAKENED');
    assert.equal(compareRetention({ policyId: 'p', until: new Date('2020-01-01'), forever: false }, { policyId: null, until: null, forever: false }), 'CLEARED');
  });

  test('audit projection exposes override/release evidence but not the sensitive hold-placement reason', () => {
    const release = safeDetails('LEGAL_HOLD_RELEASED', {
      legalHoldId: 'hold-1', before: 'ACTIVE', after: 'RELEASED', releaseReason: 'ปิดคดีแล้ว',
    });
    assert.equal(release.releaseReason, 'ปิดคดีแล้ว');
    assert.equal(release.before, 'ACTIVE');
    const placed = safeDetails('LEGAL_HOLD_CREATED', { legalHoldId: 'hold-1', reason: 'ความลับคดี' });
    assert.equal('reason' in placed, false);
  });

  test('editors cannot weaken/clear; privileged override requires a reason and audits before/after', async () => {
    const id = await folder('override');
    const long = await createPolicy(admin, { name: `${prefix}-long`, retentionDays: 3650 });
    const short = await createPolicy(admin, { name: `${prefix}-short`, retentionDays: 30 });
    policyIds.push(long.id, short.id);
    await assignPolicy(id, editor, { policyId: long.id }, audit);

    await assert.rejects(() => assignPolicy(id, editor, { policyId: short.id }, audit), appError('POLICY_WEAKENING_REQUIRES_PRIVILEGE'));
    await assert.rejects(() => assignPolicy(id, editor, { policyId: null }, audit), appError('POLICY_WEAKENING_REQUIRES_PRIVILEGE'));
    await assert.rejects(() => assignPolicy(id, admin, { policyId: short.id }, audit), appError('RETENTION_OVERRIDE_REASON_REQUIRED'));

    const result = await assignPolicy(id, admin, { policyId: short.id, reason: 'อนุมัติการลดระยะเวลา' }, audit);
    assert.equal(result.change, 'WEAKENED');
    const event = await prisma.activityLog.findFirst({ where: { resourceId: id, action: 'RETENTION_OVERRIDE_WEAKENED' }, orderBy: { createdAt: 'desc' } });
    assert.equal((event?.metadata as Record<string, unknown>).reason, 'อนุมัติการลดระยะเวลา');
    assert.equal((event?.metadata as Record<string, unknown>).beforePolicyId, long.id);
    assert.equal((event?.metadata as Record<string, unknown>).afterPolicyId, short.id);
  });

  test('release reason is mandatory and immutable history survives permanent deletion', async () => {
    const id = await folder('history-survival');
    const hold = await placeLegalHold(id, admin, { reason: 'คดีทดสอบ', caseReference: 'CASE-F25B' }, audit);
    await assert.rejects(() => releaseLegalHold(hold.id, admin, { releaseReason: '   ' }, audit), appError('LEGAL_HOLD_RELEASE_REASON_REQUIRED'));
    await releaseLegalHold(hold.id, admin, { releaseReason: 'ปิดคดีแล้ว' }, audit);
    await trashResource(id, admin, audit);
    await permanentlyDelete(id, admin, audit);

    const history = await listLegalHoldHistory(admin, { resourceId: id });
    assert.equal(history.length, 1);
    assert.equal(history[0].resourceDeleted, true);
    assert.equal(history[0].reason, 'คดีทดสอบ');
    assert.equal(history[0].releaseReason, 'ปิดคดีแล้ว');
    assert.equal(history[0].caseReference, 'CASE-F25B');
  });

  test('reapply preview is read-only and execute rechecks hold + stale state with partial counts', async () => {
    const ids = await Promise.all([folder('reapply-change'), folder('reapply-hold'), folder('reapply-stale')]);
    const policy = await createPolicy(admin, { name: `${prefix}-reapply`, retentionDays: 3650 });
    policyIds.push(policy.id);
    for (const id of ids) await assignPolicy(id, admin, { policyId: policy.id }, audit);
    const before = await prisma.resource.findUniqueOrThrow({ where: { id: ids[0] }, select: { retentionUntil: true } });
    await updatePolicy(policy.id, admin, { retentionDays: 30 });

    const preview = await previewReapplyPolicy(policy.id, admin);
    assert.equal(preview.attempted, 3);
    assert.equal(preview.changed, 3);
    assert.equal(preview.potentialWeakening, 3);
    assert.deepEqual((await prisma.resource.findUniqueOrThrow({ where: { id: ids[0] }, select: { retentionUntil: true } })).retentionUntil, before.retentionUntil);

    await placeLegalHold(ids[1], admin, { reason: 'hold หลัง preview' }, audit);
    await prisma.resource.update({ where: { id: ids[2] }, data: { name: `${prefix}-changed-after-preview` } });
    const result = await executeReapplyPolicy(policy.id, admin, { previewToken: preview.previewToken, reason: 'อนุมัติ reapply' }, audit);
    assert.deepEqual({ attempted: result.attempted, changed: result.changed, unchanged: result.unchanged, blocked: result.blocked, failed: result.failed }, {
      attempted: 3, changed: 1, unchanged: 0, blocked: 1, failed: 1,
    });
    assert.ok(result.errors.some((row) => row.code === 'LEGAL_HOLD_ACTIVE'));
    assert.ok(result.errors.some((row) => row.code === 'STALE_RESOURCE'));

    const replay = await executeReapplyPolicy(policy.id, admin, { previewToken: preview.previewToken, reason: 'retry' }, audit);
    assert.equal(replay.changed, 0);
    assert.ok(replay.failed >= 2);
  });

  test('reapply matrix covers unchanged, all-changed, permission denial, validation failure, and retry', async () => {
    const ids = await Promise.all([folder('matrix-open'), folder('matrix-restricted')]);
    await prisma.resource.update({ where: { id: ids[1] }, data: { visibility: 'RESTRICTED' } });
    const policy = await createPolicy(admin, { name: `${prefix}-matrix`, retentionDays: 1000 });
    policyIds.push(policy.id);
    for (const id of ids) await assignPolicy(id, admin, { policyId: policy.id }, audit);

    const unchanged = await previewReapplyPolicy(policy.id, admin);
    assert.equal(unchanged.unchanged, 2);
    assert.equal(unchanged.changed, 0);

    await updatePolicy(policy.id, admin, { retentionDays: 10 });
    await assert.rejects(
      () => executeReapplyPolicy(policy.id, admin, { previewToken: unchanged.previewToken, reason: 'stale policy' }, audit),
      appError('RETENTION_POLICY_STALE'),
    );
    const limitedGovernor: AuthUser = {
      ...editor,
      permissions: ['system:retention:manage'],
    };
    const limitedPreview = await previewReapplyPolicy(policy.id, limitedGovernor);
    assert.ok(limitedPreview.permissionDenied >= 1);

    const allChanged = await previewReapplyPolicy(policy.id, admin);
    assert.equal(allChanged.changed, 2);
    const invalid = await executeReapplyPolicy(policy.id, admin, { previewToken: allChanged.previewToken }, audit);
    assert.equal(invalid.failed, 2);
    assert.ok(invalid.errors.every((row) => row.code === 'RETENTION_OVERRIDE_REASON_REQUIRED'));

    // Per-resource Model B makes this safe to retry: validation failures did not mutate either snapshot.
    const retried = await executeReapplyPolicy(
      policy.id,
      admin,
      { previewToken: allChanged.previewToken, reason: 'อนุมัติหลังแก้ validation' },
      audit,
    );
    assert.equal(retried.changed, 2);
    assert.equal(retried.failed, 0);
    assert.equal((await previewReapplyPolicy(policy.id, admin)).unchanged, 2);
  });

  test('forged preview tokens and forged resource ids are rejected without mutation', async () => {
    const id = await folder('forgery');
    const policy = await createPolicy(admin, { name: `${prefix}-forgery-policy`, retentionDays: 100 });
    policyIds.push(policy.id);
    await assert.rejects(() => assignPolicy('forged-resource-id', admin, { policyId: policy.id }, audit), appError('RESOURCE_NOT_FOUND'));
    await assignPolicy(id, admin, { policyId: policy.id }, audit);
    const preview = await previewReapplyPolicy(policy.id, admin);
    const forged = `${preview.previewToken.slice(0, -1)}x`;
    await assert.rejects(() => executeReapplyPolicy(policy.id, admin, { previewToken: forged }, audit), appError('RETENTION_PREVIEW_INVALID'));
  });
});

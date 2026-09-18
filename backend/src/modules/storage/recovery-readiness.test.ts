import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, test } from 'node:test';
import {
  auditCandidateRoot, candidatePath, copyVerifiedRecovery, type RecoveryIndexEntry,
} from './recovery-readiness.js';

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((target) => fsp.rm(target, { recursive: true, force: true })));
});

async function fixture(): Promise<{ root: string; index: RecoveryIndexEntry[] }> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 's2nas-recovery-'));
  cleanup.push(root);
  const body = Buffer.from('authoritative recovered bytes');
  const item: RecoveryIndexEntry = {
    resourceVersionId: 'version-1', resourceId: 'resource-1',
    storageKey: 'resources/resource-1/stable-key-1', size: body.length,
    sha256: crypto.createHash('sha256').update(body).digest('hex'),
    createdAt: '2026-09-17T00:00:00.000Z',
  };
  const file = candidatePath(root, item.storageKey);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, body);
  return { root, index: [item] };
}

describe('recovery readiness tools', () => {
  test('candidate paths reject traversal and absolute keys', () => {
    assert.throws(() => candidatePath('C:/candidate', '../secret'));
    assert.throws(() => candidatePath('C:/candidate', 'C:/secret'));
    assert.throws(() => candidatePath('C:/candidate', 'resources/a/../b'));
  });

  test('a checksum-complete candidate root is authoritative and read-only', async () => {
    const { root, index } = await fixture();
    const report = await auditCandidateRoot(root, index, { checksum: true, extras: true });
    assert.equal(report.readOnly, true);
    assert.equal(report.authoritative, true);
    assert.equal(report.sha256Matches, 1);
    assert.equal(report.findings.length, 0);
  });

  test('dry-run verifies source but creates no target', async () => {
    const { root, index } = await fixture();
    const target = path.join(os.tmpdir(), `s2nas-target-${crypto.randomUUID()}`);
    const report = await copyVerifiedRecovery(root, target, index, true);
    assert.equal(report.sourceAudit.authoritative, true);
    assert.equal(report.copiedObjects, 0);
    await assert.rejects(fsp.stat(target), { code: 'ENOENT' });
  });

  test('nested source and target roots are refused', async () => {
    const { root, index } = await fixture();
    await assert.rejects(copyVerifiedRecovery(root, path.join(root, 'target'), index, true),
      /must not contain one another/);
  });

  test('execute copies without deleting source and verifies target', async () => {
    const { root, index } = await fixture();
    const target = await fsp.mkdtemp(path.join(os.tmpdir(), 's2nas-target-'));
    cleanup.push(target);
    const report = await copyVerifiedRecovery(root, target, index, false);
    assert.equal(report.readyForConfigSwitch, true);
    assert.equal(report.copiedObjects, 1);
    assert.equal(report.targetAudit?.authoritative, true);
    assert.ok(await fsp.stat(candidatePath(root, index[0]!.storageKey)));
  });

  test('a corrupt source blocks every copy', async () => {
    const { root, index } = await fixture();
    await fsp.writeFile(candidatePath(root, index[0]!.storageKey), 'same path, wrong bytes');
    const target = path.join(os.tmpdir(), `s2nas-target-${crypto.randomUUID()}`);
    const report = await copyVerifiedRecovery(root, target, index, false);
    assert.equal(report.sourceAudit.authoritative, false);
    assert.equal(report.copiedObjects, 0);
    await assert.rejects(fsp.stat(target), { code: 'ENOENT' });
  });
});

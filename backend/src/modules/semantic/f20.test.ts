import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { after, before, describe, test } from 'node:test';
import { env } from '../../config/env.js';
import { deleteStoredFile, removeResourceDirectory } from '../../core/file-storage.js';
import { prisma } from '../../core/prisma.js';
import type { AuthUser } from '../auth/auth.service.js';
import { uploadFile, uploadVersion } from '../files/file.service.js';
import { resetCorrection, saveCorrection } from '../search/ocr/correction.service.js';
import { runJob } from '../search/search-index.service.js';
import { searchResources } from '../workspace/search.service.js';
import { localEmbeddingProvider } from './local-embedding.provider.js';
import { runSemanticJob } from './semantic-index.service.js';

const enabled = env.S2_NAS_SEMANTIC_ENABLED === 1;
const suite = enabled ? describe : describe.skip;

suite('F20 semantic search with real local model', { concurrency: 1 }, () => {
  const prefix = `f20-${process.pid}-${Date.now()}`;
  let ownerId = '';
  let outsiderId = '';
  let owner: AuthUser;
  let outsider: AuthUser;
  const resourceIds: string[] = [];

  const auth = (id: string): AuthUser => ({
    id, email: `${id}@test.invalid`, displayName: id, status: 'ACTIVE', mustChangePassword: false,
    permissions: ['resources:read', 'resources:write', 'resources:delete'], roles: ['MEMBER'],
  });

  async function add(name: string, text: string, restricted = false): Promise<string> {
    const uploaded = await uploadFile(owner, Readable.from([Buffer.from(text)]), {
      parentId: null, fileName: `${prefix}-${name}.txt`, allowDuplicateContent: true,
    }, {});
    const id = uploaded.resource.id;
    resourceIds.push(id);
    if (restricted) await prisma.resource.update({ where: { id }, data: { visibility: 'RESTRICTED' } });
    const version = await prisma.resourceVersion.findFirstOrThrow({ where: { resourceId: id, versionNumber: 1 } });
    const lexical = await prisma.resourceSearchIndex.findUniqueOrThrow({ where: { resourceVersionId: version.id } });
    assert.equal(await runJob(lexical.id), 'READY');
    const semantic = await prisma.semanticDocumentIndex.findUniqueOrThrow({ where: { resourceVersionId: version.id } });
    assert.equal(await runSemanticJob(semantic.id), 'READY');
    return id;
  }

  let leaseId = '';
  let gardenId = '';
  let payrollId = '';
  let versionedId = '';

  before(async () => {
    const [ownerRow, outsiderRow] = await Promise.all([
      prisma.user.create({ data: { email: `${prefix}-owner@test.invalid`, displayName: 'F20 Owner', status: 'ACTIVE' } }),
      prisma.user.create({ data: { email: `${prefix}-outsider@test.invalid`, displayName: 'F20 Outsider', status: 'ACTIVE' } }),
    ]);
    ownerId = ownerRow.id;
    outsiderId = outsiderRow.id;
    owner = auth(ownerId);
    outsider = auth(outsiderId);
    leaseId = await add('lease-contract', 'Office lease agreement for rented premises between landlord and tenant. Monthly rent and security deposit terms.');
    gardenId = await add('garden-guide', 'คู่มือปลูกมะม่วง การรดน้ำต้นไม้และใส่ปุ๋ยในสวนเพื่อดูแลผลผลิต');
    payrollId = await add('private-payroll', 'รายงานเงินเดือนพนักงาน ภาษีหัก ณ ที่จ่าย และค่าตอบแทน', true);
    versionedId = await add('versioned', 'Marine cargo insurance policy covering goods transported by sea, vessel loss, and freight damage.');
  });

  after(async () => {
    const versions = await prisma.resourceVersion.findMany({ where: { resourceId: { in: resourceIds } }, select: { storageKey: true } });
    for (const version of versions) await deleteStoredFile(version.storageKey);
    for (const id of resourceIds) await removeResourceDirectory(id);
    await prisma.activityLog.deleteMany({ where: { resourceId: { in: resourceIds } } });
    await prisma.resource.deleteMany({ where: { id: { in: resourceIds } } });
    await prisma.user.deleteMany({ where: { id: { in: [ownerId, outsiderId] } } });
    await localEmbeddingProvider().dispose();
  });

  test('retrieves English content from a Thai meaning query and ranks unrelated content lower', async () => {
    const result = await searchResources({ q: 'สัญญาระหว่างผู้เช่าและผู้ให้เช่าสำนักงาน', mode: 'SEMANTIC', ownerId, limit: 20 }, owner);
    assert.equal(result.effectiveMode, 'SEMANTIC');
    assert.equal(result.items[0]?.id, leaseId, JSON.stringify(result.items.map((item) => ({ id: item.id, name: item.name, reason: item.matchReason }))));
    assert.ok(!result.items.some((item) => item.id === gardenId), 'unrelated gardening content must stay below threshold');
  });

  test('retrieves Thai content from an English meaning query', async () => {
    const result = await searchResources({ q: 'how to care for fruit trees in a garden', mode: 'SEMANTIC', ownerId, limit: 20 }, owner);
    assert.equal(result.items[0]?.id, gardenId, JSON.stringify(result.items.map((item) => ({ id: item.id, name: item.name, reason: item.matchReason }))));
    assert.equal(result.items[0]?.matchReason, 'SEMANTIC');
    assert.ok(result.items[0]?.contentSnippet);
  });

  test('applies authorization before vector candidates and snippets', async () => {
    const ownerResult = await searchResources({ q: 'employee wages and tax deductions', mode: 'SEMANTIC', ownerId, limit: 20 }, owner);
    assert.ok(ownerResult.items.some((item) => item.id === payrollId));
    const outsiderResult = await searchResources({ q: 'employee wages and tax deductions', mode: 'SEMANTIC', ownerId, limit: 20 }, outsider);
    assert.ok(!outsiderResult.items.some((item) => item.id === payrollId));
  });

  test('keeps an exact filename ahead of semantic similarity in hybrid mode', async () => {
    const exact = `${prefix}-garden-guide.txt`;
    const result = await searchResources({ q: exact, mode: 'HYBRID', ownerId, limit: 20 }, owner);
    assert.equal(result.items[0]?.id, gardenId);
    assert.equal(result.items[0]?.matchReason, 'NAME');
  });

  test('real local model returns finite, normalized and stable Thai/English embeddings', async () => {
    const provider = localEmbeddingProvider();
    const [thai, english, repeated] = await provider.embedBatch([
      'ภาษีที่บริษัทหักจากผู้รับเงินและต้องนำส่ง',
      'employee compensation for work beyond scheduled hours',
      'ภาษีที่บริษัทหักจากผู้รับเงินและต้องนำส่ง',
    ], 'passage');
    for (const vector of [thai, english, repeated]) {
      assert.equal(vector.length, 384);
      assert.ok(vector.every(Number.isFinite));
      const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
      assert.ok(Math.abs(norm - 1) < 0.0001);
    }
    const stability = thai.reduce((sum, value, index) => sum + value * repeated[index]!, 0);
    assert.ok(stability > 0.99999);
  });

  test('invalidates corrected OCR text immediately and rebuilds only the effective correction/reset text', async () => {
    await saveCorrection(gardenId, owner, {
      text: 'Employment agreement describing employee duties, salary, probation, and termination.', expectedRevision: 0,
    });
    const pending = await prisma.semanticDocumentIndex.findFirstOrThrow({ where: { resourceId: gardenId } });
    assert.equal(pending.status, 'PENDING');
    assert.equal(await prisma.semanticChunk.count({ where: { resourceId: gardenId } }), 0);
    await runSemanticJob(pending.id);
    const corrected = await searchResources({ q: 'สัญญาจ้างและหน้าที่พนักงาน', mode: 'SEMANTIC', ownerId, limit: 20 }, owner);
    assert.ok(corrected.items.some((item) => item.id === gardenId));

    assert.deepEqual(await resetCorrection(gardenId, owner), { reset: true });
    assert.equal(await prisma.semanticChunk.count({ where: { resourceId: gardenId } }), 0);
    const resetPending = await prisma.semanticDocumentIndex.findFirstOrThrow({ where: { resourceId: gardenId } });
    await runSemanticJob(resetPending.id);
    const reset = await searchResources({ q: 'how to care for fruit trees in a garden', mode: 'SEMANTIC', ownerId, limit: 20 }, owner);
    assert.ok(reset.items.some((item) => item.id === gardenId));
  });

  test('removes old vectors as soon as a new current version exists', async () => {
    const oldQuery = 'ประกันภัยสินค้าระหว่างขนส่งทางทะเล';
    const before = await searchResources({ q: oldQuery, mode: 'SEMANTIC', ownerId, limit: 20 }, owner);
    assert.ok(before.items.some((item) => item.id === versionedId));
    await uploadVersion(owner, versionedId, Readable.from([Buffer.from('Bread recipe with flour, yeast, water, kneading, and oven temperature.')]), {
      declaredMime: 'text/plain',
    }, {});
    assert.equal(await prisma.semanticDocumentIndex.count({ where: { resourceId: versionedId } }), 0);
    const stale = await searchResources({ q: oldQuery, mode: 'SEMANTIC', ownerId, limit: 20 }, owner);
    assert.ok(!stale.items.some((item) => item.id === versionedId));

    const version = await prisma.resourceVersion.findFirstOrThrow({ where: { resourceId: versionedId, versionNumber: 2 } });
    const lexical = await prisma.resourceSearchIndex.findUniqueOrThrow({ where: { resourceVersionId: version.id } });
    await runJob(lexical.id);
    const pending = await prisma.semanticDocumentIndex.findUniqueOrThrow({ where: { resourceVersionId: version.id } });
    await runSemanticJob(pending.id);
    const current = await searchResources({ q: 'instructions for baking bread', mode: 'SEMANTIC', ownerId, limit: 20 }, owner);
    assert.ok(current.items.some((item) => item.id === versionedId));
  });

  test('rebuilds after derived rows are absent without changing business/search source data', async () => {
    const before = await prisma.resourceVersion.findMany({
      where: { resourceId: { in: resourceIds } }, orderBy: { resourceId: 'asc' },
      select: { resourceId: true, versionNumber: true, checksum: true, searchIndex: { select: { extractedText: true, textSource: true } } },
    });
    await prisma.semanticDocumentIndex.deleteMany({ where: { resourceId: { in: resourceIds } } });
    assert.equal(await prisma.semanticChunk.count({ where: { resourceId: { in: resourceIds } } }), 0);
    const lexical = await searchResources({ q: 'lease agreement', mode: 'LEXICAL', ownerId, limit: 20 }, owner);
    assert.ok(lexical.items.some((item) => item.id === leaseId));

    const currentResources = await prisma.resource.findMany({
      where: { id: { in: resourceIds } }, select: { id: true, currentVersion: true },
    });
    for (const resource of currentResources) {
      const version = await prisma.resourceVersion.findFirstOrThrow({
        where: { resourceId: resource.id, versionNumber: resource.currentVersion! },
      });
      const { enqueueSemanticIndex } = await import('./semantic-index.service.js');
      assert.equal(await enqueueSemanticIndex(version.id), true);
      const document = await prisma.semanticDocumentIndex.findUniqueOrThrow({ where: { resourceVersionId: version.id } });
      assert.equal(await runSemanticJob(document.id), 'READY');
    }
    const rebuilt = await searchResources({ q: 'สัญญาระหว่างผู้เช่าและผู้ให้เช่าสำนักงาน', mode: 'SEMANTIC', ownerId, limit: 20 }, owner);
    assert.equal(rebuilt.items[0]?.id, leaseId);
    const afterSource = await prisma.resourceVersion.findMany({
      where: { resourceId: { in: resourceIds } }, orderBy: { resourceId: 'asc' },
      select: { resourceId: true, versionNumber: true, checksum: true, searchIndex: { select: { extractedText: true, textSource: true } } },
    });
    assert.deepEqual(afterSource, before);
  });
});

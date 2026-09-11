import { writeQaVersionFile } from './qa-fixture.js';
import { removeResourceDirectory } from '../../core/file-storage.js';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { env } from '../../config/env.js';
import { AppError } from '../../core/errors.js';
import { prisma } from '../../core/prisma.js';
import type { AuthUser } from '../auth/auth.service.js';
import { answerAssistantThread, assistantDiagnostics, createAssistantThread } from './assistant.service.js';
import { assistantGenerationQueue } from './generation-queue.js';
import { LlamaCppDocumentAssistantProvider } from './llama-cpp.provider.js';
import { setDocumentAssistantProviderForTests } from './provider-instance.js';
import { groundedOutputSchema, type DocumentAssistantProvider, type GroundedGenerationInput } from './provider.js';

/**
 * โหมดความล้มเหลวของผู้ช่วยเอกสาร (F21 ข้อ 8)
 *
 * **สิ่งที่ตรวจ:** เมื่อผู้ช่วยพัง NAS หลักต้องยังทำงานได้ และต้องไม่มีคำตอบที่เชื่อถือไม่ได้
 * ถูกบันทึกลงฐานข้อมูล ผู้ช่วยเป็นส่วนเสริม ไม่ใช่ทางผ่านของงานหลัก ความล้มเหลวของมัน
 * จึงต้องถูกกั้นไว้ในขอบเขตของมันเอง
 *
 * ทุกกรณีจำลองด้วยผู้ให้บริการที่ควบคุมได้ เพราะการทำให้โมเดลจริงล้มเหลวตามสั่ง
 * ทำไม่ได้อย่างแน่นอน และไม่ได้ทดสอบสิ่งที่ต้องการทดสอบเพิ่มขึ้นเลย
 */

const prefix = `f21fail-${process.pid}-${Date.now()}`;
const resourceIds: string[] = [];
const userIds: string[] = [];
const threadIds: string[] = [];
let owner: AuthUser;

/** ผู้ให้บริการที่ล้มเหลวตามรหัสที่กำหนด ใช้จำลองความพังแต่ละแบบ */
class FailingProvider implements DocumentAssistantProvider {
  constructor(private readonly failure: AppError) {}
  getModelInfo() { return { provider: 'failing', model: 'test', quantization: 'none', contextTokens: 8192, offline: true as const }; }
  async health() { return { status: 'READY' as const }; }
  async countTokens(text: string) { return Math.ceil(text.length / 3); }
  async generateGroundedAnswer(_input: GroundedGenerationInput): Promise<never> { throw this.failure; }
}

async function fixture(name: string, text: string): Promise<string> {
  const id = crypto.randomUUID();
  resourceIds.push(id);
  await prisma.resource.create({ data: { id, type: 'FILE', name, normalizedName: name.toLowerCase(),
    siblingKey: `${prefix}:${id}`, ownerId: owner.id, createdById: owner.id,
    visibility: 'ORGANIZATION', currentVersion: 1 } });
  const stored = await writeQaVersionFile(id, text);
  const version = await prisma.resourceVersion.create({ data: { resourceId: id, versionNumber: 1,
    storageKey: stored.storageKey, size: stored.size,
    checksum: stored.checksum, createdById: owner.id } });
  await prisma.resourceSearchIndex.create({ data: { resourceId: id, resourceVersionId: version.id,
    versionNumber: 1, status: 'READY', textSource: 'NATIVE_TEXT', extractedText: text,
    normalizedText: text.toLowerCase(), characterCount: text.length, extractorVersion: 'f21-failure' } });
  return id;
}

describe('F21 failure modes stay contained', { concurrency: 1 }, () => {
  let documentId = '';

  before(async () => {
    const user = await prisma.user.create({ data: { email: `${prefix}@example.invalid`,
      displayName: 'F21 failure', type: 'INTERNAL', status: 'ACTIVE' } });
    userIds.push(user.id);
    owner = { id: user.id, email: user.email, displayName: user.email, type: 'INTERNAL', status: 'ACTIVE',
      mustChangePassword: false, roles: ['MEMBER'], permissions: ['resources:read'] };
    documentId = await fixture(`${prefix}-invoice.txt`, 'ใบแจ้งหนี้ ยอดที่ต้องชำระ 12,500 บาท ครบกำหนด 30 วัน');
  });

  after(async () => {
    setDocumentAssistantProviderForTests(undefined);
    if (threadIds.length) await prisma.assistantThread.deleteMany({ where: { id: { in: threadIds } } });
    if (resourceIds.length) {
      await prisma.resourceSearchIndex.deleteMany({ where: { resourceId: { in: resourceIds } } });
      await prisma.resourceVersion.deleteMany({ where: { resourceId: { in: resourceIds } } });
      await prisma.resource.deleteMany({ where: { id: { in: resourceIds } } });
      // ลบไฟล์บนดิสก์ด้วย ไม่งั้นจะเหลือไฟล์กำพร้าที่ไม่มีแถวอ้างถึง
      for (const resourceId of resourceIds) await removeResourceDirectory(resourceId);
    }
    if (userIds.length) await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  });

  /** ปิดผู้ช่วยไว้ - ต้องรายงานว่ายังไม่ได้ตั้งค่า ไม่ใช่แกล้งทำเป็นพร้อมใช้งาน */
  test('a disabled assistant reports NOT_CONFIGURED without disturbing core NAS', async () => {
    const provider = new LlamaCppDocumentAssistantProvider();
    const health = await provider.health();
    assert.equal(health.status, 'NOT_CONFIGURED');
    assert.equal(health.reason, 'disabled');

    // NAS หลักต้องยังตอบได้ตามปกติ การปิดผู้ช่วยไม่ใช่เหตุให้ระบบเอกสารหยุดทำงาน
    const resource = await prisma.resource.findUniqueOrThrow({ where: { id: documentId } });
    assert.equal(resource.name, `${prefix}-invoice.txt`);
  });

  /** ไฟล์โมเดลหาย - ต้องตรวจพบตั้งแต่ health ไม่ใช่ไปพังตอนผู้ใช้ถาม */
  test('a missing model file is reported as not configured, not as an error state', async () => {
    const provider = new LlamaCppDocumentAssistantProvider(true, {
      modelPath: `${prefix}-does-not-exist.gguf`,
    });
    const health = await provider.health();
    assert.equal(health.status, 'NOT_CONFIGURED');
    assert.equal(health.reason, 'model_or_runtime_missing');
  });

  /** วินิจฉัยต้องไม่เปิดเผยตำแหน่งไฟล์โมเดลให้ผู้ใช้ทั่วไป */
  test('diagnostics never expose the model path', async () => {
    const diagnostics = await assistantDiagnostics();
    const serialized = JSON.stringify(diagnostics);
    assert.doesNotMatch(serialized, /\.gguf/u);
    assert.doesNotMatch(serialized, /models[\\/]assistant/u);
  });

  /**
   * llama ตายกลางคัน / หมดเวลา / คืนคำตอบที่แยกวิเคราะห์ไม่ได้
   *
   * ทั้งสามแบบต้องจบเหมือนกันคือ ผู้ใช้ได้รับข้อผิดพลาดที่ชัดเจน และฐานข้อมูลต้องไม่มี
   * ข้อความของผู้ช่วยค้างอยู่ คำตอบครึ่ง ๆ กลาง ๆ ที่ถูกบันทึกไว้อันตรายกว่าไม่มีคำตอบ
   */
  for (const [label, failure] of [
    ['llama process failure', new AppError('ASSISTANT_GENERATION_FAILED', 'สร้างคำตอบไม่สำเร็จ', 503)],
    ['generation timeout', new AppError('ASSISTANT_TIMEOUT', 'ผู้ช่วยเอกสารใช้เวลานานเกินไป', 504)],
    ['unparsable model output', new AppError('ASSISTANT_INVALID_RESPONSE', 'โมเดลคืนคำตอบที่ตรวจสอบไม่ได้', 502)],
  ] as const) {
    test(`${label} surfaces cleanly and persists no assistant message`, async () => {
      setDocumentAssistantProviderForTests(new FailingProvider(failure));
      const thread = await createAssistantThread({ scope: 'CURRENT_RESOURCE', resourceIds: [documentId] }, owner);
      threadIds.push(thread.id);

      await assert.rejects(
        answerAssistantThread({ threadId: thread.id, question: 'ยอดที่ต้องชำระเท่าไร',
          clientRequestId: crypto.randomUUID(), mode: 'QA' }, owner),
        (error: unknown) => error instanceof AppError && error.code === failure.code,
      );

      const assistantMessages = await prisma.assistantMessage.count({ where: { threadId: thread.id, role: 'ASSISTANT' } });
      assert.equal(assistantMessages, 0, 'ความล้มเหลวต้องไม่ทิ้งคำตอบไว้ในฐานข้อมูล');
      const citations = await prisma.assistantCitation.count({ where: { message: { threadId: thread.id } } });
      assert.equal(citations, 0);
    });
  }

  /**
   * คิวเต็ม - ต้องปฏิเสธอย่างสุภาพทันที ไม่ใช่ปล่อยให้คำขอกองจนเครื่องล่ม
   *
   * ใช้คิวตัวจริงที่ระบบใช้งาน ไม่ใช่สร้างตัวใหม่ขึ้นมาทดสอบ เพราะเพดานคิวมาจากค่าตั้งค่า
   * การทดสอบสำเนาที่ตั้งค่าเองจะไม่ได้ยืนยันว่าของจริงถูกจำกัดไว้เท่าไร
   */
  test('a full generation queue rejects instead of queueing without bound', async () => {
    const limit = env.S2_NAS_ASSISTANT_QUEUE_LIMIT;
    let release = () => {};
    const blocked = new Promise<void>((resolve) => { release = resolve; });

    // งานหนึ่งกำลังทำงานอยู่ และอีก limit งานรออยู่เต็มโควตาพอดี
    const running = assistantGenerationQueue.run(async () => { await blocked; return 'first'; });
    await Promise.resolve();
    const queued = Array.from({ length: limit }, (_, index) =>
      assistantGenerationQueue.run(async () => `queued-${index}`));

    assert.equal(assistantGenerationQueue.diagnostics().queued, limit);
    await assert.rejects(assistantGenerationQueue.run(async () => 'overflow'),
      (error: unknown) => error instanceof AppError && error.code === 'ASSISTANT_QUEUE_FULL');

    release();
    assert.equal(await running, 'first');
    assert.deepEqual(await Promise.all(queued), Array.from({ length: limit }, (_, i) => `queued-${i}`));

    // คิวต้องกลับมารับงานได้ตามปกติหลังระบายจนหมด
    assert.equal(await assistantGenerationQueue.run(async () => 'after'), 'after');
    assert.equal(assistantGenerationQueue.diagnostics().queued, 0);
  });

  /** โครงสร้างคำตอบที่ผิดรูปต้องไม่ผ่านการตรวจ schema */
  test('malformed model output cannot satisfy the grounded schema', () => {
    for (const malformed of [
      { answer: '', usedEvidenceIds: ['E1'] },
      { answer: 'ok', usedEvidenceIds: ['E0'] },
      { answer: 'ok', usedEvidenceIds: 'E1' },
      { usedEvidenceIds: ['E1'] },
      { answer: 'ok', usedEvidenceIds: Array.from({ length: 21 }, (_, i) => `E${i + 1}`) },
    ]) {
      assert.equal(groundedOutputSchema.safeParse(malformed).success, false,
        `ต้องปฏิเสธ ${JSON.stringify(malformed).slice(0, 60)}`);
    }
    assert.equal(groundedOutputSchema.safeParse({ answer: 'ok [E1]', usedEvidenceIds: ['E1'] }).success, true);
  });
});

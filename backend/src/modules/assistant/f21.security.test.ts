import { writeQaVersionFile } from './qa-fixture.js';
import { removeResourceDirectory } from '../../core/file-storage.js';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { prisma } from '../../core/prisma.js';
import type { AuthUser } from '../auth/auth.service.js';
import { saveCorrection } from '../search/ocr/correction.service.js';
import { answerAssistantThread, createAssistantThread } from './assistant.service.js';
import { FakeDocumentAssistantProvider } from './fake.provider.js';
import { setDocumentAssistantProviderForTests } from './provider-instance.js';
import { retrieveAssistantEvidence } from './rag.service.js';

/**
 * ชุดตรวจเส้นทางข้อมูลของผู้ช่วยเอกสาร (F21 ข้อ 13)
 *
 * ใช้ผู้ให้บริการปลอมโดยตั้งใจ เพราะสิ่งที่ตรวจคือ *เอกสารชิ้นไหนถูกหยิบมาเป็นหลักฐาน*
 * ไม่ใช่คุณภาพการเรียบเรียงของโมเดล การใช้โมเดลจริงตรงนี้จะทำให้ผลแกว่งตามการสุ่ม
 * โดยไม่ได้เพิ่มความมั่นใจในสิ่งที่กำลังตรวจเลย คุณภาพคำตอบมีชุดโมเดลจริงแยกอยู่แล้ว
 *
 * ของทดสอบทั้งหมดเป็นของสังเคราะห์และถูกลบเมื่อจบ
 */

const prefix = `f21sec-${process.pid}-${Date.now()}`;
const resourceIds: string[] = [];
const userIds: string[] = [];
const threadIds: string[] = [];
const connectionIds: string[] = [];
let owner: AuthUser;

const auth = (id: string, email: string): AuthUser => ({
  id, email, displayName: email, type: 'INTERNAL', status: 'ACTIVE', mustChangePassword: false,
  roles: ['MEMBER'], permissions: ['resources:read', 'resources:write'],
});

/** สร้างเอกสารพร้อมดัชนีข้อความ รองรับหลายเวอร์ชันเพื่อทดสอบการยึดเวอร์ชันปัจจุบัน */
async function fixture(name: string, versions: Array<{ text: string; source?: 'NATIVE_TEXT' | 'OCR' }>): Promise<string> {
  const id = crypto.randomUUID();
  resourceIds.push(id);
  await prisma.resource.create({ data: { id, type: 'FILE', name, normalizedName: name.toLowerCase(),
    siblingKey: `${prefix}:${id}`, ownerId: owner.id, createdById: owner.id,
    visibility: 'ORGANIZATION', currentVersion: versions.length } });
  for (const [index, entry] of versions.entries()) {
    const stored = await writeQaVersionFile(id, entry.text);
    const version = await prisma.resourceVersion.create({ data: { resourceId: id, versionNumber: index + 1,
      storageKey: stored.storageKey, size: stored.size,
      checksum: stored.checksum, createdById: owner.id } });
    await prisma.resourceSearchIndex.create({ data: { resourceId: id, resourceVersionId: version.id,
      versionNumber: index + 1, status: 'READY', textSource: entry.source ?? 'NATIVE_TEXT',
      extractedText: entry.text, normalizedText: entry.text.toLowerCase(),
      characterCount: entry.text.length, extractorVersion: 'f21-security' } });
  }
  return id;
}

async function evidenceFor(question: string, ids: string[], mode: 'QA' | 'COMPARE' = 'QA') {
  const { evidence } = await retrieveAssistantEvidence({ question, scope: 'SELECTED_RESOURCES',
    resourceIds: ids, includeArchived: false, mode, historyText: '' }, owner);
  return evidence;
}

describe('F21 evidence data-path security', { concurrency: 1 }, () => {
  before(async () => {
    setDocumentAssistantProviderForTests(new FakeDocumentAssistantProvider());
    const user = await prisma.user.create({ data: { email: `${prefix}@example.invalid`,
      displayName: 'F21 security', type: 'INTERNAL', status: 'ACTIVE' } });
    userIds.push(user.id);
    owner = auth(user.id, user.email);
  });

  after(async () => {
    setDocumentAssistantProviderForTests(undefined);
    if (threadIds.length) await prisma.assistantThread.deleteMany({ where: { id: { in: threadIds } } });
    if (connectionIds.length) await prisma.googleDriveSync.deleteMany({ where: { connectionId: { in: connectionIds } } });
    if (resourceIds.length) {
      await prisma.resourceSearchIndex.deleteMany({ where: { resourceId: { in: resourceIds } } });
      await prisma.resourceVersion.deleteMany({ where: { resourceId: { in: resourceIds } } });
      await prisma.resource.deleteMany({ where: { id: { in: resourceIds } } });
      // ลบไฟล์บนดิสก์ด้วย ไม่งั้นจะเหลือไฟล์กำพร้าที่ไม่มีแถวอ้างถึง
      for (const resourceId of resourceIds) await removeResourceDirectory(resourceId);
    }
    if (connectionIds.length) await prisma.googleDriveConnection.deleteMany({ where: { id: { in: connectionIds } } });
    if (userIds.length) await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  });

  /**
   * เวอร์ชันเก่าต้องไม่ถูกใช้เป็นหลักฐาน
   *
   * เอกสารฉบับเดียวกันที่แก้เงื่อนไขการชำระเงินจาก 30 วันเป็น 15 วัน ถ้าผู้ช่วยยังตอบ
   * ตามฉบับเก่า ผู้ใช้จะได้ข้อมูลที่ผิดสัญญาปัจจุบันโดยที่การอ้างอิงดูน่าเชื่อถือทุกอย่าง
   */
  test('only the current version can become evidence', async () => {
    const id = await fixture(`${prefix}-terms.txt`, [
      { text: 'เงื่อนไขการชำระเงิน ภายใน 30 วัน นับจากวันที่ได้รับใบแจ้งหนี้ ฉบับแก้ไขครั้งที่หนึ่ง' },
      { text: 'เงื่อนไขการชำระเงิน ภายใน 15 วัน นับจากวันที่ได้รับใบแจ้งหนี้ ฉบับแก้ไขครั้งที่สอง' },
    ]);
    const versions = await prisma.resourceVersion.findMany({ where: { resourceId: id }, orderBy: { versionNumber: 'asc' } });

    const evidence = await evidenceFor('เงื่อนไขการชำระเงินกี่วัน', [id]);
    assert.ok(evidence.length > 0, 'ต้องพบหลักฐาน');
    for (const item of evidence) {
      assert.equal(item.resourceVersion, 2, 'ต้องเป็นเวอร์ชันปัจจุบันเท่านั้น');
      assert.equal(item.resourceVersionId, versions[1]!.id);
      assert.match(item.text, /15 วัน/u);
      assert.doesNotMatch(item.text, /30 วัน/u, 'ข้อความจากเวอร์ชันเก่าต้องไม่หลุดมา');
    }

    const thread = await createAssistantThread({ scope: 'CURRENT_RESOURCE', resourceIds: [id] }, owner);
    threadIds.push(thread.id);
    const message = await answerAssistantThread({ threadId: thread.id, question: 'เงื่อนไขการชำระเงินกี่วัน',
      clientRequestId: crypto.randomUUID(), mode: 'QA' }, owner);
    assert.ok(message.citations.length > 0);
    for (const citation of message.citations as Array<{ resourceVersionId: string }>) {
      assert.equal(citation.resourceVersionId, versions[1]!.id, 'การอ้างอิงต้องชี้ไปยังเวอร์ชันปัจจุบัน');
    }
  });

  /**
   * ข้อความที่คนตรวจแก้แล้วต้องแทนที่ผล OCR เดิมทันที
   *
   * OCR อ่านตัวเลขผิดเป็นเรื่องปกติ จุดสำคัญคือเมื่อคนแก้ให้ถูกแล้ว ผู้ช่วยต้องเลิกใช้
   * ข้อความเดิมทันที ไม่ใช่ค้างอยู่จนกว่าจะมีการทำดัชนีใหม่รอบถัดไป
   */
  test('human-corrected text immediately replaces the raw OCR evidence', async () => {
    const id = await fixture(`${prefix}-scan.txt`, [
      { text: 'ใบแจ้งหนี้ฉบับสแกน ยอดที่ต้องชำระ 85,7SO.5O บาท อ่านจากเครื่องสแกน', source: 'OCR' },
    ]);

    const before = await evidenceFor('ยอดที่ต้องชำระเท่าไร', [id]);
    assert.ok(before.some((item) => item.textSource === 'OCR'), 'ก่อนแก้ต้องเป็นข้อความจาก OCR');

    await saveCorrection(id, owner, {
      text: 'ใบแจ้งหนี้ฉบับสแกน ยอดที่ต้องชำระ 85,750.50 บาท ตรวจแก้โดยเจ้าหน้าที่',
      expectedRevision: 0,
    });

    const after = await evidenceFor('ยอดที่ต้องชำระเท่าไร', [id]);
    assert.ok(after.length > 0);
    for (const item of after) {
      assert.equal(item.textSource, 'HUMAN_CORRECTED', 'ต้องใช้ข้อความที่ตรวจแก้แล้ว');
      assert.match(item.text, /85,750\.50/u);
      assert.doesNotMatch(item.text, /85,7SO\.5O/u, 'ข้อความ OCR เดิมต้องไม่ถูกใช้อีก');
    }
  });

  /**
   * เอกสารที่ขัดแย้งกันต้องถูกหยิบมาทั้งคู่
   *
   * ถ้าหยิบมาแค่ฉบับเดียว โมเดลจะไม่มีทางรู้เลยว่ามีความขัดแย้ง แล้วจะตอบด้านเดียว
   * อย่างมั่นใจ ซึ่งดูเหมือนคำตอบที่ดีแต่ปิดบังข้อมูลสำคัญที่สุดของคำถามนั้นไป
   */
  test('conflicting documents both reach the evidence set', async () => {
    const first = await fixture(`${prefix}-conflict-a.txt`, [
      { text: 'บันทึกข้อตกลงฉบับ ก กำหนดส่งมอบงานภายในวันที่ 30 กันยายน 2569' },
    ]);
    const second = await fixture(`${prefix}-conflict-b.txt`, [
      { text: 'บันทึกข้อตกลงฉบับ ข กำหนดส่งมอบงานภายในวันที่ 15 ตุลาคม 2569' },
    ]);

    for (const mode of ['QA', 'COMPARE'] as const) {
      const evidence = await evidenceFor('กำหนดส่งมอบงานภายในวันที่เท่าไร', [first, second], mode);
      const sources = new Set(evidence.map((item) => item.resourceId));
      assert.ok(sources.has(first) && sources.has(second),
        `${mode}: ต้องได้หลักฐานจากทั้งสองฉบับ ไม่ใช่ ${[...sources].length} ฉบับ`);
    }
  });

  test('Thai and English selected documents both survive compare budgeting with stable aliases', async () => {
    const thai = await fixture(`${prefix}-fair-th.txt`, [
      { text: 'สัญญาฉบับภาษาไทย กำหนดส่งมอบงานภายในวันที่ 30 กันยายน 2569' },
    ]);
    const english = await fixture(`${prefix}-fair-en.txt`, [
      { text: 'English contract counterpart. Delivery is due on 15 October 2026.' },
    ]);

    const evidence = await evidenceFor('Compare the delivery date stated in each document.', [thai, english], 'COMPARE');
    const sources = new Set(evidence.map((item) => item.resourceId));
    assert.deepEqual(sources, new Set([thai, english]));
    assert.ok(evidence.some((item) => item.resourceId === thai && item.text.includes('30 กันยายน 2569')));
    assert.ok(evidence.some((item) => item.resourceId === english && item.text.includes('15 October 2026')));
    assert.deepEqual(evidence.map((item) => item.id), evidence.map((_, index) => `E${index + 1}`));
  });

  test('English QA over a Thai current resource retains representative evidence without semantic recall', async () => {
    const thai = await fixture(`${prefix}-cross-language.txt`, [
      { text: 'โครงการดวงตะวันสิ้นสุดระยะเวลารับประกันวันที่ 31 ธันวาคม 2568' },
    ]);
    const evidence = await evidenceFor('When does the Sun project warranty end?', [thai], 'QA');
    assert.ok(evidence.length > 0);
    assert.ok(evidence.every((item) => item.resourceId === thai));
    assert.ok(evidence.some((item) => item.text.includes('31 ธันวาคม 2568')));
  });

  /**
   * เอกสารที่ซิงก์จาก Google ต้องตอบจากสำเนาใน NAS เท่านั้น
   *
   * การเชื่อมต่อในเทสต์นี้ไม่มีโทเคนเลยโดยตั้งใจ ถ้าเส้นทางการตอบแอบเรียก Google
   * จริง ๆ มันจะล้มเหลวทันทีเพราะไม่มีข้อมูลรับรองให้ใช้ การที่คำตอบสำเร็จ
   * จึงเป็นหลักฐานว่าไม่มีการติดต่อออกไปข้างนอกระหว่างสร้างคำตอบ
   */
  test('a Google-synced resource is answered from the NAS copy without contacting Google', async () => {
    const id = await fixture(`${prefix}-google.txt`, [
      { text: 'เอกสารที่ซิงก์มาจาก Google Drive ระบุยอดรวมโครงการ 480,000 บาท' },
    ]);
    const connection = await prisma.googleDriveConnection.create({ data: { userId: owner.id,
      providerSubject: `${prefix}-subject`, googleAccountEmail: `${prefix}@example.invalid`,
      accessTokenEncrypted: null, refreshTokenEncrypted: null, state: 'ACTIVE' } });
    connectionIds.push(connection.id);
    const sync = await prisma.googleDriveSync.create({ data: { connectionId: connection.id, resourceId: id,
      googleFileId: `${prefix}-file`, mode: 'SYNCED', syncEnabled: true,
      lastCheckedAt: new Date('2026-01-01T00:00:00Z'), lastSyncedAt: new Date('2026-01-01T00:00:00Z') } });

    const thread = await createAssistantThread({ scope: 'CURRENT_RESOURCE', resourceIds: [id] }, owner);
    threadIds.push(thread.id);
    const message = await answerAssistantThread({ threadId: thread.id, question: 'ยอดรวมโครงการเท่าไร',
      clientRequestId: crypto.randomUUID(), mode: 'QA' }, owner);

    assert.ok(message.citations.length > 0, 'ต้องตอบได้จากสำเนาใน NAS');
    assert.ok((message.citations as Array<{ resourceId: string }>).every((c) => c.resourceId === id));

    // สถานะการซิงก์ต้องไม่ถูกแตะต้อง การตอบคำถามไม่ใช่เหตุให้ไปคุยกับ Google
    const afterSync = await prisma.googleDriveSync.findUniqueOrThrow({ where: { id: sync.id } });
    assert.deepEqual(afterSync.lastCheckedAt, sync.lastCheckedAt, 'การตอบต้องไม่ทำให้เกิดการตรวจสอบฝั่ง Google');
    assert.deepEqual(afterSync.lastSyncedAt, sync.lastSyncedAt, 'การตอบต้องไม่ทำให้เกิดการซิงก์');
  });
});

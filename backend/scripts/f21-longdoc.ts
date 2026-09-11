import { writeQaVersionFile } from '../src/modules/assistant/qa-fixture.js';
import { removeResourceDirectory } from '../src/core/file-storage.js';
import crypto from 'node:crypto';
import { env } from '../src/config/env.js';
import { prisma } from '../src/core/prisma.js';
import type { AuthUser } from '../src/modules/auth/auth.service.js';
import { answerAssistantThread, createAssistantThread } from '../src/modules/assistant/assistant.service.js';
import { retrieveAssistantEvidence } from '../src/modules/assistant/rag.service.js';
import { documentAssistantProvider } from '../src/modules/assistant/provider-instance.js';
import { RESERVED_SYSTEM_TOKENS } from '../src/modules/assistant/budget.js';
import { runSemanticJob } from '../src/modules/semantic/semantic-index.service.js';
import { SEMANTIC_MODEL_VERSION } from '../src/modules/semantic/provider.js';

/**
 * เกณฑ์วัดเอกสารยาว (F21 ข้อ 11)
 *
 * ตรวจว่าตัววางแผนงบและการสรุปเป็นชั้นทำงานบนเส้นทางจริง ไม่ใช่แค่ในเทสต์หน่วย
 * เอกสารที่ใช้ยาวกว่าที่ prompt เดียวรับไหวอย่างชัดเจน เพื่อบังคับให้เกิดการแบ่งรอบจริง
 *
 * ข้อเท็จจริงถูกวางไว้ต้นเรื่องและท้ายเรื่องคนละจุด เพื่อพิสูจน์ว่าเนื้อหาส่วนท้าย
 * ไม่ได้หายไปเงียบ ๆ จากการตัดงบ ซึ่งเป็นอาการที่ F21-D1 เคยทำให้เกิดขึ้นได้
 *
 * ข้อมูลทั้งหมดเป็นของสังเคราะห์แบบใช้แล้วทิ้ง และถูกลบทิ้งเมื่อจบ
 */

const prefix = `f21-long-${Date.now()}`;
const created: { resourceIds: string[]; userIds: string[]; threadIds: string[] } = { resourceIds: [], userIds: [], threadIds: [] };

/** ข้อเท็จจริงต้นเรื่อง ท้ายเรื่อง และเนื้อความถ่วงตรงกลางที่ยาวพอจะบังคับให้ต้องแบ่งรอบ */
function buildLongDocument(): string {
  const head = [
    'รายงานประจำปีโครงการก่อสร้างอาคารสำนักงานใหญ่ ฉบับสมบูรณ์',
    'ส่วนที่ 1 ข้อมูลทั่วไปของโครงการ',
    'ผู้ว่าจ้างคือ บริษัท เอสทู จำกัด และผู้รับจ้างคือ ห้างหุ้นส่วนจำกัด ทองชาติก่อสร้าง',
    'มูลค่าตามสัญญาเริ่มต้นเท่ากับ 12,450,000.00 บาท',
  ].join('\n');
  const filler = Array.from({ length: 60 }, (_, index) => [
    `ส่วนที่ ${index + 2} รายละเอียดการดำเนินงานประจำงวดที่ ${index + 1}`,
    'ผู้รับจ้างได้ดำเนินการตามแผนงานที่กำหนดไว้ในเอกสารแนบท้ายสัญญาอย่างต่อเนื่อง',
    'คณะกรรมการตรวจการจ้างได้เข้าตรวจสอบคุณภาพงานและความปลอดภัยในพื้นที่ก่อสร้างตามรอบที่กำหนด',
    'ไม่พบข้อบกพร่องที่เป็นสาระสำคัญซึ่งกระทบต่อโครงสร้างหลักหรือกำหนดการส่งมอบงานแต่อย่างใด',
    'ที่ประชุมมีมติรับทราบรายงานความคืบหน้าและให้ดำเนินการตามแผนงานเดิมต่อไปโดยไม่มีข้อทักท้วง',
  ].join('\n')).join('\n');
  const tail = [
    'ส่วนสุดท้าย บทสรุปและข้อกำหนดการชำระเงินงวดสุดท้าย',
    'เงินประกันผลงานในอัตราร้อยละ 5 จะคืนให้ภายใน 30 วัน หลังพ้นระยะเวลารับประกัน',
    'ระยะเวลารับประกันผลงานตามสัญญาสิ้นสุดวันที่ 31 ธันวาคม 2568',
  ].join('\n');
  return `${head}\n${filler}\n${tail}`;
}

async function fixture(name: string, ownerId: string, text: string): Promise<string> {
  const id = crypto.randomUUID();
  created.resourceIds.push(id);
  await prisma.resource.create({ data: { id, type: 'FILE', name, normalizedName: name.toLowerCase(),
    siblingKey: `${prefix}:${id}`, ownerId, createdById: ownerId, visibility: 'ORGANIZATION', currentVersion: 1 } });
  const stored = await writeQaVersionFile(id, text);
  const version = await prisma.resourceVersion.create({ data: { resourceId: id, versionNumber: 1,
    storageKey: stored.storageKey, size: stored.size,
    checksum: stored.checksum, createdById: ownerId } });
  await prisma.resourceSearchIndex.create({ data: { resourceId: id, resourceVersionId: version.id,
    versionNumber: 1, status: 'READY', textSource: 'NATIVE_TEXT', extractedText: text,
    normalizedText: text.toLowerCase(), characterCount: text.length, extractorVersion: 'f21-longdoc' } });
  if (env.S2_NAS_SEMANTIC_ENABLED === 1) {
    const semantic = await prisma.semanticDocumentIndex.create({ data: { resourceId: id,
      resourceVersionId: version.id, versionNumber: 1, status: 'PENDING',
      modelVersion: SEMANTIC_MODEL_VERSION, textSource: 'NATIVE_TEXT' } });
    const status = await runSemanticJob(semantic.id);
    if (status !== 'READY') throw new Error(`สร้างดัชนีความหมายไม่สำเร็จ: ${status}`);
  }
  return id;
}

async function cleanup() {
  if (created.threadIds.length) await prisma.assistantThread.deleteMany({ where: { id: { in: created.threadIds } } });
  if (created.resourceIds.length) {
    await prisma.semanticChunk.deleteMany({ where: { resourceId: { in: created.resourceIds } } });
    await prisma.semanticDocumentIndex.deleteMany({ where: { resourceId: { in: created.resourceIds } } });
    await prisma.resourceSearchIndex.deleteMany({ where: { resourceId: { in: created.resourceIds } } });
    await prisma.resourceVersion.deleteMany({ where: { resourceId: { in: created.resourceIds } } });
    await prisma.resource.deleteMany({ where: { id: { in: created.resourceIds } } });
    // ลบไฟล์บนดิสก์ด้วย ไม่งั้นจะเหลือไฟล์กำพร้าที่ไม่มีแถวอ้างถึง
    for (const resourceId of created.resourceIds) await removeResourceDirectory(resourceId);
  }
  if (created.userIds.length) await prisma.user.deleteMany({ where: { id: { in: created.userIds } } });
}

async function main() {
  if (env.S2_NAS_ASSISTANT_ENABLED !== 1) throw new Error('ต้องเปิดผู้ช่วยก่อน ใช้ npm run qa:f21-longdoc');
  const provider = documentAssistantProvider();
  const health = await provider.health();
  if (health.status !== 'READY') throw new Error(`โมเดลไม่พร้อม: ${health.reason ?? 'ไม่ทราบ'}`);

  const user = await prisma.user.create({ data: { email: `${prefix}@example.invalid`,
    displayName: 'F21 long document QA', type: 'INTERNAL', status: 'ACTIVE' } });
  created.userIds.push(user.id);
  const owner: AuthUser = { id: user.id, email: user.email, displayName: user.email, type: 'INTERNAL',
    status: 'ACTIVE', mustChangePassword: false, roles: ['MEMBER'], permissions: ['resources:read'] };

  const text = buildLongDocument();
  const documentId = await fixture(`${prefix}-annual-report.txt`, user.id, text);
  console.log(`เอกสารทดสอบยาว ${text.length} ตัวอักษร (~${Math.round(text.length * 0.58)} token)\n`);

  const cases: Array<{ label: string; question: string; mode: 'QA' | 'SUMMARY'; expect?: RegExp; expectAbsent?: boolean }> = [
    { label: 'A สรุปเอกสาร', question: 'สรุปเอกสารนี้', mode: 'SUMMARY' },
    { label: 'B ข้อเท็จจริงต้นเรื่อง', question: 'มูลค่าตามสัญญาเริ่มต้นเท่าไร', mode: 'QA', expect: /12,450,000/u },
    { label: 'C ข้อเท็จจริงท้ายเรื่อง', question: 'ระยะเวลารับประกันผลงานสิ้นสุดเมื่อไร', mode: 'QA', expect: /2568/u },
    { label: 'D ข้อเท็จจริงที่ไม่มีในเอกสาร', question: 'เลขที่บัญชีธนาคารของผู้รับจ้างคือเลขอะไร', mode: 'QA', expectAbsent: true },
  ];

  let failures = 0;
  const selectedCases = process.env.F21_LONGDOC_CASE
    ? cases.filter((testCase) => testCase.label.startsWith(process.env.F21_LONGDOC_CASE!))
    : cases;
  for (const testCase of selectedCases) {
    // วางแผนแยกอีกครั้งเพื่ออ่านตัวเลขงบ การวางแผนขึ้นกับคำถามและงานเท่านั้นจึงได้ค่าเดียวกับที่บริการใช้
    const retrievalStarted = performance.now();
    const { evidence, budget } = await retrieveAssistantEvidence({ question: testCase.question,
      scope: 'CURRENT_RESOURCE', resourceIds: [documentId], includeArchived: false, mode: testCase.mode,
      historyText: '', countTokens: (value) => provider.countTokens(value) }, owner);
    const retrievalMs = performance.now() - retrievalStarted;

    const thread = await createAssistantThread({ scope: 'CURRENT_RESOURCE', resourceIds: [documentId] }, owner);
    created.threadIds.push(thread.id);
    const started = performance.now();
    let content = ''; let citations = 0; let error = '';
    try {
      const message = await answerAssistantThread({ threadId: thread.id, question: testCase.question,
        clientRequestId: crypto.randomUUID(), mode: testCase.mode }, owner);
      content = message.content; citations = message.citations.length;
    } catch (caught) { error = caught instanceof Error ? caught.message : String(caught); }
    const totalSeconds = (performance.now() - started) / 1000;

    const evidenceTokens = evidence.reduce((sum, item) => sum + Math.ceil(item.text.length * 0.58), 0);
    const promptTokens = RESERVED_SYSTEM_TOKENS + evidenceTokens;
    const utilisation = (budget.maxPromptTokens / env.S2_NAS_ASSISTANT_CONTEXT_TOKENS * 100).toFixed(1);

    const ok = error ? false
      : testCase.expectAbsent ? (citations === 0 && /ไม่พบข้อมูล/u.test(content))
      : testCase.expect ? testCase.expect.test(content) && citations > 0
      : citations > 0;
    if (!ok) failures++;

    console.log(`${testCase.label}  ${ok ? 'PASS' : 'FAIL'}`);
    console.log(`  หลักฐาน ${evidence.length} ชิ้น  งบต่อรอบ ${budget.evidenceTokens} token  รอบที่วางแผน ${budget.passes}`);
    console.log(`  prompt สูงสุดตามแผน ${budget.maxPromptTokens} token  ใช้ context ${utilisation}%  ` +
      `เพดานคำตอบ ${budget.outputTokens}${budget.reducedOutput ? ' (ลดลงแล้ว)' : ''}`);
    console.log(`  prompt จริงโดยประมาณ ${promptTokens} token  ค้นหา ${retrievalMs.toFixed(0)}ms  รวม ${totalSeconds.toFixed(1)}s  อ้างอิง ${citations}`);
    console.log(`  ${error ? `ข้อผิดพลาด: ${error}` : content.slice(0, 180)}\n`);
  }

  console.log(failures === 0 ? 'ผลรวม: ผ่านทั้งหมด' : `ผลรวม: ไม่ผ่าน ${failures} กรณี`);
  return failures;
}

let exitCode = 1;
try { exitCode = (await main()) === 0 ? 0 : 1; }
catch (error) { console.error(error); }
finally { await cleanup(); await prisma.$disconnect(); }
process.exit(exitCode);

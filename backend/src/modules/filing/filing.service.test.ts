import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { env } from '../../config/env.js';
import { prisma } from '../../core/prisma.js';
import { AppError } from '../../core/errors.js';
import type { AuthUser } from '../auth/auth.service.js';
import { QaFixtureScope, removeQaUsers, writeQaVersionFile } from '../assistant/qa-fixture.js';
import { createFolder } from '../resources/resource.service.js';
import { acceptSuggestion, analyzeResource, currentSuggestion, dismissSuggestion } from './filing.service.js';

/**
 * ชุดตรวจวงจรชีวิตและขอบเขตความปลอดภัยของการจัดเก็บอัจฉริยะ (F22-C/D)
 *
 * **สิ่งที่ชุดนี้ต้องพิสูจน์เหนือสิ่งอื่นใด:** ไม่มีเส้นทางใดนอกจากการยืนยันของผู้ใช้
 * ที่ทำให้เอกสารเคลื่อนที่ได้ และข้อเสนอเก่าต้องใช้ไม่ได้ทันทีที่โลกเปลี่ยนไปจากตอนวิเคราะห์
 *
 * ของทดสอบเป็นของสังเคราะห์ทั้งหมดและถูกลบเมื่อจบ ไม่มีเอกสารของผู้ใช้จริงถูกแตะต้อง
 */

const prefix = `f22svc-${process.pid}-${Date.now()}`;
const scope = new QaFixtureScope(prefix);
const folders: string[] = [];
let owner: AuthUser;
let other: AuthUser;
let clientRoot = '';
let otherClient = '';
let homeFolder = '';

const auth = (id: string, email: string): AuthUser => ({
  id, email, displayName: email, type: 'INTERNAL', status: 'ACTIVE', mustChangePassword: false,
  roles: ['MEMBER'], permissions: ['resources:read', 'resources:write'],
});

async function makeFolder(name: string, parentId: string | null, ownerId: string,
  visibility: 'ORGANIZATION' | 'RESTRICTED' = 'ORGANIZATION'): Promise<string> {
  const id = crypto.randomUUID();
  folders.push(id);
  await prisma.resource.create({ data: { id, type: 'FOLDER', name, normalizedName: name.toLowerCase(),
    siblingKey: `${prefix}:${id}`, ownerId, createdById: ownerId, visibility, currentVersion: null } });
  if (parentId) await prisma.resource.update({ where: { id }, data: { parentId } });
  return id;
}

const TAX_ID = '0105577700011';

/** เอกสารขาเข้าที่มีตัวระบุตรงกับลูกค้าที่จัดเก็บไว้แล้ว */
async function incomingDocument(label: string): Promise<string> {
  const id = await scope.createResource({ name: `${prefix}-${label}.txt`, ownerId: owner.id,
    versions: [{ text: `ใบกำกับภาษี บริษัท เอฟทเวนตี้ทู จำกัด เลขประจำตัวผู้เสียภาษี ${TAX_ID}` }] });
  await prisma.resource.update({ where: { id }, data: { parentId: homeFolder } });
  return id;
}

/**
 * สวิตช์ของ F22 ปิดไว้เป็นค่าเริ่มต้น ชุดวงจรชีวิตจึงต้องรันด้วยคำสั่งเฉพาะ
 *
 * ชุดที่ตรวจ "พฤติกรรมตอนปิด" ยังรันในชุดปกติเสมอ เพื่อยืนยันว่าเมื่อปิดอยู่
 * ระบบปฏิเสธอย่างสุภาพและไม่แตะต้องอะไร ไม่ใช่หายไปเงียบ ๆ โดยไม่มีใครตรวจ
 */
const enabled = env.S2_NAS_SMART_FILING_ENABLED === 1;

describe('F22 feature flag contract', () => {
  test('the disabled feature refuses safely and is never silently absent', async () => {
    if (enabled) {
      assert.equal(env.S2_NAS_SMART_FILING_ENABLED, 1);
      return;
    }
    console.warn('[F22] ชุดทดสอบวงจรชีวิตไม่ได้ถูกเรียกใช้ (S2_NAS_SMART_FILING_ENABLED != 1) ' +
      'รันด้วย npm run test:smart-filing');
    await assert.rejects(analyzeResource('any-resource-id', {
      id: 'u', email: 'u@example.invalid', displayName: 'u', type: 'INTERNAL', status: 'ACTIVE',
      mustChangePassword: false, roles: ['MEMBER'], permissions: ['resources:read'],
    } as AuthUser), (error: unknown) => error instanceof AppError && error.code === 'SMART_FILING_DISABLED');
  });
});

const suite = enabled ? describe : describe.skip;

suite('F22 smart filing suggestion lifecycle', { concurrency: 1 }, () => {
  before(async () => {
    const ownerUser = await scope.createUser('F22 service owner');
    const otherUser = await scope.createUser('F22 service other');
    owner = auth(ownerUser.id, ownerUser.email);
    other = auth(otherUser.id, otherUser.email);

    const index = await makeFolder(`${prefix} INDEX`, null, ownerUser.id);
    clientRoot = await makeFolder('1. F22CLIENT', index, ownerUser.id);
    otherClient = await makeFolder('2. F22OTHER', index, ownerUser.id);
    await makeFolder('3. F22SPARE', index, ownerUser.id);
    homeFolder = await makeFolder(`${prefix} INBOX`, null, ownerUser.id);

    // เอกสารที่จัดเก็บไว้แล้ว - เป็นหลักฐานว่าเลขนี้เป็นของลูกค้ารายนี้
    const filed = await scope.createResource({ name: `${prefix}-filed.txt`, ownerId: ownerUser.id,
      versions: [{ text: `ใบกำกับภาษี บริษัท เอฟทเวนตี้ทู จำกัด เลขประจำตัวผู้เสียภาษี ${TAX_ID}` }] });
    await prisma.resource.update({ where: { id: filed }, data: { parentId: clientRoot } });
  });

  /**
   * เก็บกวาดตามลำดับการอ้างอิง: ไฟล์ → โฟลเดอร์ → ผู้ใช้
   *
   * `destroy()` ลบไฟล์แล้วค่อยพยายามลบผู้ใช้ แต่โฟลเดอร์ของชุดนี้ยังอ้างถึงผู้ใช้
   * ผ่าน createdById อยู่ การลบผู้ใช้ตรงนั้นจึงติด foreign key แล้วถูกกลืนไปเงียบ ๆ
   * ตามสัญญาของ destroy() ที่ห้ามโยนข้อผิดพลาดทับสาเหตุจริง ผลคือบัญชีทดสอบ
   * ค้างในฐานข้อมูลเพิ่มขึ้นทุกครั้งที่รัน ชุดนี้จึงลบผู้ใช้ของตัวเองปิดท้ายเอง
   */
  after(async () => {
    await prisma.smartFilingSuggestion.deleteMany({ where: { resource: { name: { startsWith: prefix } } } });
    await scope.destroy();
    for (const id of [...folders].reverse()) await prisma.resource.deleteMany({ where: { id } });
    await removeQaUsers([owner.id, other.id]);
  });

  /**
   * 18/19/20. ไม่มีเส้นทางใดนอกจากการยืนยันที่ทำให้เอกสารเคลื่อนที่
   *
   * นี่คือหลักการที่ห้ามละเมิดของ F22 ตรวจทุกเส้นทางที่ผู้ใช้เรียกได้
   */
  test('analyze, read and dismiss never move the resource', async () => {
    const doc = await incomingDocument('nomove');
    const before = await prisma.resource.findUniqueOrThrow({ where: { id: doc }, select: { parentId: true } });

    const analyzed = await analyzeResource(doc, owner);
    assert.equal((await prisma.resource.findUniqueOrThrow({ where: { id: doc }, select: { parentId: true } })).parentId,
      before.parentId, 'การวิเคราะห์ต้องไม่ย้ายเอกสาร');

    await currentSuggestion(doc, owner);
    assert.equal((await prisma.resource.findUniqueOrThrow({ where: { id: doc }, select: { parentId: true } })).parentId,
      before.parentId, 'การอ่านข้อเสนอต้องไม่ย้ายเอกสาร');

    await dismissSuggestion(doc, analyzed.suggestionId, owner);
    assert.equal((await prisma.resource.findUniqueOrThrow({ where: { id: doc }, select: { parentId: true } })).parentId,
      before.parentId, 'การปฏิเสธข้อเสนอต้องไม่ย้ายเอกสาร');

    // และต้องไม่มีบันทึกการย้ายเกิดขึ้นเลยตลอดเส้นทางนี้
    assert.equal(await prisma.activityLog.count({ where: { resourceId: doc, action: 'RESOURCE_MOVED' } }), 0);
  });

  /** 17. ปลายทางที่ชัดเจนย้ายได้เมื่อผู้ใช้ยืนยัน และใช้บริการย้ายเดิมของระบบ */
  test('accept performs the move through the existing move service', async () => {
    const doc = await incomingDocument('accept');
    const suggestion = await analyzeResource(doc, owner);
    assert.ok(suggestion.client, 'ควรระบุลูกค้าได้');

    const result = await acceptSuggestion(doc, { suggestionId: suggestion.suggestionId, targetFolderId: clientRoot }, owner, {});
    assert.equal(result.moved, true);

    const moved = await prisma.resource.findUniqueOrThrow({ where: { id: doc }, select: { parentId: true } });
    assert.equal(moved.parentId, clientRoot, 'เอกสารต้องถูกย้ายไปยังปลายทางที่ยืนยัน');
    // บริการย้ายเดิมเป็นผู้บันทึกกิจกรรม การมีบันทึกนี้พิสูจน์ว่าไม่ได้เขียนตรรกะย้ายเอง
    assert.equal(await prisma.activityLog.count({ where: { resourceId: doc, action: 'RESOURCE_MOVED' } }), 1);
    assert.equal(await prisma.activityLog.count({ where: { resourceId: doc, action: 'SMART_FILING_ACCEPTED' } }), 1);

    const row = await prisma.smartFilingSuggestion.findUniqueOrThrow({ where: { id: suggestion.suggestionId } });
    assert.equal(row.status, 'ACCEPTED');
  });

  /** 5. เวอร์ชันเปลี่ยนหลังวิเคราะห์ - ข้อเสนอเดิมต้องใช้ไม่ได้ */
  test('a new document version makes the suggestion stale', async () => {
    const doc = await incomingDocument('version');
    const suggestion = await analyzeResource(doc, owner);

    // อัปโหลดเวอร์ชันใหม่ เนื้อหาอาจเป็นของบริษัทคนละรายกันเลย
    // เขียนไฟล์จริงของเวอร์ชันใหม่ ไม่ใช้ storageKey ซ้ำกับไฟล์อื่น
    const stored = await writeQaVersionFile(doc, 'เนื้อหาใหม่ที่ไม่เกี่ยวกับลูกค้าเดิม');
    await prisma.resourceVersion.create({ data: { resourceId: doc, versionNumber: 2,
      storageKey: stored.storageKey, size: stored.size, checksum: stored.checksum, createdById: owner.id } });
    await prisma.resource.update({ where: { id: doc }, data: { currentVersion: 2 } });

    await assert.rejects(
      acceptSuggestion(doc, { suggestionId: suggestion.suggestionId, targetFolderId: clientRoot }, owner, {}),
      (error: unknown) => error instanceof AppError && error.code === 'SMART_FILING_SUGGESTION_STALE');
    assert.equal((await prisma.resource.findUniqueOrThrow({ where: { id: doc }, select: { parentId: true } })).parentId,
      homeFolder, 'ข้อเสนอที่หมดอายุต้องไม่ย้ายเอกสาร');
  });

  /** 3. สิทธิ์ปลายทางถูกเพิกถอนหลังวิเคราะห์ - ต้องปฏิเสธ */
  test('a destination whose access is revoked after analysis is rejected', async () => {
    const doc = await incomingDocument('revoke-dest');
    const suggestion = await analyzeResource(doc, owner);
    // จำกัดสิทธิ์โฟลเดอร์ปลายทางให้ผู้ใช้อีกคนเข้าไม่ได้
    await prisma.resource.update({ where: { id: otherClient }, data: { visibility: 'RESTRICTED' } });

    await assert.rejects(
      acceptSuggestion(doc, { suggestionId: suggestion.suggestionId, targetFolderId: otherClient }, other, {}),
      (error: unknown) => error instanceof AppError);
    assert.equal((await prisma.resource.findUniqueOrThrow({ where: { id: doc }, select: { parentId: true } })).parentId,
      homeFolder, 'การปฏิเสธต้องไม่ทำให้เอกสารขยับ');
    await prisma.resource.update({ where: { id: otherClient }, data: { visibility: 'ORGANIZATION' } });
  });

  /** 7. โฟลเดอร์ปลายทางถูกลบหลังวิเคราะห์ - ต้องปฏิเสธ */
  test('a deleted destination folder is rejected', async () => {
    const doc = await incomingDocument('deleted-dest');
    const temp = await makeFolder(`${prefix} TEMP DEST`, null, owner.id);
    const suggestion = await analyzeResource(doc, owner);
    await prisma.resource.update({ where: { id: temp }, data: { deletedAt: new Date(), siblingKey: `deleted:${temp}` } });

    await assert.rejects(
      acceptSuggestion(doc, { suggestionId: suggestion.suggestionId, targetFolderId: temp }, owner, {}),
      (error: unknown) => error instanceof AppError && error.code === 'FOLDER_NOT_FOUND');
    assert.equal((await prisma.resource.findUniqueOrThrow({ where: { id: doc }, select: { parentId: true } })).parentId, homeFolder);
  });

  /** 10/11. ข้อเสนอของเอกสารอื่นหรือของผู้ใช้อื่นต้องใช้ไม่ได้ */
  test('a suggestion cannot be used for another resource or by another user', async () => {
    const docA = await incomingDocument('cross-a');
    const docB = await incomingDocument('cross-b');
    const suggestion = await analyzeResource(docA, owner);

    await assert.rejects(
      acceptSuggestion(docB, { suggestionId: suggestion.suggestionId, targetFolderId: clientRoot }, owner, {}),
      (error: unknown) => error instanceof AppError && error.code === 'SMART_FILING_SUGGESTION_MISMATCH');
    // ผู้ใช้คนอื่นต้องมองไม่เห็นข้อเสนอนี้เลย
    await assert.rejects(
      acceptSuggestion(docA, { suggestionId: suggestion.suggestionId, targetFolderId: clientRoot }, other, {}),
      (error: unknown) => error instanceof AppError && error.code === 'SMART_FILING_SUGGESTION_NOT_FOUND');
    assert.equal((await prisma.resource.findUniqueOrThrow({ where: { id: docB }, select: { parentId: true } })).parentId, homeFolder);
  });

  /** 9. รหัสข้อเสนอที่ไม่มีอยู่ต้องตอบว่าไม่พบ ไม่ใช่พังหรือย้ายมั่ว */
  test('a malformed or unknown suggestion id is refused safely', async () => {
    const doc = await incomingDocument('badid');
    await assert.rejects(
      acceptSuggestion(doc, { suggestionId: 'not-a-real-suggestion', targetFolderId: clientRoot }, owner, {}),
      (error: unknown) => error instanceof AppError && error.code === 'SMART_FILING_SUGGESTION_NOT_FOUND');
    assert.equal((await prisma.resource.findUniqueOrThrow({ where: { id: doc }, select: { parentId: true } })).parentId, homeFolder);
  });

  /** 12. วิเคราะห์ซ้ำต้องไม่สร้างข้อเสนอที่ขัดแย้งกันเอง */
  test('repeated analysis replaces the suggestion instead of duplicating it', async () => {
    const doc = await incomingDocument('duplicate');
    const first = await analyzeResource(doc, owner);
    const second = await analyzeResource(doc, owner);
    assert.equal(first.suggestionId, second.suggestionId, 'ต้องเป็นข้อเสนอเดิมที่ถูกเขียนทับ');
    assert.equal(await prisma.smartFilingSuggestion.count({ where: { resourceId: doc } }), 1);
  });

  /** 13. การกดยืนยันพร้อมกันต้องเกิดการย้ายที่ถูกบันทึกเพียงครั้งเดียว */
  test('concurrent accepts produce exactly one recorded acceptance', async () => {
    const doc = await incomingDocument('concurrent');
    const suggestion = await analyzeResource(doc, owner);

    const results = await Promise.allSettled([
      acceptSuggestion(doc, { suggestionId: suggestion.suggestionId, targetFolderId: clientRoot }, owner, {}),
      acceptSuggestion(doc, { suggestionId: suggestion.suggestionId, targetFolderId: clientRoot }, owner, {}),
    ]);
    assert.ok(results.some((result) => result.status === 'fulfilled'), 'อย่างน้อยหนึ่งครั้งต้องสำเร็จ');
    assert.equal(await prisma.activityLog.count({ where: { resourceId: doc, action: 'SMART_FILING_ACCEPTED' } }), 1,
      'ต้องมีบันทึกการยืนยันเพียงรายการเดียว');
    const row = await prisma.smartFilingSuggestion.findUniqueOrThrow({ where: { id: suggestion.suggestionId } });
    assert.equal(row.status, 'ACCEPTED');
  });

  /**
   * 16. ผลระดับลูกค้าเท่านั้น ต้องไม่ถูกขยายเป็นโฟลเดอร์ที่ลึกกว่าเอง
   *
   * ระบบอาจมั่นใจว่าเป็นเอกสารของลูกค้ารายนี้ แต่ไม่รู้ว่าควรอยู่โฟลเดอร์ย่อยไหน
   * การเดาให้ลึกกว่าที่รู้คือการย้ายเอกสารไปยังที่ที่ผู้ใช้ไม่ได้ยืนยัน
   */
  test('a client-only result never expands into a deeper folder on its own', async () => {
    const doc = await incomingDocument('clientonly');
    const suggestion = await analyzeResource(doc, owner);
    if (suggestion.resultLevel !== 'CLIENT_ONLY') return;
    assert.equal(suggestion.destination?.folderId, suggestion.client?.folderId,
      'ปลายทางที่เสนอต้องเป็นโฟลเดอร์ลูกค้าเท่านั้น ไม่ใช่โฟลเดอร์ย่อยที่เดาเอง');
  });

  /**
   * การสร้างโฟลเดอร์ต้องไม่ย้ายเอกสารตามไปด้วย (F22-F11)
   *
   * เป็นสองการกระทำที่แยกจากกันโดยสิ้นเชิง ผู้ใช้ที่ตั้งใจแค่เตรียมโฟลเดอร์ไว้ก่อน
   * ต้องไม่พบว่าเอกสารถูกย้ายไปแล้วโดยที่ไม่ได้สั่ง การรวมสองอย่างเป็นขั้นตอนเดียว
   * คือการย้ายเอกสารโดยผู้ใช้ไม่ได้ยืนยัน ซึ่งละเมิดหลักการของ F22 โดยตรง
   */
  test('creating a folder never moves the resource', async () => {
    const doc = await incomingDocument('createfolder');
    const before = await prisma.resource.findUniqueOrThrow({ where: { id: doc }, select: { parentId: true } });

    const folder = await createFolder(owner, { name: `${prefix} ปลายทางใหม่`, parentId: null }, {});
    folders.push(folder.id);
    assert.ok(folder.id, 'ต้องสร้างโฟลเดอร์ได้จริงผ่านบริการเดิมของระบบ');

    const after = await prisma.resource.findUniqueOrThrow({ where: { id: doc }, select: { parentId: true } });
    assert.equal(after.parentId, before.parentId, 'การสร้างโฟลเดอร์ต้องไม่เปลี่ยนโฟลเดอร์แม่ของเอกสาร');
    assert.equal(await prisma.activityLog.count({ where: { resourceId: doc, action: 'RESOURCE_MOVED' } }), 0);

    // ย้ายได้เฉพาะเมื่อผู้ใช้ยืนยันแยกอีกครั้งเท่านั้น
    const suggestion = await analyzeResource(doc, owner);
    await acceptSuggestion(doc, { suggestionId: suggestion.suggestionId, targetFolderId: folder.id }, owner, {});
    const moved = await prisma.resource.findUniqueOrThrow({ where: { id: doc }, select: { parentId: true } });
    assert.equal(moved.parentId, folder.id, 'หลังยืนยันแยกต่างหากจึงย้ายได้');
  });

  /** 14. ไม่พบข้อเสนอเป็นผลลัพธ์ที่ถูกต้อง ไม่ใช่ข้อผิดพลาด และต้องไม่ย้ายอะไร */
  test('no suggestion is a successful outcome that moves nothing', async () => {
    const doc = await scope.createResource({ name: `${prefix}-unknown.txt`, ownerId: owner.id,
      versions: [{ text: 'เอกสารทั่วไปที่ไม่มีตัวระบุของลูกค้ารายใดเลย' }] });
    await prisma.resource.update({ where: { id: doc }, data: { parentId: homeFolder } });

    const suggestion = await analyzeResource(doc, owner);
    assert.equal(suggestion.resultLevel, 'NO_SUGGESTION');
    assert.equal(suggestion.destination, null);
    assert.equal((await prisma.resource.findUniqueOrThrow({ where: { id: doc }, select: { parentId: true } })).parentId, homeFolder);

    // ไม่มีปลายทางให้ยืนยัน การกดยืนยันต้องถูกปฏิเสธอย่างสุภาพ
    await assert.rejects(
      acceptSuggestion(doc, { suggestionId: suggestion.suggestionId }, owner, {}),
      (error: unknown) => error instanceof AppError && error.code === 'SMART_FILING_TARGET_REQUIRED');
  });

  /**
   * เอกสารที่ยังสกัดข้อความไม่เสร็จ ต้องไม่ถูกสรุปว่า "ไม่พบตำแหน่ง"
   *
   * หน้าจออัปโหลดเรียกวิเคราะห์ทันทีที่อัปโหลดเสร็จ ซึ่งเร็วกว่าตัวจัดทำดัชนีเสมอ
   * ถ้าตอบว่าไม่พบตำแหน่งในจังหวะนั้น จะเป็นคำตอบที่ระบบยังไม่ได้ตรวจจริง
   * และที่แย่กว่าคือมันจะถูกบันทึกทับข้อเสนอเดิม ทำให้คำตอบผิดค้างอยู่
   */
  test('a document whose text is not extracted yet is not answered with no-suggestion', async () => {
    const doc = await scope.createResource({ name: `${prefix}-pending.txt`, ownerId: owner.id, withSearchIndex: false,
      versions: [{ text: `ใบกำกับภาษี บริษัท เอฟทเวนตี้ทู จำกัด เลขประจำตัวผู้เสียภาษี ${TAX_ID}` }] });
    await prisma.resource.update({ where: { id: doc }, data: { parentId: homeFolder } });

    await assert.rejects(analyzeResource(doc, owner),
      (error: unknown) => error instanceof AppError && error.code === 'SMART_FILING_TEXT_NOT_READY');
    // ต้องไม่มีข้อเสนอที่ผิดถูกบันทึกไว้ระหว่างรอ
    assert.equal(await prisma.smartFilingSuggestion.count({ where: { resourceId: doc } }), 0);
  });

  /**
   * ไฟล์ที่สกัดข้อความไม่ได้เลย ต้องวิเคราะห์จากชื่อไฟล์ได้ตามปกติ
   *
   * NO_TEXT และ UNSUPPORTED เป็นสถานะปลายทาง ไม่ใช่งานที่ยังทำไม่เสร็จ
   * ถ้าเหมารวมกับกรณี "ยังไม่พร้อม" ไฟล์ภาพจะวิเคราะห์ไม่ได้ตลอดไป
   */
  test('a file that will never have text is still analysed from its name', async () => {
    const doc = await scope.createResource({ name: `${prefix}-เอฟทเวนตี้ทู-สแกน.png`, ownerId: owner.id,
      withSearchIndex: false, versions: [{ text: '' }] });
    await prisma.resource.update({ where: { id: doc }, data: { parentId: homeFolder } });
    const version = await prisma.resourceVersion.findFirstOrThrow({ where: { resourceId: doc }, select: { id: true } });
    await prisma.resourceSearchIndex.create({ data: { resourceId: doc, resourceVersionId: version.id,
      versionNumber: 1, status: 'NO_TEXT', extractorVersion: 'f22-qa' } });

    const suggestion = await analyzeResource(doc, owner);
    assert.ok(suggestion.suggestionId, 'ต้องได้ข้อเสนอกลับมา ไม่ใช่ข้อผิดพลาด');
    assert.equal((await prisma.resource.findUniqueOrThrow({ where: { id: doc }, select: { parentId: true } })).parentId,
      homeFolder, 'การวิเคราะห์ต้องไม่ย้ายเอกสาร');
  });

  /** 1. เอกสารที่ไม่มีสิทธิ์เข้าถึงต้องวิเคราะห์ไม่ได้ */
  test('analyzing a resource the user cannot access is refused', async () => {
    const doc = await scope.createResource({ name: `${prefix}-private.txt`, ownerId: owner.id,
      versions: [{ text: `เอกสารลับ เลขประจำตัวผู้เสียภาษี ${TAX_ID}` }] });
    await prisma.resource.update({ where: { id: doc }, data: { parentId: homeFolder, visibility: 'RESTRICTED' } });
    await assert.rejects(analyzeResource(doc, other),
      (error: unknown) => error instanceof AppError && error.code === 'RESOURCE_NOT_FOUND');
  });

  /** บันทึกกิจกรรมต้องมีแต่ข้อมูลที่ปลอดภัย ไม่มีเนื้อหาเอกสาร */
  test('audit metadata never contains document text or paths', async () => {
    const rows = await prisma.activityLog.findMany({
      where: { action: { startsWith: 'SMART_FILING_' } }, select: { metadata: true }, take: 20 });
    assert.ok(rows.length > 0, 'ควรมีบันทึกกิจกรรมจากการทดสอบก่อนหน้า');
    for (const row of rows) {
      const serialized = JSON.stringify(row.metadata ?? {});
      assert.doesNotMatch(serialized, /เลขประจำตัวผู้เสียภาษี/u, 'ต้องไม่มีเนื้อหาเอกสาร');
      assert.doesNotMatch(serialized, /resources\//u, 'ต้องไม่มี storage key');
      assert.doesNotMatch(serialized, /[A-Za-z]:\\/u, 'ต้องไม่มี path บนดิสก์');
    }
  });
});

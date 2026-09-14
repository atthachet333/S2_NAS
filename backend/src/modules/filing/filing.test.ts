import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { prisma } from '../../core/prisma.js';
import type { AuthUser } from '../auth/auth.service.js';
import { QaFixtureScope, removeQaUsers } from '../assistant/qa-fixture.js';
import { collectEvidence } from './candidates.js';
import { loadClientRoots, clientRootOf } from './client-root.js';
import { suggestFiling } from './rank.js';

/**
 * ชุดตรวจเครื่องจัดเก็บอัจฉริยะ (F22-B)
 *
 * เน้นคุณสมบัติที่ผิดแล้วอันตราย มากกว่าความแม่นของการจัดอันดับ
 * ความแม่นวัดกับคลังเอกสารจริงแยกต่างหาก เพราะข้อมูลสังเคราะห์ไม่ได้สะท้อนความยากจริง
 *
 * สิ่งที่ต้องจริงเสมอไม่ว่าข้อมูลจะเป็นอย่างไร
 * - ไม่มีการย้ายไฟล์เกิดขึ้นจากการวิเคราะห์
 * - โฟลเดอร์ที่ผู้ใช้เข้าไม่ถึงต้องไม่โผล่มาในข้อเสนอ
 * - ตัวระบุที่ชี้ไปหลายลูกค้าต้องไม่กลายเป็นความมั่นใจสูง
 * - การเสมอกันต้องไม่ถูกตัดสินด้วยลำดับจากฐานข้อมูล
 */

const prefix = `f22-${process.pid}-${Date.now()}`;
const scope = new QaFixtureScope(prefix);
let owner: AuthUser;
let outsider: AuthUser;
let clientA = '';
let clientB = '';
let clientAYear = '';

const auth = (id: string, email: string): AuthUser => ({
  id, email, displayName: email, type: 'INTERNAL', status: 'ACTIVE', mustChangePassword: false,
  roles: ['MEMBER'], permissions: ['resources:read', 'resources:write'],
});

/** โฟลเดอร์สร้างตรง ๆ เพราะตัวช่วยของ F21 สร้างเฉพาะไฟล์ */
async function folder(name: string, parentId: string | null, ownerId: string, visibility: 'ORGANIZATION' | 'RESTRICTED' = 'ORGANIZATION'): Promise<string> {
  const id = crypto.randomUUID();
  await prisma.resource.create({ data: { id, type: 'FOLDER', name, normalizedName: name.toLowerCase(),
    siblingKey: `${prefix}:${id}`, ownerId, createdById: ownerId, visibility, currentVersion: null } });
  if (parentId) await prisma.resource.update({ where: { id }, data: { parentId } });
  return id;
}

const createdFolders: string[] = [];
const track = async (name: string, parentId: string | null, ownerId: string, visibility: 'ORGANIZATION' | 'RESTRICTED' = 'ORGANIZATION') => {
  const id = await folder(name, parentId, ownerId, visibility);
  createdFolders.push(id);
  return id;
};

describe('F22 smart filing candidate engine', { concurrency: 1 }, () => {
  before(async () => {
    const ownerUser = await scope.createUser('F22 owner');
    const outsiderUser = await scope.createUser('F22 outsider');
    owner = auth(ownerUser.id, ownerUser.email);
    outsider = auth(outsiderUser.id, outsiderUser.email);

    // สารบัญลูกค้า - ต้องมีพี่น้องที่ตั้งชื่อด้วยลำดับเลขอย่างน้อยสามรายการ
    const index = await track(`${prefix} INDEX`, null, ownerUser.id);
    // จำกัดสิทธิ์ไว้เพื่อพิสูจน์ว่าโฟลเดอร์ที่ผู้ใช้ย้ายเข้าไม่ได้จะไม่ถูกเสนอ
    clientA = await track('1. ALPHA', index, ownerUser.id, 'RESTRICTED');
    clientB = await track('2. BETA', index, ownerUser.id);
    await track('3. GAMMA', index, ownerUser.id);
    clientAYear = await track('ปี 2567', clientA, ownerUser.id);
    await track('ภงด.3', clientAYear, ownerUser.id);
    await track('ภงด.1', clientAYear, ownerUser.id);

    // เอกสารที่ถูกจัดเก็บไว้แล้ว - เป็นหลักฐานว่าเลขผู้เสียภาษีนี้เป็นของลูกค้ารายใด
    const filedA = await scope.createResource({ name: `${prefix}-alpha-filed.txt`, ownerId: ownerUser.id,
      versions: [{ text: 'ใบกำกับภาษี บริษัท อัลฟ่าทดสอบ จำกัด เลขประจำตัวผู้เสียภาษี 0105500000011' }] });
    await prisma.resource.update({ where: { id: filedA }, data: { parentId: clientAYear } });

    const filedB = await scope.createResource({ name: `${prefix}-beta-filed.txt`, ownerId: ownerUser.id,
      versions: [{ text: 'ใบกำกับภาษี บริษัท เบต้าทดสอบ จำกัด เลขประจำตัวผู้เสียภาษี 0105500000022' }] });
    await prisma.resource.update({ where: { id: filedB }, data: { parentId: clientB } });
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
    await scope.destroy();
    // ลบจากลูกขึ้นไปหาพ่อ ลำดับสร้างเป็นพ่อก่อนลูก จึงลบย้อนลำดับ
    for (const id of [...createdFolders].reverse()) {
      await prisma.resource.deleteMany({ where: { id } });
    }
    await removeQaUsers([owner.id, outsider.id]);
  });

  /** สารบัญลูกค้าต้องถูกตรวจพบจากรูปแบบการตั้งชื่อ ไม่ใช่จากชื่อที่ฝังไว้ในโค้ด */
  test('client roots are detected structurally from sibling numbering', async () => {
    const map = await loadClientRoots();
    assert.ok(map.roots.has(clientA), 'โฟลเดอร์ "1. ALPHA" ต้องถูกถือเป็นรากลูกค้า');
    assert.ok(map.roots.has(clientB));
    // โฟลเดอร์ย่อยใต้ลูกค้าต้องไม่ถูกนับเป็นรากลูกค้าเอง
    assert.ok(!map.roots.has(clientAYear));
    assert.equal(clientRootOf(clientAYear, map)?.id, clientA, 'โฟลเดอร์ปีต้องถูกยุบขึ้นไปที่ลูกค้า');
  });

  /** 3. เลขประจำตัวผู้เสียภาษีที่ตรงกันต้องชี้ลูกค้าได้ถูกต้องและมั่นใจสูง */
  test('an exact tax id resolves the client with HIGH confidence', async () => {
    const incoming = await scope.createResource({ name: `${prefix}-incoming-alpha.txt`, ownerId: owner.id,
      versions: [{ text: 'ใบกำกับภาษีใหม่ บริษัท อัลฟ่าทดสอบ จำกัด เลขประจำตัวผู้เสียภาษี 0105500000011' }] });
    const evidence = await collectEvidence(incoming, owner);
    assert.ok(evidence);
    const result = await suggestFiling(evidence!, owner);
    assert.equal(result.clients[0]?.clientRootId, clientA);
    assert.equal(result.clientConfidence, 'HIGH');
    assert.ok(result.clients[0]!.reasons.some((reason) => reason.signal === 'EXACT_TAX_ID'));
  });

  /**
   * 10. เลขผู้เสียภาษีที่ปรากฏใต้ลูกค้าหลายรายต้องไม่ให้ความมั่นใจสูง
   *
   * เลขแบบนี้มักเป็นของกรมสรรพากรหรือคู่ค้าที่ปรากฏในเอกสารของลูกค้าหลายราย
   * ไม่ใช่เลขของเจ้าของเอกสาร การเดาข้างใดข้างหนึ่งคือการสร้างความมั่นใจปลอม
   */
  test('a tax id seen under several clients never yields HIGH confidence', async () => {
    const shared = '0105599999999';
    const inA = await scope.createResource({ name: `${prefix}-shared-a.txt`, ownerId: owner.id,
      versions: [{ text: `เอกสารของลูกค้า A เลขประจำตัวผู้เสียภาษี ${shared}` }] });
    await prisma.resource.update({ where: { id: inA }, data: { parentId: clientAYear } });
    const inB = await scope.createResource({ name: `${prefix}-shared-b.txt`, ownerId: owner.id,
      versions: [{ text: `เอกสารของลูกค้า B เลขประจำตัวผู้เสียภาษี ${shared}` }] });
    await prisma.resource.update({ where: { id: inB }, data: { parentId: clientB } });

    const incoming = await scope.createResource({ name: `${prefix}-incoming-shared.txt`, ownerId: owner.id,
      versions: [{ text: `เอกสารใหม่ เลขประจำตัวผู้เสียภาษี ${shared}` }] });
    const evidence = await collectEvidence(incoming, owner);
    const result = await suggestFiling(evidence!, owner);
    assert.notEqual(result.clientConfidence, 'HIGH',
      'ตัวระบุที่กำกวมต้องไม่ถูกยกระดับเป็นความมั่นใจสูง');
  });

  /**
   * 8. การเสมอกันต้องไม่กลายเป็นความแน่ใจ
   *
   * ตัวเลือกที่คะแนนใกล้กันต้องถูกลดระดับ ไม่ใช่ตัดสินด้วยลำดับจากฐานข้อมูล
   * ผลลัพธ์ต้องคงที่เมื่อเรียกซ้ำด้วยข้อมูลเดิม
   */
  test('ties are reported as uncertainty and ranking is deterministic', async () => {
    const incoming = await scope.createResource({ name: `${prefix}-incoming-tie.txt`, ownerId: owner.id,
      versions: [{ text: 'เอกสารทั่วไปที่ไม่มีตัวระบุเฉพาะของลูกค้ารายใด' }] });
    const evidence = await collectEvidence(incoming, owner);
    const first = await suggestFiling(evidence!, owner);
    const second = await suggestFiling(evidence!, owner);
    assert.deepEqual(first.clients.map((c) => c.clientRootId), second.clients.map((c) => c.clientRootId),
      'การเรียกซ้ำด้วยข้อมูลเดิมต้องให้ลำดับเดิมเสมอ');
  });

  /** 14. โฟลเดอร์ที่ผู้ใช้เข้าไม่ถึงต้องไม่ปรากฏในข้อเสนอเลย */
  test('folders the user cannot move into are never suggested', async () => {
    const incoming = await scope.createResource({ name: `${prefix}-incoming-auth.txt`, ownerId: owner.id,
      versions: [{ text: 'ใบกำกับภาษี บริษัท อัลฟ่าทดสอบ จำกัด เลขประจำตัวผู้เสียภาษี 0105500000011' }] });
    /**
     * ผู้ใช้เห็นเอกสารได้แต่เข้าโฟลเดอร์ปลายทางไม่ได้
     *
     * เป็นสถานการณ์ที่เกิดจริงและอันตรายที่สุด เพราะถ้ากรองไม่ครบ ชื่อโฟลเดอร์
     * ของลูกค้าที่ผู้ใช้ไม่มีสิทธิ์เข้าถึงจะรั่วออกไปทางข้อเสนอ
     */
    const evidence = await collectEvidence(incoming, outsider);
    assert.ok(evidence, 'เอกสารแบบองค์กรผู้ใช้ภายในเห็นได้ตามปกติ');
    const asOutsider = await suggestFiling(evidence!, outsider);
    for (const candidate of asOutsider.clients) {
      assert.notEqual(candidate.clientRootId, clientA,
        'โฟลเดอร์ที่ผู้ใช้ย้ายเข้าไม่ได้ต้องไม่ถูกเสนอ');
    }
  });

  /** 32. การวิเคราะห์ต้องไม่ย้ายไฟล์ - นี่คือหลักการที่ห้ามละเมิดของ F22 */
  test('analysis never moves the resource', async () => {
    const incoming = await scope.createResource({ name: `${prefix}-incoming-nomove.txt`, ownerId: owner.id,
      versions: [{ text: 'ใบกำกับภาษี บริษัท อัลฟ่าทดสอบ จำกัด เลขประจำตัวผู้เสียภาษี 0105500000011' }] });
    const before = await prisma.resource.findUniqueOrThrow({ where: { id: incoming }, select: { parentId: true, updatedAt: true } });

    const evidence = await collectEvidence(incoming, owner);
    const result = await suggestFiling(evidence!, owner);
    assert.ok(result.destinationFolderId, 'ควรมีข้อเสนอปลายทาง');

    const after = await prisma.resource.findUniqueOrThrow({ where: { id: incoming }, select: { parentId: true, updatedAt: true } });
    assert.equal(after.parentId, before.parentId, 'การวิเคราะห์ต้องไม่เปลี่ยนโฟลเดอร์แม่');
    assert.deepEqual(after.updatedAt, before.updatedAt, 'การวิเคราะห์ต้องไม่แตะแถวของทรัพยากรเลย');
    // ต้องไม่มีบันทึกการย้ายเกิดขึ้นจากการวิเคราะห์
    assert.equal(await prisma.activityLog.count({ where: { resourceId: incoming, action: 'RESOURCE_MOVED' } }), 0);
  });

  /** ข้อเสนอต้องไม่มี path บนดิสก์หรือ storage key หลุดออกไป */
  test('suggestions never expose storage keys or filesystem paths', async () => {
    const incoming = await scope.createResource({ name: `${prefix}-incoming-leak.txt`, ownerId: owner.id,
      versions: [{ text: 'ใบกำกับภาษี บริษัท อัลฟ่าทดสอบ จำกัด เลขประจำตัวผู้เสียภาษี 0105500000011' }] });
    const evidence = await collectEvidence(incoming, owner);
    const result = await suggestFiling(evidence!, owner);
    const serialized = JSON.stringify(result);
    assert.doesNotMatch(serialized, /resources\//u, 'ต้องไม่มี storage key');
    assert.doesNotMatch(serialized, /[A-Za-z]:\\/u, 'ต้องไม่มี path แบบ Windows');
    assert.doesNotMatch(serialized, /\.txt"/u, 'ต้องไม่มีชื่อไฟล์ของหลักฐานหลุดมาในข้อเสนอ');
  });
});

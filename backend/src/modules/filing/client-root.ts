import { prisma } from '../../core/prisma.js';

/**
 * การหา "โฟลเดอร์ลูกค้า" จากโครงสร้างที่มีอยู่จริง (F22-B)
 *
 * **ปัญหาที่แก้:** สัญญาณที่แข็งที่สุด (เลขประจำตัวผู้เสียภาษี) ชี้ว่าเอกสารเป็นของลูกค้ารายใด
 * ได้แม่นมาก แต่ลูกค้าหนึ่งรายมีโฟลเดอร์ย่อยตามปีและประเภทหลายสิบโฟลเดอร์
 * ซึ่งได้คะแนนจากหลักฐานชุดเดียวกันเท่ากันหมด การจัดอันดับแบบแบนจึงเอาโฟลเดอร์ย่อย
 * ของลูกค้าคนเดียวกันมาแข่งกันเอง แล้วเลือกปีมั่ว วัดได้ว่าอันดับหนึ่งถูกเพียง 23%
 *
 * **วิธีหา:** ไม่ผูกกับชื่อโฟลเดอร์ใดโฟลเดอร์หนึ่ง แต่ดูรูปแบบการตั้งชื่อของพี่น้อง
 * เมื่อโฟลเดอร์หลายอันที่อยู่ใต้พ่อเดียวกันถูกตั้งชื่อขึ้นต้นด้วยลำดับเลข
 * ("1. อัลฟ่าทดสอบ", "10. ทดสอบซีเอ็นซี", "29.ทดสอบดี") นั่นคือสารบัญของหน่วยงานหรือลูกค้า
 * กติกานี้ค้นพบจากข้อมูลจริงและใช้ได้กับสารบัญอื่นที่ตั้งชื่อแบบเดียวกันโดยไม่ต้องแก้โค้ด
 */

/** ชื่อที่ขึ้นต้นด้วยลำดับเลข เช่น "1. อัลฟ่าทดสอบ" "29.ทดสอบดี" "10. ทดสอบซีเอ็นซี" */
const NUMBERED_PREFIX = /^\s*\d{1,3}\s*[.．]/u;

/** ต้องมีพี่น้องที่ตั้งชื่อแบบเดียวกันอย่างน้อยเท่านี้จึงถือว่าเป็นสารบัญ ไม่ใช่ชื่อบังเอิญ */
const MIN_SIBLINGS_FOR_INDEX = 3;

export interface FolderNode {
  id: string;
  name: string;
  parentId: string | null;
}

export interface ClientRootMap {
  /** โฟลเดอร์ทั้งหมดที่ถือเป็นรากของลูกค้าหนึ่งราย */
  roots: Set<string>;
  nodes: Map<string, FolderNode>;
}

/**
 * อ่านโครงสร้างโฟลเดอร์ทั้งหมดแล้วหาว่าชั้นไหนคือชั้นลูกค้า
 *
 * อ่านทั้งต้นไม้ครั้งเดียวเพราะระบบนี้มีโฟลเดอร์ระดับร้อย ไม่ใช่ระดับแสน
 * การไล่ถาม ancestor ทีละชั้นต่อหนึ่งผู้สมัครแพงกว่ามากเมื่อมีผู้สมัครหลายสิบ
 */
export async function loadClientRoots(): Promise<ClientRootMap> {
  const folders = await prisma.resource.findMany({
    where: { type: 'FOLDER', deletedAt: null },
    select: { id: true, name: true, parentId: true },
  });
  const nodes = new Map<string, FolderNode>(folders.map((folder) => [folder.id, folder]));

  // จัดกลุ่มตามพ่อ เพื่อดูว่าพี่น้องกลุ่มไหนถูกตั้งชื่อเป็นสารบัญ
  const byParent = new Map<string, FolderNode[]>();
  for (const folder of folders) {
    const key = folder.parentId ?? '__root__';
    const group = byParent.get(key) ?? [];
    group.push(folder);
    byParent.set(key, group);
  }

  const roots = new Set<string>();
  for (const group of byParent.values()) {
    const numbered = group.filter((folder) => NUMBERED_PREFIX.test(folder.name));
    if (numbered.length >= MIN_SIBLINGS_FOR_INDEX) {
      for (const folder of numbered) roots.add(folder.id);
    }
  }
  return { roots, nodes };
}

/** ลำดับบรรพบุรุษจากตัวเองขึ้นไปถึงราก */
export function ancestorChain(folderId: string, map: ClientRootMap): FolderNode[] {
  const chain: FolderNode[] = [];
  let cursor: string | null = folderId;
  const seen = new Set<string>();
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    const node = map.nodes.get(cursor);
    if (!node) break;
    chain.push(node);
    cursor = node.parentId;
  }
  return chain;
}

/**
 * รากลูกค้าที่ครอบโฟลเดอร์นี้อยู่
 *
 * ถ้าโฟลเดอร์ไม่ได้อยู่ใต้สารบัญลูกค้าเลย จะคืนตัวมันเองเป็นรากของตัวเอง
 * เพื่อให้โฟลเดอร์นอกโครงสร้างลูกค้ายังถูกเสนอได้ตามปกติ ไม่ใช่หายไปเงียบ ๆ
 */
export function clientRootOf(folderId: string, map: ClientRootMap): FolderNode | null {
  const chain = ancestorChain(folderId, map);
  const root = chain.find((node) => map.roots.has(node.id));
  return root ?? chain.at(-1) ?? null;
}

/** เส้นทางที่แสดงต่อผู้ใช้ - ประกอบจากชื่อโฟลเดอร์เท่านั้น ไม่มี path บนดิสก์ */
export function pathLabelOf(folderId: string, map: ClientRootMap): string {
  return ancestorChain(folderId, map).reverse().map((node) => node.name).join(' / ');
}

/** โฟลเดอร์ทั้งหมดที่อยู่ใต้รากลูกค้าหนึ่งราย รวมตัวรากเอง */
export function descendantsOf(rootId: string, map: ClientRootMap): FolderNode[] {
  const children = new Map<string, FolderNode[]>();
  for (const node of map.nodes.values()) {
    if (!node.parentId) continue;
    const group = children.get(node.parentId) ?? [];
    group.push(node);
    children.set(node.parentId, group);
  }
  const result: FolderNode[] = [];
  const queue = [rootId];
  const seen = new Set<string>();
  while (queue.length) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const node = map.nodes.get(id);
    if (node) result.push(node);
    for (const child of children.get(id) ?? []) queue.push(child.id);
  }
  return result;
}

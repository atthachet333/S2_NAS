import type { AuthUser } from '../auth/auth.service.js';
import { prisma } from '../../core/prisma.js';
import { capabilities, resourceInclude } from '../resources/resource.service.js';
import { visibilityScope } from '../workspace/search.service.js';
import { documentIdentity, detectCategories, extractBuddhistYears, extractFormCodes, normalizeCompanyName, type DetectedCategory } from './identity.js';

/**
 * เครื่องหาปลายทางที่น่าจะถูกต้อง (F22-B)
 *
 * **วิธีที่เลือกและเหตุผล:** ระบบนี้ไม่มีทะเบียนบริษัท ไม่มีแท็ก และโฟลเดอร์ลูกค้า
 * ตั้งชื่อด้วยรหัสสั้น ("1. อัลฟ่าทดสอบ", "24. ปิติชัย") ไม่ใช่ชื่อนิติบุคคล การเทียบชื่อบริษัท
 * กับชื่อโฟลเดอร์ตรง ๆ จึงแทบไม่เจออะไรเลยบนข้อมูลจริง
 *
 * แทนที่จะสร้างทะเบียนใหม่ให้ผู้ใช้กรอก เครื่องนี้ใช้การค้นย้อนกลับจากเอกสารที่ถูกจัดเก็บ
 * ไว้แล้ว: "เอกสารที่มีเลขประจำตัวผู้เสียภาษีเดียวกันนี้ ถูกเก็บไว้ที่โฟลเดอร์ไหน"
 * นี่คือหลักฐานเชิงประจักษ์จากการจัดเก็บจริงของผู้ใช้เอง ไม่ใช่กติกาที่เราคิดขึ้น
 * และแม่นขึ้นเรื่อย ๆ ตามจำนวนเอกสารที่จัดเก็บไว้
 *
 * **สิทธิ์:** โฟลเดอร์ที่ผู้ใช้ย้ายเข้าไม่ได้ ต้องไม่ถูกส่งออกไปเป็นข้อเสนอเลย
 * เพราะชื่อโฟลเดอร์เองก็เป็นข้อมูลที่รั่วได้ การกรองจึงทำฝั่งเซิร์ฟเวอร์เสมอ
 */

export type ConfidenceBand = 'HIGH' | 'MEDIUM' | 'LOW';

export type SignalType =
  | 'EXACT_TAX_ID'
  | 'EXACT_COMPANY_NAME'
  | 'COMPANY_IN_FILENAME'
  | 'CATEGORY_MATCH'
  | 'PERIOD_MATCH'
  | 'SIBLING_HISTORY';

export interface CandidateReason {
  signal: SignalType;
  /** ข้อความอธิบายที่ปลอดภัยต่อการแสดงผล ไม่มีเนื้อหาเอกสารดิบ */
  label: string;
}

export interface FolderCandidate {
  folderId: string;
  folderName: string;
  pathLabel: string;
  score: number;
  confidence: ConfidenceBand;
  reasons: CandidateReason[];
  signals: SignalType[];
  companyMatch?: string;
  categoryMatch?: string;
}

/**
 * น้ำหนักของสัญญาณแต่ละชนิด
 *
 * ตัวระบุที่ตรงตัวได้น้ำหนักสูงกว่าความคล้ายของข้อความมาก เพราะเลขประจำตัวผู้เสียภาษี
 * ที่ตรงกันทั้ง 13 หลักแทบไม่มีทางบังเอิญ ส่วนชื่อที่คล้ายกันบังเอิญได้ง่าย
 */
const WEIGHTS: Record<SignalType, number> = {
  EXACT_TAX_ID: 100,
  EXACT_COMPANY_NAME: 60,
  COMPANY_IN_FILENAME: 25,
  CATEGORY_MATCH: 12,
  PERIOD_MATCH: 30,
  SIBLING_HISTORY: 8,
};

/** ต่ำกว่านี้ไม่เสนอเลย ดีกว่าเสนอสิ่งที่เดาล้วน ๆ */
export const MIN_SCORE_TO_SUGGEST = 20;

/**
 * เพดานจำนวนตัวระบุที่นำไปค้นต่อหนึ่งชนิด
 *
 * เอกสารจริงเกี่ยวข้องกับบริษัทไม่กี่แห่ง แต่รายการเดินบัญชีมีเลข 13 หลักได้เป็นร้อยชุด
 * ซึ่งเกือบทั้งหมดเป็นเลขรายการ ไม่ใช่เลขประจำตัวผู้เสียภาษี
 */
const MAX_IDENTIFIERS_PER_KIND = 5;

/**
 * ระยะห่างคะแนนขั้นต่ำที่ถือว่าตัวเลือกอันดับหนึ่งชนะขาด
 *
 * ตั้งเท่ากับน้ำหนักของสัญญาณปี เพราะกรณีที่แยกไม่ออกที่พบจริงคือโฟลเดอร์ปีต่าง ๆ
 * ของลูกค้าคนเดียวกัน ที่ต่างกันเพียงว่าปีตรงหรือไม่ตรงเท่านั้น
 */
const AMBIGUITY_MARGIN = 30;

export function confidenceOf(score: number, signals: SignalType[]): ConfidenceBand {
  // ความมั่นใจสูงต้องมาจากหลักฐานที่ตรงตัวเท่านั้น ไม่ใช่คะแนนรวมที่สะสมจากสัญญาณอ่อน
  const hasExact = signals.includes('EXACT_TAX_ID') || signals.includes('EXACT_COMPANY_NAME');
  if (hasExact && score >= 60) return 'HIGH';
  if (score >= 30) return 'MEDIUM';
  return 'LOW';
}

export interface FilingEvidence {
  resourceId: string;
  resourceVersionId: string;
  fileName: string;
  currentParentId: string | null;
  taxIds: string[];
  companyNames: string[];
  normalizedCompanyNames: string[];
  categories: DetectedCategory[];
  /** ปีพุทธศักราชที่พบในเอกสาร ใช้เลือกโฟลเดอร์ปีให้ถูกต้อง */
  years: number[];
  /** รหัสแบบฟอร์มราชการ เช่น ภงด3 ภพ30 - ตรงกับชื่อโฟลเดอร์จริงมากกว่าป้ายหมวด */
  formCodes: string[];
  /**
   * ข้อความของเอกสารพร้อมใช้แล้วหรือยัง
   *
   * ไฟล์ที่เพิ่งอัปโหลดยังไม่ผ่านการสกัดข้อความ หลักฐานที่ได้ตอนนั้นจึงมีแค่ชื่อไฟล์
   * ผลที่ออกมาว่า "ไม่พบตำแหน่ง" ในจังหวะนั้นเป็นคนละเรื่องกับ "ค้นแล้วไม่เจอ"
   * ผู้เรียกต้องแยกสองกรณีนี้ออกจากกัน ไม่อย่างนั้นจะบอกผู้ใช้ในสิ่งที่ยังไม่ได้ตรวจ
   */
  textReady: boolean;
}

/**
 * รวบรวมหลักฐานของเอกสารที่จะจัดเก็บ
 *
 * ใช้เฉพาะเวอร์ชันปัจจุบันเท่านั้น เวอร์ชันเก่าอาจเป็นของบริษัทอื่นก่อนถูกแทนที่
 * การใช้ข้อความเก่าจะทำให้เสนอปลายทางตามข้อมูลที่ไม่มีผลแล้ว
 *
 * ลำดับความน่าเชื่อถือของข้อความเป็นไปตามที่ระบบกำหนดไว้เดิม
 * ข้อความที่คนตรวจแก้แล้วมาก่อนผล OCR เสมอ
 */
export async function collectEvidence(resourceId: string, user: AuthUser): Promise<FilingEvidence | null> {
  const resource = await prisma.resource.findFirst({
    where: { id: resourceId, type: 'FILE', deletedAt: null, ...visibilityScope(user) },
    include: resourceInclude,
  });
  if (!resource || !capabilities(resource, user).canView) return null;

  // ไฟล์ที่ยังไม่มีเวอร์ชันปัจจุบันยังจัดเก็บอัตโนมัติไม่ได้ ไม่มีเนื้อหาให้ใช้เป็นหลักฐาน
  const currentVersion = resource.currentVersion;
  if (currentVersion === null) return null;

  const index = await prisma.resourceSearchIndex.findFirst({
    where: { resourceId, versionNumber: currentVersion, status: 'READY' },
    select: { resourceVersionId: true, extractedText: true, textSource: true },
  });
  /**
   * การจัดทำดัชนีจบแล้วหรือยัง - คนละคำถามกับ "มีข้อความหรือไม่"
   *
   * ไฟล์ภาพที่สกัดข้อความไม่ได้จะจบที่ NO_TEXT หรือ UNSUPPORTED ซึ่งเป็นสถานะปลายทาง
   * เอกสารแบบนั้นยังวิเคราะห์จากชื่อไฟล์ได้ตามปกติ จึงต้องไม่ถูกกันไว้เหมือนงานที่ยังไม่เสร็จ
   */
  const settled = index ?? await prisma.resourceSearchIndex.findFirst({
    where: { resourceId, versionNumber: currentVersion, status: { in: ['NO_TEXT', 'UNSUPPORTED', 'FAILED'] } },
    select: { resourceVersionId: true },
  });
  const version = index
    ? { id: index.resourceVersionId }
    : await prisma.resourceVersion.findFirst({
        where: { resourceId, versionNumber: currentVersion }, select: { id: true } });
  if (!version) return null;

  // จำกัดความยาวข้อความที่นำมาวิเคราะห์ เอกสารยาวมากไม่ได้ทำให้ตัวระบุแม่นขึ้น
  const text = (index?.extractedText ?? '').slice(0, 40_000);
  const identity = documentIdentity({ fileName: resource.name, text });
  return {
    resourceId,
    resourceVersionId: version.id,
    fileName: resource.name,
    currentParentId: resource.parentId,
    taxIds: identity.taxIds,
    companyNames: identity.companyNames,
    normalizedCompanyNames: identity.normalizedCompanyNames,
    /**
     * หมวดจากชื่อไฟล์มาก่อนหมวดจากเนื้อหา
     *
     * วัดกับข้อมูลจริงแล้วพบว่าเนื้อหาเอกสารมีคำของหมวดอื่นปนอยู่บ่อย เช่น
     * รายการเดินบัญชีที่มีคำว่า "เงินเดือน" อยู่ในรายการโอน ทำให้ถูกจัดเป็นเอกสารเงินเดือน
     * ทั้งที่ชื่อไฟล์บอกชัดว่าเป็นกระแสรายวัน ชื่อไฟล์ที่ผู้ใช้ตั้งเองตรงกว่า
     */
    categories: detectCategories(resource.name).length > 0
      ? detectCategories(resource.name)
      : detectCategories(text.slice(0, 4000)),
    formCodes: extractFormCodes(resource.name).length > 0
      ? extractFormCodes(resource.name)
      : extractFormCodes(text.slice(0, 4000)),
    /**
     * ปีจากชื่อไฟล์มาก่อนปีจากเนื้อหา
     *
     * เนื้อหาเอกสารมีวันที่ปนอยู่หลายชุด ทั้งวันที่พิมพ์ วันครบกำหนด และวันที่อ้างอิง
     * ส่วนชื่อไฟล์ที่ผู้ใช้ตั้งเองมักระบุงวดของเอกสารตรง ๆ เช่น "เดือน 03-66"
     */
    years: extractBuddhistYears(resource.name).length > 0
      ? extractBuddhistYears(resource.name)
      : extractBuddhistYears(text.slice(0, 4000)),
    textReady: settled !== null,
  };
}

interface FolderHit { folderId: string; signal: SignalType; detail: string }

/**
 * ค้นย้อนกลับว่าเอกสารที่มีตัวระบุเดียวกันถูกเก็บไว้ที่ไหน
 *
 * จำกัดจำนวนผลลัพธ์เพราะตัวระบุที่พบบ่อยจริง ๆ จะชี้ไปยังโฟลเดอร์เดิมซ้ำ ๆ อยู่แล้ว
 * การอ่านทั้งหมดไม่ได้เพิ่มความแม่นแต่ทำให้ช้าลงอย่างเห็นได้ชัด
 */
async function hitsForIdentifier(value: string, signal: SignalType, excludeResourceId: string): Promise<FolderHit[]> {
  if (value.length < 3) return [];
  const rows = await prisma.resourceSearchIndex.findMany({
    where: {
      normalizedText: { contains: value.toLocaleLowerCase() },
      resourceId: { not: excludeResourceId },
      status: 'READY',
      resource: { deletedAt: null, type: 'FILE', parentId: { not: null } },
    },
    select: { resource: { select: { parentId: true, currentVersion: true } }, versionNumber: true },
    take: 60,
  });
  return rows
    // เอกสารที่ถูกแทนที่ด้วยเวอร์ชันใหม่แล้วไม่ใช่หลักฐานการจัดเก็บที่มีผลอยู่
    .filter((row) => row.versionNumber === row.resource.currentVersion && row.resource.parentId)
    .map((row) => ({ folderId: row.resource.parentId!, signal, detail: value }));
}

/** ค้นจากชื่อไฟล์ของเอกสารที่จัดเก็บไว้แล้ว - ข้อมูลจริงใส่ชื่อบริษัทไว้ในชื่อไฟล์บ่อยมาก */
async function hitsForFilename(companyName: string, excludeResourceId: string): Promise<FolderHit[]> {
  if (companyName.length < 3) return [];
  const rows = await prisma.resource.findMany({
    where: {
      type: 'FILE', deletedAt: null, parentId: { not: null },
      id: { not: excludeResourceId },
      normalizedName: { contains: companyName.toLocaleLowerCase() },
    },
    select: { parentId: true },
    take: 60,
  });
  return rows.map((row) => ({ folderId: row.parentId!, signal: 'COMPANY_IN_FILENAME' as const, detail: companyName }));
}

/**
 * เส้นทางที่แสดงต่อผู้ใช้
 *
 * ประกอบจากชื่อโฟลเดอร์เท่านั้น ไม่มี path บนดิสก์หรือ storage key
 * เพราะสิ่งเหล่านั้นเป็นรายละเอียดภายในที่ผู้ใช้ไม่ควรเห็นและไม่ควรรั่วออกไป
 */
async function pathLabelOf(folderId: string, cache: Map<string, string>): Promise<string> {
  const cached = cache.get(folderId);
  if (cached) return cached;
  const parts: string[] = [];
  let cursor: string | null = folderId;
  const seen = new Set<string>();
  while (cursor && parts.length < 12 && !seen.has(cursor)) {
    seen.add(cursor);
    const row: { name: string; parentId: string | null } | null = await prisma.resource.findUnique({
      where: { id: cursor }, select: { name: true, parentId: true } });
    if (!row) break;
    parts.unshift(row.name);
    cursor = row.parentId;
  }
  const label = parts.join(' / ');
  cache.set(folderId, label);
  return label;
}

/**
 * รวบรวมหลักฐานว่าตัวระบุของเอกสารนี้เคยถูกเก็บไว้ที่โฟลเดอร์ใดบ้าง
 *
 * แยกออกมาให้ชั้นจัดอันดับเรียกใช้ เพราะการค้นย้อนกลับเป็นขั้นตอนเดียวกัน
 * ไม่ว่าจะนำผลไปรวมที่ระดับลูกค้าหรือระดับโฟลเดอร์
 *
 * จำกัดจำนวนตัวระบุและค้นทีละรายการ เอกสารรายการเดินบัญชีให้เลข 13 หลักได้เป็นร้อยชุด
 * การยิงคิวรีพร้อมกันทั้งหมดทำให้ connection pool หมดและการวิเคราะห์ล้มทั้งงาน
 */
export async function collectHits(evidence: FilingEvidence): Promise<FolderHit[]> {
  const hits: FolderHit[] = [];
  for (const taxId of evidence.taxIds.slice(0, MAX_IDENTIFIERS_PER_KIND)) {
    hits.push(...await hitsForIdentifier(taxId, 'EXACT_TAX_ID', evidence.resourceId));
  }
  for (const name of evidence.normalizedCompanyNames.filter(Boolean).slice(0, MAX_IDENTIFIERS_PER_KIND)) {
    hits.push(...await hitsForIdentifier(name, 'EXACT_COMPANY_NAME', evidence.resourceId));
    hits.push(...await hitsForFilename(name, evidence.resourceId));
  }
  return hits;
}

export type { FolderHit };

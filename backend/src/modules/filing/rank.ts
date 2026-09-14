import type { AuthUser } from '../auth/auth.service.js';
import { prisma } from '../../core/prisma.js';
import { capabilities, resourceInclude } from '../resources/resource.service.js';
import { visibilityScope } from '../workspace/search.service.js';
import { extractBuddhistYears, normalizeCompanyName, normalizeFormCodeText } from './identity.js';
import { collectHits, type FilingEvidence, type SignalType } from './candidates.js';
import { clientRootOf, descendantsOf, loadClientRoots, pathLabelOf, type ClientRootMap } from './client-root.js';

/**
 * การจัดอันดับปลายทางแบบสองชั้น (F22-B ฉบับแก้)
 *
 * **เหตุที่ต้องแยกชั้น:** การจัดอันดับแบบแบนเอาโฟลเดอร์ย่อยของลูกค้าคนเดียวกัน
 * มาแข่งกันเอง ทั้งที่ทุกอันได้คะแนนจากหลักฐานชุดเดียวกัน ("ปี 2566/ประกันสังคม",
 * "ปี 2567/ประกันสังคม", "ปี 2568/ประกันสังคม" ได้คะแนนเท่ากันหมดเพราะมาจาก
 * เลขผู้เสียภาษีของลูกค้ารายเดียวกัน) ผลคือระบบเลือกปีแบบสุ่มแล้วรายงานว่ามั่นใจ
 *
 * ชั้นที่หนึ่งตอบว่า "เอกสารนี้เป็นของลูกค้ารายไหน" ซึ่งเป็นสิ่งที่หลักฐานตอบได้ดีมาก
 * ชั้นที่สองตอบว่า "ควรอยู่โฟลเดอร์ไหนของลูกค้ารายนั้น" ซึ่งใช้สัญญาณคนละชุดคือปีและประเภท
 *
 * **ความมั่นใจสองค่าแยกกัน:** ความแน่ใจว่าเป็นลูกค้ารายใด ไม่เท่ากับความแน่ใจว่าควรอยู่
 * โฟลเดอร์ย่อยไหน การยุบสองอย่างนี้เป็นค่าเดียวคือสาเหตุที่ทำให้เกิดความมั่นใจปลอม
 */

export type ConfidenceBand = 'HIGH' | 'MEDIUM' | 'LOW';

/** ระดับความละเอียดของข้อเสนอ - บอกตรง ๆ ว่าระบบรู้ลึกแค่ไหน */
export type DestinationLevel = 'CLIENT_ONLY' | 'CLIENT_AND_YEAR' | 'FULL_DESTINATION';

export interface FilingReason { signal: SignalType | 'PERIOD_MATCH' | 'CATEGORY_MATCH'; label: string }

export interface ClientCandidate {
  clientRootId: string;
  clientName: string;
  pathLabel: string;
  score: number;
  confidence: ConfidenceBand;
  signals: SignalType[];
  reasons: FilingReason[];
  /** ตัวระบุที่ชี้มาที่ลูกค้ารายนี้แต่ก็ชี้ไปรายอื่นด้วย จึงไม่ยกระดับเป็นมั่นใจสูง */
  ambiguousIdentifiers: string[];
}

export interface DestinationOption {
  folderId: string;
  pathLabel: string;
  score: number;
  reasons: FilingReason[];
}

export interface FilingSuggestion {
  clients: ClientCandidate[];
  clientConfidence: ConfidenceBand | null;
  /** ปลายทางที่แนะนำ อาจเป็นเพียงโฟลเดอร์ลูกค้าเมื่อยังเลือกโฟลเดอร์ย่อยไม่ได้ */
  destinationFolderId: string | null;
  destinationPathLabel: string | null;
  destinationLevel: DestinationLevel | null;
  destinationConfidence: ConfidenceBand | null;
  /** ทางเลือกย่อยให้ผู้ใช้เลือกเอง เมื่อระบบเลือกแทนไม่ได้อย่างมั่นใจ */
  subfolderOptions: DestinationOption[];
}

const CLIENT_WEIGHTS: Record<SignalType, number> = {
  EXACT_TAX_ID: 100,
  EXACT_COMPANY_NAME: 60,
  COMPANY_IN_FILENAME: 25,
  CATEGORY_MATCH: 0,
  PERIOD_MATCH: 0,
  SIBLING_HISTORY: 8,
};

/** ต่ำกว่านี้ไม่เสนอลูกค้ารายนั้นเลย */
const MIN_CLIENT_SCORE = 20;
/** ห่างกันน้อยกว่านี้ถือว่าแยกไม่ออก ต้องไม่ยกระดับเป็นมั่นใจสูง */
const CLIENT_AMBIGUITY_MARGIN = 40;

const YEAR_WEIGHT = 40;
/** รหัสแบบฟอร์มที่ตรงกันเป็นหลักฐานปลายทางที่แข็งที่สุด เพราะโฟลเดอร์จริงตั้งชื่อด้วยรหัสนี้ */
const FORM_CODE_WEIGHT = 60;
const CATEGORY_WEIGHT = 25;
const YEAR_MISMATCH_PENALTY = 50;

/**
 * ชั้นที่หนึ่ง - เอกสารนี้เป็นของลูกค้ารายไหน
 *
 * ตัวระบุที่ชี้ไปยังลูกค้ามากกว่าหนึ่งรายถูกทำเครื่องหมายว่ากำกวมและไม่นับเป็นหลักฐาน
 * ที่ยกระดับความมั่นใจได้ เลขผู้เสียภาษีที่โผล่ในเอกสารของหลายลูกค้ามักเป็นเลขของคู่ค้า
 * หรือหน่วยงานราชการ ไม่ใช่เลขของเจ้าของเอกสาร
 */
async function rankClients(
  evidence: FilingEvidence, user: AuthUser, map: ClientRootMap,
): Promise<ClientCandidate[]> {
  const hits = await collectHits(evidence);
  if (hits.length === 0) return [];

  // ตัวระบุหนึ่งตัวชี้ไปยังรากลูกค้ารายใดบ้าง - ใช้ตัดสินความกำกวม
  const rootsPerIdentifier = new Map<string, Set<string>>();
  const perRoot = new Map<string, { signals: Map<SignalType, Set<string>> }>();

  for (const hit of hits) {
    const root = clientRootOf(hit.folderId, map);
    if (!root) continue;
    /**
     * เฉพาะเอกสารที่ถูกจัดเก็บเข้าที่แล้วเท่านั้นที่นับเป็นหลักฐาน
     *
     * เอกสารที่ยังกองอยู่ในกล่องขาเข้าหรือที่ราก ยังไม่ได้บอกอะไรเลยว่าควรเก็บที่ไหน
     * การนับมันเป็นหลักฐานทำให้ตัวระบุเดียวกันดูเหมือนอยู่หลายที่ แล้วถูกตัดสินว่ากำกวม
     * ทั้งที่ความจริงคือมันถูกจัดเก็บไว้ที่ลูกค้ารายเดียว ส่วนที่เหลือคือของที่ยังไม่ได้จัดเก็บ
     */
    if (!map.roots.has(root.id)) continue;
    const identifierRoots = rootsPerIdentifier.get(hit.detail) ?? new Set<string>();
    identifierRoots.add(root.id);
    rootsPerIdentifier.set(hit.detail, identifierRoots);

    const entry = perRoot.get(root.id) ?? { signals: new Map<SignalType, Set<string>>() };
    const values = entry.signals.get(hit.signal) ?? new Set<string>();
    values.add(hit.detail);
    entry.signals.set(hit.signal, values);
    perRoot.set(root.id, entry);
  }

  const rootIds = [...perRoot.keys()];
  const folders = await prisma.resource.findMany({
    where: { id: { in: rootIds }, type: 'FOLDER', deletedAt: null, ...visibilityScope(user) },
    include: resourceInclude,
  });

  const candidates: ClientCandidate[] = [];
  for (const folder of folders) {
    const ability = capabilities(folder, user);
    // โฟลเดอร์ที่ย้ายเข้าไม่ได้ต้องไม่ถูกเสนอ และชื่อของมันต้องไม่รั่วออกไปด้วย
    if (!ability.canView || !ability.canEdit) continue;
    const entry = perRoot.get(folder.id)!;

    let score = 0;
    const signals: SignalType[] = [];
    const reasons: FilingReason[] = [];
    const ambiguousIdentifiers: string[] = [];

    for (const [signal, values] of entry.signals) {
      const unique = [...values].filter((value) => (rootsPerIdentifier.get(value)?.size ?? 0) === 1);
      const ambiguous = [...values].filter((value) => (rootsPerIdentifier.get(value)?.size ?? 0) > 1);
      ambiguousIdentifiers.push(...ambiguous);
      if (unique.length === 0) continue;
      signals.push(signal);
      score += CLIENT_WEIGHTS[signal];
      if (signal === 'EXACT_TAX_ID') reasons.push({ signal, label: 'เอกสารที่มีเลขประจำตัวผู้เสียภาษีเดียวกันถูกเก็บไว้ในโฟลเดอร์ลูกค้ารายนี้' });
      if (signal === 'EXACT_COMPANY_NAME') reasons.push({ signal, label: 'พบชื่อบริษัทเดียวกันในเอกสารของลูกค้ารายนี้' });
      if (signal === 'COMPANY_IN_FILENAME') reasons.push({ signal, label: 'ชื่อไฟล์ของเอกสารในโฟลเดอร์ลูกค้ารายนี้มีชื่อบริษัทเดียวกัน' });
    }

    if (score < MIN_CLIENT_SCORE) continue;
    const hasUniqueExact = signals.includes('EXACT_TAX_ID') || signals.includes('EXACT_COMPANY_NAME');
    candidates.push({
      clientRootId: folder.id,
      clientName: folder.name,
      pathLabel: pathLabelOf(folder.id, map),
      score,
      confidence: hasUniqueExact && score >= 60 ? 'HIGH' : score >= 30 ? 'MEDIUM' : 'LOW',
      signals,
      reasons,
      ambiguousIdentifiers: [...new Set(ambiguousIdentifiers)],
    });
  }

  candidates.sort((a, b) => b.score - a.score || a.clientName.localeCompare(b.clientName));
  /**
   * ลูกค้าสองรายที่คะแนนใกล้กันแปลว่าแยกไม่ออกจริง ๆ
   *
   * ห้ามตัดสินด้วยลำดับจากฐานข้อมูลหรือรหัส เพราะนั่นคือการสร้างความมั่นใจปลอม
   * จากสิ่งที่ไม่ใช่หลักฐาน ผู้ใช้ต้องเห็นว่ามีมากกว่าหนึ่งความเป็นไปได้
   */
  if (candidates.length >= 2 && candidates[0]!.confidence === 'HIGH') {
    if (candidates[0]!.score - candidates[1]!.score < CLIENT_AMBIGUITY_MARGIN) candidates[0]!.confidence = 'MEDIUM';
  }
  return candidates.slice(0, 3);
}

/**
 * ชั้นที่สอง - ควรอยู่โฟลเดอร์ไหนของลูกค้ารายที่ชนะ
 *
 * พิจารณาเฉพาะโฟลเดอร์ใต้ลูกค้ารายนั้นเท่านั้น โฟลเดอร์ของลูกค้ารายอื่นไม่มีสิทธิ์
 * เข้ามาแข่งในชั้นนี้เลย แม้จะมีชื่อประเภทเอกสารตรงกันก็ตาม
 */
async function resolveDestination(
  evidence: FilingEvidence, user: AuthUser, map: ClientRootMap, clientRootId: string,
): Promise<{ options: DestinationOption[]; level: DestinationLevel; confidence: ConfidenceBand }> {
  const descendants = descendantsOf(clientRootId, map).filter((node) => node.id !== clientRootId);
  if (descendants.length === 0) {
    return { options: [], level: 'CLIENT_ONLY', confidence: 'HIGH' };
  }

  const folders = await prisma.resource.findMany({
    where: { id: { in: descendants.map((node) => node.id) }, type: 'FOLDER', deletedAt: null, ...visibilityScope(user) },
    include: resourceInclude,
  });

  const options: DestinationOption[] = [];
  for (const folder of folders) {
    const ability = capabilities(folder, user);
    if (!ability.canView || !ability.canEdit) continue;
    const label = pathLabelOf(folder.id, map);
    // เทียบเฉพาะส่วนที่อยู่ใต้รากลูกค้า ชื่อรากลูกค้าเองไม่ควรถูกนับเป็นสัญญาณซ้ำ
    const relative = label.slice(pathLabelOf(clientRootId, map).length);

    let score = 0;
    const reasons: FilingReason[] = [];
    const folderYears = extractBuddhistYears(relative);
    if (folderYears.length > 0 && evidence.years.length > 0) {
      if (folderYears.some((year) => evidence.years.includes(year))) {
        score += YEAR_WEIGHT;
        reasons.push({ signal: 'PERIOD_MATCH', label: `ปีของโฟลเดอร์ตรงกับช่วงเวลาของเอกสาร` });
      } else {
        // ปีที่ไม่ตรงเป็นหลักฐานเชิงลบที่ชัดเจน ไม่ใช่แค่ไม่มีหลักฐาน
        score -= YEAR_MISMATCH_PENALTY;
      }
    }
    /**
     * รหัสแบบฟอร์มที่ตรงกันคือหลักฐานปลายทางที่แข็งที่สุด
     *
     * โฟลเดอร์จริงตั้งชื่อด้วยรหัสแบบฟอร์ม ("ภงด.3", "ภ.พ.30") ไม่ใช่ป้ายหมวดที่อ่านง่าย
     * การเทียบด้วยป้ายหมวดจึงไม่เคยตรงกับชื่อโฟลเดอร์เลย ซึ่งเป็นสาเหตุที่ปลายทาง
     * ถูกเลือกไม่ได้สักครั้งในการวัดครั้งก่อน
     *
     * ต้องตรงถึงระดับตัวเลข "ภงด.3" กับ "ภงด.1" เป็นคนละแบบฟอร์มและคนละโฟลเดอร์จริง ๆ
     */
    const relativeCode = normalizeFormCodeText(relative);
    const formCode = evidence.formCodes.find((code) => relativeCode.includes(normalizeFormCodeText(code)));
    if (formCode) {
      score += FORM_CODE_WEIGHT;
      reasons.push({ signal: 'CATEGORY_MATCH', label: `ชื่อโฟลเดอร์ตรงกับแบบฟอร์ม "${formCode}"` });
    }
    const category = evidence.categories.find((item) => relative.includes(item.label));
    if (category) {
      score += CATEGORY_WEIGHT;
      reasons.push({ signal: 'CATEGORY_MATCH', label: `ชื่อโฟลเดอร์ตรงกับประเภทเอกสาร "${category.label}"` });
    }
    if (score > 0) options.push({ folderId: folder.id, pathLabel: label, score, reasons });
  }

  options.sort((a, b) => b.score - a.score || a.pathLabel.localeCompare(b.pathLabel));
  if (options.length === 0) return { options: [], level: 'CLIENT_ONLY', confidence: 'LOW' };

  const best = options[0]!;
  const runnerUp = options[1];
  const decisive = !runnerUp || best.score - runnerUp.score >= YEAR_WEIGHT;
  const hasYear = best.reasons.some((reason) => reason.signal === 'PERIOD_MATCH');
  const hasCategory = best.reasons.some((reason) => reason.signal === 'CATEGORY_MATCH');

  /**
   * ความมั่นใจของปลายทางต้องมาจากหลักฐานของปลายทางเอง
   *
   * ความแน่ใจว่าเป็นลูกค้ารายใดไม่ได้แปลว่ารู้ว่าควรอยู่โฟลเดอร์ย่อยไหน
   * ถ้าเลือกไม่ขาดจะไม่ยัดเยียดคำตอบ แต่คืนเป็นทางเลือกให้ผู้ใช้ตัดสินใจ
   */
  if (!decisive) {
    return { options: options.slice(0, 3), level: 'CLIENT_ONLY', confidence: 'LOW' };
  }
  if (hasYear && hasCategory) return { options: options.slice(0, 3), level: 'FULL_DESTINATION', confidence: 'HIGH' };
  if (hasYear || hasCategory) return { options: options.slice(0, 3), level: 'CLIENT_AND_YEAR', confidence: 'MEDIUM' };
  return { options: options.slice(0, 3), level: 'CLIENT_ONLY', confidence: 'LOW' };
}

/**
 * สร้างข้อเสนอการจัดเก็บแบบสองชั้น
 *
 * ไม่มีเส้นทางใดในฟังก์ชันนี้ที่ย้ายไฟล์ อ่านอย่างเดียวทั้งหมด
 */
export async function suggestFiling(
  evidence: FilingEvidence, user: AuthUser,
): Promise<FilingSuggestion> {
  const map = await loadClientRoots();
  const clients = await rankClients(evidence, user, map);
  if (clients.length === 0) {
    return { clients: [], clientConfidence: null, destinationFolderId: null, destinationPathLabel: null,
      destinationLevel: null, destinationConfidence: null, subfolderOptions: [] };
  }

  const winner = clients[0]!;
  // ลูกค้ายังแยกไม่ออกก็ยังไม่ต้องเลือกโฟลเดอร์ย่อย ให้ผู้ใช้เลือกลูกค้าก่อน
  if (winner.confidence === 'LOW') {
    return { clients, clientConfidence: winner.confidence, destinationFolderId: null, destinationPathLabel: null,
      destinationLevel: null, destinationConfidence: null, subfolderOptions: [] };
  }

  const destination = await resolveDestination(evidence, user, map, winner.clientRootId);
  const full = destination.level === 'FULL_DESTINATION' && destination.options.length > 0;
  const target = full ? destination.options[0]! : null;

  return {
    clients,
    clientConfidence: winner.confidence,
    destinationFolderId: target?.folderId ?? winner.clientRootId,
    destinationPathLabel: target?.pathLabel ?? winner.pathLabel,
    destinationLevel: target ? destination.level : 'CLIENT_ONLY',
    destinationConfidence: target ? destination.confidence : 'LOW',
    subfolderOptions: destination.options,
  };
}

export { normalizeCompanyName };

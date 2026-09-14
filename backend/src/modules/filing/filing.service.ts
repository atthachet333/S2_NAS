import type { SmartFilingConfidence, SmartFilingLevel, SmartFilingSuggestion } from '@prisma/client';
import { env } from '../../config/env.js';
import { prisma } from '../../core/prisma.js';
import { AppError, badRequest, notFound } from '../../core/errors.js';
import type { AuthUser } from '../auth/auth.service.js';
import { capabilities, moveResource, resourceInclude } from '../resources/resource.service.js';
import { visibilityScope } from '../workspace/search.service.js';
import { collectEvidence } from './candidates.js';
import { suggestFiling, type ConfidenceBand, type FilingSuggestion } from './rank.js';
import { assistRanking } from './llm-assist.js';

/**
 * วงจรชีวิตของข้อเสนอการจัดเก็บอัจฉริยะ (F22-C/D)
 *
 * **หลักการที่ห้ามละเมิด:** ไม่มีเส้นทางใดในไฟล์นี้ที่ย้ายเอกสารโดยไม่มีการยืนยันจากผู้ใช้
 * การวิเคราะห์ การอ่านข้อเสนอ และการปฏิเสธข้อเสนอ ล้วนไม่แตะตำแหน่งของเอกสารเลย
 * การย้ายเกิดขึ้นที่เดียวคือ acceptSuggestion และต้องผ่านการตรวจสิทธิ์ใหม่ทั้งชุดก่อนเสมอ
 *
 * **ไม่ไว้ใจข้อเสนอเก่า:** ปลายทางที่บันทึกไว้ในข้อเสนอเป็นเพียงสิ่งที่ "เคยถูกต้อง"
 * ตอนวิเคราะห์ สิทธิ์ ตำแหน่ง และเวอร์ชันเปลี่ยนได้ตลอดเวลาหลังจากนั้น
 * ทุกอย่างจึงถูกตรวจใหม่ทั้งหมดในจังหวะที่ผู้ใช้กดยืนยัน ไม่ใช่ตอนสร้างข้อเสนอ
 *
 * **การย้ายจริงใช้บริการเดิมของระบบ** ไม่มีการเขียนตรรกะการย้ายซ้ำที่นี่
 * ข้อจำกัดทั้งหมดของการย้าย - การล็อก สิทธิ์ วงจรโฟลเดอร์ ขอบเขตไดร์ฟ การบันทึกกิจกรรม
 * จึงมีผลกับเส้นทางนี้เหมือนการย้ายด้วยมือทุกประการ
 */

/** รุ่นของเครื่องวิเคราะห์ - เปลี่ยนเมื่อกติกาการให้คะแนนเปลี่ยนจนผลเก่าใช้เทียบไม่ได้ */
export const ANALYZER_VERSION = 'f22-b1';

function assertEnabled(): void {
  if (env.S2_NAS_SMART_FILING_ENABLED !== 1) {
    throw new AppError('SMART_FILING_DISABLED', 'ยังไม่ได้เปิดใช้งานการจัดเก็บอัจฉริยะ', 503);
  }
}

const toBand = (band: ConfidenceBand | null): SmartFilingConfidence | null => band;

/** แปลงผลจากเครื่องจัดอันดับเป็นระดับที่บันทึกได้ */
function resultLevelOf(result: FilingSuggestion): SmartFilingLevel {
  if (result.clients.length === 0) return 'NO_SUGGESTION';
  // ลูกค้าหลายรายที่แยกไม่ออก ต้องให้ผู้ใช้เลือกเอง ไม่มีผู้ชนะโดยปริยาย
  if (result.clientConfidence === 'LOW' || result.clients.length > 1 && result.clientConfidence !== 'HIGH') {
    return 'AMBIGUOUS';
  }
  if (result.destinationLevel === 'FULL_DESTINATION') return 'FULL_DESTINATION';
  if (result.destinationLevel === 'CLIENT_AND_YEAR') return 'CLIENT_AND_PERIOD';
  return 'CLIENT_ONLY';
}

export interface SuggestionDto {
  suggestionId: string;
  status: string;
  resultLevel: SmartFilingLevel;
  client: { folderId: string; label: string; confidence: SmartFilingConfidence | null } | null;
  destination: { folderId: string; pathLabel: string; confidence: SmartFilingConfidence | null } | null;
  alternatives: Array<{ folderId: string; pathLabel: string }>;
  reasons: string[];
  signals: string[];
  stale: boolean;
}

/**
 * แปลงเป็นรูปแบบที่ส่งออกได้
 *
 * ไม่ส่งคะแนนดิบออกไป คะแนนเป็นรายละเอียดภายในที่เปลี่ยนได้ทุกครั้งที่ปรับน้ำหนัก
 * และตัวเลขอย่าง 112 ไม่ได้สื่อความหมายอะไรกับผู้ใช้ นอกจากทำให้ดูแม่นยำเกินจริง
 */
function toDto(row: SmartFilingSuggestion, stale: boolean): SuggestionDto {
  const reasons = Array.isArray(row.reasonJson) ? (row.reasonJson as string[]) : [];
  const signals = Array.isArray(row.signalJson) ? (row.signalJson as string[]) : [];
  /**
   * ตัวเลือกต้องอ่านกลับมาได้เหมือนตอนวิเคราะห์
   *
   * ข้อเสนอแบบกำกวมไม่มีผู้ชนะโดยปริยาย ถ้าอ่านกลับมาแล้วไม่มีตัวเลือกให้เลือก
   * ผู้ใช้จะติดอยู่กับหน้าจอที่บอกว่ามีหลายความเป็นไปได้ แต่เลือกอะไรไม่ได้เลย
   */
  const alternatives = Array.isArray(row.alternativesJson)
    ? (row.alternativesJson as Array<{ folderId: string; pathLabel: string }>)
    : [];
  return {
    suggestionId: row.id,
    status: stale && row.status === 'READY' ? 'STALE' : row.status,
    resultLevel: row.resultLevel,
    client: row.clientRootFolderId
      ? { folderId: row.clientRootFolderId, label: row.suggestedCompanyLabel ?? '', confidence: row.clientConfidence }
      : null,
    destination: row.suggestedFolderId
      ? { folderId: row.suggestedFolderId, pathLabel: row.suggestedCompanyLabel ?? '', confidence: row.destinationConfidence }
      : null,
    alternatives,
    reasons,
    signals,
    stale,
  };
}

async function audit(action: string, user: AuthUser, resourceId: string, metadata: Record<string, unknown>): Promise<void> {
  await prisma.activityLog.create({ data: { userId: user.id, action, resourceId, metadata: metadata as never } });
}

/**
 * วิเคราะห์และบันทึกข้อเสนอ
 *
 * **ไม่ย้ายอะไรทั้งสิ้น** ฟังก์ชันนี้อ่านอย่างเดียวนอกจากการเขียนแถวข้อเสนอ
 *
 * การวิเคราะห์ซ้ำสำหรับเอกสารเวอร์ชันเดิมโดยผู้ใช้คนเดิมจะเขียนทับข้อเสนอเดิม
 * แทนที่จะสร้างแถวใหม่ เพราะข้อเสนอสองอันที่ขัดแย้งกันสำหรับเอกสารฉบับเดียวกัน
 * ทำให้ตอบไม่ได้ว่าอันไหนคือของจริง ฐานข้อมูลบังคับความเป็นหนึ่งเดียวนี้ด้วย unique index
 */
export async function analyzeResource(resourceId: string, user: AuthUser): Promise<SuggestionDto> {
  assertEnabled();
  const started = Date.now();

  const evidence = await collectEvidence(resourceId, user);
  if (!evidence) throw notFound('RESOURCE_NOT_FOUND', 'ไม่พบเอกสารหรือไม่มีสิทธิ์เข้าถึง');

  /**
   * ยังสกัดข้อความไม่เสร็จ ก็ยังไม่ใช่เวลาที่จะสรุปอะไร
   *
   * ไฟล์ที่เพิ่งอัปโหลดจะถูกวิเคราะห์ทันทีจากหน้าจอ ซึ่งเร็วกว่าที่ตัวจัดทำดัชนีทำงานเสร็จ
   * ถ้าปล่อยให้วิเคราะห์ต่อ หลักฐานจะมีแค่ชื่อไฟล์ แล้วได้ผลว่า "ไม่พบตำแหน่งที่เหมาะสม"
   * ซึ่งเป็นคำตอบที่ไม่จริง - ระบบยังไม่ได้อ่านเอกสารเลยด้วยซ้ำ และที่แย่กว่านั้นคือ
   * ผลนั้นจะถูกบันทึกทับข้อเสนอเดิม ทำให้คำตอบผิดค้างอยู่จนกว่าจะมีใครกดวิเคราะห์ใหม่
   */
  if (!evidence.textReady) {
    throw new AppError('SMART_FILING_TEXT_NOT_READY', 'ยังเตรียมข้อความของเอกสารไม่เสร็จ กรุณาลองอีกครั้งในอีกสักครู่', 409);
  }

  let result: FilingSuggestion;
  try {
    result = await suggestFiling(evidence, user);
  } catch (error) {
    /**
     * ความล้มเหลวของการวิเคราะห์ต้องไม่ลามไปกระทบงานหลัก
     *
     * บันทึกไว้เป็นข้อเสนอที่ล้มเหลวเพื่อให้ตรวจสอบย้อนหลังได้ แล้วแจ้งผู้ใช้ตามจริง
     * เอกสารยังอยู่ที่เดิมทุกประการ
     */
    await audit('SMART_FILING_FAILED', user, resourceId, { durationMs: Date.now() - started });
    throw new AppError('SMART_FILING_FAILED', 'วิเคราะห์ตำแหน่งจัดเก็บไม่สำเร็จ', 500, {
      cause: error instanceof Error ? error.message : undefined,
    });
  }

  /**
   * ให้โมเดลช่วยจัดลำดับเฉพาะเมื่อกติกาแน่นอนยังตัดสินไม่ได้
   *
   * ผลที่ได้คือชุดผู้สมัครเดิมที่อาจสลับลำดับ ไม่มีผู้สมัครใหม่และไม่มีใครหายไป
   * ความล้มเหลวทุกชนิดถอยกลับมาใช้ลำดับเดิมเงียบ ๆ ผู้ใช้ยังได้ข้อเสนอเสมอ
   */
  const assist = await assistRanking(result, {
    fileName: evidence.fileName,
    categories: evidence.categories.map((category) => category.label),
    years: evidence.years,
  });
  if (assist.applied) result = { ...result, clients: assist.clients };

  const level = resultLevelOf(result);
  /**
   * ตัวเลือกที่บันทึกไว้
   *
   * กรณีกำกวมเก็บรายชื่อลูกค้าที่แข่งกัน กรณีอื่นเก็บโฟลเดอร์ย่อยที่เป็นไปได้
   * ทั้งสองชุดผ่านการตรวจสิทธิ์มาแล้วจากชั้นจัดอันดับ
   */
  const alternatives = resultLevelOf(result) === 'AMBIGUOUS'
    ? result.clients.map((client) => ({ folderId: client.clientRootId, pathLabel: client.pathLabel }))
    : result.subfolderOptions.map((option) => ({ folderId: option.folderId, pathLabel: option.pathLabel }));
  const winner = result.clients[0] ?? null;
  const reasons = (winner?.reasons ?? []).map((reason) => reason.label);
  const signals = winner?.signals ?? [];

  const row = await prisma.smartFilingSuggestion.upsert({
    where: {
      resourceId_resourceVersionId_analyzedById: {
        resourceId, resourceVersionId: evidence.resourceVersionId, analyzedById: user.id,
      },
    },
    create: {
      resourceId,
      resourceVersionId: evidence.resourceVersionId,
      analyzedById: user.id,
      status: 'READY',
      resultLevel: level,
      clientRootFolderId: winner?.clientRootId ?? null,
      suggestedFolderId: level === 'AMBIGUOUS' || level === 'NO_SUGGESTION' ? null : result.destinationFolderId,
      clientConfidence: toBand(result.clientConfidence),
      destinationConfidence: toBand(result.destinationConfidence),
      suggestedCompanyLabel: result.destinationPathLabel?.slice(0, 191) ?? winner?.pathLabel.slice(0, 191) ?? null,
      suggestedCategory: evidence.categories[0]?.code ?? null,
      suggestedYear: evidence.years[0] ?? null,
      reasonJson: reasons,
      signalJson: signals,
      alternativesJson: alternatives,
      analyzerVersion: ANALYZER_VERSION,
    },
    update: {
      status: 'READY',
      resultLevel: level,
      clientRootFolderId: winner?.clientRootId ?? null,
      suggestedFolderId: level === 'AMBIGUOUS' || level === 'NO_SUGGESTION' ? null : result.destinationFolderId,
      clientConfidence: toBand(result.clientConfidence),
      destinationConfidence: toBand(result.destinationConfidence),
      suggestedCompanyLabel: result.destinationPathLabel?.slice(0, 191) ?? winner?.pathLabel.slice(0, 191) ?? null,
      suggestedCategory: evidence.categories[0]?.code ?? null,
      suggestedYear: evidence.years[0] ?? null,
      reasonJson: reasons,
      signalJson: signals,
      alternativesJson: alternatives,
      analyzerVersion: ANALYZER_VERSION,
      acceptedAt: null, dismissedAt: null, staleAt: null, failureCode: null,
    },
  });

  await audit('SMART_FILING_ANALYZED', user, resourceId, {
    suggestionId: row.id, resultLevel: level,
    clientConfidence: result.clientConfidence, destinationConfidence: result.destinationConfidence,
    signalTypes: signals, durationMs: Date.now() - started,
    llmInvoked: assist.invoked, llmApplied: assist.applied,
  });

  return toDto(row, false);
}

/**
 * ตรวจว่าข้อเสนอยังใช้ได้อยู่หรือไม่
 *
 * ตรวจทุกอย่างที่เปลี่ยนแล้วทำให้ข้อเสนอไม่มีความหมาย ไม่ใช่แค่เวอร์ชัน
 * เอกสารที่ถูกย้ายด้วยมือไปแล้ว ข้อเสนอเดิมก็ไม่ตรงกับเจตนาปัจจุบันของผู้ใช้อีกต่อไป
 */
async function stalenessOf(row: SmartFilingSuggestion, user: AuthUser): Promise<string | null> {
  const resource = await prisma.resource.findFirst({
    where: { id: row.resourceId, deletedAt: null, ...visibilityScope(user) },
    include: resourceInclude,
  });
  if (!resource) return 'RESOURCE_UNAVAILABLE';
  if (!capabilities(resource, user).canView) return 'RESOURCE_UNAVAILABLE';

  const currentVersion = await prisma.resourceVersion.findFirst({
    where: { resourceId: row.resourceId, versionNumber: resource.currentVersion ?? -1 },
    select: { id: true },
  });
  if (!currentVersion || currentVersion.id !== row.resourceVersionId) return 'VERSION_CHANGED';
  // เอกสารถูกย้ายไปอยู่ปลายทางที่เสนอแล้ว ข้อเสนอจึงไม่มีอะไรให้ทำอีก
  if (row.suggestedFolderId && resource.parentId === row.suggestedFolderId) return 'ALREADY_THERE';
  return null;
}

export async function currentSuggestion(resourceId: string, user: AuthUser): Promise<SuggestionDto | null> {
  assertEnabled();
  const row = await prisma.smartFilingSuggestion.findFirst({
    where: { resourceId, analyzedById: user.id },
    orderBy: { createdAt: 'desc' },
  });
  if (!row) return null;
  const stale = await stalenessOf(row, user);
  return toDto(row, stale !== null);
}

/** ปฏิเสธข้อเสนอ - เอกสารต้องอยู่ที่เดิมทุกประการ */
export async function dismissSuggestion(resourceId: string, suggestionId: string, user: AuthUser): Promise<{ dismissed: true }> {
  assertEnabled();
  const row = await prisma.smartFilingSuggestion.findFirst({ where: { id: suggestionId, analyzedById: user.id } });
  if (!row) throw notFound('SMART_FILING_SUGGESTION_NOT_FOUND', 'ไม่พบข้อเสนอการจัดเก็บ');
  // ข้อเสนอของเอกสารอื่นต้องใช้กับเอกสารนี้ไม่ได้ แม้ผู้ใช้จะเป็นเจ้าของข้อเสนอนั้น
  if (row.resourceId !== resourceId) throw badRequest('SMART_FILING_SUGGESTION_MISMATCH', 'ข้อเสนอนี้ไม่ได้เป็นของเอกสารที่ระบุ');

  await prisma.smartFilingSuggestion.update({
    where: { id: row.id }, data: { status: 'DISMISSED', dismissedAt: new Date() },
  });
  await audit('SMART_FILING_DISMISSED', user, resourceId, { suggestionId: row.id, resultLevel: row.resultLevel });
  return { dismissed: true };
}

export interface AcceptInput {
  suggestionId: string;
  /** ปลายทางที่ผู้ใช้เลือกเอง - จำเป็นเมื่อระบบเลือกให้ไม่ได้อย่างมั่นใจ */
  targetFolderId?: string;
}

/**
 * ยืนยันย้ายตามข้อเสนอ - จุดเดียวในระบบนี้ที่เอกสารเคลื่อนที่
 *
 * ตรวจใหม่ทั้งหมดก่อนเรียกบริการย้ายจริง ไม่มีการใช้สถานะสิทธิ์ที่ติดมากับข้อเสนอเลย
 * เพราะระหว่างที่ข้อเสนอรออยู่ สิทธิ์อาจถูกเพิกถอน โฟลเดอร์อาจถูกลบ และเอกสาร
 * อาจถูกอัปโหลดเวอร์ชันใหม่ที่เป็นของบริษัทคนละรายกันเลย
 */
export async function acceptSuggestion(
  resourceId: string, input: AcceptInput, user: AuthUser,
  auditContext: { ipAddress?: string; userAgent?: string },
): Promise<{ moved: true; folderId: string }> {
  assertEnabled();

  const row = await prisma.smartFilingSuggestion.findFirst({ where: { id: input.suggestionId, analyzedById: user.id } });
  if (!row) throw notFound('SMART_FILING_SUGGESTION_NOT_FOUND', 'ไม่พบข้อเสนอการจัดเก็บ');
  if (row.resourceId !== resourceId) throw badRequest('SMART_FILING_SUGGESTION_MISMATCH', 'ข้อเสนอนี้ไม่ได้เป็นของเอกสารที่ระบุ');
  if (row.status !== 'READY') throw badRequest('SMART_FILING_SUGGESTION_NOT_READY', 'ข้อเสนอนี้ถูกใช้หรือยกเลิกไปแล้ว');

  const stale = await stalenessOf(row, user);
  if (stale) {
    await prisma.smartFilingSuggestion.update({ where: { id: row.id }, data: { status: 'STALE', staleAt: new Date(), failureCode: stale } });
    await audit('SMART_FILING_STALE', user, resourceId, { suggestionId: row.id, reason: stale });
    throw new AppError('SMART_FILING_SUGGESTION_STALE', 'ข้อมูลเอกสารเปลี่ยนไปแล้ว กรุณาวิเคราะห์ใหม่', 409, { reason: stale });
  }

  /**
   * ปลายทางต้องเป็นสิ่งที่ผู้ใช้ยืนยันจริง ๆ
   *
   * เมื่อระบบรู้แค่ระดับลูกค้า ห้ามขยายเป็นโฟลเดอร์ย่อยที่ลึกกว่าเองเด็ดขาด
   * และเมื่อผลกำกวม ต้องมีการเลือกจากผู้ใช้เสมอ ไม่มีผู้ชนะโดยปริยาย
   */
  const target = input.targetFolderId ?? row.suggestedFolderId;
  if (!target) throw badRequest('SMART_FILING_TARGET_REQUIRED', 'ต้องเลือกโฟลเดอร์ปลายทางก่อนยืนยัน');
  if (row.resultLevel === 'AMBIGUOUS' && !input.targetFolderId) {
    throw badRequest('SMART_FILING_TARGET_REQUIRED', 'ข้อเสนอนี้มีหลายความเป็นไปได้ ต้องเลือกปลายทางเอง');
  }

  // ตรวจปลายทางสดใหม่ ไม่ใช้ค่าที่ติดมากับข้อเสนอ
  const folder = await prisma.resource.findFirst({
    where: { id: target, type: 'FOLDER', deletedAt: null, ...visibilityScope(user) },
    include: resourceInclude,
  });
  if (!folder) throw notFound('FOLDER_NOT_FOUND', 'ไม่พบโฟลเดอร์ปลายทางหรือไม่มีสิทธิ์เข้าถึง');
  if (!capabilities(folder, user).canEdit) {
    throw new AppError('RESOURCE_ACCESS_DENIED', 'ไม่มีสิทธิ์ย้ายเข้าโฟลเดอร์ปลายทาง', 403);
  }

  /**
   * การย้ายจริงใช้บริการเดิมของระบบ
   *
   * ตรงนี้ไม่ได้ตรวจสิทธิ์ซ้ำเพื่อความสบายใจ แต่เพราะ moveResource ตรวจเองอีกชั้น
   * ทั้งการล็อก วงจรโฟลเดอร์ ขอบเขตไดร์ฟ และบันทึกกิจกรรม RESOURCE_MOVED ให้ด้วย
   * การเขียนตรรกะย้ายเองที่นี่จะทำให้ข้อจำกัดสองชุดค่อย ๆ แยกจากกันเมื่อเวลาผ่านไป
   */
  await moveResource(resourceId, user, target, auditContext);

  /**
   * ทำเครื่องหมายว่าใช้แล้วแบบมีเงื่อนไข
   *
   * เงื่อนไข status READY ทำให้การกดยืนยันพร้อมกันสองครั้งมีเพียงครั้งเดียวที่บันทึกผล
   * อีกครั้งจะได้ผลกระทบศูนย์แถว และไม่เกิดบันทึกกิจกรรมซ้ำ
   */
  const claimed = await prisma.smartFilingSuggestion.updateMany({
    where: { id: row.id, status: 'READY' },
    data: { status: 'ACCEPTED', acceptedAt: new Date(), suggestedFolderId: target },
  });
  if (claimed.count > 0) {
    await audit('SMART_FILING_ACCEPTED', user, resourceId, {
      suggestionId: row.id, targetFolderId: target, resultLevel: row.resultLevel,
      clientConfidence: row.clientConfidence, destinationConfidence: row.destinationConfidence,
    });
  }
  return { moved: true, folderId: target };
}

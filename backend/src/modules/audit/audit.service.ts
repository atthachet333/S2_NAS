/**
 * การสืบค้นบันทึกกิจกรรมเพื่อการตรวจสอบ
 *
 * เป็นเครื่องมือของผู้ตรวจสอบ ไม่ใช่ไทม์ไลน์ของผู้ใช้ทั่วไป
 *
 * หลักสามข้อ:
 *
 *   1. **อ่านอย่างเดียว** ไม่มีเส้นทางแก้หรือลบบันทึกในชั้นบริการนี้เลย
 *      บันทึกที่แก้ได้ไม่ใช่หลักฐาน และผู้ตรวจสอบจะเชื่อถือไม่ได้ทั้งระบบ
 *
 *   2. **กรองที่ฐานข้อมูล** ไม่ดึงทั้งหมดมากรองในหน่วยความจำ
 *      ตารางนี้โตขึ้นทุกวันและไม่มีวันเล็กลง
 *
 *   3. **ไม่ส่ง metadata ดิบออกไป** ทุกฟิลด์ที่ออกจากที่นี่ผ่านบัญชีอนุญาต
 *      ของเหตุการณ์นั้น ๆ การส่ง JSON ทั้งก้อนคือการหวังว่าไม่มีใครเคยเผลอ
 *      ใส่ความลับลงไป ซึ่งเป็นการหวังที่ผิดเสมอเมื่อเวลาผ่านไปนานพอ
 */
import type { Prisma } from '@prisma/client';
import { prisma } from '../../core/prisma.js';
import { AppError } from '../../core/errors.js';
import {
  EVENT_CATALOG,
  actionsInCategory,
  describeEvent,
  findPreset,
  type EventCategory,
} from './event-catalog.js';
import type { AuthUser } from '../auth/auth.service.js';

export const AUDIT_VIEW_PERMISSION = 'system:audit:view';
export const AUDIT_EXPORT_PERMISSION = 'system:audit:export';

function isAdmin(user: AuthUser): boolean {
  return user.roles.includes('SUPER_ADMIN') || user.roles.includes('ADMIN');
}

/**
 * ผู้ที่ดูบันทึกการตรวจสอบได้
 *
 * **ไม่ใช่ผู้ใช้ภายในทุกคน** บันทึกนี้รวมว่าใครเปิดดูเอกสารอะไรเมื่อไร
 * ซึ่งเป็นข้อมูลที่ใช้จับตาเพื่อนร่วมงานได้ถ้าเปิดให้ทุกคนดู
 *
 * บัญชีภายนอกและบัญชีบริการเข้าไม่ถึงเลย ไม่ว่าจะมีสิทธิ์อะไรติดมา
 */
export function canViewAudit(user: AuthUser): boolean {
  if (user.type !== 'INTERNAL') return false;
  return isAdmin(user) || user.permissions.includes(AUDIT_VIEW_PERMISSION);
}

/**
 * ผู้ที่ส่งออกได้
 *
 * แยกสิทธิ์จากการดู เพราะการส่งออกคือการนำบันทึกออกนอกระบบไปอยู่ในไฟล์
 * ที่ระบบควบคุมต่อไม่ได้ - เป็นการกระทำที่มีน้ำหนักต่างจากการเปิดดูบนหน้าจอ
 */
export function canExportAudit(user: AuthUser): boolean {
  if (user.type !== 'INTERNAL') return false;
  return isAdmin(user) || user.permissions.includes(AUDIT_EXPORT_PERMISSION);
}

export function assertCanView(user: AuthUser): void {
  if (!canViewAudit(user)) {
    throw new AppError('AUDIT_DENIED', 'ไม่มีสิทธิ์เข้าถึงบันทึกการตรวจสอบ', 403);
  }
}

export function assertCanExport(user: AuthUser): void {
  assertCanView(user);
  if (!canExportAudit(user)) {
    throw new AppError('AUDIT_EXPORT_DENIED', 'ไม่มีสิทธิ์ส่งออกบันทึกการตรวจสอบ', 403);
  }
}

/* ------------------------------------------------------------------ */
/* ตัวกรอง                                                             */
/* ------------------------------------------------------------------ */

export interface AuditFilters {
  /** ค้นข้อความในชื่อผู้ดำเนินการ อีเมล ชื่อทรัพยากร และชื่อเหตุการณ์ */
  q?: string;
  action?: string;
  category?: EventCategory;
  preset?: string;
  actorId?: string;
  /** บุคลากร ลูกค้า ระบบ หรือการเชื่อมต่อ */
  actorType?: 'INTERNAL' | 'EXTERNAL' | 'SERVICE' | 'SYSTEM' | 'INTEGRATION';
  resourceId?: string;
  from?: Date;
  to?: Date;
  /** เฉพาะเหตุการณ์ที่เป็นความล้มเหลวหรือถูกปฏิเสธ */
  failuresOnly?: boolean;
}

/**
 * เหตุการณ์ที่ถือว่าเป็นความล้มเหลวหรือถูกปฏิเสธ
 *
 * สร้างจากธง `failure` ในสารบัญโดยตรง จึงไม่มีรายชื่อสองชุดที่เพี้ยนจากกันเมื่อมีเหตุการณ์ใหม่
 *
 * ไม่ใช้ tone เป็นเกณฑ์ - tone บอกว่า "น่าตกใจแค่ไหน" ไม่ใช่ "สำเร็จหรือไม่"
 * การลบถาวรที่สำเร็จเป็น DANGER แต่ไม่ใช่ความล้มเหลว ถ้าปนมาในตัวกรองนี้
 * ผู้ตรวจสอบจะสรุปว่าระบบมีเหตุขัดข้องมากกว่าความเป็นจริง
 */
const FAILURE_ACTIONS = Object.entries(EVENT_CATALOG)
  .filter(([, definition]) => definition.failure === true)
  .map(([code]) => code);

/** แปลงตัวกรองเป็นเงื่อนไขฐานข้อมูล */
function buildWhere(filters: AuditFilters): Prisma.ActivityLogWhereInput {
  const and: Prisma.ActivityLogWhereInput[] = [];

  /* ---- ช่วงเวลา ---- */
  if (filters.from || filters.to) {
    and.push({
      createdAt: {
        ...(filters.from ? { gte: filters.from } : {}),
        ...(filters.to ? { lte: filters.to } : {}),
      },
    });
  }

  /* ---- เหตุการณ์ ---- */
  if (filters.action) and.push({ action: filters.action });

  if (filters.category) {
    const actions = actionsInCategory(filters.category);
    and.push(actions.length > 0 ? { action: { in: actions } } : { action: { in: [] } });
  }

  if (filters.preset) {
    const preset = findPreset(filters.preset);
    // ชุด "ทั้งหมด" ไม่มีรายชื่อ จึงไม่เพิ่มเงื่อนไข
    if (preset && preset.actions.length > 0) and.push({ action: { in: preset.actions } });
  }

  if (filters.failuresOnly) {
    and.push({ action: { in: FAILURE_ACTIONS } });
  }

  /* ---- ผู้ดำเนินการ ---- */
  if (filters.actorId) and.push({ userId: filters.actorId });

  if (filters.actorType) {
    if (filters.actorType === 'SYSTEM') {
      // ระบบเป็นผู้ลงมือ = ไม่มีผู้ใช้และไม่มีแอปเชื่อมต่อ
      and.push({ userId: null, integrationAppId: null });
    } else if (filters.actorType === 'INTEGRATION') {
      and.push({ integrationAppId: { not: null } });
    } else {
      and.push({ user: { type: filters.actorType } });
    }
  }

  /* ---- ทรัพยากร ---- */
  if (filters.resourceId) and.push({ resourceId: filters.resourceId });

  /* ---- ค้นข้อความ ---- */
  if (filters.q) {
    const term = filters.q.trim().slice(0, 191);
    if (term) {
      /**
       * ค้นได้เฉพาะข้อความที่ปลอดภัย: ชื่อ/อีเมลของผู้ดำเนินการ รหัสเหตุการณ์
       * และชื่อเหตุการณ์ภาษาไทย
       *
       * **ไม่ค้นใน metadata** เพราะที่นั่นเป็น JSON อิสระซึ่งไม่มีใครรับประกันได้ว่า
       * ข้างในมีอะไร การเปิดให้ค้นเท่ากับเปิดให้ดึงสิ่งที่ไม่ตั้งใจเปิดเผยออกมา
       */
      const matchedActions = Object.entries(EVENT_CATALOG)
        .filter(
          ([code, definition]) =>
            code.toLowerCase().includes(term.toLowerCase()) || definition.label.includes(term),
        )
        .map(([code]) => code);

      and.push({
        OR: [
          { action: { contains: term } },
          ...(matchedActions.length > 0 ? [{ action: { in: matchedActions } }] : []),
          { user: { displayName: { contains: term } } },
          { user: { email: { contains: term } } },
        ],
      });
    }
  }

  return and.length > 0 ? { AND: and } : {};
}

/* ------------------------------------------------------------------ */
/* การอ่านบันทึก                                                        */
/* ------------------------------------------------------------------ */

export interface AuditActor {
  id: string | null;
  displayName: string;
  email: string | null;
  type: 'INTERNAL' | 'EXTERNAL' | 'SERVICE' | 'SYSTEM' | 'INTEGRATION';
}

export interface AuditResourceRef {
  id: string;
  /** null เมื่อทรัพยากรถูกลบไปแล้ว - หน้าจอแสดงว่า "ทรัพยากรถูกลบแล้ว" */
  name: string | null;
  type: string | null;
  deleted: boolean;
}

export interface AuditEventDto {
  id: string;
  createdAt: Date;
  action: string;
  label: string;
  category: EventCategory;
  tone: string;
  actor: AuditActor;
  resource: AuditResourceRef | null;
  ipAddress: string | null;
  /** สรุปให้อ่านง่าย เช่น "Chrome / Windows" */
  userAgent: string | null;
  /** เฉพาะฟิลด์ที่ผ่านบัญชีอนุญาตของเหตุการณ์นั้น */
  details: Record<string, string | number | boolean>;
}

export interface AuditPage {
  items: AuditEventDto[];
  nextCursor: string | null;
  /** มีต่อหรือไม่ - ไม่นับยอดรวมทั้งตารางทุกครั้ง เพราะแพงและไม่จำเป็น */
  hasMore: boolean;
}

const eventInclude = {
  user: { select: { id: true, displayName: true, email: true, type: true } },
  integrationApp: { select: { id: true, name: true, code: true } },
} as const;

/**
 * รายการเหตุการณ์
 *
 * ใช้ cursor ไม่ใช่ offset - ตารางนี้มีของใหม่เข้ามาตลอดเวลา การใช้ offset
 * จะทำให้ผู้ตรวจสอบเห็นแถวเดิมซ้ำหรือข้ามแถวไปโดยไม่รู้ตัวขณะเลื่อนหน้า
 */
export async function searchAuditEvents(
  user: AuthUser,
  filters: AuditFilters,
  options: { limit?: number; cursor?: string } = {},
): Promise<AuditPage> {
  assertCanView(user);

  const limit = Math.min(Math.max(options.limit ?? 50, 1), 100);
  const where = buildWhere(filters);

  const rows = await prisma.activityLog.findMany({
    where,
    include: eventInclude,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    ...(options.cursor ? { cursor: { id: options.cursor }, skip: 1 } : {}),
  });

  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const items = await toDtos(page);

  return {
    items,
    nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
    hasMore,
  };
}

/** เหตุการณ์เดียว - ใช้เปิดรายละเอียด */
export async function getAuditEvent(id: string, user: AuthUser): Promise<AuditEventDto> {
  assertCanView(user);
  const row = await prisma.activityLog.findUnique({ where: { id }, include: eventInclude });
  if (!row) throw new AppError('AUDIT_EVENT_NOT_FOUND', 'ไม่พบบันทึกกิจกรรมนี้', 404);
  const [dto] = await toDtos([row]);
  // toDtos คืนหนึ่งรายการต่อหนึ่งแถวเสมอ แต่ TypeScript ไม่รู้ จึงกันไว้ให้ชัด
  if (!dto) throw new AppError('AUDIT_EVENT_NOT_FOUND', 'ไม่พบบันทึกกิจกรรมนี้', 404);
  return dto;
}

type EventRow = Prisma.ActivityLogGetPayload<{ include: typeof eventInclude }>;

/**
 * แปลงแถวเป็น DTO พร้อมเติมชื่อทรัพยากร
 *
 * ดึงชื่อทรัพยากรของทั้งหน้าในคำสั่งเดียว ไม่ใช่ถามทีละแถว
 * ห้าสิบแถว = ห้าสิบคำสั่ง คือสิ่งที่จะช้าลงเรื่อย ๆ จนไม่มีใครใช้หน้านี้
 */
async function toDtos(rows: EventRow[]): Promise<AuditEventDto[]> {
  const resourceIds = [...new Set(rows.map((row) => row.resourceId).filter((id): id is string => !!id))];

  const resources =
    resourceIds.length > 0
      ? await prisma.resource.findMany({
          where: { id: { in: resourceIds } },
          select: { id: true, name: true, type: true },
        })
      : [];
  const byId = new Map(resources.map((row) => [row.id, row]));

  return rows.map((row) => {
    const definition = describeEvent(row.action);
    return {
      id: row.id,
      createdAt: row.createdAt,
      action: row.action,
      label: definition.label,
      category: definition.category,
      tone: definition.tone ?? 'NEUTRAL',
      actor: describeActor(row),
      resource: describeResource(row.resourceId, byId),
      ipAddress: row.ipAddress,
      userAgent: summarizeUserAgent(row.userAgent),
      details: safeDetails(row.action, row.metadata),
    };
  });
}

/**
 * ผู้ดำเนินการ
 *
 * เหตุการณ์ที่ไม่มีผู้ใช้ไม่ใช่ช่องว่าง - มันคือ "ระบบ" ซึ่งเป็นคำตอบที่มีความหมาย
 * เช่น งานเก็บกวาดถังขยะหรือการสำรองตามกำหนดเวลา ที่ไม่มีคนกดปุ่ม
 */
function describeActor(row: EventRow): AuditActor {
  if (row.integrationApp) {
    return {
      id: row.integrationApp.id,
      displayName: row.integrationApp.name,
      email: null,
      type: 'INTEGRATION',
    };
  }
  if (row.user) {
    return {
      id: row.user.id,
      displayName: row.user.displayName,
      email: row.user.email,
      type: row.user.type as AuditActor['type'],
    };
  }
  return { id: null, displayName: 'ระบบ', email: null, type: 'SYSTEM' };
}

function describeResource(
  resourceId: string | null,
  byId: Map<string, { id: string; name: string; type: string }>,
): AuditResourceRef | null {
  if (!resourceId) return null;
  const found = byId.get(resourceId);
  if (!found) {
    /**
     * ทรัพยากรถูกลบไปแล้ว - เหตุการณ์ยังมีความหมายและต้องแสดงต่อไป
     * ประวัติที่หายไปพร้อมของที่ถูกลบ คือประวัติที่ใช้ตรวจสอบไม่ได้
     */
    return { id: resourceId, name: null, type: null, deleted: true };
  }
  return { id: found.id, name: found.name, type: found.type, deleted: false };
}

/* ------------------------------------------------------------------ */
/* การกรอง metadata                                                     */
/* ------------------------------------------------------------------ */

/**
 * บัญชีอนุญาตของ metadata แยกตามเหตุการณ์
 *
 * **ไม่ส่ง metadata ดิบออกไปเด็ดขาด** ต่อให้วันนี้ทุกเหตุการณ์สะอาด
 * วันหนึ่งจะมีคนเพิ่มฟิลด์ใหม่ที่มีข้อมูลอ่อนไหวโดยไม่ได้ตั้งใจ และไม่มีใครสังเกต
 * จนกว่ามันจะไปโผล่ในไฟล์ส่งออกที่ส่งให้คนนอก
 *
 * ฟิลด์ที่ไม่อยู่ในบัญชีถูกทิ้งเงียบ ๆ - ไม่ใช่ความผิดพลาด แต่เป็นค่าเริ่มต้นที่ปลอดภัย
 */
const DETAIL_ALLOWLIST: Record<string, string[]> = {
  RESOURCE_OWNER_CHANGED: ['newOwnerId', 'previousOwnerId', 'batchId'],
  BULK_OWNER_CHANGED: ['newOwnerId', 'succeeded', 'skipped', 'failed', 'batchId'],
  BULK_TAG_ADDED: ['tagName', 'succeeded', 'skipped', 'failed', 'batchId'],
  BULK_TAG_REMOVED: ['tagId', 'succeeded', 'skipped', 'failed', 'batchId'],
  BULK_CATEGORY_SET: ['documentCategoryId', 'succeeded', 'skipped', 'failed', 'batchId'],
  RESOURCE_TAG_ADDED: ['tagName', 'tagId'],
  RESOURCE_TAG_REMOVED: ['tagId'],
  RESOURCE_MOVED: ['fromParentId', 'toParentId'],
  RESOURCE_DRIVE_CHANGED: ['fromDrive', 'toDrive'],
  RESOURCE_LOCKED: ['reason'],
  USER_ROLE_CHANGED: ['roles', 'previousRoles'],
  USER_ACTIVATED: ['status'],
  USER_DISABLED: ['status'],
  GOOGLE_LOGIN_FAILED: ['reason'],
  GOOGLE_IDENTITY_CONFLICT: ['reason'],
  /* ---- OCR: จำนวนเท่านั้น ไม่มีตัวข้อความ ---- */
  OCR_CORRECTION_CREATED: ['correctionRevision', 'characterCount', 'truncated'],
  OCR_CORRECTION_UPDATED: ['correctionRevision', 'characterCount', 'truncated'],
  /* ---- การกำกับดูแล: ไม่มีเหตุผลของ Legal Hold ---- */
  RETENTION_POLICY_ASSIGNED: ['policyId', 'retentionUntil', 'retainForever', 'source', 'bulk'],
  RETENTION_POLICY_CHANGED: ['policyId', 'retentionUntil', 'retainForever'],
  RETENTION_POLICY_UPDATED: ['policyId', 'reapplied'],
  LEGAL_HOLD_CREATED: ['legalHoldId'],
  LEGAL_HOLD_RELEASED: ['legalHoldId'],
  PERMANENT_DELETE_BLOCKED_RETENTION: ['blockedBy', 'retentionUntil'],
  PERMANENT_DELETE_BLOCKED_HOLD: ['blockedBy'],
  /* ---- สำรองและกู้คืน ---- */
  BACKUP_CREATED: ['backupId', 'fileCount', 'totalBytes', 'durationMs', 'trigger'],
  BACKUP_FAILED: ['backupId', 'errorCode'],
  BACKUP_DELETED: ['backupId'],
  BACKUP_RETENTION_DELETED: ['deleted', 'keptDays'],
  RESTORE_REHEARSAL_PASSED: ['rehearsalId', 'resourceCount', 'versionCount'],
  RESTORE_REHEARSAL_FAILED: ['rehearsalId', 'errorCode'],
  AUDIT_LOG_EXPORTED: ['rowCount', 'from', 'to', 'filterSummary', 'format'],
  SYSTEM_SETTING_UPDATED: ['key', 'previousValue', 'value'],
  SYSTEM_SETTING_RESET: ['key'],
};

/**
 * คำที่ห้ามหลุดออกไปไม่ว่าจะอยู่ในบัญชีอนุญาตหรือไม่
 *
 * เป็นชั้นป้องกันสุดท้าย เผื่อมีใครเผลอเพิ่มชื่อฟิลด์อ่อนไหวเข้าไปในบัญชีอนุญาต
 */
const FORBIDDEN_KEY = /(password|hash|token|secret|authorization|credential|storagekey|cookie|session)/i;

export function safeDetails(
  action: string,
  metadata: Prisma.JsonValue | null,
): Record<string, string | number | boolean> {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return {};

  const allowed = DETAIL_ALLOWLIST[action] ?? [];
  const source = metadata as Record<string, unknown>;
  const result: Record<string, string | number | boolean> = {};

  for (const key of allowed) {
    if (FORBIDDEN_KEY.test(key)) continue;
    const value = source[key];
    if (value === undefined || value === null) continue;

    if (typeof value === 'string') {
      // จำกัดความยาวเพื่อไม่ให้ metadata ก้อนใหญ่ทำให้หน้าจอหรือไฟล์ส่งออกบวม
      result[key] = value.slice(0, 300);
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      result[key] = value;
    } else if (Array.isArray(value)) {
      result[key] = value.map((item) => String(item)).join(', ').slice(0, 300);
    }
  }

  return result;
}

/* ------------------------------------------------------------------ */
/* User agent                                                          */
/* ------------------------------------------------------------------ */

/**
 * สรุป user agent ให้อ่านออก
 *
 * ทำเองด้วยการจับคู่ข้อความสั้น ๆ ไม่เพิ่มไลบรารีวิเคราะห์ UA เข้ามา
 * สิ่งที่ต้องตอบคือ "เบราว์เซอร์อะไร ระบบปฏิบัติการอะไร" ไม่ใช่การจำแนกรุ่นย่อย
 */
export function summarizeUserAgent(value: string | null): string | null {
  if (!value) return null;

  const browser =
    /Edg\//.test(value) ? 'Edge'
    : /OPR\//.test(value) ? 'Opera'
    : /Chrome\//.test(value) ? 'Chrome'
    : /Safari\//.test(value) && !/Chrome/.test(value) ? 'Safari'
    : /Firefox\//.test(value) ? 'Firefox'
    : null;

  const os =
    /Windows NT/.test(value) ? 'Windows'
    : /Mac OS X|Macintosh/.test(value) ? 'macOS'
    : /Android/.test(value) ? 'Android'
    : /iPhone|iPad|iOS/.test(value) ? 'iOS'
    : /Linux/.test(value) ? 'Linux'
    : null;

  if (browser && os) return `${browser} / ${os}`;
  if (browser) return browser;
  if (os) return os;
  // ไม่ใช่เบราว์เซอร์ที่รู้จัก เช่นการเรียกจากสคริปต์ - บอกตามจริงแบบสั้น
  return value.slice(0, 60);
}

/* ------------------------------------------------------------------ */
/* ไทม์ไลน์ของทรัพยากร                                                  */
/* ------------------------------------------------------------------ */

/**
 * ประวัติของทรัพยากรหนึ่งชิ้น
 *
 * ใช้ตารางเดิมและตัวกรองเดิม ไม่มีการทำสำเนาบันทึกลงตารางที่สอง
 * สำเนาที่สองจะเพี้ยนจากต้นฉบับในวันที่มีคนเพิ่มเหตุการณ์ใหม่แล้วลืมอัปเดตทั้งสองที่
 */
export async function resourceTimeline(
  resourceId: string,
  user: AuthUser,
  options: { limit?: number; cursor?: string } = {},
): Promise<AuditPage> {
  return searchAuditEvents(user, { resourceId }, options);
}

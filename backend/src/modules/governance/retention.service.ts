/**
 * นโยบายการเก็บรักษาเอกสาร
 *
 * **ไม่ใช่เรื่องเดียวกับอายุของชุดสำรอง (F6)**
 *   - อายุชุดสำรอง = เก็บไฟล์สำรองของทั้งระบบไว้กี่ชุด
 *   - นโยบายการเก็บรักษา = ห้ามลบเอกสารฉบับนี้จนกว่าจะถึงเมื่อไร
 * สองอย่างนี้ตั้งค่าคนละที่และไม่มีผลต่อกัน ดู docs/DOCUMENT_RETENTION.md
 *
 * หมายเหตุสำคัญ: ระยะเวลาที่ระบบมีมาให้เป็นเพียงตัวอย่างที่แก้ไขได้
 * **ไม่ใช่คำแนะนำทางกฎหมาย และไม่รับประกันว่าสอดคล้องกับกฎหมายไทย**
 * องค์กรต้องกำหนดระยะเวลาเองตามที่ปรึกษาของตน
 */
import type { Prisma } from '@prisma/client';
import crypto from 'node:crypto';
import { prisma } from '../../core/prisma.js';
import { AppError, notFound } from '../../core/errors.js';
import { env } from '../../config/env.js';
import { capabilities, resourceInclude } from '../resources/resource.service.js';
import type { AuthUser } from '../auth/auth.service.js';

export const RETENTION_PERMISSION = 'system:retention:manage';

export function canManageRetention(user: AuthUser): boolean {
  return (
    user.roles.includes('SUPER_ADMIN') ||
    user.roles.includes('ADMIN') ||
    user.permissions.includes(RETENTION_PERMISSION)
  );
}

function assertManager(user: AuthUser): void {
  if (!canManageRetention(user)) {
    throw new AppError(
      'RETENTION_DENIED',
      'ต้องมีสิทธิ์จัดการนโยบายการเก็บรักษาจึงจะดำเนินการนี้ได้',
      403,
    );
  }
}

export interface RetentionPolicyDto {
  id: string;
  name: string;
  description: string | null;
  retentionDays: number | null;
  retainForever: boolean;
  isActive: boolean;
  sortOrder: number;
  /** จำนวนเอกสารที่ใช้นโยบายนี้ - ผู้ดูแลต้องรู้ก่อนตัดสินใจปิดหรือลบ */
  resourceCount: number;
}

const policySelect = {
  id: true,
  name: true,
  description: true,
  retentionDays: true,
  retainForever: true,
  isActive: true,
  sortOrder: true,
  _count: { select: { resources: true } },
} as const;

type PolicyRow = {
  id: string;
  name: string;
  description: string | null;
  retentionDays: number | null;
  retainForever: boolean;
  isActive: boolean;
  sortOrder: number;
  _count: { resources: number };
};

const toDto = (row: PolicyRow): RetentionPolicyDto => ({
  id: row.id,
  name: row.name,
  description: row.description,
  retentionDays: row.retentionDays,
  retainForever: row.retainForever,
  isActive: row.isActive,
  sortOrder: row.sortOrder,
  resourceCount: row._count.resources,
});

/** ผู้ใช้ภายในทุกคนเห็นรายการนโยบายได้ - ต้องเลือกได้เมื่อกำหนดให้เอกสาร */
export async function listPolicies(
  user: AuthUser,
  options: { includeInactive?: boolean } = {},
): Promise<RetentionPolicyDto[]> {
  const includeInactive = options.includeInactive === true && canManageRetention(user);
  const rows = await prisma.retentionPolicy.findMany({
    where: includeInactive ? {} : { isActive: true },
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    select: policySelect,
  });
  return rows.map(toDto);
}

export interface PolicyInput {
  name: string;
  description?: string | null;
  retentionDays?: number | null;
  retainForever?: boolean;
  sortOrder?: number;
}

function validate(input: PolicyInput): void {
  if (!input.name.trim()) {
    throw new AppError('RETENTION_NAME_REQUIRED', 'กรุณาระบุชื่อนโยบาย', 400);
  }
  /**
   * ต้องเลือกอย่างใดอย่างหนึ่ง - นโยบายที่ไม่ระบุทั้งจำนวนวันและไม่ใช่เก็บถาวร
   * จะไม่คุ้มครองอะไรเลย แต่หน้าจอจะแสดงว่ามีนโยบายอยู่ ซึ่งหลอกผู้ใช้
   */
  if (!input.retainForever && (input.retentionDays === null || input.retentionDays === undefined)) {
    throw new AppError(
      'RETENTION_PERIOD_REQUIRED',
      'กรุณาระบุจำนวนวันที่ต้องเก็บ หรือเลือกเก็บถาวร',
      400,
    );
  }
  if (input.retentionDays !== null && input.retentionDays !== undefined && input.retentionDays < 1) {
    throw new AppError('RETENTION_PERIOD_INVALID', 'จำนวนวันต้องมากกว่าศูนย์', 400);
  }
}

export async function createPolicy(user: AuthUser, input: PolicyInput): Promise<RetentionPolicyDto> {
  assertManager(user);
  validate(input);

  const row = await prisma.retentionPolicy.create({
    data: {
      name: input.name.trim(),
      description: input.description?.trim() || null,
      // เก็บถาวรไม่มีจำนวนวัน - เก็บทั้งสองค่าไว้จะทำให้ตอบไม่ได้ว่าอันไหนมีผล
      retentionDays: input.retainForever ? null : (input.retentionDays ?? null),
      retainForever: input.retainForever ?? false,
      sortOrder: input.sortOrder ?? 0,
      createdById: user.id,
    },
    select: policySelect,
  });
  return toDto(row as PolicyRow);
}

/**
 * แก้ไขนิยามของนโยบาย
 *
 * **มีผลกับการกำหนดครั้งต่อไปเท่านั้น** เอกสารที่ถูกกำหนดนโยบายนี้ไว้แล้ว
 * ยังคงวันหมดอายุเดิมที่ถูกคำนวณไว้ตอนกำหนด
 *
 * ถ้าคำนวณใหม่ทุกครั้ง การแก้ตัวเลขเดียวจะเปลี่ยนวันหมดอายุของเอกสารหลายพันฉบับ
 * พร้อมกัน และบางฉบับจะกลายเป็น "ลบได้แล้ว" ทั้งที่เมื่อวานยังห้ามลบ
 * ซึ่งเป็นผลข้างเคียงที่ไม่มีใครตั้งใจและมองไม่เห็นจนกว่าจะมีคนลบไปแล้ว
 *
 * ต้องการให้มีผลย้อนหลังจริง ๆ ให้ใช้ reapplyPolicy() ซึ่งเป็นการตัดสินใจที่ตั้งใจ
 */
export async function updatePolicy(
  id: string,
  user: AuthUser,
  input: Partial<PolicyInput> & { isActive?: boolean },
): Promise<RetentionPolicyDto> {
  assertManager(user);
  const current = await prisma.retentionPolicy.findUnique({ where: { id } });
  if (!current) throw notFound('RETENTION_POLICY_NOT_FOUND', 'ไม่พบนโยบายการเก็บรักษา');

  const merged: PolicyInput = {
    name: input.name ?? current.name,
    description: input.description !== undefined ? input.description : current.description,
    retentionDays: input.retentionDays !== undefined ? input.retentionDays : current.retentionDays,
    retainForever: input.retainForever !== undefined ? input.retainForever : current.retainForever,
  };
  validate(merged);

  const row = await prisma.retentionPolicy.update({
    where: { id },
    data: {
      name: merged.name.trim(),
      description: merged.description?.trim() || null,
      retentionDays: merged.retainForever ? null : (merged.retentionDays ?? null),
      retainForever: merged.retainForever ?? false,
      ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
      ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
    },
    select: policySelect,
  });
  return toDto(row as PolicyRow);
}

/**
 * ลบนโยบาย
 *
 * ลบได้เฉพาะนโยบายที่ไม่มีเอกสารและไม่มีประเภทเอกสารใดอ้างถึง
 * การลบทั้งที่ยังมีคนใช้จะทำให้เอกสารสูญเสียการคุ้มครองเงียบ ๆ
 */
export async function deletePolicy(id: string, user: AuthUser): Promise<{ deleted: boolean }> {
  assertManager(user);
  const row = await prisma.retentionPolicy.findUnique({
    where: { id },
    select: { id: true, _count: { select: { resources: true, categories: true } } },
  });
  if (!row) throw notFound('RETENTION_POLICY_NOT_FOUND', 'ไม่พบนโยบายการเก็บรักษา');

  if (row._count.resources > 0 || row._count.categories > 0) {
    throw new AppError(
      'RETENTION_POLICY_IN_USE',
      `นโยบายนี้ถูกใช้กับเอกสาร ${row._count.resources} รายการ และประเภทเอกสาร ${row._count.categories} รายการ กรุณาปิดการใช้งานแทนการลบ`,
      409,
    );
  }

  await prisma.retentionPolicy.delete({ where: { id } });
  return { deleted: true };
}

/* ------------------------------------------------------------------ */
/* การกำหนดนโยบายให้เอกสาร                                              */
/* ------------------------------------------------------------------ */

/**
 * คำนวณวันที่เก็บรักษาถึง
 *
 * เป็นการคำนวณครั้งเดียวตอนกำหนด ผลลัพธ์ถูกเก็บเป็นภาพนิ่งบนทรัพยากร
 */
export function computeRetentionUntil(
  policy: { retentionDays: number | null; retainForever: boolean },
  startAt: Date,
): Date | null {
  if (policy.retainForever || policy.retentionDays === null) return null;
  const until = new Date(startAt);
  until.setDate(until.getDate() + policy.retentionDays);
  return until;
}

export interface AssignInput {
  policyId: string | null;
  /** วันเริ่มนับ - ไม่ระบุ = ใช้วันที่นำเข้าระบบ */
  startAt?: Date | null;
  /** บังคับเมื่อการเปลี่ยนแปลงลดหรือถอดการคุ้มครอง */
  reason?: string | null;
}

export interface AssignResult {
  resourceId: string;
  retentionPolicyId: string | null;
  retentionUntil: Date | null;
  retentionForever: boolean;
  change: RetentionChange;
}

export type RetentionChange = 'UNCHANGED' | 'APPLIED' | 'STRENGTHENED' | 'WEAKENED' | 'CLEARED';

interface RetentionState {
  policyId: string | null;
  until: Date | null;
  forever: boolean;
}

/**
 * ลำดับความแข็งของ retention ที่มีผลจริง:
 * forever > วันที่ช้ากว่า > วันที่เร็วกว่า > ไม่มีนโยบาย
 * การถอด policy ถือว่าอ่อนลงแม้วันที่เดิมจะผ่านไปแล้ว เพราะลบร่องรอยข้อกำหนดที่ตั้งใจไว้
 */
export function compareRetention(current: RetentionState, next: RetentionState): RetentionChange {
  const currentProtected = current.policyId !== null || current.forever || current.until !== null;
  const nextProtected = next.policyId !== null || next.forever || next.until !== null;
  if (!currentProtected && !nextProtected) return 'UNCHANGED';
  if (currentProtected && !nextProtected) return 'CLEARED';
  if (!currentProtected && nextProtected) return 'APPLIED';
  if (current.forever && !next.forever) return 'WEAKENED';
  if (!current.forever && next.forever) return 'STRENGTHENED';
  if (current.forever && next.forever) {
    return current.policyId === next.policyId ? 'UNCHANGED' : 'APPLIED';
  }
  const currentMs = current.until?.getTime() ?? Number.NEGATIVE_INFINITY;
  const nextMs = next.until?.getTime() ?? Number.NEGATIVE_INFINITY;
  if (nextMs < currentMs) return 'WEAKENED';
  if (nextMs > currentMs) return 'STRENGTHENED';
  return current.policyId === next.policyId ? 'UNCHANGED' : 'APPLIED';
}

function overrideReason(user: AuthUser, change: RetentionChange, rawReason?: string | null): string | null {
  if (change !== 'WEAKENED' && change !== 'CLEARED') return null;
  if (!canManageRetention(user)) {
    throw new AppError(
      'POLICY_WEAKENING_REQUIRES_PRIVILEGE',
      'การลดหรือล้างการเก็บรักษาต้องใช้สิทธิ์จัดการนโยบาย',
      403,
    );
  }
  const reason = rawReason?.trim() ?? '';
  if (!reason) {
    throw new AppError('RETENTION_OVERRIDE_REASON_REQUIRED', 'กรุณาระบุเหตุผลของการลดการคุ้มครอง', 400);
  }
  if (reason.length > 500) {
    throw new AppError('RETENTION_OVERRIDE_REASON_TOO_LONG', 'เหตุผลยาวเกิน 500 ตัวอักษร', 400);
  }
  return reason;
}

const stateMetadata = (prefix: 'before' | 'after', state: RetentionState) => ({
  [`${prefix}PolicyId`]: state.policyId,
  [`${prefix}RetentionUntil`]: state.until?.toISOString() ?? null,
  [`${prefix}RetentionForever`]: state.forever,
});

/**
 * กำหนดนโยบายให้เอกสารหนึ่งฉบับ
 *
 * ใช้สิทธิ์แก้ไขเอกสารเป็นเกณฑ์ - การกำหนดนโยบายเป็นการจัดการเอกสาร ไม่ใช่การตั้งค่าระบบ
 * ส่วนการ "สร้างหรือแก้นิยามนโยบาย" ต้องใช้สิทธิ์ระดับผู้ดูแล ซึ่งเป็นคนละเรื่องกัน
 */
export async function assignPolicy(
  resourceId: string,
  user: AuthUser,
  input: AssignInput,
  audit: { ipAddress?: string; userAgent?: string },
): Promise<AssignResult> {
  const resource = await prisma.resource.findUnique({
    where: { id: resourceId },
    include: resourceInclude,
  });
  if (!resource || resource.deletedAt) throw notFound('RESOURCE_NOT_FOUND', 'ไม่พบทรัพยากร');
  const caps = capabilities(resource, user);
  if (!caps.canView || !caps.canEdit) {
    throw new AppError('RESOURCE_ACCESS_DENIED', 'ไม่มีสิทธิ์แก้ไขเอกสารนี้', 403);
  }

  const before: RetentionState = {
    policyId: resource.retentionPolicyId,
    until: resource.retentionUntil,
    forever: resource.retentionForever,
  };

  /* ---- ล้างนโยบายออก ---- */
  if (input.policyId === null) {
    const after: RetentionState = { policyId: null, until: null, forever: false };
    const change = compareRetention(before, after);
    const reason = overrideReason(user, change, input.reason);
    await prisma.$transaction(async (tx) => {
      const updated = await tx.resource.updateMany({
        where: { id: resourceId, updatedAt: resource.updatedAt },
        data: {
          retentionPolicyId: null,
          retentionStartAt: null,
          retentionStartBasis: null,
          retentionUntil: null,
          retentionForever: false,
          updatedById: user.id,
        },
      });
      if (updated.count !== 1) {
        throw new AppError('RETENTION_STATE_STALE', 'การเก็บรักษาเปลี่ยนระหว่างดำเนินการ กรุณาลองใหม่', 409);
      }
      await tx.activityLog.create({
        data: {
          userId: user.id,
          action: change === 'CLEARED' ? 'RETENTION_CLEARED' : 'RETENTION_APPLIED',
          resourceId,
          ipAddress: audit.ipAddress,
          userAgent: audit.userAgent?.slice(0, 500),
          metadata: { ...stateMetadata('before', before), ...stateMetadata('after', after), reason },
        },
      });
    });
    return { resourceId, retentionPolicyId: null, retentionUntil: null, retentionForever: false, change };
  }

  const policy = await prisma.retentionPolicy.findUnique({ where: { id: input.policyId } });
  if (!policy) throw notFound('RETENTION_POLICY_NOT_FOUND', 'ไม่พบนโยบายการเก็บรักษา');
  if (!policy.isActive) {
    throw new AppError('RETENTION_POLICY_INACTIVE', 'นโยบายนี้ถูกปิดการใช้งานอยู่', 409);
  }

  const startAt = input.startAt ?? resource.createdAt;
  const basis = input.startAt ? 'MANUAL' : 'CREATED_AT';
  const until = computeRetentionUntil(policy, startAt);

  const after: RetentionState = { policyId: policy.id, until, forever: policy.retainForever };
  const change = compareRetention(before, after);
  const reason = overrideReason(user, change, input.reason);
  const action =
    change === 'WEAKENED'
      ? 'RETENTION_OVERRIDE_WEAKENED'
      : change === 'STRENGTHENED'
        ? 'RETENTION_STRENGTHENED'
        : 'RETENTION_APPLIED';

  await prisma.$transaction(async (tx) => {
    const updated = await tx.resource.updateMany({
      where: { id: resourceId, updatedAt: resource.updatedAt },
      data: {
        retentionPolicyId: policy.id,
        retentionStartAt: startAt,
        retentionStartBasis: basis,
        retentionUntil: until,
        retentionForever: policy.retainForever,
        updatedById: user.id,
      },
    });
    if (updated.count !== 1) {
      throw new AppError('RETENTION_STATE_STALE', 'การเก็บรักษาเปลี่ยนระหว่างดำเนินการ กรุณาลองใหม่', 409);
    }
    await tx.activityLog.create({
      data: {
        userId: user.id,
        action,
        resourceId,
        ipAddress: audit.ipAddress,
        userAgent: audit.userAgent?.slice(0, 500),
        metadata: { ...stateMetadata('before', before), ...stateMetadata('after', after), reason },
      },
    });
  });

  return {
    resourceId,
    retentionPolicyId: policy.id,
    retentionUntil: until,
    retentionForever: policy.retainForever,
    change,
  };
}

async function logAssignment(
  action: string,
  user: AuthUser,
  resourceId: string,
  audit: { ipAddress?: string; userAgent?: string },
  metadata: Prisma.InputJsonValue,
): Promise<void> {
  await prisma.activityLog.create({
    data: {
      userId: user.id,
      action,
      resourceId,
      ipAddress: audit.ipAddress,
      userAgent: audit.userAgent?.slice(0, 500),
      metadata,
    },
  });
}

/**
 * ใช้นโยบายเริ่มต้นของประเภทเอกสาร
 *
 * เรียกตอนจัดประเภทเอกสาร - กำหนดให้เฉพาะเอกสารที่ **ยังไม่มีนโยบายของตัวเอง**
 *
 * ไม่เขียนทับนโยบายที่มีอยู่แล้วเด็ดขาด เพราะนั่นคือสิ่งที่คนตั้งใจกำหนดไว้
 * การเปลี่ยนประเภทเอกสารไม่ควรมีผลข้างเคียงเป็นการลดการคุ้มครองที่มีอยู่
 */
export async function applyCategoryDefaultPolicy(
  resourceId: string,
  categoryId: string | null,
  user: AuthUser,
  audit: { ipAddress?: string; userAgent?: string },
): Promise<{ applied: boolean }> {
  if (!categoryId) return { applied: false };

  const [resource, category] = await Promise.all([
    prisma.resource.findUnique({
      where: { id: resourceId },
      select: { id: true, retentionPolicyId: true, createdAt: true },
    }),
    prisma.documentCategory.findUnique({
      where: { id: categoryId },
      select: { defaultRetentionPolicyId: true },
    }),
  ]);

  if (!resource || !category?.defaultRetentionPolicyId) return { applied: false };
  // มีนโยบายของตัวเองอยู่แล้ว - ไม่แตะ
  if (resource.retentionPolicyId) return { applied: false };

  const policy = await prisma.retentionPolicy.findUnique({
    where: { id: category.defaultRetentionPolicyId },
  });
  if (!policy || !policy.isActive) return { applied: false };

  const until = computeRetentionUntil(policy, resource.createdAt);
  await prisma.resource.update({
    where: { id: resourceId },
    data: {
      retentionPolicyId: policy.id,
      retentionStartAt: resource.createdAt,
      retentionStartBasis: 'CREATED_AT',
      retentionUntil: until,
      retentionForever: policy.retainForever,
    },
  });

  await logAssignment('RETENTION_APPLIED', user, resourceId, audit, {
    policyId: policy.id,
    source: 'CATEGORY_DEFAULT',
  });
  return { applied: true };
}

/**
 * คำนวณวันหมดอายุใหม่ให้เอกสารที่ใช้นโยบายนี้
 *
 * เป็นการกระทำที่ **ตั้งใจ** และต้องกดเอง ไม่ใช่ผลข้างเคียงของการแก้นิยามนโยบาย
 * คืนจำนวนที่เปลี่ยนจริง เพื่อให้ผู้ดูแลเห็นว่าการกดครั้งนี้กระทบกี่ฉบับ
 */
type ReapplyStatus = 'CHANGED' | 'UNCHANGED' | 'BLOCKED' | 'PERMISSION_DENIED';

export interface RetentionReapplyPreviewItem {
  resourceId: string;
  resourceName: string | null;
  status: ReapplyStatus;
  code: string | null;
  currentPolicyId: string | null;
  resultingPolicyId: string;
  currentRetentionUntil: string | null;
  resultingRetentionUntil: string | null;
  currentRetentionForever: boolean;
  resultingRetentionForever: boolean;
  weakening: boolean;
}

export interface RetentionReapplyPreview {
  policy: { id: string; name: string; retentionDays: number | null; retainForever: boolean };
  attempted: number;
  changed: number;
  unchanged: number;
  blocked: number;
  permissionDenied: number;
  legalHoldConflicts: number;
  potentialWeakening: number;
  candidates: RetentionReapplyPreviewItem[];
  previewToken: string;
}

interface PreviewPayload {
  policyId: string;
  policyFingerprint: string;
  issuedAt: number;
  resources: Array<{ id: string; fingerprint: string }>;
}

const digest = (value: unknown) =>
  crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

function policyFingerprint(policy: { id: string; retentionDays: number | null; retainForever: boolean; updatedAt: Date }) {
  return digest([policy.id, policy.retentionDays, policy.retainForever, policy.updatedAt.toISOString()]);
}

function resourceFingerprint(resource: {
  id: string;
  updatedAt: Date;
  retentionPolicyId: string | null;
  retentionStartAt: Date | null;
  retentionUntil: Date | null;
  retentionForever: boolean;
  legalHolds: Array<{ id: string }>;
}) {
  return digest([
    resource.id,
    resource.updatedAt.toISOString(),
    resource.retentionPolicyId,
    resource.retentionStartAt?.toISOString() ?? null,
    resource.retentionUntil?.toISOString() ?? null,
    resource.retentionForever,
    resource.legalHolds.map((hold) => hold.id).sort(),
  ]);
}

function previewKey(): Buffer {
  return crypto
    .createHash('sha256')
    .update(env.JWT_ACCESS_SECRET || 's2-nas-development-preview-token')
    .digest();
}

/** Authenticated encryption keeps denied resource identifiers out of the browser-visible token. */
function signPreview(payload: PreviewPayload): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', previewKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  return `${iv.toString('base64url')}.${ciphertext.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}`;
}

function verifyPreview(token: string): PreviewPayload {
  const [ivRaw, ciphertextRaw, tagRaw, extra] = token.split('.');
  if (!ivRaw || !ciphertextRaw || !tagRaw || extra) {
    throw new AppError('RETENTION_PREVIEW_INVALID', 'ข้อมูลตัวอย่างไม่ถูกต้อง', 400);
  }
  let payload: PreviewPayload;
  try {
    const iv = Buffer.from(ivRaw, 'base64url');
    const ciphertext = Buffer.from(ciphertextRaw, 'base64url');
    const tag = Buffer.from(tagRaw, 'base64url');
    // Node accepts non-canonical base64url encodings whose unused trailing bits
    // decode to the same bytes. Reject them so changing any token character is
    // always a forgery, even when the decoded AES-GCM tag would be unchanged.
    if (
      iv.length !== 12 || tag.length !== 16 || ciphertext.length === 0 ||
      iv.toString('base64url') !== ivRaw ||
      ciphertext.toString('base64url') !== ciphertextRaw ||
      tag.toString('base64url') !== tagRaw
    ) throw new Error('non-canonical preview token');
    const decipher = crypto.createDecipheriv('aes-256-gcm', previewKey(), iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString('utf8');
    payload = JSON.parse(plaintext) as PreviewPayload;
  } catch {
    throw new AppError('RETENTION_PREVIEW_INVALID', 'ข้อมูลตัวอย่างไม่ถูกต้อง', 400);
  }
  if (
    !Number.isFinite(payload.issuedAt) ||
    payload.issuedAt > Date.now() + 60_000 ||
    Date.now() - payload.issuedAt > 15 * 60_000
  ) {
    throw new AppError('RETENTION_PREVIEW_EXPIRED', 'ตัวอย่างหมดอายุ กรุณาดูตัวอย่างใหม่', 409);
  }
  return payload;
}

/** อ่านอย่างเดียวทั้งหมด และลงลายเซ็น snapshot สำหรับตรวจ stale ตอน execute */
export async function previewReapplyPolicy(policyId: string, user: AuthUser): Promise<RetentionReapplyPreview> {
  assertManager(user);
  const policy = await prisma.retentionPolicy.findUnique({ where: { id: policyId } });
  if (!policy) throw notFound('RETENTION_POLICY_NOT_FOUND', 'ไม่พบนโยบายการเก็บรักษา');
  const resources = await prisma.resource.findMany({
    where: { retentionPolicyId: policyId },
    include: resourceInclude,
    orderBy: { id: 'asc' },
  });

  const candidates: RetentionReapplyPreviewItem[] = [];
  for (const resource of resources) {
    const canSee = capabilities(resource, user).canView;
    const startAt = resource.retentionStartAt ?? resource.createdAt;
    const resultingUntil = computeRetentionUntil(policy, startAt);
    const change = compareRetention(
      { policyId: resource.retentionPolicyId, until: resource.retentionUntil, forever: resource.retentionForever },
      { policyId: policy.id, until: resultingUntil, forever: policy.retainForever },
    );
    const held = resource.legalHolds.length > 0;
    candidates.push({
      resourceId: resource.id,
      resourceName: canSee ? resource.name : null,
      status: !canSee ? 'PERMISSION_DENIED' : held ? 'BLOCKED' : change === 'UNCHANGED' ? 'UNCHANGED' : 'CHANGED',
      code: !canSee ? 'PERMISSION_DENIED' : held ? 'LEGAL_HOLD_ACTIVE' : null,
      currentPolicyId: resource.retentionPolicyId,
      resultingPolicyId: policy.id,
      currentRetentionUntil: resource.retentionUntil?.toISOString() ?? null,
      resultingRetentionUntil: resultingUntil?.toISOString() ?? null,
      currentRetentionForever: resource.retentionForever,
      resultingRetentionForever: policy.retainForever,
      weakening: change === 'WEAKENED' || change === 'CLEARED',
    });
  }

  const count = (status: ReapplyStatus) => candidates.filter((item) => item.status === status).length;
  const payload: PreviewPayload = {
    policyId,
    policyFingerprint: policyFingerprint(policy),
    issuedAt: Date.now(),
    resources: resources.map((resource) => ({ id: resource.id, fingerprint: resourceFingerprint(resource) })),
  };
  return {
    policy: { id: policy.id, name: policy.name, retentionDays: policy.retentionDays, retainForever: policy.retainForever },
    attempted: candidates.length,
    changed: count('CHANGED'),
    unchanged: count('UNCHANGED'),
    blocked: count('BLOCKED'),
    permissionDenied: count('PERMISSION_DENIED'),
    legalHoldConflicts: candidates.filter((item) => item.code === 'LEGAL_HOLD_ACTIVE').length,
    potentialWeakening: candidates.filter((item) => item.weakening).length,
    candidates,
    previewToken: signPreview(payload),
  };
}

export interface RetentionReapplyResult {
  attempted: number;
  changed: number;
  unchanged: number;
  blocked: number;
  failed: number;
  errors: Array<{ resourceId: string; code: string; message: string }>;
}

/**
 * Model B: transaction ต่อทรัพยากร + ผลลัพธ์ partial ที่บังคับให้เห็นชัด
 * การเปลี่ยนหนึ่งรายการและ audit ของมันสำเร็จ/ย้อนกลับพร้อมกันเสมอ
 */
export async function executeReapplyPolicy(
  policyId: string,
  user: AuthUser,
  input: { previewToken: string; reason?: string | null },
  audit: { ipAddress?: string; userAgent?: string },
): Promise<RetentionReapplyResult> {
  assertManager(user);
  const preview = verifyPreview(input.previewToken);
  if (preview.policyId !== policyId) throw new AppError('RETENTION_PREVIEW_INVALID', 'ตัวอย่างไม่ตรงกับนโยบาย', 400);
  const policy = await prisma.retentionPolicy.findUnique({ where: { id: policyId } });
  if (!policy) throw notFound('RETENTION_POLICY_NOT_FOUND', 'ไม่พบนโยบายการเก็บรักษา');
  if (preview.policyFingerprint !== policyFingerprint(policy)) {
    throw new AppError('RETENTION_POLICY_STALE', 'นโยบายเปลี่ยนหลังจากดูตัวอย่าง กรุณาดูตัวอย่างใหม่', 409);
  }

  const result: RetentionReapplyResult = {
    attempted: preview.resources.length,
    changed: 0,
    unchanged: 0,
    blocked: 0,
    failed: 0,
    errors: [],
  };
  await prisma.activityLog.create({
    data: {
      userId: user.id,
      action: 'RETENTION_REAPPLY_STARTED',
      ipAddress: audit.ipAddress,
      userAgent: audit.userAgent?.slice(0, 500),
      metadata: { policyId, attempted: result.attempted },
    },
  });

  for (const expected of preview.resources) {
    try {
      const resource = await prisma.resource.findUnique({ where: { id: expected.id }, include: resourceInclude });
      if (!resource || resource.deletedAt) {
        result.failed += 1;
        result.errors.push({ resourceId: expected.id, code: 'STALE_RESOURCE', message: 'ทรัพยากรถูกเปลี่ยนหรือลบหลังดูตัวอย่าง' });
        continue;
      }
      if (!capabilities(resource, user).canView) {
        result.failed += 1;
        result.errors.push({ resourceId: expected.id, code: 'PERMISSION_DENIED', message: 'ไม่มีสิทธิ์เข้าถึงทรัพยากรนี้' });
        continue;
      }
      // Legal Hold มีลำดับสูงสุด ตรวจใหม่ก่อน stale เพื่อรายงาน conflict ที่มีความหมายกว่า
      if (resource.legalHolds.length > 0) {
        result.blocked += 1;
        result.errors.push({ resourceId: expected.id, code: 'LEGAL_HOLD_ACTIVE', message: 'ทรัพยากรอยู่ภายใต้ Legal Hold' });
        continue;
      }
      if (resourceFingerprint(resource) !== expected.fingerprint || resource.retentionPolicyId !== policyId) {
        result.failed += 1;
        result.errors.push({ resourceId: expected.id, code: 'STALE_RESOURCE', message: 'การเก็บรักษาเปลี่ยนหลังดูตัวอย่าง' });
        continue;
      }

      const startAt = resource.retentionStartAt ?? resource.createdAt;
      const until = computeRetentionUntil(policy, startAt);
      const before: RetentionState = {
        policyId: resource.retentionPolicyId,
        until: resource.retentionUntil,
        forever: resource.retentionForever,
      };
      const after: RetentionState = { policyId, until, forever: policy.retainForever };
      const change = compareRetention(before, after);
      const reason = overrideReason(user, change, input.reason);
      if (change === 'UNCHANGED') {
        result.unchanged += 1;
        continue;
      }

      await prisma.$transaction(async (tx) => {
        const updated = await tx.resource.updateMany({
          where: { id: resource.id, updatedAt: resource.updatedAt },
          data: { retentionUntil: until, retentionForever: policy.retainForever, updatedById: user.id },
        });
        if (updated.count !== 1) {
          throw new AppError('RETENTION_STATE_STALE', 'การเก็บรักษาเปลี่ยนระหว่างดำเนินการ', 409);
        }
        await tx.activityLog.create({
          data: {
            userId: user.id,
            action: change === 'WEAKENED' ? 'RETENTION_OVERRIDE_WEAKENED' : 'RETENTION_STRENGTHENED',
            resourceId: resource.id,
            ipAddress: audit.ipAddress,
            userAgent: audit.userAgent?.slice(0, 500),
            metadata: {
              ...stateMetadata('before', before),
              ...stateMetadata('after', after),
              reason,
              source: 'REAPPLY',
            },
          },
        });
      });
      result.changed += 1;
    } catch (error) {
      result.failed += 1;
      const code = error instanceof AppError ? error.code : 'VALIDATION_FAILED';
      const message = error instanceof AppError ? error.message : 'ดำเนินการกับทรัพยากรนี้ไม่สำเร็จ';
      result.errors.push({ resourceId: expected.id, code, message });
    }
  }

  await prisma.activityLog.create({
    data: {
      userId: user.id,
      action: result.blocked > 0 || result.failed > 0 ? 'RETENTION_REAPPLY_PARTIAL' : 'RETENTION_REAPPLY_COMPLETED',
      ipAddress: audit.ipAddress,
      userAgent: audit.userAgent?.slice(0, 500),
      metadata: {
        policyId,
        attempted: result.attempted,
        changed: result.changed,
        unchanged: result.unchanged,
        blocked: result.blocked,
        failed: result.failed,
      },
    },
  });
  return result;
}

/** compatibility wrapper for internal callers; HTTP execution always requires preview */
export async function reapplyPolicy(policyId: string, user: AuthUser): Promise<{ updated: number }> {
  const preview = await previewReapplyPolicy(policyId, user);
  const result = await executeReapplyPolicy(policyId, user, { previewToken: preview.previewToken, reason: 'Legacy internal reapply' }, {});
  if (result.failed || result.blocked) {
    throw new AppError('RETENTION_REAPPLY_PARTIAL', 'คำนวณใหม่ไม่สำเร็จครบทุกทรัพยากร', 409, result);
  }
  return { updated: result.changed };
}

/**
 * ตัวอย่างนโยบายเริ่มต้น
 *
 * **เป็นเพียงตัวอย่างที่แก้ไขได้ ไม่ใช่คำแนะนำทางกฎหมาย**
 * ระบบไม่ทราบว่าองค์กรต้องเก็บเอกสารชนิดใดนานเท่าไร และไม่ควรแกล้งทำเป็นรู้
 *
 * สร้างเมื่อผู้ดูแลกดเท่านั้น ไม่ใช่ seed อัตโนมัติ และทำซ้ำได้โดยไม่เกิดของซ้ำ
 */
export const DEFAULT_POLICIES: PolicyInput[] = [
  { name: 'เก็บ 1 ปี', description: 'ตัวอย่างนโยบาย - ปรับได้ตามที่องค์กรกำหนด', retentionDays: 365 },
  { name: 'เก็บ 5 ปี', description: 'ตัวอย่างนโยบาย - ปรับได้ตามที่องค์กรกำหนด', retentionDays: 365 * 5 },
  { name: 'เก็บ 10 ปี', description: 'ตัวอย่างนโยบาย - ปรับได้ตามที่องค์กรกำหนด', retentionDays: 365 * 10 },
  { name: 'เก็บถาวร', description: 'เก็บโดยไม่มีกำหนด จนกว่าจะมีคนเปลี่ยนนโยบาย', retainForever: true },
];

export async function seedDefaultPolicies(user: AuthUser): Promise<{ created: number }> {
  assertManager(user);
  let created = 0;
  for (const [index, preset] of DEFAULT_POLICIES.entries()) {
    const existing = await prisma.retentionPolicy.findFirst({
      where: { name: preset.name },
      select: { id: true },
    });
    if (existing) continue;
    await prisma.retentionPolicy.create({
      data: {
        name: preset.name,
        description: preset.description ?? null,
        retentionDays: preset.retainForever ? null : (preset.retentionDays ?? null),
        retainForever: preset.retainForever ?? false,
        sortOrder: index * 10,
        createdById: user.id,
      },
    });
    created += 1;
  }
  return { created };
}

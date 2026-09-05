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
import { prisma } from '../../core/prisma.js';
import { AppError, notFound } from '../../core/errors.js';
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
}

export interface AssignResult {
  resourceId: string;
  retentionPolicyId: string | null;
  retentionUntil: Date | null;
  retentionForever: boolean;
}

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

  /* ---- ล้างนโยบายออก ---- */
  if (input.policyId === null) {
    await prisma.resource.update({
      where: { id: resourceId },
      data: {
        retentionPolicyId: null,
        retentionStartAt: null,
        retentionStartBasis: null,
        retentionUntil: null,
        retentionForever: false,
        updatedById: user.id,
      },
    });
    await logAssignment('RETENTION_POLICY_ASSIGNED', user, resourceId, audit, { policyId: null });
    return { resourceId, retentionPolicyId: null, retentionUntil: null, retentionForever: false };
  }

  const policy = await prisma.retentionPolicy.findUnique({ where: { id: input.policyId } });
  if (!policy) throw notFound('RETENTION_POLICY_NOT_FOUND', 'ไม่พบนโยบายการเก็บรักษา');
  if (!policy.isActive) {
    throw new AppError('RETENTION_POLICY_INACTIVE', 'นโยบายนี้ถูกปิดการใช้งานอยู่', 409);
  }

  const startAt = input.startAt ?? resource.createdAt;
  const basis = input.startAt ? 'MANUAL' : 'CREATED_AT';
  const until = computeRetentionUntil(policy, startAt);

  const changed = resource.retentionPolicyId !== null && resource.retentionPolicyId !== policy.id;

  await prisma.resource.update({
    where: { id: resourceId },
    data: {
      retentionPolicyId: policy.id,
      retentionStartAt: startAt,
      retentionStartBasis: basis,
      // ภาพนิ่ง - การแก้นิยามนโยบายภายหลังจะไม่เปลี่ยนค่านี้
      retentionUntil: until,
      retentionForever: policy.retainForever,
      updatedById: user.id,
    },
  });

  await logAssignment(
    changed ? 'RETENTION_POLICY_CHANGED' : 'RETENTION_POLICY_ASSIGNED',
    user,
    resourceId,
    audit,
    { policyId: policy.id, retentionUntil: until?.toISOString() ?? null, retainForever: policy.retainForever },
  );

  return {
    resourceId,
    retentionPolicyId: policy.id,
    retentionUntil: until,
    retentionForever: policy.retainForever,
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

  await logAssignment('RETENTION_POLICY_ASSIGNED', user, resourceId, audit, {
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
export async function reapplyPolicy(
  policyId: string,
  user: AuthUser,
): Promise<{ updated: number }> {
  assertManager(user);
  const policy = await prisma.retentionPolicy.findUnique({ where: { id: policyId } });
  if (!policy) throw notFound('RETENTION_POLICY_NOT_FOUND', 'ไม่พบนโยบายการเก็บรักษา');

  const resources = await prisma.resource.findMany({
    where: { retentionPolicyId: policyId },
    select: { id: true, createdAt: true, retentionStartAt: true },
  });

  let updated = 0;
  for (const resource of resources) {
    const startAt = resource.retentionStartAt ?? resource.createdAt;
    const until = computeRetentionUntil(policy, startAt);
    await prisma.resource.update({
      where: { id: resource.id },
      data: { retentionUntil: until, retentionForever: policy.retainForever },
    });
    updated += 1;
  }

  await prisma.activityLog.create({
    data: {
      userId: user.id,
      action: 'RETENTION_POLICY_UPDATED',
      metadata: { policyId, reapplied: updated },
    },
  });

  return { updated };
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

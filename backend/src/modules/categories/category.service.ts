/**
 * ประเภทเอกสาร
 *
 * ตั้งค่าได้ ไม่ใช่ enum ตายตัว - ประเภทเอกสารของแต่ละองค์กรต่างกัน และการเพิ่ม
 * ประเภทใหม่ไม่ควรต้องแก้โค้ดแล้ว deploy ใหม่
 *
 * **การจัดประเภทเป็นการตัดสินใจของคน ไม่ใช่การเดาของเครื่อง** F15 ไม่มีการจัดประเภท
 * อัตโนมัติ เพราะการเดาผิดในเอกสารการเงินมีราคาสูงกว่าการให้คนเลือกเองมาก
 */
import { prisma } from '../../core/prisma.js';
import { AppError, notFound } from '../../core/errors.js';
import type { AuthUser } from '../auth/auth.service.js';

export interface DocumentCategoryDto {
  id: string;
  name: string;
  slug: string;
  isActive: boolean;
  sortOrder: number;
  /** จำนวนเอกสารที่ใช้ประเภทนี้ - ผู้ดูแลต้องรู้ก่อนตัดสินใจปิดการใช้งาน */
  resourceCount: number;
}

/**
 * สร้าง slug จากชื่อ
 *
 * ชื่อประเภทเป็นภาษาไทยเกือบทั้งหมด ซึ่งแปลงเป็น ASCII slug ไม่ได้อย่างมีความหมาย
 * จึงคงอักษรไทยไว้ตามเดิมและตัดเฉพาะอักขระที่ใช้ใน URL ไม่ได้ออก
 * ผลที่ได้อ่านออกเมื่อ decode แล้ว และไม่ชนกันเองสำหรับชื่อที่ต่างกัน
 */
export function slugify(name: string): string {
  const base = name
    .normalize('NFC')
    .trim()
    .toLocaleLowerCase()
    .replace(/[\s/\\?#[\]@!$&'()*+,;=%]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return base.slice(0, 100) || `category-${Date.now().toString(36)}`;
}

function isAdmin(user: AuthUser): boolean {
  return user.roles.includes('SUPER_ADMIN') || user.roles.includes('ADMIN');
}

function assertAdmin(user: AuthUser): void {
  if (!isAdmin(user) && !user.permissions.includes('admin:access')) {
    throw new AppError('CATEGORY_DENIED', 'เฉพาะผู้ดูแลระบบเท่านั้นที่จัดการประเภทเอกสารได้', 403);
  }
}

/**
 * รายการประเภทเอกสาร
 *
 * ผู้ใช้ทั่วไปเห็นเฉพาะที่เปิดใช้งานอยู่ ผู้ดูแลเห็นทั้งหมดเพื่อจัดการของที่ปิดไว้ได้
 */
export async function listCategories(
  user: AuthUser,
  options: { includeInactive?: boolean } = {},
): Promise<DocumentCategoryDto[]> {
  const includeInactive = options.includeInactive === true && isAdmin(user);
  const rows = await prisma.documentCategory.findMany({
    where: includeInactive ? {} : { isActive: true },
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    select: {
      id: true,
      name: true,
      slug: true,
      isActive: true,
      sortOrder: true,
      _count: { select: { resources: true } },
    },
  });

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    slug: row.slug,
    isActive: row.isActive,
    sortOrder: row.sortOrder,
    resourceCount: row._count.resources,
  }));
}

export async function createCategory(
  user: AuthUser,
  input: { name: string; sortOrder?: number },
): Promise<DocumentCategoryDto> {
  assertAdmin(user);
  const name = input.name.trim();
  if (!name) throw new AppError('CATEGORY_NAME_REQUIRED', 'กรุณาระบุชื่อประเภทเอกสาร', 400);

  const slug = slugify(name);
  const existing = await prisma.documentCategory.findUnique({ where: { slug }, select: { id: true } });
  if (existing) throw new AppError('CATEGORY_EXISTS', 'มีประเภทเอกสารชื่อนี้อยู่แล้ว', 409);

  const row = await prisma.documentCategory.create({
    data: { name, slug, sortOrder: input.sortOrder ?? 0, createdById: user.id },
    select: { id: true, name: true, slug: true, isActive: true, sortOrder: true },
  });
  return { ...row, resourceCount: 0 };
}

export async function updateCategory(
  id: string,
  user: AuthUser,
  input: { name?: string; isActive?: boolean; sortOrder?: number },
): Promise<DocumentCategoryDto> {
  assertAdmin(user);
  const current = await prisma.documentCategory.findUnique({ where: { id }, select: { id: true } });
  if (!current) throw notFound('CATEGORY_NOT_FOUND', 'ไม่พบประเภทเอกสาร');

  const name = input.name?.trim();
  if (input.name !== undefined && !name) {
    throw new AppError('CATEGORY_NAME_REQUIRED', 'กรุณาระบุชื่อประเภทเอกสาร', 400);
  }

  /**
   * เปลี่ยนชื่อได้ แต่ slug ไม่เปลี่ยนตาม
   *
   * slug ถูกใช้ใน URL และในชุดค้นหาที่บันทึกไว้ การเปลี่ยนมันตามชื่อจะทำให้
   * ลิงก์และชุดค้นหาที่คนบันทึกไว้เสียทันทีที่มีคนแก้คำผิดในชื่อ
   */
  const row = await prisma.documentCategory.update({
    where: { id },
    data: {
      ...(name ? { name } : {}),
      ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
      ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
    },
    select: {
      id: true,
      name: true,
      slug: true,
      isActive: true,
      sortOrder: true,
      _count: { select: { resources: true } },
    },
  });

  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    isActive: row.isActive,
    sortOrder: row.sortOrder,
    resourceCount: row._count.resources,
  };
}

/**
 * ลบประเภทเอกสาร
 *
 * ลบได้เฉพาะประเภทที่ไม่มีเอกสารใดใช้อยู่ ถ้ายังมีเอกสารอ้างถึง ให้ปิดการใช้งานแทน
 * การลบทิ้งทั้งที่ยังมีคนใช้จะทำให้เอกสารหลายร้อยฉบับสูญเสียการจัดประเภท
 * ที่คนนั่งทำไว้ ซึ่งกู้กลับไม่ได้
 */
export async function deleteCategory(id: string, user: AuthUser): Promise<{ deleted: boolean }> {
  assertAdmin(user);
  const row = await prisma.documentCategory.findUnique({
    where: { id },
    select: { id: true, _count: { select: { resources: true } } },
  });
  if (!row) throw notFound('CATEGORY_NOT_FOUND', 'ไม่พบประเภทเอกสาร');

  if (row._count.resources > 0) {
    throw new AppError(
      'CATEGORY_IN_USE',
      `ประเภทนี้ถูกใช้กับเอกสาร ${row._count.resources} รายการ กรุณาปิดการใช้งานแทนการลบ`,
      409,
    );
  }

  await prisma.documentCategory.delete({ where: { id } });
  return { deleted: true };
}

/**
 * ประเภทเริ่มต้น
 *
 * จงใจให้มีน้อยและเป็นของที่องค์กรบัญชีไทยใช้จริง การใส่มาสามสิบประเภท
 * จะทำให้ไม่มีใครหาอันที่ต้องการเจอ และคนจะเลิกจัดประเภทไปเลย
 *
 * ทำงานซ้ำได้โดยไม่สร้างของซ้ำ - ตรวจจาก slug ก่อนสร้างเสมอ
 */
export const DEFAULT_CATEGORIES = [
  'ใบกำกับภาษี',
  'ใบเสร็จรับเงิน',
  'สัญญา',
  'งบการเงิน',
  'เอกสารภาษี',
  'เอกสารลูกค้า',
] as const;

export async function seedDefaultCategories(user: AuthUser): Promise<{ created: number }> {
  assertAdmin(user);
  let created = 0;
  for (const [index, name] of DEFAULT_CATEGORIES.entries()) {
    const slug = slugify(name);
    const existing = await prisma.documentCategory.findUnique({ where: { slug }, select: { id: true } });
    if (existing) continue;
    await prisma.documentCategory.create({
      data: { name, slug, sortOrder: index * 10, createdById: user.id },
    });
    created += 1;
  }
  return { created };
}

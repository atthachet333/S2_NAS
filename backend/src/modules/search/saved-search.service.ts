/**
 * ชุดค้นหาที่ผู้ใช้บันทึกไว้
 *
 * เก็บ "เงื่อนไข" ไม่ได้เก็บ "ผลลัพธ์"
 *
 * ความต่างนี้สำคัญเรื่องความปลอดภัย: ถ้าเก็บรายการผลลัพธ์ไว้ เอกสารที่ถูกถอนสิทธิ์
 * ไปแล้วจะยังโผล่ในชุดที่บันทึกไว้ตลอดไป การเก็บเงื่อนไขแล้วค้นใหม่ทุกครั้ง
 * ทำให้ผลลัพธ์ผ่านด่านสิทธิ์ปัจจุบันเสมอ ชุดค้นหาจึงไม่มีวันกลายเป็นช่องโหว่
 *
 * เป็นของส่วนตัวของแต่ละคนใน F15 - ชื่อที่คนตั้งให้ชุดค้นหามักบอกใบ้เนื้องาน
 * ที่เขากำลังทำอยู่ ซึ่งไม่จำเป็นต้องให้คนทั้งองค์กรเห็น
 */
import type { Prisma } from '@prisma/client';
import { prisma } from '../../core/prisma.js';
import { AppError, notFound } from '../../core/errors.js';
import { searchFiltersSchema, type SearchFilters } from './search-filters.js';
import type { AuthUser } from '../auth/auth.service.js';

export interface SavedSearchDto {
  id: string;
  name: string;
  query: string;
  filters: SearchFilters;
  lastUsedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * แปลงแถวเป็น DTO พร้อมตรวจตัวกรองที่เก็บไว้อีกครั้ง
 *
 * ตัวกรองถูกเก็บเป็น JSON ซึ่งฐานข้อมูลไม่ได้บังคับรูปร่างให้ การอ่านออกมา
 * โดยไม่ตรวจซ้ำแปลว่าเชื่อข้อมูลเก่าที่อาจถูกบันทึกไว้ด้วยกติกาคนละรุ่น
 * ตัวกรองที่ไม่ผ่านการตรวจถูกตัดทิ้งทั้งชุด ดีกว่าส่งเงื่อนไขครึ่ง ๆ กลาง ๆ
 * ที่ทำให้ผู้ใช้เห็นผลลัพธ์ผิดโดยไม่รู้ตัว
 */
function toDto(row: {
  id: string;
  name: string;
  query: string;
  filters: Prisma.JsonValue;
  lastUsedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}): SavedSearchDto {
  const parsed = searchFiltersSchema.safeParse(row.filters ?? {});
  return {
    id: row.id,
    name: row.name,
    query: row.query,
    filters: parsed.success ? parsed.data : {},
    lastUsedAt: row.lastUsedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

const select = {
  id: true,
  name: true,
  query: true,
  filters: true,
  lastUsedAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

/**
 * ชุดค้นหาของผู้เรียก
 *
 * userId มาจาก session เสมอ ไม่เคยมาจากคำขอ - ไม่มีพารามิเตอร์ให้ระบุเจ้าของ
 * จึงไม่มีทางที่ใครจะขอดูของคนอื่นได้ แม้จะแก้คำขอเอง
 */
export async function listSavedSearches(user: AuthUser): Promise<SavedSearchDto[]> {
  const rows = await prisma.savedSearch.findMany({
    where: { userId: user.id },
    orderBy: [{ lastUsedAt: 'desc' }, { updatedAt: 'desc' }],
    take: 100,
    select,
  });
  return rows.map(toDto);
}

/** ชุดค้นหาหนึ่งชุด - คืนเฉพาะของผู้เรียกเท่านั้น */
export async function getSavedSearch(id: string, user: AuthUser): Promise<SavedSearchDto> {
  const row = await prisma.savedSearch.findFirst({
    where: { id, userId: user.id },
    select,
  });
  /**
   * ชุดของคนอื่นตอบ 404 ไม่ใช่ 403
   * 403 จะเป็นการยืนยันว่ารหัสนี้มีอยู่จริง ซึ่งเป็นข้อมูลที่ผู้เรียกไม่ควรได้
   */
  if (!row) throw notFound('SAVED_SEARCH_NOT_FOUND', 'ไม่พบชุดค้นหาที่บันทึกไว้');
  return toDto(row);
}

export interface SaveSearchInput {
  name: string;
  query?: string;
  filters?: SearchFilters;
}

export async function createSavedSearch(
  user: AuthUser,
  input: SaveSearchInput,
): Promise<SavedSearchDto> {
  const name = input.name.trim();
  if (!name) throw new AppError('SAVED_SEARCH_NAME_REQUIRED', 'กรุณาตั้งชื่อชุดค้นหา', 400);

  const count = await prisma.savedSearch.count({ where: { userId: user.id } });
  if (count >= 100) {
    throw new AppError(
      'SAVED_SEARCH_LIMIT_REACHED',
      'บันทึกชุดค้นหาได้สูงสุด 100 ชุด กรุณาลบชุดที่ไม่ใช้แล้วก่อน',
      409,
    );
  }

  try {
    const row = await prisma.savedSearch.create({
      data: {
        userId: user.id,
        name,
        query: (input.query ?? '').slice(0, 191),
        filters: (input.filters ?? {}) as Prisma.InputJsonValue,
      },
      select,
    });
    return toDto(row);
  } catch (error) {
    throw duplicateOrThrow(error);
  }
}

export async function renameSavedSearch(
  id: string,
  user: AuthUser,
  name: string,
): Promise<SavedSearchDto> {
  const trimmed = name.trim();
  if (!trimmed) throw new AppError('SAVED_SEARCH_NAME_REQUIRED', 'กรุณาตั้งชื่อชุดค้นหา', 400);

  // updateMany + เงื่อนไข userId ทำให้ไม่มีทางแก้ของคนอื่นได้แม้จะเดารหัสถูก
  try {
    const result = await prisma.savedSearch.updateMany({
      where: { id, userId: user.id },
      data: { name: trimmed },
    });
    if (result.count === 0) throw notFound('SAVED_SEARCH_NOT_FOUND', 'ไม่พบชุดค้นหาที่บันทึกไว้');
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw duplicateOrThrow(error);
  }
  return getSavedSearch(id, user);
}

/** อัปเดตเงื่อนไขของชุดเดิม - ใช้เมื่อผู้ใช้ปรับตัวกรองแล้วกดบันทึกทับ */
export async function updateSavedSearch(
  id: string,
  user: AuthUser,
  input: { query?: string; filters?: SearchFilters },
): Promise<SavedSearchDto> {
  const result = await prisma.savedSearch.updateMany({
    where: { id, userId: user.id },
    data: {
      ...(input.query !== undefined ? { query: input.query.slice(0, 191) } : {}),
      ...(input.filters !== undefined ? { filters: input.filters as Prisma.InputJsonValue } : {}),
    },
  });
  if (result.count === 0) throw notFound('SAVED_SEARCH_NOT_FOUND', 'ไม่พบชุดค้นหาที่บันทึกไว้');
  return getSavedSearch(id, user);
}

export async function deleteSavedSearch(id: string, user: AuthUser): Promise<{ deleted: boolean }> {
  const result = await prisma.savedSearch.deleteMany({ where: { id, userId: user.id } });
  if (result.count === 0) throw notFound('SAVED_SEARCH_NOT_FOUND', 'ไม่พบชุดค้นหาที่บันทึกไว้');
  return { deleted: true };
}

/**
 * บันทึกว่าเพิ่งถูกใช้
 *
 * ใช้จัดลำดับ "ที่ใช้บ่อย" โดยไม่ต้องเก็บสถิติการใช้งานแยกต่างหาก
 * ล้มเหลวเงียบ ๆ ได้ - การอัปเดตเวลาใช้งานล่าสุดไม่สำเร็จ ไม่ควรทำให้ผู้ใช้
 * เปิดชุดค้นหาไม่ได้
 */
export async function touchSavedSearch(id: string, user: AuthUser): Promise<void> {
  await prisma.savedSearch
    .updateMany({ where: { id, userId: user.id }, data: { lastUsedAt: new Date() } })
    .catch(() => undefined);
}

/** ชื่อซ้ำในชุดของคนเดียวกัน */
function duplicateOrThrow(error: unknown): Error {
  const code = (error as { code?: string }).code;
  if (code === 'P2002') {
    return new AppError('SAVED_SEARCH_NAME_EXISTS', 'มีชุดค้นหาชื่อนี้อยู่แล้ว', 409);
  }
  return error as Error;
}

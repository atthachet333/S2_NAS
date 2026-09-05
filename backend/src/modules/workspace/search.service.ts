import type { Prisma, ResourceSourceType, ResourceType, ResourceVisibility } from '@prisma/client';
import { prisma } from '../../core/prisma.js';
import { badRequest, forbidden } from '../../core/errors.js';
import { capabilities, resourceInclude, toResourceDto } from '../resources/resource.service.js';
import {
  contentMatchResourceIds,
  indexStateResourceIds,
  matchReasonFor,
  rankOf,
  snippetsFor,
  type ContentSnippetInfo,
  type MatchReason,
} from '../search/content-match.js';
import {
  fileKindWhere,
  hasTextCondition,
  ocrStateCondition,
  orderByFor,
  resolveDateRange,
  type SearchFilters,
} from '../search/search-filters.js';
import type { AuthUser } from '../auth/auth.service.js';

/**
 * การค้นหาทั่วทั้งพื้นที่ทำงาน
 *
 * หลักการสำคัญ: กรองสิทธิ์ "ก่อน" ดึงผลลัพธ์เสมอ
 *
 * ถ้าค้นก่อนแล้วค่อยกรองทีหลัง ผู้ใช้จะอนุมานการมีอยู่ของเอกสารลับได้จากจำนวนผลลัพธ์
 * และหน้าที่ถูกกรองจนว่างจะดูเหมือนระบบพัง เงื่อนไขสิทธิ์จึงถูกผูกเข้าไปใน WHERE
 * ตั้งแต่ต้น แล้วยังตรวจซ้ำด้วย capabilities() อีกชั้นก่อนคืนค่า
 */

export interface SearchInput {
  q?: string;
  type?: ResourceType;
  sourceType?: ResourceSourceType;
  ownerId?: string;
  tagId?: string;
  visibility?: ResourceVisibility;
  updatedFrom?: Date;
  updatedTo?: Date;
  /** เฉพาะรายการโปรดของฉัน */
  favoriteOnly?: boolean;
  limit: number;
  cursor?: string;
  /**
   * ตัวกรองขั้นสูงของ F15
   *
   * แยกเป็นก้อนเดียวเพื่อให้ชุดค้นหาที่บันทึกไว้ มุมมองอัจฉริยะ และ URL
   * ใช้รูปร่างเดียวกันทั้งหมด ดู search-filters.ts
   */
  filters?: SearchFilters;
}

function isAdmin(user: AuthUser): boolean {
  return user.roles.includes('SUPER_ADMIN') || user.roles.includes('ADMIN');
}

/** เงื่อนไขการมองเห็นระดับฐานข้อมูล ต้องสมมูลกับ capabilities().canView */
export function visibilityScope(user: AuthUser): Prisma.ResourceWhereInput {
  if (isAdmin(user)) return {};
  return {
    OR: [
      { visibility: 'ORGANIZATION' },
      { ownerId: user.id },
      { access: { some: { userId: user.id } } },
    ],
  };
}

export async function searchResources(input: SearchInput, user: AuthUser) {
  if (!user.permissions.includes('resources:read')) throw forbidden('ไม่มีสิทธิ์ค้นหาทรัพยากร');

  const term = input.q?.trim() ?? '';
  if (term.length > 191) throw badRequest('SEARCH_QUERY_TOO_LONG', 'คำค้นยาวเกินไป');

  const filters: Prisma.ResourceWhereInput[] = [{ deletedAt: null }, visibilityScope(user)];

  /**
   * รหัสของทรัพยากรที่เนื้อในเวอร์ชันปัจจุบันตรงกับคำค้น
   *
   * หามาก่อนแล้วนำมาผสมเป็นเงื่อนไข OR ในคำสั่งเดียวกับเงื่อนไขสิทธิ์
   * ไม่ใช่ค้นแยกแล้วรวมผลทีหลัง - การรวมทีหลังคือจุดที่เงื่อนไขสิทธิ์มักหลุด
   */
  const contentIds = term ? await contentMatchResourceIds(term) : [];

  if (term) {
    const normalized = term.normalize('NFC').toLocaleLowerCase();
    // ค้นจากชื่อและหมายเหตุ ไม่ค้นจาก storageKey เพราะเป็นข้อมูลภายในของเซิร์ฟเวอร์
    filters.push({
      OR: [
        { normalizedName: { contains: normalized } },
        { remark: { contains: term } },
        { tags: { some: { tag: { normalizedName: { contains: normalized } } } } },
        ...(contentIds.length > 0 ? [{ id: { in: contentIds } }] : []),
      ],
    });
  }
  if (input.type) filters.push({ type: input.type });
  if (input.sourceType) filters.push({ sourceType: input.sourceType });
  if (input.ownerId) filters.push({ ownerId: input.ownerId });
  if (input.tagId) filters.push({ tags: { some: { tagId: input.tagId } } });
  if (input.visibility) filters.push({ visibility: input.visibility });
  if (input.favoriteOnly) filters.push({ favoritedBy: { some: { userId: user.id } } });

  /**
   * ตัวกรองขั้นสูงถูกใส่ "ต่อท้าย" เงื่อนไขสิทธิ์ที่ใส่ไว้ตั้งแต่ต้นเสมอ
   * ทุกอย่างอยู่ใน AND เดียวกัน ตัวกรองจึงทำได้แค่ทำให้ผลลัพธ์แคบลง
   * ไม่มีทางทำให้เห็นทรัพยากรที่เดิมมองไม่เห็น
   */
  const f = input.filters ?? {};

  if (f.fileKind) filters.push(fileKindWhere(f.fileKind) as Prisma.ResourceWhereInput);
  if (f.driveScope) filters.push({ driveScope: f.driveScope });
  if (f.ownerId) filters.push({ ownerId: f.ownerId });
  if (f.createdById) filters.push({ createdById: f.createdById });
  if (f.sourceType) filters.push({ sourceType: f.sourceType });
  if (f.tagId) filters.push({ tags: { some: { tagId: f.tagId } } });
  if (f.untaggedOnly) filters.push({ tags: { none: {} } });
  if (f.documentCategoryId) filters.push({ documentCategoryId: f.documentCategoryId });
  if (f.uncategorizedOnly) filters.push({ documentCategoryId: null });
  if (f.favoriteOnly) filters.push({ favoritedBy: { some: { userId: user.id } } });

  const uploaded = resolveDateRange(f.uploadedPreset, f.uploadedFrom, f.uploadedTo);
  if (uploaded) filters.push({ createdAt: uploaded });
  const touched = resolveDateRange(f.updatedPreset, f.updatedFrom, f.updatedTo);
  if (touched) filters.push({ updatedAt: touched });

  /**
   * ตัวกรองที่อ้างอิงดัชนีข้อความต้องดูเฉพาะเวอร์ชันปัจจุบัน
   * จึงหารหัสมาก่อนแล้วค่อยผสมเป็นเงื่อนไข แทนการใช้ relation filter ของ Prisma
   * ซึ่งเทียบ versionNumber กับ currentVersion ของตารางแม่ไม่ได้
   *
   * รายการว่างแปลว่า "ไม่มีอะไรตรง" ไม่ใช่ "ไม่ต้องกรอง" - ต้องบังคับให้ผลเป็นศูนย์
   */
  if (f.ocrState) {
    const ids = await indexStateResourceIds(ocrStateCondition(f.ocrState));
    filters.push(ids.length > 0 ? { id: { in: ids } } : { id: { in: [] } });
  }
  if (f.textSource) {
    const ids = await indexStateResourceIds(`i.textSource = '${f.textSource}'`);
    filters.push(ids.length > 0 ? { id: { in: ids } } : { id: { in: [] } });
  }
  if (f.hasText !== undefined) {
    const ids = await indexStateResourceIds(hasTextCondition(f.hasText));
    filters.push(ids.length > 0 ? { id: { in: ids } } : { id: { in: [] } });
  }
  if (input.updatedFrom || input.updatedTo) {
    filters.push({
      updatedAt: {
        ...(input.updatedFrom ? { gte: input.updatedFrom } : {}),
        ...(input.updatedTo ? { lte: input.updatedTo } : {}),
      },
    });
  }

  const where: Prisma.ResourceWhereInput = { AND: filters };

  const rows = await prisma.resource.findMany({
    where,
    include: resourceInclude,
    /**
     * ค่าเริ่มต้น: โฟลเดอร์ขึ้นก่อนเพื่อให้ผู้ใช้เจอ "ที่เก็บ" ก่อน "ของชิ้นเดียว"
     * เมื่อผู้ใช้เลือกการเรียงเอง ให้ใช้ของเขาแทน
     */
    orderBy: orderByFor(f.sort) as Prisma.ResourceOrderByWithRelationInput[],
    take: input.limit + 1,
    ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
  });

  const page = rows.slice(0, input.limit);
  // ตรวจสิทธิ์ซ้ำอีกชั้น กันกรณีเงื่อนไข WHERE กับ capabilities() หลุดจากกันในอนาคต
  const visible = page.filter((row) => capabilities(row, user).canView);

  /**
   * ตัวอย่างข้อความถูกดึงหลังการกรองสิทธิ์เสร็จแล้วเท่านั้น
   * เนื้อในเอกสารที่ผู้ใช้ไม่มีสิทธิ์เห็นจึงไม่มีทางถูกอ่านขึ้นมาเพื่อทำ DTO
   */
  const contentSet = new Set(contentIds);
  const snippetTargets = visible.filter((row) => contentSet.has(row.id)).map((row) => row.id);
  const snippets =
    term && snippetTargets.length > 0
      ? await snippetsFor(snippetTargets, term)
      : new Map<string, ContentSnippetInfo>();

  const items = visible.map((row) => {
    const tags = row.tags.map((link) => link.tag.name);
    const reason: MatchReason | null = term
      ? matchReasonFor({ name: row.name, remark: row.remark, tags, term, hasContentMatch: contentSet.has(row.id) })
      : null;

    return {
      ...toResourceDto(row, user),
      /** บอกผู้ใช้ว่าทำไมผลลัพธ์นี้ถึงขึ้นมา - การค้นหาที่อธิบายตัวเองได้คือการค้นหาที่เชื่อถือได้ */
      matchReason: reason,
      contentSnippet: reason === 'CONTENT' ? snippets.get(row.id)?.snippet ?? null : null,
      /** ที่มาของข้อความที่ตรงกัน - หน้าจอใช้บอกว่าผลนี้มาจากการอ่านภาพ */
      textSource: reason === 'CONTENT' ? snippets.get(row.id)?.textSource ?? null : null,
      _rank: rankOf({ name: row.name, term, reason, textSource: snippets.get(row.id)?.textSource ?? null }),
    };
  });

  // เรียงตามความชัดเจนของการตรงกัน แล้วคงลำดับเดิมของฐานข้อมูลไว้ภายในกลุ่มเดียวกัน
  if (term) items.sort((a, b) => a._rank - b._rank);

  return {
    items: items.map(({ _rank, ...item }) => item),
    nextCursor: rows.length > input.limit ? page[page.length - 1]?.id ?? null : null,
    total: await prisma.resource.count({ where }),
  };
}

/**
 * ตัวเลือกสำหรับแผงกรอง
 * คืนเฉพาะเจ้าของและแท็กที่ปรากฏในทรัพยากรที่ผู้ใช้คนนี้เห็นได้จริง
 * มิฉะนั้นรายชื่อในตัวกรองเองจะกลายเป็นช่องรั่วของข้อมูล
 */
export async function searchFacets(user: AuthUser) {
  if (!user.permissions.includes('resources:read')) throw forbidden('ไม่มีสิทธิ์ค้นหาทรัพยากร');
  const scope: Prisma.ResourceWhereInput = { AND: [{ deletedAt: null }, visibilityScope(user)] };

  const [ownerGroups, tagLinks] = await Promise.all([
    prisma.resource.groupBy({ by: ['ownerId'], where: scope, _count: { _all: true } }),
    prisma.resourceTag.groupBy({
      by: ['tagId'],
      where: { resource: scope },
      _count: { _all: true },
    }),
  ]);

  const [owners, tags] = await Promise.all([
    prisma.user.findMany({
      where: { id: { in: ownerGroups.map((group) => group.ownerId) } },
      select: { id: true, displayName: true, email: true },
      orderBy: { displayName: 'asc' },
    }),
    prisma.tag.findMany({
      where: { id: { in: tagLinks.map((link) => link.tagId) } },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    }),
  ]);

  const ownerCount = new Map(ownerGroups.map((group) => [group.ownerId, group._count._all]));
  const tagCount = new Map(tagLinks.map((link) => [link.tagId, link._count._all]));

  return {
    owners: owners.map((owner) => ({ ...owner, resourceCount: ownerCount.get(owner.id) ?? 0 })),
    tags: tags.map((tag) => ({ ...tag, resourceCount: tagCount.get(tag.id) ?? 0 })),
  };
}

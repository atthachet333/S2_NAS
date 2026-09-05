/**
 * เส้นทางของ F15 - ตัวกรองขั้นสูง ชุดค้นหา มุมมองอัจฉริยะ คิวตรวจ OCR
 * ประเภทเอกสาร และการแก้ข้อมูลหลายรายการ
 *
 * ทุกเส้นทางอยู่หลัง requireInternal - บัญชีลูกค้าภายนอกเข้าไม่ถึงเลย
 * ไม่ใช่ "เข้าถึงได้แต่ถูกปฏิเสธ" ซึ่งยังบอกใบ้ว่าความสามารถเหล่านี้มีอยู่
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireInternal, requirePermission } from '../auth/auth.guard.js';
import { searchFiltersSchema } from './search-filters.js';
import {
  createSavedSearch,
  deleteSavedSearch,
  getSavedSearch,
  listSavedSearches,
  renameSavedSearch,
  touchSavedSearch,
  updateSavedSearch,
} from './saved-search.service.js';
import { SMART_VIEWS, findSmartView, smartViewFilters } from './smart-views.js';
import { reviewQueue, reviewSummary, verifyOcrResult } from './ocr/review.service.js';
import {
  createCategory,
  deleteCategory,
  listCategories,
  seedDefaultCategories,
  updateCategory,
} from '../categories/category.service.js';
import {
  bulkAddTag,
  bulkRemoveTag,
  bulkSetCategory,
  bulkSetOwner,
} from '../resources/bulk.service.js';
import { searchResources } from '../workspace/search.service.js';

const idParams = z.object({ id: z.string().min(1) });
const audit = (request: FastifyRequest) => ({
  ipAddress: request.ip,
  userAgent: request.headers['user-agent'],
});

/** รายการรหัสทรัพยากรของงานหลายรายการ - จำกัดจำนวนตั้งแต่ชั้น schema */
const resourceIds = z.array(z.string().min(1).max(191)).min(1).max(200);

export async function f15Routes(app: FastifyInstance): Promise<void> {
  /* ---------------- ชุดค้นหาที่บันทึกไว้ ---------------- */

  app.get('/saved-searches', { preHandler: requireInternal }, async (request) => ({
    success: true,
    data: await listSavedSearches(request.authUser!),
  }));

  app.post('/saved-searches', { preHandler: requireInternal }, async (request, reply) => {
    const input = z
      .object({
        name: z.string().min(1).max(100),
        query: z.string().max(191).optional(),
        filters: searchFiltersSchema.optional(),
      })
      .strict()
      .parse(request.body);
    // userId มาจาก session เสมอ ไม่มีช่องให้ระบุเจ้าของในคำขอ
    return reply
      .status(201)
      .send({ success: true, data: await createSavedSearch(request.authUser!, input) });
  });

  app.get('/saved-searches/:id', { preHandler: requireInternal }, async (request) => {
    const { id } = idParams.parse(request.params);
    const saved = await getSavedSearch(id, request.authUser!);
    await touchSavedSearch(id, request.authUser!);
    return { success: true, data: saved };
  });

  app.patch('/saved-searches/:id', { preHandler: requireInternal }, async (request) => {
    const { id } = idParams.parse(request.params);
    const input = z
      .object({
        name: z.string().min(1).max(100).optional(),
        query: z.string().max(191).optional(),
        filters: searchFiltersSchema.optional(),
      })
      .strict()
      .refine((value) => Object.keys(value).length > 0, 'ต้องระบุอย่างน้อยหนึ่งฟิลด์')
      .parse(request.body);

    if (input.name !== undefined) await renameSavedSearch(id, request.authUser!, input.name);
    if (input.query !== undefined || input.filters !== undefined) {
      return {
        success: true,
        data: await updateSavedSearch(id, request.authUser!, {
          query: input.query,
          filters: input.filters,
        }),
      };
    }
    return { success: true, data: await getSavedSearch(id, request.authUser!) };
  });

  app.delete('/saved-searches/:id', { preHandler: requireInternal }, async (request) => ({
    success: true,
    data: await deleteSavedSearch(idParams.parse(request.params).id, request.authUser!),
  }));

  /* ---------------- มุมมองอัจฉริยะ ---------------- */

  /** รายชื่อมุมมอง - เป็นค่าคงที่ของระบบ ไม่ใช่ข้อมูลของผู้ใช้ */
  app.get('/smart-views', { preHandler: requireInternal }, async () => ({
    success: true,
    data: SMART_VIEWS.map((view) => ({
      slug: view.slug,
      name: view.name,
      description: view.description,
    })),
  }));

  /**
   * ผลลัพธ์ของมุมมองหนึ่ง
   *
   * เดินผ่าน searchResources() ตัวเดียวกับการค้นหาปกติ มุมมองอัจฉริยะจึงไม่ใช่
   * ทางลัดข้ามสิทธิ์ - มันเป็นเพียงชุดตัวกรองสำเร็จรูปที่ผู้ใช้ไม่ต้องกรอกเอง
   */
  app.get('/smart-views/:slug', { preHandler: requireInternal }, async (request) => {
    const { slug } = z.object({ slug: z.string().min(1).max(64) }).parse(request.params);
    const query = z
      .object({
        limit: z.coerce.number().int().min(1).max(100).default(25),
        cursor: z.string().min(1).optional(),
      })
      .parse(request.query);

    const view = findSmartView(slug);
    if (!view) {
      return { success: false, error: { code: 'SMART_VIEW_NOT_FOUND', message: 'ไม่พบมุมมองนี้' } };
    }

    const filters = smartViewFilters(view, request.authUser!.id);
    const data = await searchResources({ ...query, filters }, request.authUser!);
    return { success: true, data: { view: { slug: view.slug, name: view.name }, ...data } };
  });

  /* ---------------- คิวตรวจ OCR ---------------- */

  app.get('/ocr-review/queue', { preHandler: requireInternal }, async (request) => {
    const query = z
      .object({
        lowConfidenceOnly: z.coerce.boolean().optional(),
        fileKind: z.enum(['pdf', 'image']).optional(),
        ownerId: z.string().min(1).optional(),
        from: z.coerce.date().optional(),
        to: z.coerce.date().optional(),
        order: z.enum(['oldest', 'newest', 'lowestConfidence']).optional(),
        limit: z.coerce.number().int().min(1).max(50).default(20),
      })
      .parse(request.query);

    const { limit, ...filters } = query;
    return { success: true, data: await reviewQueue(request.authUser!, filters, limit) };
  });

  /**
   * ยืนยันว่าเครื่องอ่านถูกต้องแล้ว
   *
   * ไม่เปลี่ยน textSource - ข้อความยังเป็นผลของเครื่องทุกตัวอักษร
   * การแก้ข้อความใช้เส้นทางของ F14 (PUT /resources/:id/ocr-text) ซึ่งจะตั้ง
   * สถานะเป็น CORRECTED ให้เอง ไม่มีการเขียนตรรกะการแก้ข้อความซ้ำที่นี่
   */
  app.post('/resources/:id/ocr-review/verify', { preHandler: requireInternal }, async (request) => {
    const { id } = idParams.parse(request.params);
    const result = await verifyOcrResult(id, request.authUser!);
    return { success: true, data: result };
  });

  /** ตัวเลขสรุปสำหรับผู้ดูแล - นับจากสถานะจริงทั้งหมด */
  app.get(
    '/ocr-review/summary',
    { preHandler: requirePermission('admin:access') },
    async () => ({ success: true, data: await reviewSummary() }),
  );

  /* ---------------- ประเภทเอกสาร ---------------- */

  app.get('/document-categories', { preHandler: requireInternal }, async (request) => {
    const query = z.object({ includeInactive: z.coerce.boolean().optional() }).parse(request.query);
    return {
      success: true,
      data: await listCategories(request.authUser!, { includeInactive: query.includeInactive }),
    };
  });

  app.post('/document-categories', { preHandler: requireInternal }, async (request, reply) => {
    const input = z
      .object({ name: z.string().min(1).max(100), sortOrder: z.number().int().optional() })
      .strict()
      .parse(request.body);
    return reply
      .status(201)
      .send({ success: true, data: await createCategory(request.authUser!, input) });
  });

  app.patch('/document-categories/:id', { preHandler: requireInternal }, async (request) => {
    const { id } = idParams.parse(request.params);
    const input = z
      .object({
        name: z.string().min(1).max(100).optional(),
        isActive: z.boolean().optional(),
        sortOrder: z.number().int().optional(),
      })
      .strict()
      .refine((value) => Object.keys(value).length > 0)
      .parse(request.body);
    return { success: true, data: await updateCategory(id, request.authUser!, input) };
  });

  app.delete('/document-categories/:id', { preHandler: requireInternal }, async (request) => ({
    success: true,
    data: await deleteCategory(idParams.parse(request.params).id, request.authUser!),
  }));

  /** สร้างประเภทเริ่มต้นชุดเล็ก - ทำซ้ำได้โดยไม่เกิดของซ้ำ */
  app.post(
    '/document-categories/seed-defaults',
    { preHandler: requirePermission('admin:access') },
    async (request) => ({ success: true, data: await seedDefaultCategories(request.authUser!) }),
  );

  /* ---------------- แก้ข้อมูลหลายรายการ ---------------- */

  app.post('/resources/bulk/tags', { preHandler: requireInternal }, async (request) => {
    const input = z
      .object({ resourceIds, tagName: z.string().min(1).max(64) })
      .strict()
      .parse(request.body);
    return {
      success: true,
      data: await bulkAddTag(input.resourceIds, input.tagName, request.authUser!, audit(request)),
    };
  });

  app.delete('/resources/bulk/tags', { preHandler: requireInternal }, async (request) => {
    const input = z
      .object({ resourceIds, tagId: z.string().min(1).max(191) })
      .strict()
      .parse(request.body);
    return {
      success: true,
      data: await bulkRemoveTag(input.resourceIds, input.tagId, request.authUser!, audit(request)),
    };
  });

  app.post('/resources/bulk/category', { preHandler: requireInternal }, async (request) => {
    const input = z
      .object({ resourceIds, documentCategoryId: z.string().min(1).max(191).nullable() })
      .strict()
      .parse(request.body);
    return {
      success: true,
      data: await bulkSetCategory(
        input.resourceIds,
        input.documentCategoryId,
        request.authUser!,
        audit(request),
      ),
    };
  });

  app.post('/resources/bulk/owner', { preHandler: requireInternal }, async (request) => {
    const input = z
      .object({ resourceIds, newOwnerId: z.string().min(1).max(191) })
      .strict()
      .parse(request.body);
    return {
      success: true,
      data: await bulkSetOwner(
        input.resourceIds,
        input.newOwnerId,
        request.authUser!,
        audit(request),
      ),
    };
  });
}

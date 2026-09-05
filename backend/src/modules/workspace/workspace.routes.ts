import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireInternal } from '../auth/auth.guard.js';
import {
  addFavorite,
  addTagToResource,
  listFavorites,
  listPins,
  listTags,
  lockResource,
  pinResource,
  removeFavorite,
  removeTagFromResource,
  unlockResource,
  unpinResource,
  updateRemark,
} from './workspace.service.js';
import { searchFacets, searchResources } from './search.service.js';
import { listActivityActions, listAdminActivity, listResourceActivity } from './activity.service.js';
import { bulkTransferOwnership, offboardingCheck, ownershipOverview, previewHandover } from './handover.service.js';
import {
  grantAccess,
  listAccess,
  listSharedWithMe,
  revokeAccess,
  searchShareTargets,
} from './sharing.service.js';

const idParams = z.object({ id: z.string().min(1) });
const audit = (request: FastifyRequest) => ({
  ipAddress: request.ip,
  userAgent: request.headers['user-agent'],
});

export async function workspaceRoutes(app: FastifyInstance): Promise<void> {
  /* ---------------- รายการโปรด ---------------- */
  app.get('/favorites', { preHandler: requireInternal }, async (request) => ({
    success: true,
    data: await listFavorites(request.authUser!),
  }));

  app.post('/resources/:id/favorite', { preHandler: requireInternal }, async (request) => ({
    success: true,
    data: await addFavorite(idParams.parse(request.params).id, request.authUser!),
  }));

  app.delete('/resources/:id/favorite', { preHandler: requireInternal }, async (request) => ({
    success: true,
    data: await removeFavorite(idParams.parse(request.params).id, request.authUser!),
  }));

  /* ---------------- ปักหมุด ---------------- */
  app.get('/pins', { preHandler: requireInternal }, async (request) => ({
    success: true,
    data: await listPins(request.authUser!),
  }));

  app.post('/resources/:id/pin', { preHandler: requireInternal }, async (request) => ({
    success: true,
    data: await pinResource(idParams.parse(request.params).id, request.authUser!),
  }));

  app.delete('/resources/:id/pin', { preHandler: requireInternal }, async (request) => ({
    success: true,
    data: await unpinResource(idParams.parse(request.params).id, request.authUser!),
  }));

  /* ---------------- แท็ก ---------------- */
  app.get('/tags', { preHandler: requireInternal }, async (request) => {
    const query = z.object({ q: z.string().optional() }).parse(request.query);
    return { success: true, data: await listTags(request.authUser!, query.q) };
  });

  app.post('/resources/:id/tags', { preHandler: requireInternal }, async (request) => {
    const body = z.object({ name: z.string().min(1).max(64) }).parse(request.body);
    return {
      success: true,
      data: await addTagToResource(idParams.parse(request.params).id, body.name, request.authUser!, audit(request)),
    };
  });

  app.delete('/resources/:id/tags/:tagId', { preHandler: requireInternal }, async (request) => {
    const params = z.object({ id: z.string().min(1), tagId: z.string().min(1) }).parse(request.params);
    return {
      success: true,
      data: await removeTagFromResource(params.id, params.tagId, request.authUser!, audit(request)),
    };
  });

  /* ---------------- หมายเหตุ ---------------- */
  app.patch('/resources/:id/remark', { preHandler: requireInternal }, async (request) => {
    const body = z.object({ remark: z.string().max(1000).nullable() }).parse(request.body);
    return {
      success: true,
      data: await updateRemark(idParams.parse(request.params).id, body.remark, request.authUser!, audit(request)),
    };
  });

  /* ---------------- ล็อก ---------------- */
  app.post('/resources/:id/lock', { preHandler: requireInternal }, async (request) => {
    const body = z.object({ reason: z.string().max(500).nullable().optional() }).parse(request.body ?? {});
    return {
      success: true,
      data: await lockResource(
        idParams.parse(request.params).id,
        { reason: body.reason ?? null },
        request.authUser!,
        audit(request),
      ),
    };
  });

  app.delete('/resources/:id/lock', { preHandler: requireInternal }, async (request) => ({
    success: true,
    data: await unlockResource(idParams.parse(request.params).id, request.authUser!, audit(request)),
  }));

  /* ---------------- การแชร์ภายในองค์กร ---------------- */
  app.get('/resources/:id/access', { preHandler: requireInternal }, async (request) => ({
    success: true,
    data: await listAccess(idParams.parse(request.params).id, request.authUser!),
  }));

  app.post('/resources/:id/access', { preHandler: requireInternal }, async (request) => {
    const body = z
      .object({
        userId: z.string().min(1),
        accessLevel: z.enum(['EDITOR', 'VIEWER']),
        allowDownload: z.boolean().default(true),
        /**
         * เวลาสัมบูรณ์เสมอ หน้าจอเป็นผู้แปลตัวเลือก "7 วัน / 30 วัน / 90 วัน" เป็นวันที่จริง
         * เซิร์ฟเวอร์ไม่เก็บ "จำนวนวัน" เพราะจุดอ้างอิงจะกำกวมทันทีที่มีการแก้ไขสิทธิ์ภายหลัง
         */
        expiresAt: z.coerce.date().nullish(),
      })
      .parse(request.body);
    return {
      success: true,
      data: await grantAccess(idParams.parse(request.params).id, body, request.authUser!, audit(request)),
    };
  });

  app.delete('/resources/:id/access/:userId', { preHandler: requireInternal }, async (request) => {
    const params = z.object({ id: z.string().min(1), userId: z.string().min(1) }).parse(request.params);
    return {
      success: true,
      data: await revokeAccess(params.id, params.userId, request.authUser!, audit(request)),
    };
  });

  app.get('/shared', { preHandler: requireInternal }, async (request) => ({
    success: true,
    data: await listSharedWithMe(request.authUser!),
  }));

  app.get('/share-targets', { preHandler: requireInternal }, async (request) => {
    const query = z
      .object({
        q: z.string().default(''),
        limit: z.coerce.number().int().min(1).max(25).default(10),
        /** หน้าจอค้นหาแยกกลุ่ม เพื่อให้ "บุคลากรภายใน" กับ "ลูกค้า" ไม่ปะปนกันในรายการเดียว */
        scope: z.enum(['INTERNAL', 'EXTERNAL']).optional(),
      })
      .parse(request.query);
    return {
      success: true,
      data: await searchShareTargets(query.q, request.authUser!, query.limit, query.scope),
    };
  });
  /* ---------------- ค้นหา ---------------- */
  const isoDate = z.coerce.date().optional();
  app.get('/search', { preHandler: requireInternal }, async (request) => {
    const query = z
      .object({
        q: z.string().max(191).optional(),
        type: z.enum(['FOLDER', 'FILE']).optional(),
        sourceType: z
          .enum(['MANUAL', 'GOOGLE', 'S2_PAYROLL', 'S2_ERP', 'S2_LINE_BOT', 'EXTERNAL_UPLOAD', 'SYSTEM'])
          .optional(),
        ownerId: z.string().min(1).optional(),
        tagId: z.string().min(1).optional(),
        visibility: z.enum(['ORGANIZATION', 'RESTRICTED']).optional(),
        updatedFrom: isoDate,
        updatedTo: isoDate,
        favoriteOnly: z.coerce.boolean().optional(),
        limit: z.coerce.number().int().min(1).max(100).default(25),
        cursor: z.string().min(1).optional(),

        /* ---- ตัวกรองขั้นสูงของ F15 ---- */
        fileKind: z
          .enum(['pdf', 'image', 'word', 'excel', 'powerpoint', 'text', 'link', 'folder', 'other'])
          .optional(),
        driveScope: z.enum(['MY_DRIVE', 'SYSTEM_DRIVE']).optional(),
        createdById: z.string().min(1).optional(),
        untaggedOnly: z.coerce.boolean().optional(),
        documentCategoryId: z.string().min(1).optional(),
        uncategorizedOnly: z.coerce.boolean().optional(),
        textSource: z.enum(['NATIVE_TEXT', 'OCR', 'HUMAN_CORRECTED']).optional(),
        ocrState: z
          .enum(['PENDING', 'PROCESSING', 'READY', 'NEEDS_OCR', 'OCR_DONE', 'FAILED', 'REVIEWED'])
          .optional(),
        hasText: z.coerce.boolean().optional(),
        uploadedPreset: z.enum(['today', 'last7', 'last30', 'thisMonth', 'custom']).optional(),
        uploadedFrom: isoDate,
        uploadedTo: isoDate,
        updatedPreset: z.enum(['today', 'last7', 'last30', 'thisMonth', 'custom']).optional(),
        sort: z.enum(['relevance', 'newest', 'oldest', 'name', 'largest']).optional(),
      })
      .parse(request.query);

    /**
     * แยกตัวกรองขั้นสูงออกจากพารามิเตอร์เดิม
     *
     * พารามิเตอร์เดิมของ F12 ยังทำงานเหมือนเดิมทุกอย่าง ลิงก์และชุดค้นหาเก่า
     * จึงไม่พังเมื่อ F15 เพิ่มตัวกรองเข้ามา
     */
    const {
      fileKind, driveScope, createdById, untaggedOnly, documentCategoryId, uncategorizedOnly,
      textSource, ocrState, hasText, uploadedPreset, uploadedFrom, uploadedTo,
      updatedPreset, sort, ...base
    } = query;

    return {
      success: true,
      data: await searchResources(
        {
          ...base,
          filters: {
            fileKind, driveScope, createdById, untaggedOnly, documentCategoryId,
            uncategorizedOnly, textSource, ocrState, hasText, uploadedPreset,
            uploadedFrom, uploadedTo, updatedPreset,
            updatedFrom: base.updatedFrom, updatedTo: base.updatedTo,
            sort,
          },
        },
        request.authUser!,
      ),
    };
  });

  app.get('/search/facets', { preHandler: requireInternal }, async (request) => ({
    success: true,
    data: await searchFacets(request.authUser!),
  }));

  /* ---------------- ประวัติการใช้งาน ---------------- */
  app.get('/resources/:id/activity', { preHandler: requireInternal }, async (request) => {
    const query = z
      .object({
        limit: z.coerce.number().int().min(1).max(100).default(25),
        cursor: z.string().min(1).optional(),
      })
      .parse(request.query);
    return {
      success: true,
      data: await listResourceActivity(idParams.parse(request.params).id, request.authUser!, query),
    };
  });

  app.get('/activity', { preHandler: requireInternal }, async (request) => {
    const query = z
      .object({
        userId: z.string().min(1).optional(),
        action: z.string().max(100).optional(),
        resourceId: z.string().min(1).optional(),
        from: isoDate,
        to: isoDate,
        limit: z.coerce.number().int().min(1).max(100).default(50),
        cursor: z.string().min(1).optional(),
      })
      .parse(request.query);
    return { success: true, data: await listAdminActivity(query, request.authUser!) };
  });

  app.get('/activity/actions', { preHandler: requireInternal }, async (request) => ({
    success: true,
    data: await listActivityActions(request.authUser!),
  }));

  /* ---------------- ส่งมอบความรับผิดชอบ ---------------- */
  app.get('/handover/overview', { preHandler: requireInternal }, async (request) => ({
    success: true,
    data: await ownershipOverview(request.authUser!),
  }));

  app.get('/handover/preview', { preHandler: requireInternal }, async (request) => {
    const query = z.object({ fromUserId: z.string().min(1), toUserId: z.string().min(1) }).parse(request.query);
    return {
      success: true,
      data: await previewHandover(query.fromUserId, query.toUserId, request.authUser!),
    };
  });

  app.post('/handover/transfer', { preHandler: requireInternal }, async (request) => {
    const body = z.object({ fromUserId: z.string().min(1), toUserId: z.string().min(1) }).parse(request.body);
    return {
      success: true,
      data: await bulkTransferOwnership(body.fromUserId, body.toUserId, request.authUser!, audit(request)),
    };
  });

  app.get('/users/:id/offboarding-check', { preHandler: requireInternal }, async (request) => ({
    success: true,
    data: await offboardingCheck(idParams.parse(request.params).id, request.authUser!),
  }));
}

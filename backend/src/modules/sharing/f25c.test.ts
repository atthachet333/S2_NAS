import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app.js';
import { prisma } from '../../core/prisma.js';
import { issueSessionForUser, type AuthUser } from '../auth/auth.service.js';
import { createFolder } from '../resources/resource.service.js';
import { effectiveAccessReview, neutralizeCsvCell } from './access-review.service.js';
import { shareStatus } from './public-share.service.js';

const prefix = `f25c-${Date.now().toString(36)}`;
const audit = { ipAddress: '127.0.0.1', userAgent: 'f25c-test' };

describe('F25-C effective access and link governance', () => {
  let app: FastifyInstance;
  let adminId = '';
  let ordinaryId = '';
  let portalId = '';
  let disabledId = '';
  let rootId = '';
  let childId = '';
  let adminToken = '';
  let ordinaryToken = '';
  let portalToken = '';

  before(async () => {
    app = await buildApp();
    await app.ready();
    const users = await Promise.all([
      prisma.user.create({ data: { email: `${prefix}-admin@example.invalid`, displayName: 'F25C Admin', status: 'ACTIVE' } }),
      prisma.user.create({ data: { email: `${prefix}-ordinary@example.invalid`, displayName: 'F25C Ordinary', status: 'ACTIVE' } }),
      prisma.user.create({ data: { email: `${prefix}-portal@example.invalid`, displayName: '=HYPERLINK("unsafe")', type: 'EXTERNAL', status: 'ACTIVE', organizationName: 'Formula =Corp' } }),
      prisma.user.create({ data: { email: `${prefix}-disabled@example.invalid`, displayName: 'F25C Disabled', status: 'DISABLED' } }),
    ]);
    [adminId, ordinaryId, portalId, disabledId] = users.map((user) => user.id);
    const [adminRole, memberRole] = await Promise.all([
      prisma.role.findUniqueOrThrow({ where: { code: 'ADMIN' } }),
      prisma.role.findUniqueOrThrow({ where: { code: 'MEMBER' } }),
    ]);
    await prisma.userRole.createMany({ data: [
      { userId: adminId, roleId: adminRole.id },
      { userId: ordinaryId, roleId: memberRole.id },
      { userId: disabledId, roleId: memberRole.id },
    ] });
    const admin: AuthUser = {
      id: adminId, email: users[0].email, displayName: users[0].displayName,
      type: 'INTERNAL', status: 'ACTIVE', mustChangePassword: false,
      roles: ['ADMIN'], permissions: ['resources:read', 'resources:write', 'resources:delete', 'resources:share'],
    };
    const root = await createFolder(admin, { name: `${prefix}-root`, parentId: null }, audit);
    const child = await createFolder(admin, { name: `${prefix}-child`, parentId: root.id }, audit);
    rootId = root.id;
    childId = child.id;
    /*
     * visibility = RESTRICTED  คือประเด็นเดิมของ F25-C: ใครในองค์กรเห็นได้บ้าง
     * classification = PUBLIC คือเพดานการเปิดออกนอกองค์กรที่ F25-D เพิ่มเข้ามา
     *
     * สองอย่างนี้ตั้งพร้อมกันได้และไม่ขัดกัน - เอกสารที่จำกัดคนในแต่เปิดลิงก์ให้คนนอกได้
     * มีอยู่จริง ชุดทดสอบนี้ต้องประกาศเพดานให้ชัด เพราะมันตรวจสถานะของลิงก์ ไม่ได้ตรวจชั้นความลับ
     */
    await prisma.resource.updateMany({
      where: { id: { in: [rootId, childId] } },
      data: { visibility: 'RESTRICTED', classification: 'PUBLIC' },
    });
    await prisma.resourceAccess.createMany({ data: [
      { resourceId: rootId, userId: portalId, accessLevel: 'VIEWER', allowDownload: false, createdById: adminId },
      { resourceId: childId, userId: portalId, accessLevel: 'EDITOR', allowDownload: true, createdById: adminId },
      { resourceId: childId, userId: disabledId, accessLevel: 'EDITOR', allowDownload: true, createdById: adminId },
    ] });
    const now = Date.now();
    await prisma.publicShareLink.createMany({ data: [
      { resourceId: childId, tokenHash: `${prefix}-active`, createdById: adminId, expiresAt: new Date(now + 86_400_000), allowPreview: true },
      { resourceId: childId, tokenHash: `${prefix}-expired`, createdById: adminId, expiresAt: new Date(now - 86_400_000), allowPreview: true },
      { resourceId: childId, tokenHash: `${prefix}-revoked`, createdById: adminId, revokedAt: new Date(), revokedById: adminId, allowPreview: true },
      { resourceId: childId, tokenHash: `${prefix}-limited`, createdById: adminId, maxViews: 1, viewCount: 1, allowPreview: true },
      { resourceId: rootId, tokenHash: `${prefix}-inherited`, createdById: adminId, allowPreview: true, allowDownload: false },
    ] });
    adminToken = (await issueSessionForUser(adminId)).accessToken;
    ordinaryToken = (await issueSessionForUser(ordinaryId)).accessToken;
    portalToken = (await issueSessionForUser(portalId)).accessToken;
  });

  after(async () => {
    await app.close();
    await prisma.activityLog.deleteMany({ where: { userId: { in: [adminId, ordinaryId, portalId, disabledId] } } });
    await prisma.resource.deleteMany({ where: { id: childId } });
    await prisma.resource.deleteMany({ where: { id: rootId } });
    await prisma.user.deleteMany({ where: { id: { in: [adminId, ordinaryId, portalId, disabledId] } } });
  });

  test('portal evidence preserves direct and inherited sources; nearest direct grant controls role and download', async () => {
    const review = await effectiveAccessReview(childId);
    const portal = review.entries.find((entry) => entry.subject.id === portalId)!;
    assert.equal(portal.channel, 'PORTAL');
    assert.equal(portal.effectiveRole, 'CONTRIBUTOR');
    assert.equal(portal.allowDownload, true);
    assert.deepEqual(new Set(portal.evidence.map((evidence) => evidence.source)), new Set(['DIRECT', 'INHERITED']));
    assert.equal(portal.evidence.find((evidence) => evidence.source === 'INHERITED')?.sourceResourceId, rootId);
  });

  test('disabled assignments remain evidence but are not effective', async () => {
    const review = await effectiveAccessReview(childId);
    const disabled = review.entries.find((entry) => entry.subject.id === disabledId)!;
    assert.equal(disabled.usable, false);
    assert.equal(disabled.status, 'PRINCIPAL_INACTIVE');
    assert.equal(review.summary.effectiveUsers, review.entries.filter((entry) => entry.usable).length);
  });

  test('one authoritative status excludes expired, revoked and exhausted links from active counts and responses contain no tokens', async () => {
    const review = await effectiveAccessReview(childId);
    assert.equal(review.summary.activePublicLinks, 2);
    assert.deepEqual(new Set(review.publicLinks.map((link) => link.status)), new Set(['ACTIVE', 'EXPIRED', 'REVOKED', 'LIMIT_REACHED']));
    assert.equal(review.publicLinks.find((link) => link.sourceResourceId === rootId)?.source, 'INHERITED');
    assert.equal(JSON.stringify(review).includes(`${prefix}-active`), false);
    const rows = await prisma.publicShareLink.findMany({ where: { resourceId: childId }, include: { resource: true } });
    assert.equal(rows.filter((row) => shareStatus(row, row.resource) === 'ACTIVE').length, 1);
    const allRows = await prisma.publicShareLink.findMany({ include: { resource: true } });
    const expectedActive = allRows.filter((row) => shareStatus(row, row.resource) === 'ACTIVE').length;
    const summary = await app.inject({ method: 'GET', url: '/api/admin/public-shares/summary', headers: { authorization: `Bearer ${adminToken}` } });
    assert.equal(summary.statusCode, 200);
    assert.equal(summary.json().data.active, expectedActive);
    const activeList = await app.inject({ method: 'GET', url: `/api/admin/public-shares?status=ACTIVE&resourceId=${childId}`, headers: { authorization: `Bearer ${adminToken}` } });
    assert.equal(activeList.statusCode, 200);
    assert.ok(activeList.json().data.items.every((item: { status: string }) => item.status === 'ACTIVE'));
  });

  test('HTTP review/export are admin-only, forged IDs do not disclose data, and CSV formulas are neutralized', async () => {
    const denied = await app.inject({ method: 'GET', url: `/api/resources/${childId}/access-review`, headers: { authorization: `Bearer ${ordinaryToken}` } });
    assert.equal(denied.statusCode, 403);
    const externalDenied = await app.inject({ method: 'GET', url: `/api/resources/${childId}/access-review`, headers: { authorization: `Bearer ${portalToken}` } });
    assert.equal(externalDenied.statusCode, 403);
    const forged = await app.inject({ method: 'GET', url: '/api/resources/not-a-real-resource/access-review', headers: { authorization: `Bearer ${adminToken}` } });
    assert.equal(forged.statusCode, 404);
    const allowed = await app.inject({ method: 'GET', url: `/api/resources/${childId}/access-review`, headers: { authorization: `Bearer ${adminToken}` } });
    assert.equal(allowed.statusCode, 200);
    assert.equal(allowed.body.includes('tokenHash'), false);
    const deniedExport = await app.inject({ method: 'GET', url: `/api/resources/${childId}/access-review/export`, headers: { authorization: `Bearer ${ordinaryToken}` } });
    assert.equal(deniedExport.statusCode, 403);
    const exported = await app.inject({ method: 'GET', url: `/api/resources/${childId}/access-review/export`, headers: { authorization: `Bearer ${adminToken}` } });
    assert.equal(exported.statusCode, 200);
    assert.match(exported.body, /'\=HYPERLINK/);
    assert.equal(exported.body.includes('tokenHash'), false);
    assert.ok(await prisma.activityLog.findFirst({ where: { resourceId: childId, action: 'ACCESS_EXPORT_CREATED' } }));
    assert.equal(neutralizeCsvCell('=HYPERLINK("evil")').startsWith('"\'='), true);
  });
});

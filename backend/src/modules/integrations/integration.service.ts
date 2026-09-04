import crypto from 'node:crypto';
import type { ResourceSourceType, ResourceType } from '@prisma/client';
import { prisma } from '../../core/prisma.js';
import { AppError, badRequest, notFound } from '../../core/errors.js';
import type { AuthUser } from '../auth/auth.service.js';
import { resourceInclude, toResourceDto, validateResourceName } from '../resources/resource.service.js';
import { isExternalResourceType, validateExternalResourceUrl } from '../resources/external-resource.js';

export const INTEGRATION_SCOPES = ['resources:read','resources:create','resources:upload','resources:update','resources:download','resources:metadata'] as const;
export type IntegrationScope = (typeof INTEGRATION_SCOPES)[number];
export interface IntegrationAuth { app: IntegrationAppRecord; user: AuthUser; credentialId: string }
type IntegrationAppRecord = Awaited<ReturnType<typeof loadApp>>;
type Audit = { ipAddress?: string; userAgent?: string };

const appInclude = {
  actorUser: { select: { id: true, email: true, displayName: true, status: true } },
  allowedRoot: { select: { id: true, name: true, ownerId: true, visibility: true } },
  credentials: { select: { id: true, label: true, createdAt: true, lastUsedAt: true, expiresAt: true, revokedAt: true }, orderBy: { createdAt: 'desc' as const } },
  _count: { select: { credentials: true } },
} as const;

function normalizeCode(raw: string) {
  const code = raw.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9_]{2,63}$/u.test(code)) throw badRequest('INVALID_INTEGRATION_CODE', 'Code ต้องเป็น A-Z, 0-9 หรือ _');
  return code;
}
function sourceTypeFor(code: string): ResourceSourceType {
  return code === 'S2_PAYROLL' ? 'S2_PAYROLL' : code === 'S2_ERP' ? 'S2_ERP' : code === 'S2_LINE_BOT' ? 'S2_LINE_BOT' : 'EXTERNAL_UPLOAD';
}
function hash(value: string) { return crypto.createHash('sha256').update(value, 'utf8').digest('hex'); }
import { siblingKey } from '../resources/sibling-key.js';
export function validateIntegrationSourceUrl(raw?: string | null): string | null {
  if (!raw) return null;
  let url: URL;
  try { url = new URL(raw.trim()); } catch { throw badRequest('UNSAFE_URL_SCHEME', 'URL ต้นทางไม่ถูกต้อง'); }
  if (!['http:','https:'].includes(url.protocol) || url.username || url.password) throw badRequest('UNSAFE_URL_SCHEME', 'URL ต้นทางไม่ถูกต้อง');
  return url.toString();
}

async function loadApp(id: string) {
  const app = await prisma.integrationApp.findUnique({ where: { id }, include: appInclude });
  if (!app) throw notFound('INTEGRATION_APP_NOT_FOUND', 'ไม่พบ Connected App');
  return app;
}
export async function listApps() { return prisma.integrationApp.findMany({ include: appInclude, orderBy: { createdAt: 'desc' } }); }
export async function getApp(id: string) { return loadApp(id); }

export async function createApp(input: { name: string; code: string; description?: string | null; allowedRootId: string; scopes: IntegrationScope[] }, actor: AuthUser, audit: Audit) {
  const name = input.name.trim(); if (!name || name.length > 191) throw badRequest('INVALID_RESOURCE_NAME', 'ชื่อแอปไม่ถูกต้อง');
  const code = normalizeCode(input.code);
  const root = await prisma.resource.findFirst({ where: { id: input.allowedRootId, type: 'FOLDER', deletedAt: null } });
  if (!root) throw notFound('FOLDER_NOT_FOUND', 'ไม่พบโฟลเดอร์ขอบเขต');
  const scopes = [...new Set(input.scopes)];
  try {
    const id = await prisma.$transaction(async tx => {
      const serviceUser = await tx.user.create({ data: { email: `${code.toLowerCase()}.${crypto.randomUUID()}@integration.s2nas.local`, displayName: name, type: 'SERVICE', status: 'ACTIVE', mustChangePassword: false } });
      const app = await tx.integrationApp.create({ data: { name, code, description: input.description?.trim() || null, allowedRootId: root.id, scopes, actorUserId: serviceUser.id } });
      await tx.activityLog.create({ data: { userId: actor.id, action: 'INTEGRATION_APP_CREATED', integrationAppId: app.id, ipAddress: audit.ipAddress, userAgent: audit.userAgent?.slice(0,500), metadata: { code, allowedRootId: root.id, scopes } } });
      return app.id;
    });
    return loadApp(id);
  } catch (error) {
    if ((error as { code?: string }).code === 'P2002') throw new AppError('INTEGRATION_CODE_EXISTS', 'Code นี้ถูกใช้งานแล้ว', 409);
    throw error;
  }
}

export async function updateApp(id: string, input: { isActive?: boolean; name?: string; description?: string | null; allowedRootId?: string; scopes?: IntegrationScope[] }, actor: AuthUser, audit: Audit) {
  await loadApp(id);
  if (input.allowedRootId) {
    const root = await prisma.resource.findFirst({ where: { id: input.allowedRootId, type: 'FOLDER', deletedAt: null } });
    if (!root) throw notFound('FOLDER_NOT_FOUND', 'ไม่พบโฟลเดอร์ขอบเขต');
  }
  await prisma.$transaction(async tx => {
    await tx.integrationApp.update({ where: { id }, data: { name: input.name?.trim(), description: input.description === undefined ? undefined : input.description?.trim() || null, isActive: input.isActive, allowedRootId: input.allowedRootId, scopes: input.scopes ? [...new Set(input.scopes)] : undefined } });
    await tx.activityLog.create({ data: { userId: actor.id, action: 'INTEGRATION_APP_UPDATED', integrationAppId: id, ipAddress: audit.ipAddress, userAgent: audit.userAgent?.slice(0,500) } });
  });
  return loadApp(id);
}

export async function createCredential(appId: string, input: { label?: string | null; expiresAt?: Date | null }, actor: AuthUser, audit: Audit) {
  await loadApp(appId);
  const id = crypto.randomUUID(); const secret = crypto.randomBytes(32).toString('base64url'); const apiKey = `s2nas_${id}_${secret}`;
  await prisma.$transaction(async tx => {
    await tx.integrationCredential.create({ data: { id, appId, secretHash: hash(secret), label: input.label?.trim() || null, expiresAt: input.expiresAt } });
    await tx.activityLog.create({ data: { userId: actor.id, action: 'INTEGRATION_CREDENTIAL_CREATED', integrationAppId: appId, ipAddress: audit.ipAddress, userAgent: audit.userAgent?.slice(0,500), metadata: { credentialId: id } } });
  });
  return { credentialId: id, secret: apiKey };
}

export async function revokeCredential(appId: string, credentialId: string, actor: AuthUser, audit: Audit) {
  const credential = await prisma.integrationCredential.findFirst({ where: { id: credentialId, appId } });
  if (!credential) throw notFound('INTEGRATION_CREDENTIAL_NOT_FOUND', 'ไม่พบ Credential');
  if (!credential.revokedAt) await prisma.$transaction(async tx => {
    await tx.integrationCredential.update({ where: { id: credentialId }, data: { revokedAt: new Date() } });
    await tx.activityLog.create({ data: { userId: actor.id, action: 'INTEGRATION_CREDENTIAL_REVOKED', integrationAppId: appId, ipAddress: audit.ipAddress, userAgent: audit.userAgent?.slice(0,500), metadata: { credentialId } } });
  });
  return { revoked: true };
}

export async function authenticateApiKey(apiKey: string): Promise<IntegrationAuth> {
  const match = /^s2nas_([0-9a-f-]{36})_([A-Za-z0-9_-]{40,})$/u.exec(apiKey);
  if (!match) throw new AppError('INTEGRATION_AUTH_FAILED', 'Integration authentication failed', 401);
  const credential = await prisma.integrationCredential.findUnique({ where: { id: match[1]! }, include: { app: { include: appInclude } } });
  const supplied = Buffer.from(hash(match[2]!), 'hex');
  const stored = credential ? Buffer.from(credential.secretHash, 'hex') : Buffer.alloc(32);
  const valid = crypto.timingSafeEqual(supplied, stored);
  if (!credential || !valid || (credential.expiresAt && credential.expiresAt <= new Date())) throw new AppError('INTEGRATION_AUTH_FAILED', 'Integration authentication failed', 401);
  if (credential.revokedAt) throw new AppError('INTEGRATION_CREDENTIAL_REVOKED', 'Integration credential has been revoked', 401);
  if (!credential.app.isActive) throw new AppError('INTEGRATION_DISABLED', 'Integration is disabled', 403);
  const scopes = credential.app.scopes as string[];
  const permissions = [scopes.includes('resources:read') ? 'resources:read' : '', scopes.some(s=>['resources:create','resources:upload','resources:update','resources:metadata'].includes(s)) ? 'resources:write' : ''].filter(Boolean);
  const user: AuthUser = { id: credential.app.actorUser.id, email: credential.app.actorUser.email, displayName: credential.app.name, type: 'SERVICE', status: 'ACTIVE', mustChangePassword: false, roles: ['SERVICE'], permissions };
  const now = new Date();
  await prisma.$transaction([prisma.integrationCredential.update({ where: { id: credential.id }, data: { lastUsedAt: now } }), prisma.integrationApp.update({ where: { id: credential.appId }, data: { lastUsedAt: now } })]);
  return { app: credential.app, user, credentialId: credential.id };
}

export function requireScope(auth: IntegrationAuth, scope: IntegrationScope) {
  if (!(auth.app.scopes as string[]).includes(scope)) throw new AppError('INTEGRATION_PERMISSION_DENIED', 'Integration permission denied', 403);
}
export async function assertWithinScope(app: IntegrationAppRecord, resourceId: string) {
  let cursor: string | null = resourceId; const seen = new Set<string>();
  while (cursor) {
    if (cursor === app.allowedRootId) return;
    if (seen.has(cursor)) break; seen.add(cursor);
    const resource: { parentId: string | null } | null = await prisma.resource.findFirst({ where: { id: cursor, deletedAt: null }, select: { parentId: true } });
    if (!resource) break; cursor = resource.parentId;
  }
  throw new AppError('INTEGRATION_SCOPE_DENIED', 'Resource is outside the integration folder scope', 403);
}

export async function createMetadata(auth: IntegrationAuth, input: { type: ResourceType; name: string; parentId: string; remark?: string | null; externalUrl?: string | null; sourceEntityType?: string | null; sourceEntityId?: string | null; sourceUrl?: string | null }, idempotencyKey?: string) {
  requireScope(auth, 'resources:create'); await assertWithinScope(auth.app, input.parentId);
  const parent = await prisma.resource.findFirst({ where: { id: input.parentId, type: 'FOLDER', deletedAt: null } });
  if (!parent) throw notFound('FOLDER_NOT_FOUND', 'ไม่พบโฟลเดอร์ปลายทาง');
  const named = validateResourceName(input.name); const requestHash = hash(JSON.stringify(input));
  if (idempotencyKey) {
    const previous = await prisma.integrationIdempotency.findUnique({ where: { appId_key: { appId: auth.app.id, key: idempotencyKey } }, include: { resource: { include: resourceInclude } } });
    if (previous) {
      if (previous.requestHash !== requestHash) throw new AppError('INTEGRATION_IDEMPOTENCY_CONFLICT', 'Idempotency key was used with different input', 409);
      return toResourceDto(previous.resource, auth.user);
    }
  }
  let externalUrl: string | null = null; let externalProvider: string | null = null;
  if (isExternalResourceType(input.type)) { externalUrl = validateExternalResourceUrl(input.type, input.externalUrl ?? ''); externalProvider = input.type === 'GOOGLE_SHEET' ? 'GOOGLE_SHEETS' : input.type === 'GOOGLE_DOC' ? 'GOOGLE_DOCS' : input.type === 'GOOGLE_DRIVE' ? 'GOOGLE_DRIVE' : 'WEB'; }
  if (!['FOLDER','WEB_LINK','GOOGLE_SHEET','GOOGLE_DOC','GOOGLE_DRIVE'].includes(input.type)) throw badRequest('INVALID_EXTERNAL_RESOURCE_TYPE', 'ไม่รองรับชนิดทรัพยากรนี้');
  const id = await prisma.$transaction(async tx => {
    const resource = await tx.resource.create({ data: { type: input.type, ...named, siblingKey: siblingKey(input.parentId,named.normalizedName,parent.driveScope), parentId: input.parentId, ownerId: parent.ownerId, driveScope: parent.driveScope, createdById: auth.user.id, updatedById: auth.user.id, createdByIntegrationAppId: auth.app.id, sourceType: sourceTypeFor(auth.app.code), sourceSystem: auth.app.code, sourceEntityType: input.sourceEntityType?.trim() || null, sourceEntityId: input.sourceEntityId?.trim() || null, sourceUrl: validateIntegrationSourceUrl(input.sourceUrl), externalUrl, externalProvider, remark: input.remark?.trim() || null, visibility: parent.visibility } });
    if (idempotencyKey) await tx.integrationIdempotency.create({ data: { appId: auth.app.id, key: idempotencyKey, requestHash, resourceId: resource.id } });
    await tx.activityLog.create({ data: { userId: auth.user.id, integrationAppId: auth.app.id, action: 'INTEGRATION_RESOURCE_CREATED', resourceId: resource.id, metadata: { sourceEntityType: input.sourceEntityType, sourceEntityId: input.sourceEntityId } } });
    return resource.id;
  });
  const resource = await prisma.resource.findUniqueOrThrow({ where: { id }, include: resourceInclude }); return toResourceDto(resource, auth.user);
}

export async function getScopedResource(auth: IntegrationAuth, id: string) { requireScope(auth,'resources:read'); await assertWithinScope(auth.app,id); const resource=await prisma.resource.findFirst({where:{id,deletedAt:null},include:resourceInclude}); if(!resource) throw notFound('RESOURCE_NOT_FOUND','ไม่พบทรัพยากร'); return toResourceDto(resource,auth.user); }
export async function getScopedMetadata(auth: IntegrationAuth, id: string) { requireScope(auth,'resources:metadata'); await assertWithinScope(auth.app,id); const resource=await prisma.resource.findFirst({where:{id,deletedAt:null},include:resourceInclude}); if(!resource) throw notFound('RESOURCE_NOT_FOUND','ไม่พบทรัพยากร'); return toResourceDto(resource,auth.user); }
export async function listScopedResources(auth: IntegrationAuth, parentId: string) { requireScope(auth,'resources:read'); await assertWithinScope(auth.app,parentId); const rows=await prisma.resource.findMany({where:{parentId,deletedAt:null},include:resourceInclude,orderBy:{normalizedName:'asc'},take:100}); return rows.map(r=>toResourceDto(r,auth.user)); }
export async function updateScopedResource(auth: IntegrationAuth, id: string, input: { name?: string; remark?: string | null; externalUrl?: string }) {
  requireScope(auth,'resources:update'); await assertWithinScope(auth.app,id);
  const current=await prisma.resource.findFirst({where:{id,deletedAt:null}}); if(!current) throw notFound('RESOURCE_NOT_FOUND','ไม่พบทรัพยากร');
  const named=input.name===undefined?null:validateResourceName(input.name);
  let externalUrl: string|undefined;
  if(input.externalUrl!==undefined){ if(!isExternalResourceType(current.type)) throw badRequest('INVALID_EXTERNAL_RESOURCE_TYPE','ทรัพยากรนี้ไม่ใช่ลิงก์ภายนอก'); externalUrl=validateExternalResourceUrl(current.type,input.externalUrl); }
  await prisma.$transaction(async tx=>{ await tx.resource.update({where:{id},data:{...(named?{...named,siblingKey:siblingKey(current.parentId,named.normalizedName,current.driveScope)}:{}),remark:input.remark,externalUrl,updatedById:auth.user.id}}); await tx.activityLog.create({data:{userId:auth.user.id,integrationAppId:auth.app.id,action:'INTEGRATION_RESOURCE_UPDATED',resourceId:id}}); });
  return getScopedResource(auth,id);
}
export function sourceTypeForApp(code: string) { return sourceTypeFor(code); }
export function requestFingerprint(value: unknown) { return hash(JSON.stringify(value)); }

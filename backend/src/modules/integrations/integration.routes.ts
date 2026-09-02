import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../core/prisma.js';
import { AppError, badRequest } from '../../core/errors.js';
import { requirePermission } from '../auth/auth.guard.js';
import { uploadFile, uploadVersion } from '../files/file.service.js';
import { resolveContent } from '../files/file.service.js';
import { sendFile } from '../files/file.routes.js';
import {
  INTEGRATION_SCOPES, assertWithinScope, authenticateApiKey, createApp, createCredential, createMetadata,
  getApp, getScopedMetadata, getScopedResource, listApps, listScopedResources, requestFingerprint, requireScope,
  revokeCredential, sourceTypeForApp, updateApp, updateScopedResource, validateIntegrationSourceUrl,
  type IntegrationAuth,
} from './integration.service.js';

type IntegrationRequest = FastifyRequest & { integrationAuth?: IntegrationAuth };
const audit=(r:FastifyRequest)=>({ipAddress:r.ip,userAgent:r.headers['user-agent']});
const id=z.object({id:z.string().min(1)}); const appCredential=z.object({id:z.string().min(1),credentialId:z.string().min(1)});
const integrationRate={config:{rateLimit:{max:120,timeWindow:'1 minute',keyGenerator:(r:FastifyRequest)=>r.headers.authorization?.slice(0,80)??r.ip}}};

async function integrationAuthenticate(request: FastifyRequest) {
  const value=request.headers.authorization;
  if(!value?.startsWith('Bearer ')) throw new AppError('INTEGRATION_AUTH_FAILED','Integration authentication failed',401);
  (request as IntegrationRequest).integrationAuth=await authenticateApiKey(value.slice(7));
}
function ia(request:FastifyRequest){const auth=(request as IntegrationRequest).integrationAuth;if(!auth)throw new AppError('INTEGRATION_AUTH_FAILED','Integration authentication failed',401);return auth;}

export async function integrationRoutes(app:FastifyInstance){
  const scope=z.enum(INTEGRATION_SCOPES);
  app.get('/admin/integrations',{preHandler:requirePermission('admin:access')},async()=>({success:true,data:await listApps()}));
  app.get('/admin/integrations/:id',{preHandler:requirePermission('admin:access')},async r=>({success:true,data:await getApp(id.parse(r.params).id)}));
  app.post('/admin/integrations',{preHandler:requirePermission('admin:access')},async(r,reply)=>{const body=z.object({name:z.string(),code:z.string(),description:z.string().max(500).nullable().optional(),allowedRootId:z.string(),scopes:z.array(scope).min(1)}).strict().parse(r.body);return reply.status(201).send({success:true,data:await createApp(body,r.authUser!,audit(r))});});
  app.patch('/admin/integrations/:id',{preHandler:requirePermission('admin:access')},async r=>{const body=z.object({name:z.string().optional(),description:z.string().max(500).nullable().optional(),isActive:z.boolean().optional(),allowedRootId:z.string().optional(),scopes:z.array(scope).min(1).optional()}).strict().parse(r.body);return{success:true,data:await updateApp(id.parse(r.params).id,body,r.authUser!,audit(r))};});
  app.post('/admin/integrations/:id/credentials',{preHandler:requirePermission('admin:access')},async(r,reply)=>{const body=z.object({label:z.string().max(191).nullable().optional(),expiresAt:z.coerce.date().nullable().optional()}).strict().parse(r.body??{});return reply.status(201).send({success:true,data:await createCredential(id.parse(r.params).id,body,r.authUser!,audit(r))});});
  app.delete('/admin/integrations/:id/credentials/:credentialId',{preHandler:requirePermission('admin:access')},async r=>{const p=appCredential.parse(r.params);return{success:true,data:await revokeCredential(p.id,p.credentialId,r.authUser!,audit(r))};});

  app.post('/integrations/resources',{...integrationRate,preHandler:integrationAuthenticate},async(r,reply)=>{const body=z.object({type:z.enum(['FOLDER','WEB_LINK','GOOGLE_SHEET','GOOGLE_DOC','GOOGLE_DRIVE']),name:z.string(),parentId:z.string(),remark:z.string().max(1000).nullable().optional(),externalUrl:z.string().max(2048).nullable().optional(),sourceEntityType:z.string().max(100).nullable().optional(),sourceEntityId:z.string().max(191).nullable().optional(),sourceUrl:z.string().max(2048).nullable().optional()}).strict().parse(r.body);const key=typeof r.headers['idempotency-key']==='string'?r.headers['idempotency-key']:undefined;if(key&&key.length>191)throw badRequest('INTEGRATION_IDEMPOTENCY_CONFLICT','Idempotency key is too long');return reply.status(201).send({success:true,data:await createMetadata(ia(r),body,key)});});
  app.get('/integrations/resources',{...integrationRate,preHandler:integrationAuthenticate},async r=>{const q=z.object({parentId:z.string()}).parse(r.query);return{success:true,data:await listScopedResources(ia(r),q.parentId)};});
  app.get('/integrations/resources/:id',{...integrationRate,preHandler:integrationAuthenticate},async r=>({success:true,data:await getScopedResource(ia(r),id.parse(r.params).id)}));
  app.get('/integrations/resources/:id/metadata',{...integrationRate,preHandler:integrationAuthenticate},async r=>({success:true,data:await getScopedMetadata(ia(r),id.parse(r.params).id)}));
  app.patch('/integrations/resources/:id',{...integrationRate,preHandler:integrationAuthenticate},async r=>{const body=z.object({name:z.string().optional(),remark:z.string().max(1000).nullable().optional(),externalUrl:z.string().max(2048).optional()}).strict().refine(v=>Object.keys(v).length>0).parse(r.body);return{success:true,data:await updateScopedResource(ia(r),id.parse(r.params).id,body)};});
  app.post('/integrations/resources/upload',{...integrationRate,preHandler:integrationAuthenticate},async(r,reply)=>{const auth=ia(r);requireScope(auth,'resources:upload');const part=await r.file();if(!part)throw badRequest('FILE_MISSING','ไม่พบไฟล์ที่อัปโหลด');const fields=part.fields as Record<string,{value?:unknown}|undefined>;const read=(k:string)=>typeof fields[k]?.value==='string'?fields[k]!.value as string:undefined;const parentId=read('parentId');if(!parentId)throw badRequest('FOLDER_NOT_FOUND','ต้องระบุ parentId');await assertWithinScope(auth.app,parentId);const key=typeof r.headers['idempotency-key']==='string'?r.headers['idempotency-key']:undefined;const fingerprint=requestFingerprint({parentId,fileName:part.filename,sourceEntityType:read('sourceEntityType'),sourceEntityId:read('sourceEntityId'),sourceUrl:read('sourceUrl'),remark:read('remark')});if(key){const prev=await prisma.integrationIdempotency.findUnique({where:{appId_key:{appId:auth.app.id,key}},select:{requestHash:true,resourceId:true}});if(prev){if(prev.requestHash!==fingerprint)throw new AppError('INTEGRATION_IDEMPOTENCY_CONFLICT','Idempotency key was used with different input',409);return reply.status(200).send({success:true,data:{status:'CREATED',resource:await getScopedResource(auth,prev.resourceId)}});}}
    const result=await uploadFile(auth.user,part.file,{parentId,fileName:part.filename,declaredMime:part.mimetype,remark:read('remark')??null,allowDuplicateContent:true,sourceType:sourceTypeForApp(auth.app.code),sourceSystem:auth.app.code,integrationAppId:auth.app.id,sourceEntityType:read('sourceEntityType')??null,sourceEntityId:read('sourceEntityId')??null,sourceUrl:validateIntegrationSourceUrl(read('sourceUrl'))},audit(r));if(key)await prisma.integrationIdempotency.create({data:{appId:auth.app.id,key,requestHash:fingerprint,resourceId:result.resource.id}});return reply.status(201).send({success:true,data:result});});
  app.post('/integrations/resources/:id/versions',{...integrationRate,preHandler:integrationAuthenticate},async(r,reply)=>{const auth=ia(r);requireScope(auth,'resources:upload');const resourceId=id.parse(r.params).id;await assertWithinScope(auth.app,resourceId);const part=await r.file();if(!part)throw badRequest('FILE_MISSING','ไม่พบไฟล์ที่อัปโหลด');const fields=part.fields as Record<string,{value?:unknown}|undefined>;const remark=typeof fields.remark?.value==='string'?fields.remark.value:null;const resource=await uploadVersion(auth.user,resourceId,part.file,{declaredMime:part.mimetype,remark,integrationAppId:auth.app.id},audit(r));return reply.status(201).send({success:true,data:resource});});
  app.get('/integrations/resources/:id/download',{...integrationRate,preHandler:integrationAuthenticate},async(r,reply:FastifyReply)=>{const auth=ia(r);requireScope(auth,'resources:download');const resourceId=id.parse(r.params).id;await assertWithinScope(auth.app,resourceId);const content=await resolveContent(resourceId,auth.user,{requireDownload:true});return sendFile(r,reply,content,'attachment');});
}

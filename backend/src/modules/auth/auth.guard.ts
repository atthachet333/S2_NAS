import type { FastifyReply, FastifyRequest } from 'fastify';
import { forbidden, unauthorized } from '../../core/errors.js';
import { verifyAccessToken } from './auth.service.js';

export async function authenticate(request: FastifyRequest): Promise<void> {
  const header = request.headers.authorization;
  if (!header?.startsWith('Bearer ')) throw unauthorized();
  request.authUser = await verifyAccessToken(header.slice(7));
}

export function requirePermission(code: string) {
  return async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    await authenticate(request);
    if (!request.authUser?.permissions.includes(code)) throw forbidden();
  };
}

import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { assertPasswordStrength } from './password-policy.js';
import { SignJWT, jwtVerify } from 'jose';
import { env } from '../../config/env.js';
import { prisma } from '../../core/prisma.js';
import { unauthorized } from '../../core/errors.js';

export interface AuthUser {
  id: string;
  email: string;
  displayName: string;
  status: string;
  mustChangePassword: boolean;
  roles: string[];
  permissions: string[];
}

const accessSecret = new TextEncoder().encode(env.JWT_ACCESS_SECRET);
const refreshMaxAgeSeconds = parseDuration(env.JWT_REFRESH_EXPIRES_IN, 7 * 86400);

function parseDuration(value: string, fallback: number): number {
  const match = /^(\d+)([smhd])$/.exec(value);
  if (!match) return fallback;
  const amount = Number(match[1]);
  return amount * ({ s: 1, m: 60, h: 3600, d: 86400 }[match[2] as 's' | 'm' | 'h' | 'd']);
}

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

const userInclude = {
  roles: { include: { role: { include: { permissions: { include: { permission: true } } } } } },
} as const;

function toAuthUser(user: Awaited<ReturnType<typeof findAuthUser>>): AuthUser {
  if (!user) throw unauthorized();
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    status: user.status,
    mustChangePassword: user.mustChangePassword,
    roles: user.roles.map((item) => item.role.code),
    permissions: [...new Set(user.roles.flatMap((item) => item.role.permissions.map((p) => p.permission.code)))],
  };
}

async function findAuthUser(id: string) {
  return prisma.user.findUnique({ where: { id }, include: userInclude });
}

async function issueAccessToken(userId: string, tokenVersion: number): Promise<string> {
  return new SignJWT({ tokenVersion })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuer('s2-nas')
    .setAudience('s2-nas-web')
    .setIssuedAt()
    .setExpirationTime(env.JWT_ACCESS_EXPIRES_IN)
    .sign(accessSecret);
}

async function issueSession(userId: string, tokenVersion: number) {
  const refreshToken = crypto.randomBytes(48).toString('base64url');
  const expiresAt = new Date(Date.now() + refreshMaxAgeSeconds * 1000);
  await prisma.refreshToken.create({ data: { userId, tokenHash: hashToken(refreshToken), expiresAt } });
  return { accessToken: await issueAccessToken(userId, tokenVersion), refreshToken, refreshMaxAgeSeconds };
}

export async function login(email: string, password: string) {
  const user = await prisma.user.findUnique({ where: { email: email.trim().toLowerCase() }, include: userInclude });
  if (!user?.passwordHash || user.status !== 'ACTIVE' || !(await bcrypt.compare(password, user.passwordHash))) {
    throw unauthorized('อีเมลหรือรหัสผ่านไม่ถูกต้อง');
  }
  const session = await issueSession(user.id, user.tokenVersion);
  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
  return { user: toAuthUser(user), ...session };
}

export async function verifyAccessToken(token: string): Promise<AuthUser> {
  try {
    const { payload } = await jwtVerify(token, accessSecret, { issuer: 's2-nas', audience: 's2-nas-web' });
    if (!payload.sub) throw unauthorized();
    const user = await findAuthUser(payload.sub);
    if (!user || user.status !== 'ACTIVE' || user.tokenVersion !== payload.tokenVersion) throw unauthorized();
    return toAuthUser(user);
  } catch {
    throw unauthorized('Session หมดอายุหรือไม่ถูกต้อง');
  }
}

export async function rotateRefreshToken(rawToken: string) {
  const stored = await prisma.refreshToken.findUnique({
    where: { tokenHash: hashToken(rawToken) }, include: { user: { include: userInclude } },
  });
  if (!stored || stored.revokedAt || stored.expiresAt <= new Date() || stored.user.status !== 'ACTIVE') {
    throw unauthorized('Refresh session หมดอายุหรือไม่ถูกต้อง');
  }
  return prisma.$transaction(async (tx) => {
    await tx.refreshToken.update({ where: { id: stored.id }, data: { revokedAt: new Date() } });
    const refreshToken = crypto.randomBytes(48).toString('base64url');
    const expiresAt = new Date(Date.now() + refreshMaxAgeSeconds * 1000);
    await tx.refreshToken.create({ data: { userId: stored.userId, tokenHash: hashToken(refreshToken), expiresAt } });
    return {
      user: toAuthUser(stored.user),
      accessToken: await issueAccessToken(stored.userId, stored.user.tokenVersion),
      refreshToken,
      refreshMaxAgeSeconds,
    };
  });
}

export async function revokeRefreshToken(rawToken?: string): Promise<void> {
  if (!rawToken) return;
  await prisma.refreshToken.updateMany({ where: { tokenHash: hashToken(rawToken), revokedAt: null }, data: { revokedAt: new Date() } });
}

export async function changePassword(userId: string, currentPassword: string, newPassword: string): Promise<void> {
  // ใช้เกณฑ์เดียวกับที่ผู้ดูแลตั้งรหัสชั่วคราว ผู้ใช้จึงตั้งรหัสอ่อนกว่านั้นไม่ได้
  assertPasswordStrength(newPassword);
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user?.passwordHash || !(await bcrypt.compare(currentPassword, user.passwordHash))) {
    throw unauthorized('รหัสผ่านปัจจุบันไม่ถูกต้อง');
  }
  const passwordHash = await bcrypt.hash(newPassword, 12);
  await prisma.$transaction([
    prisma.user.update({ where: { id: userId }, data: { passwordHash, mustChangePassword: false, tokenVersion: { increment: 1 } } }),
    prisma.refreshToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } }),
  ]);
}

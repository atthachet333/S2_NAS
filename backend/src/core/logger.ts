import pino from 'pino';
import { env } from '../config/env.js';

/**
 * Logger กลางของระบบ
 * - Development: pino-pretty อ่านง่ายใน CMD / Terminal
 * - Production: JSON line เพื่อเก็บเข้า log aggregator
 *
 * ห้าม log: password, JWT, refresh token, database password, ข้อมูล sensitive
 */
const redactPaths = [
  'req.headers.authorization',
  'req.headers.cookie',
  'headers.authorization',
  'headers.cookie',
  'password',
  '*.password',
  'currentPassword',
  'newPassword',
  'token',
  'accessToken',
  'refreshToken',
  'DATABASE_URL',
  'JWT_ACCESS_SECRET',
  'JWT_REFRESH_SECRET',
];

export const logger = pino({
  level: env.LOG_LEVEL,
  redact: { paths: redactPaths, censor: '[REDACTED]' },
  base: undefined,
  transport: env.isProduction
    ? undefined
    : {
        target: 'pino-pretty',
        options: {
          colorize: Boolean(process.stdout.isTTY) && !process.env.NO_COLOR,
          translateTime: 'SYS:HH:MM:ss',
          ignore: 'pid,hostname',
          messageFormat: '{msg}',
          singleLine: true,
        },
      },
});

export type Logger = typeof logger;

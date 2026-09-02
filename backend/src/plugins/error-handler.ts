import type { FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { env } from '../config/env.js';
import { AppError, toErrorResponse } from '../core/errors.js';
import { color } from '../core/banner.js';

export async function registerErrorHandler(app: FastifyInstance): Promise<void> {
  app.setNotFoundHandler((request, reply) => {
    reply.status(404).send({
      success: false,
      error: {
        code: 'ROUTE_NOT_FOUND',
        message: `ไม่พบเส้นทาง ${request.method} ${request.url}`,
      },
    });
  });

  app.setErrorHandler((rawError, request, reply) => {
    const error = rawError as Error & { statusCode?: number; code?: string };
    let appError: AppError;

    if (error instanceof AppError) {
      appError = error;
    } else if (error instanceof ZodError) {
      appError = new AppError('VALIDATION_ERROR', 'ข้อมูลที่ส่งมาไม่ถูกต้อง', 422, error.issues);
    } else if (typeof error.statusCode === 'number' && error.statusCode < 500) {
      appError = new AppError(error.code ?? 'BAD_REQUEST', error.message, error.statusCode);
    } else {
      appError = new AppError('INTERNAL_ERROR', 'เกิดข้อผิดพลาดภายในระบบ', 500);
    }

    if (appError.statusCode >= 500) {
      // Stack trace อยู่ใน server log เท่านั้น ห้ามส่งให้ client ใน production
      request.log.error({ err: error }, 'unhandled error');
      if (!env.isProduction) {
        process.stderr.write(
          `\n${color.red('[ERROR]')}\n${request.method} ${request.url}\n` +
            `${error.message}\n${error.stack ?? ''}\n\n`,
        );
      }
    } else if (!env.isProduction) {
      process.stderr.write(
        `\n${color.amber('[ERROR]')}\n${request.method} ${request.url}\n` +
          `${appError.message}\nReason: ${appError.code}\n\n`,
      );
    }

    reply.status(appError.statusCode).send(toErrorResponse(appError, !env.isProduction));
  });
}

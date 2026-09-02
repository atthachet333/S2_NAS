/**
 * Error กลางของระบบ - ตอบกลับ client ด้วยรูปแบบเดียวกันเสมอ
 * {
 *   "success": false,
 *   "error": { "code": "DOCUMENT_NOT_FOUND", "message": "ไม่พบเอกสาร" }
 * }
 */
export class AppError extends Error {
  readonly code: string;
  readonly statusCode: number;
  readonly details?: unknown;

  constructor(code: string, message: string, statusCode = 400, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

export const badRequest = (code: string, message: string, details?: unknown) =>
  new AppError(code, message, 400, details);
export const unauthorized = (message = 'กรุณาเข้าสู่ระบบ') =>
  new AppError('UNAUTHORIZED', message, 401);
export const forbidden = (message = 'ไม่มีสิทธิ์เข้าถึง') =>
  new AppError('FORBIDDEN', message, 403);
export const notFound = (code: string, message: string) =>
  new AppError(code, message, 404);
export const internal = (message = 'เกิดข้อผิดพลาดภายในระบบ') =>
  new AppError('INTERNAL_ERROR', message, 500);

export interface ErrorResponseBody {
  success: false;
  error: { code: string; message: string; details?: unknown };
}

/**
 * details ของ AppError เป็นข้อมูลที่เราตั้งใจส่งให้ client ใช้ตัดสินใจ
 * เช่น สาเหตุที่กู้คืนไม่ได้ หรือไฟล์เดิมที่ชนกัน จึงส่งออกทุก environment
 *
 * สิ่งที่ห้ามส่งออกคือ stack trace และรายละเอียดภายในของ error ที่ไม่ได้ตั้งใจ
 * ซึ่งถูกกันไว้ตั้งแต่ชั้น error handler แล้ว (error ที่ไม่ใช่ AppError จะถูกแปลงเป็น INTERNAL_ERROR)
 */
export function toErrorResponse(error: AppError, _includeDetails: boolean): ErrorResponseBody {
  return {
    success: false,
    error: {
      code: error.code,
      message: error.message,
      ...(error.details === undefined ? {} : { details: error.details }),
    },
  };
}

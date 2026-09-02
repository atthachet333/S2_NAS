import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app.js';

let app: FastifyInstance;

before(async () => {
  app = await buildApp();
  await app.ready();
});

after(async () => {
  await app.close();
});

describe('GET /api/health', () => {
  test('ตอบกลับโครงสร้างที่กำหนดไว้', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/health' });
    const body = response.json();

    assert.ok([200, 503].includes(response.statusCode));
    assert.equal(body.service, 'S2 NAS');
    assert.ok(['ok', 'degraded', 'error'].includes(body.status));
    assert.ok(['connected', 'disconnected', 'not_configured'].includes(body.database));
    assert.ok(['ready', 'read_only', 'unavailable'].includes(body.storage));
    assert.equal(typeof body.uptime, 'number');
  });

  test('storage ต้องพร้อมใช้งานตอนรันเทส', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/health' });
    assert.equal(response.json().storage, 'ready');
  });
});

describe('GET /api/system/storage', () => {
  test('ต้องไม่ส่ง physical path ของ server กลับไปยัง client', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/system/storage' });
    assert.equal(response.statusCode, 200);

    const payload = response.payload;
    assert.ok(!payload.includes('storage/'), 'response ต้องไม่มี path');
    assert.ok(!/[A-Za-z]:\\/.test(payload), 'response ต้องไม่มี Windows path');
    assert.equal(response.json().data.status, 'READY');
  });
});

describe('error format', () => {
  test('route ที่ไม่มีอยู่ต้องตอบรูปแบบ error กลาง', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/ไม่มีเส้นทางนี้' });
    const body = response.json();

    assert.equal(response.statusCode, 404);
    assert.equal(body.success, false);
    assert.equal(body.error.code, 'ROUTE_NOT_FOUND');
    assert.equal(typeof body.error.message, 'string');
  });

  test('storage ต้องไม่ถูก serve เป็น static public directory', async () => {
    const response = await app.inject({ method: 'GET', url: '/storage/test.pdf' });
    assert.equal(response.statusCode, 404);
  });
});

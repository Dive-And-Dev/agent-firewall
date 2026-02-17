import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createAuthMiddleware } from '../../src/middleware/auth.js';

function buildApp(token: string) {
  const app = express();
  app.use(createAuthMiddleware(token));
  app.get('/test', (_req, res) => {
    res.json({ ok: true });
  });
  return app;
}

describe('auth middleware', () => {
  const TOKEN = 'test-bridge-token-abc123';

  it('allows request with valid Bearer token', async () => {
    const res = await request(buildApp(TOKEN))
      .get('/test')
      .set('Authorization', `Bearer ${TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('rejects request with no Authorization header', async () => {
    const res = await request(buildApp(TOKEN)).get('/test');
    expect(res.status).toBe(401);
    expect(res.body.error).toContain('Authorization');
  });

  it('rejects request with wrong token', async () => {
    const res = await request(buildApp(TOKEN))
      .get('/test')
      .set('Authorization', 'Bearer wrong-token');
    expect(res.status).toBe(401);
    expect(res.body.error).toContain('Invalid');
  });

  it('rejects request with non-Bearer scheme', async () => {
    const res = await request(buildApp(TOKEN))
      .get('/test')
      .set('Authorization', `Basic ${TOKEN}`);
    expect(res.status).toBe(401);
  });

  it('rejects request with empty Bearer value', async () => {
    const res = await request(buildApp(TOKEN))
      .get('/test')
      .set('Authorization', 'Bearer ');
    expect(res.status).toBe(401);
  });

  it('uses timing-safe comparison', async () => {
    // Verify it doesn't crash with different-length tokens
    const res = await request(buildApp(TOKEN))
      .get('/test')
      .set('Authorization', 'Bearer x');
    expect(res.status).toBe(401);
  });
});

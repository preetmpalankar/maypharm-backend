import { Test, TestingModule } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { loadConfig } from '../src/config';

type ErrorBody = { statusCode: number; message: string; requestId: string };

describe('MayPharm API (e2e)', () => {
  let app: NestExpressApplication;
  let server: App;

  beforeAll(async () => {
    // Point Supabase at a closed local port: these tests cover the HTTP
    // contract (auth gates, error shape, limits) without a real project.
    // Config is read lazily when the app is built, so setting it here is early
    // enough, and explicit values always win over a local .env.
    process.env.SUPABASE_URL = 'http://127.0.0.1:9';
    process.env.SUPABASE_SERVICE_ROLE_KEY =
      'test-service-role-key-not-real-0000';
    process.env.CORS_ORIGINS = 'http://localhost:3001';

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication<NestExpressApplication>({
      bodyParser: false,
    });
    configureApp(app, loadConfig());
    await app.init();
    server = app.getHttpServer();
  });

  afterAll(async () => {
    await app.close();
  });

  it('reports liveness with a request id', async () => {
    const response = await request(server).get('/health').expect(200);

    expect(response.body).toMatchObject({
      status: 'ok',
      service: 'maypharm-api',
    });
    expect(response.headers['x-request-id']).toBeTruthy();
  });

  it('reuses a well-formed incoming request id', async () => {
    const response = await request(server)
      .get('/health')
      .set('x-request-id', 'web-abcdef12')
      .expect(200);

    expect(response.headers['x-request-id']).toBe('web-abcdef12');
  });

  it.each([
    ['GET', '/content'],
    ['GET', '/content/summary'],
    ['GET', '/brands'],
    ['GET', '/categories'],
    ['GET', '/admin/stats'],
    ['GET', '/admin/users'],
    ['POST', '/admin/uploads'],
    ['POST', '/admin/content'],
  ])(
    '%s %s refuses anonymous callers with a JSON 401',
    async (method, path) => {
      const call =
        method === 'GET'
          ? request(server).get(path)
          : request(server).post(path).send({});
      const response = await call.expect(401);
      const body = response.body as ErrorBody;

      expect(body.statusCode).toBe(401);
      expect(body.message).toBe('Sign in to continue.');
      expect(typeof body.requestId).toBe('string');
    },
  );

  it('answers 503, not "signed out", when Supabase Auth is unreachable', async () => {
    const response = await request(server)
      .get('/content')
      .set('Authorization', 'Bearer some-token')
      .expect(503);

    expect((response.body as ErrorBody).message).toMatch(
      /temporarily unavailable/,
    );
  });

  it('rejects oversized JSON bodies before they reach a handler', async () => {
    await request(server)
      .post('/admin/content')
      .set('Content-Type', 'application/json')
      .send({ description: 'x'.repeat(300 * 1024) })
      .expect(413);
  });

  it('answers malformed JSON with a 400, not a server error', async () => {
    const response = await request(server)
      .post('/admin/content')
      .set('Content-Type', 'application/json')
      .send('{"title": "unterminated')
      .expect(400);
    const body = response.body as ErrorBody;

    expect(body.statusCode).toBe(400);
    expect(typeof body.message).toBe('string');
    expect(typeof body.requestId).toBe('string');
  });

  it('returns JSON for unknown routes', async () => {
    const response = await request(server).get('/does-not-exist').expect(404);
    const body = response.body as ErrorBody;

    expect(body.statusCode).toBe(404);
    expect(typeof body.requestId).toBe('string');
  });

  it('sends security headers and hides the framework', async () => {
    const response = await request(server).get('/health');

    expect(response.headers['x-powered-by']).toBeUndefined();
    expect(response.headers['x-content-type-options']).toBe('nosniff');
  });
});

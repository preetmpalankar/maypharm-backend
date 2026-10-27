import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import {
  type AssistantEvent,
  AssistantService,
} from '../src/assistant/assistant.service';
import { AuthService } from '../src/auth/auth.service';
import { loadConfig } from '../src/config';

/**
 * The assistant's HTTP contract with the model and database stubbed out:
 * validation, the configured check, and the exact Server-Sent Events stream.
 */
describe('Assistant API (e2e)', () => {
  let app: NestExpressApplication;
  let server: App;
  let configured = true;

  const user = {
    id: '00000000-0000-4000-8000-0000000000aa',
    email: 'rep@maypharm.com',
    fullName: 'Field Rep',
    role: 'sales',
    status: 'active',
  };

  const stub = {
    get configured() {
      return configured;
    },
    assertConfigured() {
      if (!configured) {
        const { ServiceUnavailableException } =
          jest.requireActual<typeof import('@nestjs/common')>('@nestjs/common');
        throw new ServiceUnavailableException(
          'The MayPharm Assistant is not available right now.',
        );
      }
    },
    openConversation: jest.fn(() =>
      Promise.resolve({ id: 'conv-1', title: 'What is Calpol?' }),
    ),
    answer: jest.fn(
      (
        _user: unknown,
        conversation: { id: string; title: string },
        _message: string,
        emit: (event: AssistantEvent) => void,
      ) => {
        emit({
          event: 'meta',
          data: {
            conversationId: conversation.id,
            title: conversation.title,
            userMessageId: 'm-1',
          },
        });
        emit({ event: 'status', data: { stage: 'searching' } });
        emit({ event: 'sources', data: { sources: [] } });
        emit({ event: 'status', data: { stage: 'answering' } });
        emit({ event: 'delta', data: { text: 'Calpol contains ' } });
        emit({ event: 'delta', data: { text: 'paracetamol [1].' } });
        emit({
          event: 'done',
          data: { messageId: 'm-2', status: 'completed', cited: [1] },
        });
        return Promise.resolve();
      },
    ),
  };

  beforeAll(async () => {
    process.env.SUPABASE_URL = 'http://127.0.0.1:9';
    process.env.SUPABASE_SERVICE_ROLE_KEY =
      'test-service-role-key-not-real-0000';
    process.env.CORS_ORIGINS = 'http://localhost:3001';

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(AuthService)
      .useValue({ requireMember: () => Promise.resolve(user) })
      .overrideProvider(AssistantService)
      .useValue(stub)
      .compile();

    app = moduleRef.createNestApplication<NestExpressApplication>({
      bodyParser: false,
    });
    configureApp(app, loadConfig());
    await app.init();
    server = app.getHttpServer();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    configured = true;
    jest.clearAllMocks();
  });

  it('streams the answer as Server-Sent Events in order', async () => {
    const response = await request(server)
      .post('/assistant/chat')
      .set('Authorization', 'Bearer token')
      .send({ message: 'What is Calpol?' })
      .expect(200);

    expect(response.headers['content-type']).toContain('text/event-stream');
    expect(response.headers['cache-control']).toContain('no-cache');

    const events = response.text
      .trim()
      .split('\n\n')
      .map((block) => {
        const [eventLine, dataLine] = block.split('\n');
        return {
          event: eventLine.replace('event: ', ''),
          data: JSON.parse(dataLine.replace('data: ', '')) as unknown,
        };
      });

    expect(events.map((entry) => entry.event)).toEqual([
      'meta',
      'status',
      'sources',
      'status',
      'delta',
      'delta',
      'done',
    ]);
    expect(events[6].data).toEqual({
      messageId: 'm-2',
      status: 'completed',
      cited: [1],
    });
    expect(stub.openConversation).toHaveBeenCalledWith(
      user,
      undefined,
      'What is Calpol?',
    );
  });

  it('rejects an empty question before streaming', async () => {
    const response = await request(server)
      .post('/assistant/chat')
      .set('Authorization', 'Bearer token')
      .send({ message: '   ' })
      .expect(400);

    expect(response.headers['content-type']).toContain('application/json');
    expect(stub.answer).not.toHaveBeenCalled();
  });

  it('rejects an over-long question and a malformed conversation id', async () => {
    await request(server)
      .post('/assistant/chat')
      .set('Authorization', 'Bearer token')
      .send({ message: 'x'.repeat(2001) })
      .expect(400);

    await request(server)
      .post('/assistant/chat')
      .set('Authorization', 'Bearer token')
      .send({ message: 'Hi', conversationId: 'not-a-uuid' })
      .expect(400);
  });

  it('answers 503 when the assistant is not configured', async () => {
    configured = false;

    const response = await request(server)
      .post('/assistant/chat')
      .set('Authorization', 'Bearer token')
      .send({ message: 'What is Calpol?' })
      .expect(503);

    expect((response.body as { message: string }).message).toContain(
      'not available',
    );
  });
});

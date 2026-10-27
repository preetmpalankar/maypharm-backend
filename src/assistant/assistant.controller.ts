import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Logger,
  Param,
  Post,
  Res,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { z } from 'zod';
import { AuthService } from '../auth/auth.service';
import { parseId, uuidSchema } from '../common/validation';
import { type AssistantEvent, AssistantService } from './assistant.service';

const chatSchema = z.object({
  message: z
    .string({ error: 'Type a question.' })
    .trim()
    .min(1, 'Type a question.')
    .max(2000, 'Keep questions under 2,000 characters.'),
  conversationId: uuidSchema.optional(),
});

/** Keeps proxies from closing a quiet stream while the model is thinking. */
const heartbeatMs = 15_000;

/**
 * The MayPharm Assistant for field users. Answers stream as Server-Sent
 * Events: meta → status(searching) → sources → status(answering) → delta… →
 * done | error. Everything before the stream opens (auth, validation, a
 * missing conversation) fails as a normal JSON error.
 */
@Controller('assistant')
export class AssistantController {
  private readonly logger = new Logger('AssistantController');

  constructor(
    private readonly auth: AuthService,
    private readonly assistant: AssistantService,
  ) {}

  @Get('status')
  async status(@Headers('authorization') authorization: string | undefined) {
    await this.auth.requireMember(authorization);
    return { data: await this.assistant.status() };
  }

  @Post('chat')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  async chat(
    @Headers('authorization') authorization: string | undefined,
    @Body() body: unknown,
    @Res() response: Response,
  ) {
    const user = await this.auth.requireMember(authorization);
    this.assistant.assertConfigured();
    const { message, conversationId } = chatSchema.parse(body);
    const conversation = await this.assistant.openConversation(
      user,
      conversationId,
      message,
    );

    response.status(200);
    response.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    response.setHeader('Cache-Control', 'no-cache, no-transform');
    response.setHeader('Connection', 'keep-alive');
    response.setHeader('X-Accel-Buffering', 'no');
    response.flushHeaders();

    const controller = new AbortController();
    let closed = false;
    // The client stopped the answer or went away: stop generating and save
    // what exists. (The request's own 'close' fires once its body is read, so
    // the response's 'close' is the reliable disconnect signal.)
    response.on('close', () => {
      if (response.writableFinished) return;
      closed = true;
      controller.abort();
    });

    const send = ({ event, data }: AssistantEvent) => {
      if (closed) return;
      response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const heartbeat = setInterval(
      () => !closed && response.write(': ping\n\n'),
      heartbeatMs,
    );

    try {
      await this.assistant.answer(
        user,
        conversation,
        message,
        send,
        controller.signal,
      );
    } catch (error) {
      this.logger.error(`Chat failed: ${(error as Error).message}`);
      send({
        event: 'error',
        data: { message: 'Something went wrong. Try again.' },
      });
    } finally {
      clearInterval(heartbeat);
      if (!closed) response.end();
    }
  }

  @Get('conversations')
  async conversations(
    @Headers('authorization') authorization: string | undefined,
  ) {
    const user = await this.auth.requireMember(authorization);
    return { data: await this.assistant.listConversations(user) };
  }

  @Get('conversations/:id')
  async conversation(
    @Headers('authorization') authorization: string | undefined,
    @Param('id') id: string,
  ) {
    const user = await this.auth.requireMember(authorization);
    return { data: await this.assistant.getConversation(user, parseId(id)) };
  }

  @Delete('conversations/:id')
  async deleteConversation(
    @Headers('authorization') authorization: string | undefined,
    @Param('id') id: string,
  ) {
    const user = await this.auth.requireMember(authorization);
    await this.assistant.deleteConversation(user, parseId(id));
    return { data: { deleted: true } };
  }
}

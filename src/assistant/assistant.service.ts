import {
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import OpenAI from 'openai';
import type { ResponseInputItem } from 'openai/resources/responses/responses';
import { AuditService } from '../audit/audit.service';
import type { Principal } from '../auth/auth.service';
import { loadConfig } from '../config';
import { SupabaseService } from '../supabase.service';
import {
  type AssistantSource,
  buildUserTurn,
  citedIndexes,
  isConversational,
  type LibraryOverview,
  systemPrompt,
  titleFrom,
  toPublicSource,
} from './prompt';
import { RetrievalService } from './retrieval.service';

/** Earlier turns sent to the model for follow-up questions. */
const historyTurns = 8;
/** Includes reasoning tokens on reasoning models, so leave headroom. */
const maxOutputTokens = 6000;

export type AssistantEvent =
  | {
      event: 'meta';
      data: { conversationId: string; title: string; userMessageId: string };
    }
  | { event: 'status'; data: { stage: 'searching' | 'answering' } }
  | { event: 'sources'; data: { sources: ReturnType<typeof toPublicSource>[] } }
  | { event: 'delta'; data: { text: string } }
  | {
      event: 'done';
      data: {
        messageId: string;
        status: 'completed' | 'stopped';
        cited: number[];
      };
    }
  | { event: 'error'; data: { message: string } };

type MessageRow = { role: 'user' | 'assistant'; content: string };

/**
 * Answers a field user's question from approved MayPharm content: retrieves
 * sources, streams a grounded, cited answer, and keeps the conversation and
 * what it cited (for compliance review).
 */
@Injectable()
export class AssistantService {
  private readonly logger = new Logger('Assistant');
  private client?: OpenAI;

  constructor(
    private readonly supabase: SupabaseService,
    private readonly retrieval: RetrievalService,
    private readonly audit: AuditService,
  ) {}

  get configured() {
    return Boolean(loadConfig().OPENAI_API_KEY);
  }

  private get openai() {
    this.client ??= new OpenAI({
      apiKey: loadConfig().OPENAI_API_KEY,
      maxRetries: 2,
      timeout: 120_000,
    });
    return this.client;
  }

  assertConfigured() {
    if (!this.configured) {
      throw new ServiceUnavailableException(
        'The MayPharm Assistant is not available right now.',
      );
    }
  }

  /** Loads the user's conversation, or creates one titled after the question. */
  async openConversation(
    user: Principal,
    conversationId: string | undefined,
    message: string,
  ) {
    const db = this.supabase.admin;

    if (conversationId) {
      const { data, error } = await db
        .from('assistant_conversations')
        .select('id,title')
        .eq('id', conversationId)
        .eq('user_id', user.id)
        .maybeSingle<{ id: string; title: string }>();
      if (error) throw error;
      if (!data) throw new NotFoundException('Conversation not found.');
      return data;
    }

    const { data, error } = await db
      .from('assistant_conversations')
      .insert({ user_id: user.id, title: titleFrom(message) })
      .select('id,title')
      .single<{ id: string; title: string }>();
    if (error) throw error;
    return data;
  }

  async answer(
    user: Principal,
    conversation: { id: string; title: string },
    message: string,
    emit: (event: AssistantEvent) => void,
    signal: AbortSignal,
  ) {
    const db = this.supabase.admin;
    const started = Date.now();
    const config = loadConfig();

    const { data: past, error: historyError } = await db
      .from('assistant_messages')
      .select('role,content')
      .eq('conversation_id', conversation.id)
      .eq('status', 'completed')
      .order('created_at', { ascending: false })
      .limit(historyTurns);
    if (historyError) throw historyError;
    const history = ((past ?? []) as MessageRow[]).reverse();

    const { data: saved, error: saveError } = await db
      .from('assistant_messages')
      .insert({
        conversation_id: conversation.id,
        role: 'user',
        content: message,
      })
      .select('id')
      .single<{ id: string }>();
    if (saveError) throw saveError;

    emit({
      event: 'meta',
      data: {
        conversationId: conversation.id,
        title: conversation.title,
        userMessageId: saved.id,
      },
    });
    // Greetings and small talk need no content search: answer them straight away.
    const chatty = isConversational(message);
    const overviewPromise = this.libraryOverview();
    let sources: AssistantSource[] = [];

    if (!chatty) {
      emit({ event: 'status', data: { stage: 'searching' } });
      // Follow-ups ("what about its side effects?") lean on the previous question.
      const previousQuestion = [...history]
        .reverse()
        .find((turn) => turn.role === 'user')?.content;
      sources = await this.retrieval.retrieve(
        previousQuestion ? `${previousQuestion}\n${message}` : message,
      );
    }
    const overview = await overviewPromise;

    emit({ event: 'sources', data: { sources: sources.map(toPublicSource) } });
    emit({ event: 'status', data: { stage: 'answering' } });

    const input: ResponseInputItem[] = [
      ...history.map((turn): ResponseInputItem => ({
        role: turn.role,
        content: turn.content,
      })),
      {
        role: 'user',
        content: buildUserTurn(message, overview, chatty ? null : sources),
      },
    ];

    let answer = '';
    let usage: unknown = null;
    let status: 'completed' | 'stopped' | 'failed' = 'completed';
    let failure: string | null = null;

    try {
      const stream = await this.openai.responses.create(
        {
          model: config.OPENAI_ASSISTANT_MODEL,
          instructions: systemPrompt,
          input,
          max_output_tokens: maxOutputTokens,
          stream: true,
          ...(config.OPENAI_ASSISTANT_REASONING !== 'none'
            ? { reasoning: { effort: config.OPENAI_ASSISTANT_REASONING } }
            : {}),
        },
        { signal },
      );

      for await (const event of stream) {
        if (event.type === 'response.output_text.delta') {
          answer += event.delta;
          emit({ event: 'delta', data: { text: event.delta } });
        } else if (event.type === 'response.completed') {
          usage = event.response.usage ?? null;
        } else if (event.type === 'response.incomplete') {
          usage = event.response.usage ?? null;
          if (!answer)
            failure = 'The answer was cut short. Try a more specific question.';
        } else if (event.type === 'response.failed') {
          failure =
            event.response.error?.message ?? 'The assistant could not answer.';
        } else if (event.type === 'error') {
          failure = event.message || 'The assistant could not answer.';
        }
      }
    } catch (error) {
      if (signal.aborted) {
        status = 'stopped';
      } else {
        failure =
          'The assistant is having trouble right now. Try again in a moment.';
        this.logger.error(
          `Answer generation failed: ${(error as Error).message}`,
        );
      }
    }

    if (failure) status = 'failed';

    const cited = citedIndexes(answer, sources.length);
    const citedSources = cited
      .map((index) => sources.find((source) => source.index === index))
      .filter((source): source is AssistantSource => Boolean(source))
      .map(toPublicSource);

    const { data: reply, error: replyError } = await db
      .from('assistant_messages')
      .insert({
        conversation_id: conversation.id,
        role: 'assistant',
        content: answer,
        sources: citedSources,
        status,
        model: config.OPENAI_ASSISTANT_MODEL,
        usage,
        latency_ms: Date.now() - started,
      })
      .select('id')
      .single<{ id: string }>();
    if (replyError) throw replyError;

    await db
      .from('assistant_conversations')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', conversation.id);

    void this.audit.record({
      actorId: user.id,
      action: 'assistant.answered',
      entityType: 'assistant_messages',
      entityId: reply.id,
      metadata: {
        conversationId: conversation.id,
        status,
        citedContentIds: citedSources.map((source) => source.contentId),
      },
    });

    if (failure) {
      emit({ event: 'error', data: { message: failure } });
    } else {
      emit({
        event: 'done',
        data: {
          messageId: reply.id,
          status: status === 'stopped' ? 'stopped' : 'completed',
          cited,
        },
      });
    }
  }

  private overviewCache?: { value: LibraryOverview; at: number };

  /** Brands and how much content each has; cached briefly (it changes rarely). */
  private async libraryOverview(): Promise<LibraryOverview> {
    if (this.overviewCache && Date.now() - this.overviewCache.at < 60_000) {
      return this.overviewCache.value;
    }

    const db = this.supabase.admin;
    const [brands, counts, total] = await Promise.all([
      db
        .from('brands')
        .select('id,name,category')
        .eq('status', 'active')
        .order('sort_order', { ascending: true })
        .limit(50),
      db.from('brand_library_counts').select('brand_id,total_count'),
      db
        .from('content_items')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'approved'),
    ]);

    if (brands.error || counts.error || total.error) {
      this.logger.warn('Library overview unavailable; answering without it.');
      return { totalItems: 0, brands: [] };
    }

    const byBrand = new Map(
      ((counts.data ?? []) as { brand_id: string; total_count: number }[]).map(
        (row) => [row.brand_id, Number(row.total_count ?? 0)],
      ),
    );
    const value: LibraryOverview = {
      totalItems: total.count ?? 0,
      brands: (
        (brands.data ?? []) as { id: string; name: string; category: string }[]
      ).map((brand) => ({
        name: brand.name,
        category: brand.category,
        items: byBrand.get(brand.id) ?? 0,
      })),
    };
    this.overviewCache = { value, at: Date.now() };
    return value;
  }

  async listConversations(user: Principal) {
    const { data, error } = await this.supabase.admin
      .from('assistant_conversations')
      .select('id,title,updated_at')
      .eq('user_id', user.id)
      .order('updated_at', { ascending: false })
      .limit(50);
    if (error) throw error;
    return data ?? [];
  }

  async getConversation(user: Principal, id: string) {
    const db = this.supabase.admin;
    const { data: conversation, error } = await db
      .from('assistant_conversations')
      .select('id,title,updated_at')
      .eq('id', id)
      .eq('user_id', user.id)
      .maybeSingle();
    if (error) throw error;
    if (!conversation) throw new NotFoundException('Conversation not found.');

    const { data: messages, error: messageError } = await db
      .from('assistant_messages')
      .select('id,role,content,sources,status,created_at')
      .eq('conversation_id', id)
      .order('created_at', { ascending: true })
      .limit(200);
    if (messageError) throw messageError;

    return { ...conversation, messages: messages ?? [] };
  }

  async deleteConversation(user: Principal, id: string) {
    const { error } = await this.supabase.admin
      .from('assistant_conversations')
      .delete()
      .eq('id', id)
      .eq('user_id', user.id);
    if (error) throw error;
  }

  /** Whether the assistant can answer, and how much content it can draw on. */
  async status() {
    if (!this.configured) return { available: false, indexedItems: 0 };
    const { count, error } = await this.supabase.admin
      .from('knowledge_index_state')
      .select('content_id', { count: 'exact', head: true })
      .eq('status', 'indexed');
    if (error) {
      this.logger.warn(`Index status unavailable: ${error.message}`);
      return { available: true, indexedItems: 0 };
    }
    return { available: true, indexedItems: count ?? 0 };
  }
}

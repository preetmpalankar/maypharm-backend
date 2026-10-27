import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { loadConfig } from '../config';
import { SupabaseService } from '../supabase.service';
import { KnowledgeIndexerService } from './knowledge-indexer.service';

const tickIntervalMs = 20 * 1000;
const firstTickDelayMs = 30 * 1000;
const itemsPerTick = 3;
/** A claim older than this is assumed abandoned (instance restarted mid-item). */
const staleClaimMs = 15 * 60 * 1000;
const maxBackoffMs = 6 * 60 * 60 * 1000;
const pruneEveryMs = 30 * 60 * 1000;
const scanLimit = 1000;

type StateRow = {
  content_id: string;
  content_version: string | null;
  content_hash: string | null;
  status: 'pending' | 'processing' | 'indexed' | 'failed';
  attempts: number;
  next_attempt_at: string | null;
  claimed_at: string | null;
};

/**
 * Keeps the knowledge index in step with content, entirely in the background.
 *
 * It never hooks into uploads: every few seconds it compares each content
 * item's updated_at with the version it last indexed and processes what is new
 * or changed, a few items at a time. Failures are retried with backoff and
 * never touch the content itself. Safe on several instances: an item is
 * claimed with a conditional update before it is processed.
 */
@Injectable()
export class KnowledgeWorkerService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger('KnowledgeWorker');
  private timer?: NodeJS.Timeout;
  private running = false;
  private lastPrune = 0;

  constructor(
    private readonly supabase: SupabaseService,
    private readonly indexer: KnowledgeIndexerService,
  ) {}

  onApplicationBootstrap() {
    if (process.env.NODE_ENV === 'test') return;

    if (loadConfig().KNOWLEDGE_INDEXING === 'off') {
      this.logger.log(
        'Knowledge indexing is switched off (KNOWLEDGE_INDEXING=off).',
      );
      return;
    }

    if (!this.indexer.configured) {
      this.logger.warn(
        'Knowledge indexing is idle: set OPENAI_API_KEY to enable it.',
      );
      return;
    }

    const first = setTimeout(() => void this.tick(), firstTickDelayMs);
    first.unref();
    this.timer = setInterval(() => void this.tick(), tickIntervalMs);
    this.timer.unref();
    this.logger.log('Knowledge indexing is on.');
  }

  onApplicationShutdown() {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick() {
    if (this.running) return;
    this.running = true;

    try {
      const due = await this.findDueItems();
      for (const item of due.slice(0, itemsPerTick)) {
        await this.process(item.id, item.state);
      }
      await this.pruneOccasionally();
    } catch (error) {
      this.logger.warn(`Indexing pass failed: ${(error as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  /** Content whose current version isn't indexed yet and isn't waiting out a backoff. */
  private async findDueItems() {
    const db = this.supabase.admin;
    const { data: items, error } = await db
      .from('content_items')
      .select('id,updated_at')
      .order('updated_at', { ascending: false })
      .limit(scanLimit);
    if (error) throw error;

    const rows = (items ?? []) as { id: string; updated_at: string }[];
    if (rows.length === 0) return [];

    const { data: states, error: stateError } = await db
      .from('knowledge_index_state')
      .select(
        'content_id,content_version,content_hash,status,attempts,next_attempt_at,claimed_at',
      )
      .in(
        'content_id',
        rows.map((row) => row.id),
      );
    if (stateError) throw stateError;

    const byId = new Map(
      ((states ?? []) as StateRow[]).map((state) => [state.content_id, state]),
    );
    const now = Date.now();

    return rows
      .map((row) => ({
        id: row.id,
        updatedAt: row.updated_at,
        state: byId.get(row.id) ?? null,
      }))
      .filter(({ updatedAt, state }) => {
        if (!state) return true;
        if (state.status === 'processing') {
          return (
            !state.claimed_at ||
            now - Date.parse(state.claimed_at) > staleClaimMs
          );
        }
        if (state.next_attempt_at && Date.parse(state.next_attempt_at) > now)
          return false;
        if (state.status === 'failed') return true;
        return (
          !state.content_version ||
          Date.parse(state.content_version) !== Date.parse(updatedAt)
        );
      })
      .reverse(); // oldest first, so a backlog drains in upload order
  }

  private async claim(contentId: string, state: StateRow | null) {
    const db = this.supabase.admin;
    const claimedAt = new Date().toISOString();

    if (!state) {
      const { data, error } = await db
        .from('knowledge_index_state')
        .upsert(
          {
            content_id: contentId,
            status: 'processing',
            claimed_at: claimedAt,
            updated_at: claimedAt,
          },
          { onConflict: 'content_id', ignoreDuplicates: true },
        )
        .select('content_id');
      if (error) throw error;
      return (data ?? []).length > 0;
    }

    const staleBefore = new Date(Date.now() - staleClaimMs).toISOString();
    const { data, error } = await db
      .from('knowledge_index_state')
      .update({
        status: 'processing',
        claimed_at: claimedAt,
        updated_at: claimedAt,
      })
      .eq('content_id', contentId)
      .or(
        `status.neq.processing,claimed_at.is.null,claimed_at.lt.${staleBefore}`,
      )
      .select('content_id');
    if (error) throw error;
    return (data ?? []).length > 0;
  }

  private async process(contentId: string, state: StateRow | null) {
    if (!(await this.claim(contentId, state))) return;

    const db = this.supabase.admin;
    const started = Date.now();

    try {
      const outcome = await this.indexer.indexItem(
        contentId,
        state?.content_hash ?? null,
      );
      const now = new Date().toISOString();

      if (outcome.kind === 'missing') {
        // Deleted while queued; the cascade removes its index rows.
        await db
          .from('knowledge_index_state')
          .delete()
          .eq('content_id', contentId);
        return;
      }

      const update: Record<string, unknown> = {
        status: 'indexed',
        content_version: outcome.version,
        content_hash: outcome.hash,
        attempts: 0,
        last_error: null,
        next_attempt_at: null,
        claimed_at: null,
        updated_at: now,
      };

      if (outcome.kind === 'excluded') {
        // No hash, so switching ingestion back on always rebuilds it.
        Object.assign(update, {
          content_hash: null,
          chunk_count: 0,
          entity_count: 0,
          relation_count: 0,
          indexed_at: null,
        });
        this.logger.log(
          `Removed ${contentId} from the index (AI ingestion off).`,
        );
      }

      if (outcome.kind === 'indexed') {
        const models = KnowledgeIndexerService.models();
        Object.assign(update, {
          chunk_count: outcome.chunks,
          entity_count: outcome.entities,
          relation_count: outcome.relations,
          embedding_model: models.embeddingModel,
          graph_model: models.graphModel,
          indexed_at: now,
        });
        this.logger.log(
          `Indexed ${contentId}: ${outcome.chunks} chunks, ${outcome.entities} entities, ${outcome.relations} relations (${outcome.method}, ${Date.now() - started} ms).`,
        );
      }

      const { error } = await db
        .from('knowledge_index_state')
        .update(update)
        .eq('content_id', contentId);
      if (error) throw error;
    } catch (error) {
      const attempts = (state?.attempts ?? 0) + 1;
      const delay = Math.min(60_000 * 2 ** (attempts - 1), maxBackoffMs);
      const message =
        (error as Error).message?.slice(0, 1000) ?? 'Unknown error';
      this.logger.warn(
        `Indexing ${contentId} failed (attempt ${attempts}): ${message}`,
      );

      await db
        .from('knowledge_index_state')
        .update({
          status: 'failed',
          attempts,
          last_error: message,
          next_attempt_at: new Date(Date.now() + delay).toISOString(),
          claimed_at: null,
          updated_at: new Date().toISOString(),
        })
        .eq('content_id', contentId);
    }
  }

  private async pruneOccasionally() {
    if (Date.now() - this.lastPrune < pruneEveryMs) return;
    this.lastPrune = Date.now();
    const { error } = await this.supabase.admin.rpc('kg_prune_orphan_entities');
    if (error)
      this.logger.warn(`Pruning orphan entities failed: ${error.message}`);
  }
}

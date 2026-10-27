import { Injectable, Logger } from '@nestjs/common';
import { escapeFilter } from '../common/validation';
import { EmbeddingsService } from '../knowledge/embeddings.service';
import { visibleContentFilter } from '../auth/brand-access.service';
import { SupabaseService } from '../supabase.service';
import {
  type AssistantSource,
  type GraphFact,
  locationsIn,
  normalizeQuery,
  queryTerms,
} from './prompt';

/** Chunks fetched from vector search before filtering. */
const chunkCandidates = 16;
/** Cosine similarity below this is treated as unrelated. */
const minSimilarity = 0.25;
const maxSources = 8;
const maxExcerptsPerSource = 3;
const maxFactsPerSource = 8;
const maxGraphEntities = 6;

type ChunkMatch = {
  chunk_id: string;
  content_id: string;
  chunk_index: number;
  content: string;
  similarity: number;
};

type EntityRow = { id: string; name: string; normalized_name: string };

type RelationRow = {
  content_id: string;
  relation: string;
  evidence: string | null;
  source: { name: string } | null;
  target: { name: string } | null;
};

type ContentRow = {
  id: string;
  title: string;
  content_type: string;
  category: string;
  file_name: string | null;
  storage_path: string | null;
  brand: { name: string; slug: string } | null;
};

/**
 * Finds the approved content that can answer a question, combining:
 *  - semantic search over embedded chunks (what the text says), and
 *  - the knowledge graph (what the question names: brands, molecules,
 *    studies...), which also surfaces related documents that never use the
 *    question's exact words.
 * Only approved content is ever returned.
 */
@Injectable()
export class RetrievalService {
  private readonly logger = new Logger('AssistantRetrieval');

  constructor(
    private readonly supabase: SupabaseService,
    private readonly embeddings: EmbeddingsService,
  ) {}

  /** `hiddenBrandIds`: restricted brands the asker hasn't been given; never used or cited. */
  async retrieve(
    query: string,
    hiddenBrandIds: string[] = [],
  ): Promise<AssistantSource[]> {
    const [chunks, graph] = await Promise.all([
      this.searchChunks(query),
      this.searchGraph(query).catch((error: Error) => {
        // The graph enriches answers; semantic search alone still works.
        this.logger.warn(`Graph lookup failed: ${error.message}`);
        return {
          contentIds: [] as string[],
          facts: [] as (GraphFact & { contentId: string })[],
        };
      }),
    ]);

    // Rank documents: best semantic match first, then graph-only documents.
    const order: string[] = [];
    const best = new Map<string, number>();
    for (const chunk of chunks) {
      if (!best.has(chunk.content_id)) order.push(chunk.content_id);
      best.set(
        chunk.content_id,
        Math.max(best.get(chunk.content_id) ?? 0, chunk.similarity),
      );
    }
    for (const id of graph.contentIds) {
      if (!best.has(id) && !order.includes(id)) order.push(id);
    }

    const ids = order.slice(0, maxSources * 2);
    if (ids.length === 0) return [];

    const items = await this.loadApproved(ids, hiddenBrandIds);
    const sources: AssistantSource[] = [];

    for (const id of ids) {
      const item = items.get(id);
      if (!item) continue; // not approved (or deleted): never used

      const excerpts = chunks
        .filter((chunk) => chunk.content_id === id)
        .slice(0, maxExcerptsPerSource)
        .sort((a, b) => a.chunk_index - b.chunk_index)
        .map((chunk) => chunk.content);
      const facts = graph.facts
        .filter((fact) => fact.contentId === id)
        .slice(0, maxFactsPerSource)
        .map((fact) => ({
          source: fact.source,
          relation: fact.relation,
          target: fact.target,
          evidence: fact.evidence,
        }));

      sources.push({
        index: sources.length + 1,
        contentId: item.id,
        title: item.title,
        contentType: item.content_type,
        category: item.category,
        brandName: item.brand?.name ?? null,
        brandSlug: item.brand?.slug ?? null,
        fileName: item.file_name,
        locations: locationsIn(excerpts),
        score: best.has(id)
          ? Math.round((best.get(id) ?? 0) * 100) / 100
          : null,
        excerpts,
        facts,
      });

      if (sources.length >= maxSources) break;
    }

    return sources;
  }

  private async searchChunks(query: string) {
    const vectors = await this.embeddings.embed([query]);
    const vector = vectors[0];
    const result = await this.supabase.admin.rpc('match_knowledge_chunks', {
      query_embedding: JSON.stringify(vector),
      match_count: chunkCandidates,
      approved_only: true,
    });
    if (result.error) throw result.error;
    return ((result.data ?? []) as ChunkMatch[]).filter(
      (chunk) => chunk.similarity >= minSimilarity,
    );
  }

  /** Entities the question names, the documents mentioning them, and their relations. */
  private async searchGraph(query: string) {
    const terms = queryTerms(query);
    if (terms.length === 0) return { contentIds: [], facts: [] };

    const db = this.supabase.admin;
    const filter = terms
      .map((term) => escapeFilter(term))
      .filter(Boolean)
      .map((term) => `normalized_name.ilike.%${term}%`)
      .join(',');
    if (!filter) return { contentIds: [], facts: [] };

    const { data: candidates, error } = await db
      .from('kg_entities')
      .select('id,name,normalized_name')
      .or(filter)
      .limit(50);
    if (error) throw error;

    // Keep entities whose full name appears in the question, longest first
    // ("calpol plus" beats "calpol"), so partial word matches don't add noise.
    const normalized = ` ${normalizeQuery(query)} `;
    const entities = ((candidates ?? []) as EntityRow[])
      .filter(
        (entity) =>
          entity.normalized_name.length >= 3 &&
          normalized.includes(entity.normalized_name),
      )
      .sort((a, b) => b.normalized_name.length - a.normalized_name.length)
      .slice(0, maxGraphEntities);
    if (entities.length === 0) return { contentIds: [], facts: [] };

    const entityIds = entities.map((entity) => entity.id);
    const idList = entityIds.join(',');

    const [mentions, relations] = await Promise.all([
      db
        .from('kg_mentions')
        .select('content_id')
        .in('entity_id', entityIds)
        .limit(40),
      db
        .from('kg_relations')
        .select(
          'content_id,relation,evidence,source:kg_entities!kg_relations_source_entity_id_fkey(name),target:kg_entities!kg_relations_target_entity_id_fkey(name)',
        )
        .or(`source_entity_id.in.(${idList}),target_entity_id.in.(${idList})`)
        .limit(60),
    ]);
    if (mentions.error) throw mentions.error;
    if (relations.error) throw relations.error;

    const contentIds = [
      ...new Set(
        ((mentions.data ?? []) as { content_id: string }[]).map(
          (row) => row.content_id,
        ),
      ),
    ];
    const facts = ((relations.data ?? []) as unknown as RelationRow[])
      .filter((row) => row.source && row.target)
      .map((row) => ({
        contentId: row.content_id,
        source: row.source!.name,
        relation: row.relation,
        target: row.target!.name,
        evidence: row.evidence,
      }));

    return { contentIds, facts };
  }

  private async loadApproved(ids: string[], hiddenBrandIds: string[]) {
    let request = this.supabase.admin
      .from('content_items')
      .select(
        'id,title,content_type,category,file_name,storage_path,brand:brands(name,slug)',
      )
      .in('id', ids)
      .eq('status', 'approved')
      // Excluded from AI ingestion: never cited, even before the worker removes its index rows.
      .eq('ai_ingestion', true);
    // Content of restricted brands the asker hasn't been given is never used.
    const visible = visibleContentFilter(hiddenBrandIds);
    if (visible) request = request.or(visible);
    const { data, error } = await request;
    if (error) throw error;
    return new Map(
      ((data ?? []) as unknown as ContentRow[]).map((row) => [row.id, row]),
    );
  }
}

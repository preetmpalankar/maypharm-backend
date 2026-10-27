import { Injectable, Logger } from '@nestjs/common';
import { getExtension } from '../storage/file-policy';
import { SupabaseService } from '../supabase.service';
import {
  chunkText,
  contentHash,
  describeItem,
  estimateTokens,
  type IndexableItem,
  normalizeEntityName,
} from './chunking';
import { EmbeddingsService, embeddingModel } from './embeddings.service';
import {
  type ExtractedGraph,
  GraphExtractionService,
  graphModel,
} from './graph-extraction.service';
import { extractText } from './text-extraction';

type ItemRow = IndexableItem & {
  status: string;
  ai_ingestion: boolean;
  storage_bucket: string;
  storage_path: string | null;
  file_name: string | null;
  updated_at: string;
  brand: { name: string } | null;
};

export type IndexOutcome =
  | { kind: 'missing' }
  | { kind: 'unchanged' }
  | { kind: 'excluded' }
  | {
      kind: 'indexed';
      chunks: number;
      entities: number;
      relations: number;
      method: string;
    };

type FileRow = {
  id: string;
  storage_bucket: string;
  storage_path: string;
  file_name: string;
  file_size: number | null;
};

/** File types text can be read from; images, video and audio are skipped. */
const readableExtensions = new Set(['pdf', 'docx', 'xlsx', 'pptx', 'csv']);
/**
 * Larger documents are not downloaded for text extraction (the whole file is
 * held in memory); they are indexed by their title, summary and details.
 */
const maxExtractBytes = 100 * 1024 * 1024;

/** Graph extraction is skipped for items with almost no text (e.g. a bare image). */
const minGraphChars = 120;
const insertBatch = 100;

/**
 * Builds the knowledge index for one content item: text from the file and the
 * item's details, chunked and embedded, plus a knowledge graph. Everything is
 * computed before anything is written, so a failure leaves the previous index
 * in place.
 */
@Injectable()
export class KnowledgeIndexerService {
  private readonly logger = new Logger('KnowledgeIndexer');

  constructor(
    private readonly supabase: SupabaseService,
    private readonly embeddings: EmbeddingsService,
    private readonly graph: GraphExtractionService,
  ) {}

  get configured() {
    return this.embeddings.configured && this.graph.configured;
  }

  async indexItem(
    contentId: string,
    previousHash: string | null,
  ): Promise<IndexOutcome & { hash?: string; version?: string }> {
    const db = this.supabase.admin;
    const { data: item, error } = await db
      .from('content_items')
      .select(
        'id,title,content_type,category,product_name,description,metadata,status,ai_ingestion,storage_bucket,storage_path,file_name,updated_at,brand:brands(name)',
      )
      .eq('id', contentId)
      .maybeSingle<ItemRow>();

    if (error) throw error;
    if (!item) return { kind: 'missing' };

    // AI ingestion switched off for this item: take it out of the index.
    if (!item.ai_ingestion) {
      await this.writeChunks(item.id, [], []);
      await this.writeGraph(item.id, { entities: [], relations: [] });
      return { kind: 'excluded', version: item.updated_at };
    }

    const details = describeItem({
      ...item,
      brand_name: item.brand?.name ?? null,
    });
    const extracted = await this.readFiles(item);
    const hash = contentHash([details, extracted.text]);

    // Nothing that feeds the index changed (e.g. only the status did).
    if (previousHash && previousHash === hash) {
      return { kind: 'unchanged', hash, version: item.updated_at };
    }

    const header = `[${item.title} | ${item.content_type}${item.brand?.name ? ` | ${item.brand.name}` : ''}]`;
    const document = extracted.text
      ? `${details}\n\n${extracted.text}`
      : details;
    const chunks = chunkText(document, header);
    const vectors =
      chunks.length > 0 ? await this.embeddings.embed(chunks) : [];
    const graph: ExtractedGraph =
      document.length >= minGraphChars
        ? await this.graph.extract(document)
        : { entities: [], relations: [] };

    await this.writeChunks(item.id, chunks, vectors);
    const counts = await this.writeGraph(item.id, graph);

    return {
      kind: 'indexed',
      chunks: chunks.length,
      entities: counts.entities,
      relations: counts.relations,
      method: extracted.method,
      hash,
      version: item.updated_at,
    };
  }

  /**
   * Text from every file attached to the item, each under its own heading.
   * Media (nothing to read) and files too large to hold in memory are left
   * out; the item's title, summary and details are still indexed.
   */
  private async readFiles(item: ItemRow) {
    const { data: files, error } = await this.supabase.admin
      .from('content_files')
      .select('id,storage_bucket,storage_path,file_name,file_size')
      .eq('content_id', item.id)
      .order('position')
      .returns<FileRow[]>();
    if (error) throw error;

    const parts: string[] = [];
    const methods: string[] = [];

    for (const file of files ?? []) {
      const extension = getExtension(file.file_name || file.storage_path) ?? '';

      if (!readableExtensions.has(extension)) {
        methods.push(`skipped:${extension || 'unknown'}`);
        continue;
      }
      if ((file.file_size ?? 0) > maxExtractBytes) {
        methods.push(`too-large:${extension}`);
        continue;
      }

      const extracted = await this.readFile(item.id, file, extension);
      methods.push(extracted.method);
      if (extracted.text)
        parts.push(`File: ${file.file_name}\n${extracted.text}`);
    }

    return {
      text: parts.join('\n\n'),
      method: methods.length ? methods.join(',') : 'no-file',
    };
  }

  private async readFile(contentId: string, file: FileRow, extension: string) {
    const { data, error } = await this.supabase.admin.storage
      .from(file.storage_bucket)
      .download(file.storage_path);

    if (error || !data) {
      throw new Error(
        `Could not download ${file.file_name}: ${error?.message ?? 'no data'}`,
      );
    }

    try {
      return await extractText(
        new Uint8Array(await data.arrayBuffer()),
        extension,
      );
    } catch (cause) {
      // An unreadable file still gets its title, description and details indexed.
      this.logger.warn(
        `Text extraction failed for ${contentId} / ${file.file_name}: ${(cause as Error).message}`,
      );
      return { text: '', method: `extract-failed:${extension}` };
    }
  }

  private async writeChunks(
    contentId: string,
    chunks: string[],
    vectors: number[][],
  ) {
    const db = this.supabase.admin;
    const { error: deleteError } = await db
      .from('knowledge_chunks')
      .delete()
      .eq('content_id', contentId);
    if (deleteError) throw deleteError;

    const rows = chunks.map((content, index) => ({
      content_id: contentId,
      chunk_index: index,
      content,
      // pgvector accepts the JSON array text form.
      embedding: JSON.stringify(vectors[index]),
      token_estimate: estimateTokens(content),
    }));

    for (let start = 0; start < rows.length; start += insertBatch) {
      const { error } = await db
        .from('knowledge_chunks')
        .insert(rows.slice(start, start + insertBatch));
      if (error) throw error;
    }
  }

  private async writeGraph(contentId: string, graph: ExtractedGraph) {
    const db = this.supabase.admin;

    for (const table of ['kg_relations', 'kg_mentions'] as const) {
      const { error } = await db
        .from(table)
        .delete()
        .eq('content_id', contentId);
      if (error) throw error;
    }

    // One row per distinct entity (same normalized name and type).
    const unique = new Map<
      string,
      {
        name: string;
        normalized_name: string;
        entity_type: string;
        description: string;
      }
    >();
    for (const entity of graph.entities) {
      const normalized = normalizeEntityName(entity.name);
      if (!normalized) continue;
      const key = `${entity.type}\u0000${normalized}`;
      if (!unique.has(key)) {
        unique.set(key, {
          name: entity.name.trim(),
          normalized_name: normalized,
          entity_type: entity.type,
          description: entity.description.trim(),
        });
      }
    }

    if (unique.size === 0) return { entities: 0, relations: 0 };

    const { data: saved, error: upsertError } = await db
      .from('kg_entities')
      .upsert([...unique.values()], {
        onConflict: 'normalized_name,entity_type',
      })
      .select('id,normalized_name,entity_type');
    if (upsertError) throw upsertError;

    const entities = (saved ?? []) as {
      id: string;
      normalized_name: string;
      entity_type: string;
    }[];
    const byName = new Map<string, string>();
    for (const entity of entities) {
      // Relations name entities without a type; the first match wins.
      if (!byName.has(entity.normalized_name))
        byName.set(entity.normalized_name, entity.id);
    }

    const { error: mentionError } = await db.from('kg_mentions').upsert(
      entities.map((entity) => ({
        entity_id: entity.id,
        content_id: contentId,
      })),
      { onConflict: 'entity_id,content_id', ignoreDuplicates: true },
    );
    if (mentionError) throw mentionError;

    const relations = graph.relations
      .map((relation) => ({
        content_id: contentId,
        source_entity_id: byName.get(normalizeEntityName(relation.source)),
        target_entity_id: byName.get(normalizeEntityName(relation.target)),
        relation:
          relation.relation
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '_')
            .replace(/^_|_$/g, '') || 'related_to',
        evidence: relation.evidence.trim().slice(0, 1000),
      }))
      .filter(
        (
          relation,
        ): relation is typeof relation & {
          source_entity_id: string;
          target_entity_id: string;
        } =>
          Boolean(relation.source_entity_id && relation.target_entity_id) &&
          relation.source_entity_id !== relation.target_entity_id,
      );

    for (let start = 0; start < relations.length; start += insertBatch) {
      const { error } = await db
        .from('kg_relations')
        .insert(relations.slice(start, start + insertBatch));
      if (error) throw error;
    }

    return { entities: entities.length, relations: relations.length };
  }

  static models() {
    return { embeddingModel, graphModel: graphModel() };
  }
}

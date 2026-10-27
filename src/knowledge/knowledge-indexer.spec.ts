import { KnowledgeIndexerService } from './knowledge-indexer.service';
import type { EmbeddingsService } from './embeddings.service';
import type { GraphExtractionService } from './graph-extraction.service';
import type { SupabaseService } from '../supabase.service';

/** A minimal stand-in for the Supabase query builder that records deletes. */
function fakeSupabase(item: Record<string, unknown>) {
  const deletes: string[] = [];
  const from = (table: string) => ({
    select: () => ({
      eq: () => ({
        maybeSingle: () => Promise.resolve({ data: item, error: null }),
      }),
    }),
    delete: () => ({
      eq: () => {
        deletes.push(table);
        return Promise.resolve({ error: null });
      },
    }),
    insert: () => {
      throw new Error(`unexpected insert into ${table}`);
    },
  });
  return {
    service: { admin: { from } } as unknown as SupabaseService,
    deletes,
  };
}

describe('knowledge indexer', () => {
  it('removes an item from the index without calling OpenAI when AI ingestion is off', async () => {
    const { service, deletes } = fakeSupabase({
      id: '7c1d4a52-2f6e-4f0b-9a37-1b2a3c4d5e6f',
      title: 'Internal pricing sheet',
      content_type: 'product',
      category: 'Diabetes',
      product_name: null,
      description: 'Not for the assistant.',
      metadata: {},
      status: 'approved',
      ai_ingestion: false,
      storage_bucket: 'content-assets',
      storage_path: null,
      file_name: null,
      updated_at: '2026-10-27T10:00:00.000Z',
      brand: null,
    });
    const embed = jest.fn();
    const extract = jest.fn();
    const indexer = new KnowledgeIndexerService(
      service,
      { configured: true, embed } as unknown as EmbeddingsService,
      { configured: true, extract } as unknown as GraphExtractionService,
    );

    const outcome = await indexer.indexItem(
      '7c1d4a52-2f6e-4f0b-9a37-1b2a3c4d5e6f',
      'old-hash',
    );

    expect(outcome).toEqual({
      kind: 'excluded',
      version: '2026-10-27T10:00:00.000Z',
    });
    expect(deletes).toEqual(
      expect.arrayContaining([
        'knowledge_chunks',
        'kg_relations',
        'kg_mentions',
      ]),
    );
    expect(embed).not.toHaveBeenCalled();
    expect(extract).not.toHaveBeenCalled();
  });
});

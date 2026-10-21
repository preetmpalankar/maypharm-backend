import { createHash } from 'node:crypto';

/** ~300-400 tokens per chunk, with overlap so facts aren't cut in half. */
export const chunkChars = 1500;
export const overlapChars = 200;

export type IndexableItem = {
  id: string;
  title: string;
  content_type: string;
  category: string;
  product_name: string | null;
  description: string;
  metadata: Record<string, unknown> | null;
  brand_name?: string | null;
};

/** The item's own fields as readable text: indexed even when the file has none. */
export function describeItem(item: IndexableItem) {
  const lines = [
    `Title: ${item.title}`,
    `Type: ${item.content_type}`,
    item.brand_name ? `Brand: ${item.brand_name}` : '',
    item.product_name ? `Product: ${item.product_name}` : '',
    item.category ? `Category: ${item.category}` : '',
    item.description ? `Description: ${item.description}` : '',
  ];

  for (const [key, value] of Object.entries(item.metadata ?? {})) {
    if (typeof value === 'string' && value.trim()) {
      lines.push(`${humanize(key)}: ${value.trim()}`);
    }
  }

  return lines.filter(Boolean).join('\n');
}

function humanize(key: string) {
  return key
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/^./, (first) => first.toUpperCase());
}

/**
 * Splits text into overlapping chunks, preferring paragraph, then sentence,
 * then word boundaries. Every chunk is prefixed with a short header naming the
 * item, so a retrieved chunk is self-explanatory to the assistant.
 */
export function chunkText(text: string, header: string) {
  const body = text.trim();
  if (!body) return [];

  const chunks: string[] = [];
  let start = 0;

  while (start < body.length) {
    let end = Math.min(start + chunkChars, body.length);

    if (end < body.length) {
      const window = body.slice(start, end);
      const breakAt = Math.max(
        window.lastIndexOf('\n\n'),
        window.lastIndexOf('. '),
        window.lastIndexOf('\n'),
      );
      const spaceAt = window.lastIndexOf(' ');
      const cut =
        breakAt > chunkChars * 0.5
          ? breakAt + 1
          : spaceAt > chunkChars * 0.5
            ? spaceAt
            : -1;
      if (cut > 0) end = start + cut;
    }

    const piece = body.slice(start, end).trim();
    if (piece) chunks.push(`${header}\n\n${piece}`);
    if (end >= body.length) break;
    start = Math.max(end - overlapChars, start + 1);
  }

  return chunks;
}

/** Rough token count (about four characters per token for English). */
export function estimateTokens(text: string) {
  return Math.ceil(text.length / 4);
}

/** Fingerprint of everything that feeds the index; unchanged means no rework. */
export function contentHash(parts: string[]) {
  const hash = createHash('sha256');
  for (const part of parts) hash.update(part).update('\u0000');
  return hash.digest('hex');
}

/** Case- and spacing-insensitive key for merging the same entity across documents. */
export function normalizeEntityName(name: string) {
  return name
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[®™©]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

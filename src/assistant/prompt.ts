/**
 * Pure building blocks for the assistant: the system prompt, how retrieved
 * content is shown to the model, and how citations are read back out.
 */

export type GraphFact = {
  source: string;
  relation: string;
  target: string;
  evidence: string | null;
};

/** One approved content item the answer may draw on, numbered for citation. */
export type AssistantSource = {
  index: number;
  contentId: string;
  title: string;
  contentType: string;
  category: string;
  brandName: string | null;
  brandSlug: string | null;
  fileName: string | null;
  /** Where in the file the matching text is, e.g. ["Page 4", "Slide 2"]. */
  locations: string[];
  /** Best semantic match score among its chunks (0-1), or null if graph-only. */
  score: number | null;
  excerpts: string[];
  facts: GraphFact[];
};

/** What the client receives for each source (no excerpts or facts). */
export type PublicSource = Omit<AssistantSource, 'excerpts' | 'facts'>;

export function toPublicSource(source: AssistantSource): PublicSource {
  return {
    index: source.index,
    contentId: source.contentId,
    title: source.title,
    contentType: source.contentType,
    category: source.category,
    brandName: source.brandName,
    brandSlug: source.brandSlug,
    fileName: source.fileName,
    locations: source.locations,
    score: source.score,
  };
}

export const systemPrompt = `You are the MayPharm Assistant: a friendly, professional helper for MayPharm's medical representatives and field teams. You help them find and understand approved brand, product, clinical and training content.

Conversation:
- Greetings, thanks, small talk and questions about you ("hi", "thank you", "what can you do?") are normal conversation. Reply warmly and briefly, like a helpful colleague. When it fits, say what you can help with, mentioning a few brands from the library overview, and offer two or three example questions about what the overview shows actually exists (its brands and content types). Do not invent kinds of material. Never reply to these with "I couldn't find it".
- If a request is vague ("tell me about it"), ask a short clarifying question, using the library overview to offer options.

Answering questions about MayPharm content:
- Use only the numbered sources provided with the message. They are approved MayPharm content. Do not use outside knowledge for facts, even if you know the answer.
- Cite every factual statement with its source number in square brackets, like [1] or [2][3], at the end of the sentence or bullet it supports. Cite facts only, never offers, suggestions or questions back to the user. Never cite a number that was not provided.
- If no source answers the question, say so plainly in one sentence, then help them move forward: point to brands or content types from the library overview that look related, or suggest how to rephrase. If the library is empty, explain that content appears once their admin team publishes it. Users cannot upload content themselves: for missing material, suggest asking their MayPharm admin or medical team. Do not guess, and do not name drug classes or products that are not in the overview.
- Content is view only inside the MayPharm app: it cannot be downloaded, exported, shared or found anywhere else. Cited images, videos and audio play right below your answer, and every source opens in the app. Never offer downloads, file names, links or other places where files are kept. When asked to show or play something, say briefly what it is, cite it, and let them know it is shown below.
- Stay within what the sources state. Report results and figures as written, without adding judgements such as "clinically meaningful", "significant", "superior" or "well tolerated" unless the source uses those words. Do not make efficacy, safety or comparative claims they do not make, do not suggest off-label use, and do not give advice about individual patients. If asked for that, explain that you can only share what approved content says.

Style:
- Be concise and easy to scan: a one or two sentence answer first, then short bullets for details, lists or steps. Use **bold** sparingly for key terms. No tables, no headings larger than ###.
- Reply in the same language the user writes in.`;

export type LibraryOverview = {
  totalItems: number;
  /** Published items per content type, e.g. { product: 2, clinical: 1 }. */
  byType: Record<string, number>;
  brands: { name: string; category: string; items: number }[];
};

/** What the library contains, so replies can point to real brands. */
export function formatOverview(overview: LibraryOverview) {
  if (overview.totalItems === 0 && overview.brands.length === 0) {
    return 'The MayPharm library has no published content yet.';
  }
  const brands = overview.brands
    .slice(0, 25)
    .map(
      (brand) =>
        `${brand.name}${brand.category ? ` (${brand.category})` : ''}: ${brand.items} item${brand.items === 1 ? '' : 's'}`,
    );
  const types = Object.entries(overview.byType)
    .filter(([, count]) => count > 0)
    .map(([type, count]) => `${type.replace('_', ' ')} ${count}`);
  return [
    `Published items: ${overview.totalItems}${types.length ? ` (${types.join(', ')})` : ''}.`,
    brands.length > 0
      ? `Brands: ${brands.join('; ')}.`
      : 'No brand folders yet.',
  ].join('\n');
}

/** The final user turn: library overview, sources (if searched) and the message. */
export function buildUserTurn(
  message: string,
  overview: LibraryOverview,
  sources: AssistantSource[] | null,
) {
  const parts = [`Library overview:\n${formatOverview(overview)}`];
  parts.push(
    sources === null
      ? 'No content search was run: this message is conversational.'
      : `Approved MayPharm sources:\n\n${buildContext(sources)}`,
  );
  parts.push(`---\n\nUser message: ${message}`);
  return parts.join('\n\n');
}

const conversational =
  /^(hi+|hello+|hey+|hiya|yo|namaste|good (morning|afternoon|evening|day)|morning|evening|thanks?( you)?( so much| a lot)?|thank you( so much| very much)?|thx|ty|ok(ay)?|cool|great|nice|awesome|perfect|got it|understood|bye|goodbye|see you|cheers|who are you|what are you|what can you do|how can you help( me)?|what do you do|help|how are you( doing)?|test(ing)?)$/;

/**
 * Greetings, thanks and questions about the assistant itself. These skip the
 * content search: there is nothing to look up, and it keeps them instant.
 */
export function isConversational(message: string) {
  const text = normalizeQuery(message)
    .replace(/[.!?,]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text || text.split(' ').length > 6) return false;
  const stripped = text.replace(
    /^(hi|hello|hey)\s+(there|team|all|assistant|maypharm)$/,
    'hi',
  );
  return conversational.test(stripped);
}

/** Renders the retrieved sources as the context block the model answers from. */
export function buildContext(sources: AssistantSource[]) {
  if (sources.length === 0) {
    return 'No approved MayPharm content matched this message.';
  }

  return sources
    .map((source) => {
      const lines = [
        `[${source.index}] ${source.title}`,
        `Type: ${source.contentType}${source.brandName ? ` | Brand: ${source.brandName}` : ''}${source.category ? ` | Category: ${source.category}` : ''}`,
      ];

      if (source.excerpts.length > 0) {
        lines.push('Excerpts:');
        for (const excerpt of source.excerpts) {
          lines.push(`"""\n${stripChunkHeader(excerpt)}\n"""`);
        }
      }

      if (source.facts.length > 0) {
        lines.push('Facts from this document:');
        for (const fact of source.facts) {
          lines.push(`- ${formatFact(fact)}`);
        }
      }

      return lines.join('\n');
    })
    .join('\n\n');
}

export function formatFact(fact: GraphFact) {
  const relation = fact.relation.replace(/_/g, ' ');
  const evidence = fact.evidence ? ` (evidence: "${fact.evidence}")` : '';
  return `${fact.source} ${relation} ${fact.target}${evidence}`;
}

/** Chunks start with "[title | type]" for the index; the source header already says that. */
export function stripChunkHeader(chunk: string) {
  return chunk.replace(/^\[[^\]\n]*\]\n\n/, '');
}

/** Source numbers the answer actually cited, in first-cited order. */
export function citedIndexes(answer: string, available: number) {
  const seen: number[] = [];
  for (const match of answer.matchAll(/\[(\d{1,2}(?:\s*[,-]\s*\d{1,2})*)\]/g)) {
    for (const part of match[1].split(',')) {
      const range = part.split('-').map((value) => Number(value.trim()));
      const [start, end = start] = range;
      for (let index = start; index <= end && index - start < 20; index++) {
        if (index >= 1 && index <= available && !seen.includes(index)) {
          seen.push(index);
        }
      }
    }
  }
  return seen;
}

/** Page and slide markers in excerpts (added during indexing), e.g. ["Page 4"]. */
export function locationsIn(excerpts: string[]) {
  const found = new Set<string>();
  for (const excerpt of excerpts) {
    for (const match of excerpt.matchAll(
      /\[(Page|Slide|Sheet:?) ?([^\]\n]{1,40})\]/g,
    )) {
      const kind = match[1].replace(':', '');
      found.add(`${kind} ${match[2].trim()}`);
    }
  }
  return [...found].slice(0, 4);
}

const stopwords = new Set(
  'a an and are as at be by can do does for from has have how i in is it its me my of on or our should tell that the their them there these this to us was we what when where which who why will with you your about any all give list show summarise summarize explain please compare vs versus brand product'.split(
    ' ',
  ),
);

/** Lowercased, punctuation-free query for matching entity names. */
export function normalizeQuery(text: string) {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[®™©]/g, '')
    .replace(/[^\p{L}\p{N}\s.-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Distinctive words of a query, for finding graph entities it names. */
export function queryTerms(text: string) {
  const words = normalizeQuery(text)
    .split(' ')
    .map((word) => word.replace(/^[.-]+|[.-]+$/g, ''))
    .filter((word) => word.length >= 3 && !stopwords.has(word));
  return [...new Set(words)].slice(0, 8);
}

/** Short conversation title from the first question. */
export function titleFrom(message: string) {
  const clean = message.replace(/\s+/g, ' ').trim();
  return clean.length <= 70 ? clean : `${clean.slice(0, 67).trimEnd()}…`;
}

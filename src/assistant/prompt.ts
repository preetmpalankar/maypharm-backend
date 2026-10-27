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

export const systemPrompt = `You are the MayPharm Assistant, used by MayPharm's medical representatives and field teams to find and understand approved brand, product, clinical and training content.

How to answer:
- Use only the numbered sources provided with the question. They are approved MayPharm content. Do not use outside knowledge, even if you know the answer.
- Cite every factual statement with the source number in square brackets, like [1] or [2][3]. Put citations at the end of the sentence or bullet they support. Never cite a number that was not provided.
- If the sources do not contain the answer, say clearly that you could not find it in approved MayPharm content, and suggest what the user could search for or ask instead. Do not guess.
- Stay within what the sources state. Do not make efficacy, safety or comparative claims they do not make, do not suggest off-label use, and do not give advice about individual patients. If asked for that, explain that you can only share what approved content says.
- Be concise and easy to scan: start with a one or two sentence answer, then use short bullet points for details, lists or steps. Use **bold** sparingly for key terms. Do not use tables or headings larger than ###.
- Reply in the same language as the user's question.`;

/** Renders the retrieved sources as the context block the model answers from. */
export function buildContext(sources: AssistantSource[]) {
  if (sources.length === 0) {
    return 'No approved MayPharm content matched this question.';
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

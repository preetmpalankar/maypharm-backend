import { Injectable } from '@nestjs/common';
import OpenAI from 'openai';
import { zodTextFormat } from 'openai/helpers/zod';
import { z } from 'zod';
import { loadConfig } from '../config';

/** The OpenAI model that extracts the graph (OPENAI_GRAPH_MODEL overrides it). */
export function graphModel() {
  return loadConfig().OPENAI_GRAPH_MODEL;
}

export const entityTypes = [
  'brand',
  'product',
  'molecule',
  'indication',
  'condition',
  'study',
  'endpoint',
  'population',
  'dosage_form',
  'strength',
  'adverse_event',
  'mechanism',
  'organization',
  'person',
  'other',
] as const;

const graphSchema = z.object({
  entities: z.array(
    z.object({
      name: z.string(),
      type: z.enum(entityTypes),
      description: z.string(),
    }),
  ),
  relations: z.array(
    z.object({
      source: z.string(),
      relation: z.string(),
      target: z.string(),
      evidence: z.string(),
    }),
  ),
});

export type ExtractedGraph = z.infer<typeof graphSchema>;

const systemPrompt = `You build a knowledge graph from approved pharmaceutical content for a field-force assistant used by medical representatives.

From the document, extract:
- entities: brands, products, molecules (generic names), indications, conditions, clinical studies, endpoints, patient populations, dosage forms, strengths, adverse events, mechanisms of action, organizations and named people. Use the most specific type that fits; "other" only when nothing else does. Use the name as written in the document (e.g. "Paracetamol 500 mg" is a product; "Paracetamol" is a molecule). Each description is one short factual sentence from the document.
- relations between those entities, as short lower_snake_case verbs, for example: contains_molecule, indicated_for, studied_in, has_endpoint, has_strength, has_dosage_form, causes_adverse_event, manufactured_by, compared_with, enrolled_population, has_mechanism. Source and target must be names that appear in your entities list. Evidence is a short quote or close paraphrase from the document supporting the relation.

Skip file and media details that are not pharmaceutical facts: file formats, image or video dimensions, durations, file names, usage rights, years and channel names.

Only extract what the document states. Do not add outside knowledge, infer efficacy, or create claims the text does not make. If the document has little factual content, return few or no entities.`;

/** Extracts entities and relations from a document with OpenAI (structured output). */
@Injectable()
export class GraphExtractionService {
  private client?: OpenAI;

  get configured() {
    return Boolean(loadConfig().OPENAI_API_KEY);
  }

  private get openai() {
    this.client ??= new OpenAI({
      apiKey: loadConfig().OPENAI_API_KEY,
      maxRetries: 3,
      timeout: 5 * 60_000,
    });
    return this.client;
  }

  async extract(document: string): Promise<ExtractedGraph> {
    const response = await this.openai.responses.parse({
      model: graphModel(),
      instructions: systemPrompt,
      input: `<document>\n${document}\n</document>\n\nExtract the knowledge graph for this document.`,
      max_output_tokens: 16000,
      text: { format: zodTextFormat(graphSchema, 'knowledge_graph') },
    });

    if (response.status === 'incomplete') {
      throw new Error(
        `Graph extraction was incomplete (${response.incomplete_details?.reason ?? 'unknown reason'}).`,
      );
    }

    const refused = response.output.some(
      (item) =>
        item.type === 'message' &&
        item.content.some((part) => part.type === 'refusal'),
    );
    if (refused) {
      throw new Error('Graph extraction was declined by the model.');
    }

    if (!response.output_parsed) {
      throw new Error('Graph extraction returned no parseable output.');
    }

    return response.output_parsed;
  }
}

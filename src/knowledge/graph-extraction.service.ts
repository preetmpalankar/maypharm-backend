import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { loadConfig } from '../config';

export const graphModel = 'claude-opus-5-5';

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

Only extract what the document states. Do not add outside knowledge, infer efficacy, or create claims the text does not make. If the document has little factual content, return few or no entities.`;

/** Extracts entities and relations from a document with Claude (structured output). */
@Injectable()
export class GraphExtractionService {
  private client?: Anthropic;

  get configured() {
    return Boolean(loadConfig().ANTHROPIC_API_KEY);
  }

  private get anthropic() {
    this.client ??= new Anthropic({
      apiKey: loadConfig().ANTHROPIC_API_KEY,
      maxRetries: 3,
    });
    return this.client;
  }

  async extract(document: string): Promise<ExtractedGraph> {
    const response = await this.anthropic.beta.messages.parse({
      model: graphModel,
      max_tokens: 16000,
      // Re-run on a fallback model if a safety classifier declines.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system: systemPrompt,
      output_config: {
        effort: 'medium',
        format: betaZodOutputFormat(graphSchema),
      },
      messages: [
        {
          role: 'user',
          content: `<document>\n${document}\n</document>\n\nExtract the knowledge graph for this document.`,
        },
      ],
    });

    if (response.stop_reason === 'refusal') {
      throw new Error('Graph extraction was declined by the model.');
    }

    if (response.stop_reason === 'max_tokens') {
      throw new Error('Graph extraction output was cut off (max_tokens).');
    }

    if (!response.parsed_output) {
      throw new Error('Graph extraction returned no parseable output.');
    }

    return response.parsed_output;
  }
}

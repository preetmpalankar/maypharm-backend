import { Injectable } from '@nestjs/common';
import OpenAI from 'openai';
import { loadConfig } from '../config';

export const embeddingModel = 'text-embedding-3-small';
export const embeddingDimensions = 1536;

/** Inputs per request; well under the API's limits for ~400-token chunks. */
const batchSize = 64;

/** Turns text chunks into vectors with OpenAI embeddings. */
@Injectable()
export class EmbeddingsService {
  private client?: OpenAI;

  get configured() {
    return Boolean(loadConfig().OPENAI_API_KEY);
  }

  private get openai() {
    this.client ??= new OpenAI({
      apiKey: loadConfig().OPENAI_API_KEY,
      maxRetries: 3,
      timeout: 60_000,
    });
    return this.client;
  }

  async embed(inputs: string[]): Promise<number[][]> {
    const vectors: number[][] = [];

    for (let start = 0; start < inputs.length; start += batchSize) {
      const batch = inputs.slice(start, start + batchSize);
      const response = await this.openai.embeddings.create({
        model: embeddingModel,
        input: batch,
        dimensions: embeddingDimensions,
      });

      // Results carry their input index; never rely on response order.
      const ordered = [...response.data].sort((a, b) => a.index - b.index);
      vectors.push(...ordered.map((entry) => entry.embedding));
    }

    return vectors;
  }
}

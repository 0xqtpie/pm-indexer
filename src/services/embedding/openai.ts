import OpenAI from "openai";
import { config } from "../../config.ts";
import type { NormalizedMarket } from "../../types/market.ts";

const openai = new OpenAI({
  apiKey: config.OPENAI_API_KEY,
});

const EMBEDDING_MODEL = "text-embedding-3-small";
const EMBEDDING_DIMENSIONS = 1536;
const BATCH_SIZE = 100;

export function buildEmbeddingText(market: NormalizedMarket): string {
  const parts = [
    market.title,
    market.description,
    market.rules,
    market.tags.join(", "),
    market.category,
  ].filter(Boolean);

  return parts.join("\n\n");
}

export async function generateEmbedding(text: string): Promise<number[]> {
  const response = await openai.embeddings.create({
    model: EMBEDDING_MODEL,
    input: text,
    dimensions: EMBEDDING_DIMENSIONS,
  });

  return response.data[0]?.embedding ?? [];
}

export async function generateEmbeddings(
  texts: string[]
): Promise<number[][]> {
  const embeddings: number[][] = [];

  // Process in batches
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);

    const response = await openai.embeddings.create({
      model: EMBEDDING_MODEL,
      input: batch,
      dimensions: EMBEDDING_DIMENSIONS,
    });

    for (const item of response.data) {
      embeddings.push(item.embedding);
    }

    // Small delay between batches to respect rate limits
    if (i + BATCH_SIZE < texts.length) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  return embeddings;
}

export async function generateMarketEmbeddings(
  markets: NormalizedMarket[]
): Promise<Map<string, number[]>> {
  const texts = markets.map(buildEmbeddingText);
  const embeddings = await generateEmbeddings(texts);

  const result = new Map<string, number[]>();
  for (let i = 0; i < markets.length; i++) {
    const market = markets[i];
    const embedding = embeddings[i];
    if (market && embedding) {
      result.set(market.id, embedding);
    }
  }

  return result;
}

export { EMBEDDING_MODEL, EMBEDDING_DIMENSIONS };

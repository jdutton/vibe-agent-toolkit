/**
 * Shared test helpers for embedding provider integration tests.
 *
 * Reduces duplication across provider-specific integration test files.
 */

import { expect } from 'vitest';

import type { EmbeddingProvider } from '../../src/interfaces/embedding.js';

/**
 * Assert that embedBatch returns correct structure for a batch of 3 texts.
 *
 * Checks that the result has 3 embeddings, each with the expected number of dimensions.
 */
export async function assertBatchEmbedding(
  provider: EmbeddingProvider,
  expectedDimensions: number,
): Promise<void> {
  const texts = ['Hello', 'world', 'test'];
  const embeddings = await provider.embedBatch(texts);

  expect(embeddings).toHaveLength(3);
  for (const embedding of embeddings) {
    expect(embedding).toHaveLength(expectedDimensions);
  }
}

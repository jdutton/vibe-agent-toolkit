/**
 * A chunk budget the provider had to clamp is reported in the batch result —
 * `IndexResult.warnings` — and the library itself writes nothing to the
 * console: the caller (`vat rag index`) reports it through its own channel.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LanceDBRAGProvider } from '../../src/lancedb-rag-provider.js';
import {
  createStubEmbeddingProvider,
  createTestMarkdownFile,
  createTestResource,
  setupLanceDBTestSuite,
} from '../test-helpers.js';

const suite = setupLanceDBTestSuite();
beforeEach(suite.beforeEach);
afterEach(() => {
  vi.restoreAllMocks();
  return suite.afterEach();
});

describe('chunking-config warnings', () => {
  it('come back in the result, and nothing reaches the console', async () => {
    const consoleCalls = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) => vi.spyOn(console, method));
    const embedder = createStubEmbeddingProvider();
    const provider = await LanceDBRAGProvider.create({
      dbPath: suite.dbPath,
      embeddingProvider: embedder,
      // Over the stub's 256-token limit: clamped, with a warning.
      targetChunkSize: embedder.maxInputTokens * 4,
    });
    const filePath = await createTestMarkdownFile(suite.tempDir, 'a.md', '# A\n\nSome prose.\n');

    const result = await provider.indexResources([await createTestResource(filePath, 'a')]);
    await provider.close();

    expect(result.warnings).toEqual([expect.stringMatching(/targetChunkSize 1024 exceeds the 256-token limit/)]);
    expect(consoleCalls.flatMap((spy) => spy.mock.calls)).toEqual([]);
  });
});

/**
 * `vat rag index` prints a document the PROVIDER failed to index through the
 * shared finding reporter, the same line its unreadable documents get.
 */

import { writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';

import type { ResourceMetadata } from '@vibe-agent-toolkit/resources';
import { normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { mkdirSyncReal } from '@vibe-agent-toolkit/utils/fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { indexCommand } from '../../src/commands/rag/index-command.js';
import { captureCommand } from '../helpers/stdout-capture.js';

vi.mock('@vibe-agent-toolkit/rag-lancedb', () => ({
  LanceDBRAGProvider: {
    create: async () => ({
      indexResources: async (resources: ResourceMetadata[]) => ({
        resourcesIndexed: 0, resourcesSkipped: 0, resourcesUpdated: 0, resourcesEmpty: 0,
        chunksCreated: 0, chunksDeleted: 0, durationMs: 0,
        errors: resources.map((resource) => ({ resourceId: resource.id, error: 'embedder refused' })),
      }),
      close: async () => undefined,
    }),
  },
}));

describe('vat rag index — a provider failure on stderr', () => {
  let tempDir = '';
  beforeEach(async () => {
    tempDir = await mkdtemp(safePath.join(normalizedTmpdir(), 'vat-rag-provider-findings-'));
    mkdirSyncReal(safePath.join(tempDir, 'docs'));
    writeFileSync(safePath.join(tempDir, 'docs', 'a.md'), '# A\n\nSome prose.\n');
    vi.spyOn(process, 'cwd').mockReturnValue(tempDir);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tempDir, { recursive: true, force: true });
  });

  it('prints the provider failure as its compiler-style finding line, exit 1', async () => {
    const { stderr, exited } = await captureCommand(() => indexCommand(tempDir, { db: safePath.join(tempDir, 'db') }));

    expect(exited, stderr).toBe(1);
    expect(stderr).toMatch(/^ {2}docs\/a\.md: error: docs\/a\.md is not in the index, so its content is not searchable: embedder refused \[RAG_DOCUMENT_INDEX_FAILED\]$/m);
  });
});

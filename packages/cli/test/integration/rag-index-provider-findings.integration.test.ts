/**
 * `vat rag index` prints a document the PROVIDER failed to index through the
 * shared finding reporter, the same line its unreadable documents get — and
 * the unreadable ones on a run the database then refuses, and the writer's
 * zero-examined refusal on a run that found nothing.
 */

import { writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';

import type { ResourceMetadata, UnreadableResource } from '@vibe-agent-toolkit/resources';
import type { Report } from '@vibe-agent-toolkit/schema';
import { normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { mkdirSyncReal } from '@vibe-agent-toolkit/utils/fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as YAML from 'yaml';

import { indexCommand } from '../../src/commands/rag/index-command.js';
import type * as ResourceLoader from '../../src/utils/resource-loader.js';
import { captureCommand } from '../helpers/stdout-capture.js';

/** What the crawl reports it could not read, per test; the real crawl otherwise. */
const crawl = vi.hoisted(() => ({ unreadable: [] as UnreadableResource[] }));

vi.mock('../../src/utils/resource-loader.js', async (importOriginal) => {
  const original = await importOriginal<typeof ResourceLoader>();
  return {
    ...original,
    loadResourcesWithConfig: async (...args: Parameters<typeof original.loadResourcesWithConfig>) => {
      const loaded = await original.loadResourcesWithConfig(...args);
      const real = loaded.registry.getUnreadableResources.bind(loaded.registry);
      loaded.registry.getUnreadableResources = () => [...real(), ...crawl.unreadable];
      return loaded;
    },
  };
});

vi.mock('@vibe-agent-toolkit/rag-lancedb', () => ({
  LanceDBRAGProvider: {
    create: async () => ({
      indexResources: async (resources: ResourceMetadata[]) => ({
        resourcesIndexed: 0, resourcesSkipped: 0, resourcesUpdated: 0, resourcesEmpty: 0,
        chunksCreated: 0, chunksDeleted: 0, durationMs: 0,
        errors: resources.map((resource) => ({ resourceId: resource.id, error: 'embedder refused' })),
        warnings: ['targetChunkSize 1024 exceeds the 256-token limit of \'stub\' and has been clamped to 256.'],
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
    crawl.unreadable = [];
    vi.restoreAllMocks();
    await rm(tempDir, { recursive: true, force: true });
  });

  it('prints the provider failure as its compiler-style finding line, exit 1', async () => {
    const { stderr, exited } = await captureCommand(() => indexCommand(tempDir, { db: safePath.join(tempDir, 'db') }));

    expect(exited, stderr).toBe(1);
    expect(stderr).toMatch(/^ {2}docs\/a\.md: error: docs\/a\.md is not in the index, so its content is not searchable: embedder refused \[RAG_DOCUMENT_INDEX_FAILED\]$/m);
  });

  it('reports the provider\'s chunking warning as a finding, in the document and through the shared reporter', async () => {
    const { stdout, stderr } = await captureCommand(() => indexCommand(tempDir, { db: safePath.join(tempDir, 'db') }));
    const document = YAML.parse(stdout) as Report<unknown>;

    expect(document.findings.filter((finding) => finding.code === 'RAG_CHUNKING_CONFIG_ADJUSTED')).toEqual([
      expect.objectContaining({ severity: 'warning', message: expect.stringContaining('clamped to 256') as unknown }),
    ]);
    expect(stderr).toMatch(/^ {2}warning: targetChunkSize 1024 .* \[RAG_CHUNKING_CONFIG_ADJUSTED\]$/m);
  });

  it('names an unreadable document on a run the database then refuses, in the document and on stderr', async () => {
    crawl.unreadable = [{ filePath: safePath.join(tempDir, 'docs', 'locked.md'), reason: 'EACCES' }];
    const notADirectory = safePath.join(tempDir, 'db-file');
    writeFileSync(notADirectory, 'x');

    const { stdout, stderr, exited } = await captureCommand(() => indexCommand(tempDir, { db: notADirectory }));
    const document = YAML.parse(stdout) as Report<unknown>;

    expect(exited, stderr).toBe(2);
    expect(document.status).toBe('error');
    expect(document.findings.map((finding) => finding.location)).toEqual(['docs/locked.md']);
    expect(stderr).toMatch(/^ {2}docs\/locked\.md: error: .*EACCES \[RAG_DOCUMENT_INDEX_FAILED\]$/m);
  });

  it('says the writer\'s zero-examined refusal on stderr, exactly once', async () => {
    const empty = safePath.join(tempDir, 'empty');
    mkdirSyncReal(empty);

    const { stderr, exited } = await captureCommand(() => indexCommand(empty, { db: safePath.join(tempDir, 'db') }));

    expect(exited, stderr).toBe(1);
    expect(stderr.match(/error: Nothing was examined: .*\[RESOURCE_CHECK_BROKEN\]/g)).toHaveLength(1);
  });
});

/**
 * `vat rag index` indexes the working tree's bytes, never git's, even with the store on and warm.
 *
 * It is a disk lane (`RUN_MEMBER_BYTES['rag index']` is `'disk'`): every file is read from the
 * checkout and keyed by its checksum. Under `core.autocrlf=true` the checkout holds CRLF while git
 * holds LF, so the text the index embeds says which one the run read. A warm run (served the
 * stored extent the first run wrote) must read the same disk bytes, and refuse nothing: an extent
 * keyed by git object IDs would contradict the disk read and refuse every file as changed since it
 * was crawled.
 */

import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';

import type { EmbeddingProvider } from '@vibe-agent-toolkit/rag';
import type * as RagLancedb from '@vibe-agent-toolkit/rag-lancedb';
import { mkdirSyncReal, normalizedTmpdir, readWorkCounters, safePath, VAT_CACHE_DIR_ENV, type WorkCounter } from '@vibe-agent-toolkit/utils';
import { runGitOrThrow } from '@vibe-agent-toolkit/utils/git';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as YAML from 'yaml';

import { indexCommand } from '../../src/commands/rag/index-command.js';
import { PROJECTION_STORE_ENV, PROJECTION_STORE_SQLITE } from '../../src/utils/projection-store.js';
import { captureCommand } from '../helpers/stdout-capture.js';
import { commitTestFixture } from '../test-helpers.js';

/** Every text the index handed its embedder, in order. */
const embedded = vi.hoisted(() => ({ texts: [] as string[] }));

// The real provider and database; only the model is a stub, so nothing is downloaded and the
// embedder sees exactly the text the index chunked.
vi.mock('@vibe-agent-toolkit/rag-lancedb', async (importOriginal) => {
  const original = await importOriginal<typeof RagLancedb>();
  const stub: EmbeddingProvider = {
    name: 'stub',
    model: 'stub-model-4',
    dimensions: 4,
    maxInputTokens: 256,
    embed: () => Promise.resolve([0, 0, 0, 1]),
    embedBatch: (texts: string[]) => {
      embedded.texts.push(...texts);
      return Promise.resolve(texts.map(() => [0, 0, 0, 1]));
    },
  };
  const create: typeof original.LanceDBRAGProvider.create = (config) => original.LanceDBRAGProvider.create({ ...config, embeddingProvider: stub });
  return { ...original, LanceDBRAGProvider: { ...original.LanceDBRAGProvider, create } };
});

const DOC = 'docs/doc.md';
const DOC_BODY = '# Keyed from disk\n\nProse the checkout writes with CRLF line ends.\n';

/** The counters a run moved, as `after - before`. */
function moved(before: Readonly<Record<WorkCounter, number>>, names: readonly WorkCounter[]): Record<string, number> {
  const after = readWorkCounters();
  return Object.fromEntries(names.map((name) => [name, after[name] - before[name]]));
}

/** Index `repo` into a fresh database `db` under it, expecting a clean run, and return what it embedded. */
async function cleanIndex(repo: string, db: string): Promise<readonly string[]> {
  embedded.texts = [];
  const { stdout, stderr, exited } = await captureCommand(() => indexCommand(repo, { db: safePath.join(repo, db) }));
  const document = YAML.parse(stdout) as { data: { resourcesIndexed: number } };
  expect(exited, `${stdout}\n${stderr}`).toBe(0);
  expect(document.data.resourcesIndexed, 'the one document is indexed').toBe(1);
  return [...embedded.texts];
}

describe('vat rag index over a CRLF checkout of LF objects, store on', () => {
  let tempDir = '';
  let repo = '';
  const saved = { store: process.env[PROJECTION_STORE_ENV], cacheDir: process.env[VAT_CACHE_DIR_ENV] };

  beforeEach(async () => {
    tempDir = await mkdtemp(safePath.join(normalizedTmpdir(), 'vat-rag-disk-lane-'));
    repo = safePath.join(tempDir, 'corpus');
    mkdirSyncReal(safePath.join(repo, 'docs'), { recursive: true });
    const doc = safePath.join(repo, DOC);
    writeFileSync(safePath.join(repo, '.gitignore'), 'db*/\n');
    writeFileSync(doc, DOC_BODY);
    commitTestFixture(repo);
    runGitOrThrow(['config', 'core.autocrlf', 'true'], { cwd: repo });
    rmSync(doc);
    runGitOrThrow(['checkout', '--', DOC], { cwd: repo });
    process.env[PROJECTION_STORE_ENV] = PROJECTION_STORE_SQLITE;
    process.env[VAT_CACHE_DIR_ENV] = safePath.join(tempDir, 'cache');
    vi.spyOn(process, 'cwd').mockReturnValue(repo);
    embedded.texts = [];
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const [name, value] of [[PROJECTION_STORE_ENV, saved.store], [VAT_CACHE_DIR_ENV, saved.cacheDir]] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(tempDir, { recursive: true, force: true });
  });

  it('embeds the checkout\'s CRLF text cold and warm, reading it from disk and never from git', async () => {
    expect(readFileSync(safePath.join(repo, DOC), 'utf-8'), 'the checkout holds CRLF').toContain('\r\n');

    const cold = await cleanIndex(repo, 'db-cold');
    expect(cold.join('\n'), 'the cold run indexes the disk bytes').toContain('# Keyed from disk\r\n\r\nProse the checkout');

    const before = readWorkCounters();
    const warm = await cleanIndex(repo, 'db-warm');
    expect(moved(before, ['extent.served', 'content.gitRead']), 'the warm run is served the stored extent and reads nothing from git').toEqual({
      'extent.served': 1,
      'content.gitRead': 0,
    });
    expect(warm, 'the warm run indexes the same disk bytes').toEqual(cold);
  });
});

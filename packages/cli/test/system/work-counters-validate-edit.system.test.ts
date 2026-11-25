/**
 * `vat validate` after an edit pays for the edited files only: counted, not timed, from the
 * `vat validate` process's own `resources` phase.
 *
 * Each arm primes a store over a committed corpus, first asserts the primed store holds every
 * key covered and every reached harness pair settled (so whatever the miss extracts, the edit
 * caused), then edits files without committing and runs `vat validate` again: a miss, since the
 * tree moved.
 *
 * - 1-file arm, exact: one parse lookup, every other distinct key served from the stored blob
 *   tier (`blob.storeServed`), and the edited blob's one harness pair derived (it is reached
 *   through an `@`-import). The run reads each member at most once and nothing else (purity).
 * - N-file arm, bounds: at most N lookups, at least `distinct keys - N` served, at most N pairs.
 */

import { appendFileSync } from 'node:fs';

import { openSqliteFactStore } from '@vibe-agent-toolkit/projection-sqlite';
import { ALL_BLOB_REQUEST, computeContentKey, parserKindForPath, uncoveredContentKeys } from '@vibe-agent-toolkit/resources';
import { safePath, type WorkCounter } from '@vibe-agent-toolkit/utils';
import { parseLookupsIn } from '@vibe-agent-toolkit/utils/testing';
import { describe, expect, it } from 'vitest';

import { storedContentKeys } from '../helpers/cache-differential.js';
import { expectPureMiss } from '../helpers/fs-purity.js';
import { storeFilesUnder } from '../helpers/projection-store-probe.js';
import {
  freshValidateArm,
  isConfig,
  validateCounts,
  validateCountsSuite,
  type ValidateArm,
} from '../helpers/work-counters-validate.js';
import { commitTestFixture } from '../test-helpers.js';

import { writeFileTree } from './test-common.js';

const context = validateCountsSuite('vat-work-validate-edit-', import.meta.url);

/** How many documents the corpus holds besides the memory file. */
const DOCUMENTS = 12;

function documentPath(index: number): string {
  return `docs/a${String(index).padStart(2, '0')}.md`;
}

/** The documents `CLAUDE.md` imports: the harness reaches these, and the memory file. */
const IMPORTED = [documentPath(1), documentPath(2)];

/** The corpus, each file with bytes of its own. */
const CORPUS: Readonly<Record<string, string>> = {
  'vibe-agent-toolkit.config.yaml': 'resources:\n  include:\n    - "**/*.md"\n',
  '.gitignore': 'ignored/\n',
  'CLAUDE.md': ['# Memory', '', ...IMPORTED.map((path) => `@${path}`), ''].join('\n'),
  ...Object.fromEntries(Array.from({ length: DOCUMENTS }, (_, index) => {
    const path = documentPath(index + 1);
    return [path, `# Document ${String(index + 1)}\n\nBody of ${path}.\n`];
  })),
};

const MEMBERS = Object.keys(CORPUS);

/** The content key a corpus file's committed bytes key to. */
function committedKey(path: string): string {
  return computeContentKey(Buffer.from(CORPUS[path] ?? ''), parserKindForPath(path));
}

/** The corpus's distinct content keys: every file has bytes of its own, so one per file. */
const DISTINCT_KEYS = new Set(MEMBERS.map((path) => committedKey(path))).size;

/** Write the corpus and commit it; returns the project root. */
function plant(): string {
  const cwd = safePath.join(context.createTempDir(), 'corpus');
  writeFileTree(cwd, CORPUS);
  commitTestFixture(cwd);
  return cwd;
}

/** Edit files without committing: `HEAD` stays, the tree moves. */
function edit(cwd: string, paths: readonly string[]): void {
  for (const path of paths) appendFileSync(safePath.join(cwd, path), `\nEdited after the prime: ${path}.\n`);
}

/**
 * The primed store answers every key and every reached pair: by the one blob-tier predicate no
 * stored key is uncovered, and the harness facts hold a row for each file the harness reaches.
 */
async function expectPrimedStoreSettled(arm: ValidateArm): Promise<void> {
  const keys = [...storedContentKeys({ store: arm.storeDir }).values()];
  expect(new Set(keys).size, 'the primed store keys every member').toBe(DISTINCT_KEYS);
  const [file] = storeFilesUnder(arm.storeDir);
  if (file === undefined) throw new Error(`no projection store under ${arm.storeDir}`);
  const store = openSqliteFactStore({ directory: safePath.join(file, '..') });
  try {
    const rows = await store.readBlobFacts(keys, ALL_BLOB_REQUEST);
    expect(uncoveredContentKeys(rows, keys), 'uncovered keys in the primed store').toEqual([]);
    const settled = new Set(rows.harnessBlobFacts.map((row) => row.blob));
    const reached = ['CLAUDE.md', ...IMPORTED].map((path) => committedKey(path));
    expect(reached.filter((key) => !settled.has(key)), 'unsettled harness pairs in the primed store').toEqual([]);
  } finally {
    await store.close();
  }
}

/** Prime a fresh store-on arm over a fresh corpus, settled; returns both. */
async function primed(): Promise<{ cwd: string; arm: ValidateArm }> {
  const cwd = plant();
  const arm = freshValidateArm(context, false);
  await validateCounts(context, cwd, arm);
  await expectPrimedStoreSettled(arm);
  return { cwd, arm };
}

/** The `vat validate` process's `resources` phase counters. */
function resourcesPhase(phases: Readonly<Record<string, Readonly<Record<WorkCounter, number>>>>): Readonly<Record<WorkCounter, number>> {
  const phase = phases['resources'];
  if (phase === undefined) throw new Error('the vat validate dump carries no resources phase');
  return phase;
}

describe('vat validate after an edit pays for the edited files only', () => {
  it('1-file arm: one lookup, every other key served, the edited blob\'s one pair derived; each member read at most once', async () => {
    const { cwd, arm } = await primed();
    const edited = [documentPath(1)];
    edit(cwd, edited);
    const miss = await validateCounts(context, cwd, arm);
    // The config is a member too, but every process's config loader reads it, so purity allows it on its own terms.
    expectPureMiss(miss.parentReads, cwd, { members: MEMBERS.filter((path) => !isConfig(path)), schemas: [] });
    const resources = resourcesPhase(miss.phases);
    expect(resources['blob.storeServed'], 'blob.storeServed: every distinct key but the edited one').toBe(DISTINCT_KEYS - 1);
    expect(parseLookupsIn(resources), 'parse lookups: the edited file only').toBe(1);
    expect(resources['harness.pairsDerived'], 'harness pairs derived: the edited, reached blob\'s').toBe(1);
  });

  it('N-file arm: at most N lookups, at least distinct keys minus N served, at most N pairs', async () => {
    const { cwd, arm } = await primed();
    const edited = [documentPath(1), documentPath(2), documentPath(5), documentPath(6)];
    edit(cwd, edited);
    const resources = resourcesPhase((await validateCounts(context, cwd, arm)).phases);
    expect(resources['blob.storeServed'], 'blob.storeServed: at least distinct keys minus N').toBeGreaterThanOrEqual(DISTINCT_KEYS - edited.length);
    expect(parseLookupsIn(resources), 'parse lookups: at most N').toBeLessThanOrEqual(edited.length);
    expect(resources['harness.pairsDerived'], 'harness pairs derived: at most N files\'').toBeLessThanOrEqual(edited.length);
  });
});

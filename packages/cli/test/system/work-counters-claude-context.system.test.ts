/**
 * The claude-context lane decodes no stored row twice in a process: its import roots and its
 * population read one tree's extent through the run's one stored reader, and so does a
 * `vat resources query` whose statement runs the claude-context lens beside the resources
 * population. Warm (a second run over the same store), each run is served from the store and
 * counts `store.rows.decoded.repeated` zero.
 *
 * Positive controls: each warm run reads the store (`store.reads.extent`) and decodes rows from it
 * (`store.rows.decoded.persistent`), so a run that read nothing cannot pass for one that read once.
 */

import type { WorkCounter } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runWithWorkCounters, soleProcessCounters } from '../helpers/work-counter-run.js';
import { writeCommittedCorpus } from '../test-helpers.js';

import { createSuiteContext } from './test-common.js';

const context = createSuiteContext('vat-work-claude-context-', import.meta.url);

/** A CLAUDE.md that imports a document, a rule, and a linked document. */
const FILES: Readonly<Record<string, string>> = {
  'vibe-agent-toolkit.config.yaml': 'resources:\n  include:\n    - "**/*.md"\n',
  'CLAUDE.md': '# Project\n\n@docs/guide.md\n\nSee [the notes](./docs/notes.md).\n',
  'docs/guide.md': '# Guide\n\nSee [the notes](./notes.md) and @notes.md.\n',
  'docs/notes.md': '# Notes\n',
  '.claude/rules/style.md': '---\npaths: ["docs/**"]\n---\n# Style\n',
};

/** The counters this suite holds. */
const HELD = ['store.rows.decoded.repeated', 'store.rows.decoded.persistent', 'store.reads.extent'] as const satisfies readonly WorkCounter[];

/**
 * Run `vat <args>` twice in one committed copy of the fixture over one store, and read back the
 * held counters of the second (warm) run's one CLI process.
 *
 * @param args - The verb and its arguments
 * @returns The warm run's held counters
 */
async function warmCounters(args: readonly string[]): Promise<Record<(typeof HELD)[number], number>> {
  const root = writeCommittedCorpus(context.createTempDir(), FILES);
  const cacheDir = context.createTempDir();
  const options = { cacheDir, tmpDir: null, storeOff: false, probeRoot: null, cores: null } as const;
  const cold = await runWithWorkCounters(context, root, args, options);
  expect(cold.result.status, `${cold.result.stdout}\n${cold.result.stderr}`).toBe(0);
  return soleProcessCounters(await runWithWorkCounters(context, root, args, options), HELD);
}

beforeAll(() => {
  context.setup();
});

afterAll(() => {
  context.cleanup();
});

describe('a warm claude-context lane decodes each stored row once', () => {
  it('vat claude context', async () => {
    const counts = await warmCounters(['claude', 'context', '--all']);

    expect(counts['store.reads.extent'], 'the warm run reads the store').toBeGreaterThan(0);
    expect(counts['store.rows.decoded.persistent'], 'and decodes rows from it').toBeGreaterThan(0);
    expect(counts['store.rows.decoded.repeated']).toBe(0);
  });

  it('vat resources query naming a claude-context relation, beside the resources population', async () => {
    const counts = await warmCounters(['resources', 'query', 'SELECT COUNT(*) AS n FROM claude_context_loads JOIN blob_references ON 1 = 0']);

    expect(counts['store.reads.extent'], 'the warm run reads the store').toBeGreaterThan(0);
    expect(counts['store.rows.decoded.persistent'], 'and decodes rows from it').toBeGreaterThan(0);
    expect(counts['store.rows.decoded.repeated']).toBe(0);
  });
});

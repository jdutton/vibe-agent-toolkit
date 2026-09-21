/**
 * `vat validate` derives ONCE across every surface it runs, through the default store.
 *
 * Two things landed together, and only the first is what this file can see:
 *
 * - **The store is the default.** No selector is set below — deliberately. An
 *   arm that named `VAT_PROJECTION_STORE=sqlite` would pass identically against
 *   a build where the default was still off, and the flip is precisely what this
 *   run is supposed to be exercising. Only `VAT_PROJECTION_STORE_DIR` is set,
 *   which says WHERE and never WHETHER.
 * - **The population scope is hoisted.** `vat validate`'s orchestrator holds one
 *   `withPopulationCache` bracket around every phase, and each lane's own
 *   bracket joins it instead of opening a second database and taking a second
 *   `git write-tree` (`packages/cli/src/commands/validate.ts ›
 *   runPhasesUnderOnePopulation()`).
 *
 * ## 🪤 What this file can and cannot discriminate
 *
 * The **join** itself — same cache by identity, one backend open, the inner
 * scope not closing what it did not own — is pinned in
 * `test/utils/projection-store.test.ts`, against a mocked backend that can count
 * opens. Nothing observable from out here counts store opens: two connections to
 * one WAL database leave the same file, the same rows and the same timing rows
 * as one.
 *
 * ⚠️ So this file does NOT pin the hoist: remove it and the counts below are
 * unchanged, because the second lane's own bracket still hits the extent the
 * first one wrote. What it pins is the DEFAULT-ON store doing that sharing: a
 * two-surface run **derives the filesystem extent once** and **writes the store
 * once**, while consulting it twice. Every part is a count rather than a
 * presence — `calls`, not "was this contributor charged", because a contributor
 * invoked once and invoked five times file the same single row.
 *
 * ## The positive controls
 *
 * Both surfaces must actually run, and the store must actually be written.
 * Without those two assertions, "one derivation" is satisfied by a run that did
 * one surface, or by one that reached no store at all — the two most likely ways
 * for this test to go green while proving nothing.
 */

import { mkdirSyncReal } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PROJECTION_STORE_DIR_ENV } from '../../src/utils/projection-store.js';
import { chargedCalls, storeFilesUnder } from '../helpers/projection-store-probe.js';
import {
  createSkillMarkdown,
  createSuiteContext,
  executeCli,
  join,
  writeTestFile,
} from '../system/test-common.js';
import { commitTestFixture } from '../test-helpers.js';

const context = createSuiteContext('vat-validate-one-population-', import.meta.url);

/** The contributor that DERIVES the base extent — charged once per population that missed. */
const FILESYSTEM_EXTENT = 'builtin:filesystem';

/** Charged by a population that derived and recorded an extent. */
const STORE_WRITE = 'projection-store:write';

/** Charged by a population that consulted the store, hit or miss. */
const STORE_READ = 'projection-store:read';

/** Both surfaces, so the run has more than one lane in it to share a population. */
const BOTH_SURFACES_CONFIG = `version: 1
resources:
  exclude:
    - "node_modules/**"
skills:
  include:
    - "resources/skills/**/SKILL.md"
`;

let corpus: string;

beforeAll(() => {
  context.setup();
  corpus = join(context.createTempDir(), 'corpus');
  mkdirSyncReal(join(corpus, 'resources', 'skills'), { recursive: true });
  writeTestFile(join(corpus, 'vibe-agent-toolkit.config.yaml'), BOTH_SURFACES_CONFIG);
  writeTestFile(join(corpus, 'README.md'), '# Corpus\n\nSee [the skill](./resources/skills/SKILL.md).\n');
  writeTestFile(join(corpus, 'resources', 'skills', 'SKILL.md'), createSkillMarkdown('one-population'));
  // Committed, because the store's key is `git write-tree` against a throwaway
  // index: a corpus outside a readable repository cannot be keyed, every lane
  // would run uncached, and every count below would be describing a run with no
  // store in it at all.
  commitTestFixture(corpus);
});

afterAll(context.cleanup);

describe('vat validate and the population its surfaces share', () => {
  it('derives the extent once and writes the store once, across two surfaces', async () => {
    const storeDir = context.createTempDir();
    const timing = context.createTempDir();

    const result = await executeCli(context.binPath, ['validate'], {
      cwd: corpus,
      // No `VAT_PROJECTION_STORE`: the default is what is under test. Only the
      // location is named, and it is named so this run cannot read or write the
      // developer's shared cache — `defaultStoreDirectory()` is one database per
      // VAT release for every root on the machine.
      env: { VAT_CRAWL_TIMING: timing, [PROJECTION_STORE_DIR_ENV]: storeDir },
    });

    expect(result.status, result.stderr).toBe(0);
    // Positive control #1: two surfaces really ran. "One derivation" is trivially
    // true of a run that did one.
    expect(result.stdout).toContain('name: resources');
    expect(result.stdout).toContain('name: skills');

    const calls = chargedCalls(timing);
    // Positive control #2: a store was really opened and written, at the DEFAULT
    // setting. Without this, every count below is satisfied by a run that never
    // reached a store — which is exactly what this run would have been before
    // the default moved.
    expect(storeFilesUnder(storeDir)).toHaveLength(1);
    expect(calls[STORE_WRITE]).toBe(1);

    // The claim itself. Two lanes consulted the store; only one of them had to
    // derive anything, and the extent the first wrote answered the second.
    expect(calls[STORE_READ]).toBe(2);
    expect(calls[FILESYSTEM_EXTENT]).toBe(1);
  });
});

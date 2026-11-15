/**
 * `vat resources validate`, run twice against one pinned projection store,
 * gives the same answer both times — and the second run SAYS the store served
 * it.
 *
 * `data.population` is derived from `populate()`'s own outcome, never from a
 * side tell, so the only way the warm run can report `'store'` is that every
 * root's population was a hit. Each fixture shape is one most likely to make a
 * stored extent differ from a derived one, and each case first asserts its shape
 * DID produce its finding — an equality between two runs that never saw the
 * shape proves nothing about it:
 *
 * - two broken links in two files (every host) — findings from more than one
 *   file, so their order is observable;
 * - two declined symlinks (hosts that can create one) — two conditions of one
 *   code, the shape whose order a stored extent once reversed;
 * - a gitignored directory the OS will not list (hosts that can deny reads) — a
 *   condition row, not a refusal: the resources verbs refuse only a NON-ignored
 *   one;
 * - that directory AND a declined symlink together (hosts that can do both) —
 *   two condition CODES. This is the case that went red when the population was
 *   unsorted: a derived run emits the unlistable directory before the link, the
 *   store hands them back in its own order, and the warm findings came out
 *   reversed. Two links of one code did not reproduce it.
 *
 * No case plants a `REALIZATION_PATH_COLLISION`, because this verb cannot emit
 * one: the filesystem extent is the only contributor in its lane that writes
 * realizations, and it mints each row's identity from the very path the row
 * names (`idFor(absolutePath)` beside `relativize(absolutePath)`), so one path
 * always carries one identity. A collision needs two identities flattened onto
 * one path — a packaged tree, which this verb never builds.
 *
 * A findings-only run writes nothing to stderr, so stderr is compared whole
 * rather than as one line.
 *
 * Isolation: `HOME`, `USERPROFILE`, `CLAUDE_CONFIG_DIR` and the temp directory (`TMPDIR`,
 * `TEMP`, `TMP`) all point into scratch, and the store directory is pinned through the
 * variable the module under test owns.
 */

import { chmodSync, rmSync, writeFileSync } from 'node:fs';

import { createSymlink, mkdirSyncReal, safePath, symlinkCapability } from '@vibe-agent-toolkit/utils';
import { CANNOT_DENY_READS } from '@vibe-agent-toolkit/utils/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PROJECTION_STORE_DIR_ENV } from '../../src/utils/projection-store.js';
import { commitTestFixture } from '../test-helpers.js';

import { createIsolatedScratch, executeCli, getBinPath, isolatedScratchEnv } from './test-common.js';

const binPath = getBinPath(import.meta.url);

/** The directory the OS refuses to list. Gitignored, so the run is not refused. */
const LOCKED_DIR = 'locked';

/** Null on a host that cannot create symlinks; the symlink case is skipped there. */
const SYMLINKS = symlinkCapability();

/** The two files whose links are broken, in every fixture. */
const BROKEN_ONE = 'docs/one.md';
const BROKEN_TWO = 'docs/three.md';

/** The two declined links of the symlink fixture. */
const LINK_Z = 'docs/linked-z.md';
const LINK_Y = 'docs/linked-y.md';

/** A link to nothing: its path sorts before {@link LINK_Z}, its code after. */
const LINK_DANGLING = 'docs/a-dangling.md';

let scratch: string;

interface Finding {
  readonly code: string;
  readonly location: string;
}

interface Run {
  readonly status: number | null;
  readonly document: { readonly findings: Finding[]; readonly summary: unknown; readonly data: Record<string, unknown> };
  readonly stderr: string;
}

/**
 * A committed corpus holding the two broken links, plus whatever `plant` adds.
 *
 * @param name - The corpus directory's name under scratch
 * @param plant - Adds this case's shape; runs before the commit
 * @returns The corpus root
 */
function corpusWith(name: string, plant: (corpus: string) => void): string {
  const corpus = safePath.join(scratch, name);
  mkdirSyncReal(safePath.join(corpus, 'docs'), { recursive: true });
  writeFileSync(safePath.join(corpus, BROKEN_ONE), '# One\n\nSee [missing](./missing.md).\n', 'utf-8');
  writeFileSync(safePath.join(corpus, 'docs', 'two.md'), '# Two\n', 'utf-8');
  writeFileSync(safePath.join(corpus, BROKEN_TWO), '# Three\n\nSee [gone](./gone.md).\n', 'utf-8');
  plant(corpus);
  commitTestFixture(corpus);
  return corpus;
}

/** The start of the line naming what a population declined to derive. */
const REFUSAL_LINE = 'blob derivation declined';

/** PNG signature bytes: a NUL inside the sniff window, so the blob stage declines them as not text. */
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);

/**
 * A committed corpus with the two broken links and two tracked binaries the
 * blob stage declines as not text: an image, which is the ordinary shape of a
 * repository and is NOT reported, and the same bytes at a path typed as JSON,
 * which is. So `1 not text` pins the line both ways — a report of every
 * declined blob says 2, and a report of none says nothing.
 *
 * @param name - The corpus directory's name under scratch
 * @param config - A `vibe-agent-toolkit.config.yaml` to commit with it, if any
 * @returns The corpus root
 */
function binaryCorpus(name: string, config?: string): string {
  return corpusWith(name, (root) => {
    writeFileSync(safePath.join(root, 'docs', 'logo.png'), PNG_BYTES);
    writeFileSync(safePath.join(root, 'docs', 'settings.json'), Buffer.concat([PNG_BYTES, Buffer.from('{}')]));
    if (config !== undefined) writeFileSync(safePath.join(root, 'vibe-agent-toolkit.config.yaml'), config, 'utf-8');
  });
}

/**
 * The isolated environment every run in this file gets, against one pinned store.
 *
 * @param storeDir - The store directory
 * @param lane - Which lane `VAT_RESOURCES_CRAWL` selects
 * @returns The environment
 */
function storeEnv(storeDir: string, lane: 'projection' | 'walk' = 'projection'): Record<string, string> {
  return {
    ...isolatedScratchEnv(scratch),
    VAT_RESOURCES_CRAWL: lane,
    VAT_PROJECTION_STORE: 'sqlite',
    [PROJECTION_STORE_DIR_ENV]: storeDir,
  };
}

/**
 * Run `vat resources validate` once against a pinned store.
 *
 * @param corpus - The tree to validate
 * @param storeDir - The store directory, shared by both runs of one case
 * @param lane - Which lane `VAT_RESOURCES_CRAWL` selects
 * @param verb - The resources verb to run; `validate` unless a case crosses verbs
 * @returns The exit status, the parsed document and stderr
 */
async function validateOnce(
  corpus: string,
  storeDir: string,
  lane: 'projection' | 'walk' = 'projection',
  verb: 'validate' | 'check' = 'validate',
): Promise<Run> {
  const result = await executeCli(binPath, ['resources', verb, '--format', 'json'], {
    cwd: corpus,
    env: storeEnv(storeDir, lane),
  });
  return {
    status: result.status,
    document: JSON.parse(result.stdout) as Run['document'],
    stderr: result.stderr,
  };
}

/**
 * Validate one corpus cold then warm, and assert the two answers are one answer
 * and the warm one was served.
 *
 * @param corpus - The tree to validate
 * @returns The cold run, for the case's own shape assertions
 */
async function expectServedIdentically(corpus: string): Promise<Run> {
  // A sibling of the corpus, so the store is not part of the tree it keys.
  const storeDir = `${corpus}-store`;
  const cold = await validateOnce(corpus, storeDir);
  const warm = await validateOnce(corpus, storeDir);

  expect(cold.status).not.toBe(0);
  expect(warm.status).toBe(cold.status);
  expect(warm.document.findings).toEqual(cold.document.findings);
  expect(warm.document.summary).toEqual(cold.document.summary);
  expect(warm.stderr).toBe(cold.stderr);
  expect(cold.document.data['population']).toBe('derived');
  expect(warm.document.data['population']).toBe('store');
  return cold;
}

/**
 * The locations a run reported a code at.
 *
 * @param run - One run
 * @param code - The finding code
 * @returns Every location carrying it, in published order
 */
function locationsOf(run: Run, code: string): string[] {
  return run.document.findings.filter((finding) => finding.code === code).map((finding) => finding.location);
}

/** Every corpus that locked its directory, so each is unlocked for removal. */
const locked: string[] = [];

/**
 * A corpus with the locked, gitignored directory, plus whatever `plant` adds.
 *
 * @param name - The corpus directory's name under scratch
 * @param plant - Adds anything else this case needs
 * @returns The corpus root, its directory already unlistable
 */
function lockedCorpus(name: string, plant: (corpus: string) => void): string {
  const corpus = corpusWith(name, (root) => {
    mkdirSyncReal(safePath.join(root, LOCKED_DIR), { recursive: true });
    writeFileSync(safePath.join(root, '.gitignore'), `${LOCKED_DIR}/\n`, 'utf-8');
    writeFileSync(safePath.join(root, LOCKED_DIR, 'hidden.md'), '# Hidden\n', 'utf-8');
    plant(root);
  });
  chmodSync(safePath.join(corpus, LOCKED_DIR), 0o000);
  locked.push(corpus);
  return corpus;
}

describe('vat resources validate twice against one pinned store (system test)', () => {
  beforeAll(() => {
    scratch = createIsolatedScratch('vat-validate-population-');
  });

  afterAll(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  it('answers broken links in two files identically, the second time from the store', async () => {
    const cold = await expectServedIdentically(corpusWith('links', () => undefined));

    expect(locationsOf(cold, 'LINK_BROKEN_FILE')).toEqual([
      expect.stringContaining(BROKEN_ONE),
      expect.stringContaining(BROKEN_TWO),
    ]);
  });

  it('serves vat resources check from what validate wrote, and reports the binary validate declined', async () => {
    // One question for every resources lane: membership and the full lane share
    // a key, so the check is a store HIT, which derives nothing. A query user
    // can act on `blob_conditions`; a membership user cannot. The report is a
    // function of the stored rows, so the check must still name the binary the
    // validate that wrote the store declined.
    const corpus = binaryCorpus('binary');
    const storeDir = `${corpus}-store`;

    const validated = await validateOnce(corpus, storeDir);
    const checked = await validateOnce(corpus, storeDir, 'projection', 'check');

    expect(validated.document.data['population']).toBe('derived');
    expect(validated.stderr).not.toContain(REFUSAL_LINE);
    expect(checked.document.data['population'], checked.stderr).toBe('store');
    expect(checked.stderr).toContain(`${REFUSAL_LINE} 1 of 5 blob(s)`);
    expect(checked.stderr).toContain('(1 not text)');
  });

  it('reports a tracked binary once under vat validate, from the checks phase', async () => {
    // The resources phase is a membership lane and stays quiet; the checks child
    // is served the population that phase wrote, and reports from its rows.
    // `vat validate` runs only the phases a config declares.
    const corpus = binaryCorpus('binary-validate', 'resources: {}\n');

    const result = await executeCli(binPath, ['validate'], { cwd: corpus, env: storeEnv(`${corpus}-store`) });

    expect(result.stderr.split(REFUSAL_LINE).length - 1, result.stderr).toBe(1);
    // Printed by the checks phase: after its banner, so not by the resources
    // phase that ran first. The checks phase is the last one this config runs.
    const checksBanner = result.stderr.indexOf('▶ Surface: checks');
    expect(checksBanner, result.stderr).toBeGreaterThan(result.stderr.indexOf('▶ Surface: resources'));
    expect(result.stderr.indexOf(REFUSAL_LINE), result.stderr).toBeGreaterThan(checksBanner);
    // The run's header is a header, not a verdict: nothing has run when it prints.
    expect(result.stderr).toContain('🔍 vat validate (surfaces: resources → checks)');
    expect(result.stderr).not.toContain('✅ vat validate');
  });

  it('publishes population: null when the walk lane answered', async () => {
    const corpus = corpusWith('walked', () => undefined);

    const walked = await validateOnce(corpus, `${corpus}-store`, 'walk');

    // The run still validated: the null is about provenance, not a failed run.
    expect(locationsOf(walked, 'LINK_BROKEN_FILE')).toHaveLength(2);
    expect(walked.document.data['population']).toBeNull();
  });

  it.skipIf(SYMLINKS === null)('answers two declined symlinks of one code identically, cold and warm', async () => {
    const corpus = corpusWith('symlinks', (root) => {
      if (SYMLINKS === null) return;
      createSymlink(SYMLINKS, 'two.md', safePath.join(root, LINK_Z));
      createSymlink(SYMLINKS, 'two.md', safePath.join(root, LINK_Y));
    });
    const cold = await expectServedIdentically(corpus);

    expect(locationsOf(cold, 'EXTENT_SYMLINK_NOT_REALIZED')).toEqual([LINK_Y, LINK_Z]);
    expect(locationsOf(cold, 'LINK_BROKEN_FILE')).toHaveLength(2);
  });

  // Two condition CODES with no denied read, so the cold/warm order is pinned on
  // every host that can create a link — Windows included, where the locked
  // directory cases below cannot run. The dangling link's path sorts FIRST and
  // its code sorts SECOND, so an order by path alone, or by arrival, is caught.
  it.skipIf(SYMLINKS === null)('answers a declined link and a dangling one in code order, cold and warm', async () => {
    const corpus = corpusWith('two-codes', (root) => {
      if (SYMLINKS === null) return;
      createSymlink(SYMLINKS, 'two.md', safePath.join(root, LINK_Z));
      createSymlink(SYMLINKS, 'absent.md', safePath.join(root, LINK_DANGLING));
    });
    const cold = await expectServedIdentically(corpus);

    const codes = new Set(['EXTENT_SYMLINK_NOT_REALIZED', 'EXTENT_SYMLINK_TARGET_UNRESOLVED']);
    expect(cold.document.findings.filter((finding) => codes.has(finding.code))).toEqual([
      expect.objectContaining({ code: 'EXTENT_SYMLINK_NOT_REALIZED', location: LINK_Z }),
      expect.objectContaining({ code: 'EXTENT_SYMLINK_TARGET_UNRESOLVED', location: LINK_DANGLING }),
    ]);
  });

  describe.skipIf(CANNOT_DENY_READS)('a gitignored directory the OS will not list', () => {
    afterAll(() => {
      for (const corpus of locked) chmodSync(safePath.join(corpus, LOCKED_DIR), 0o755);
    });

    it('is reported as a condition, identically, the second time from the store', async () => {
      const cold = await expectServedIdentically(lockedCorpus('locked', () => undefined));

      expect(locationsOf(cold, 'EXTENT_DIRECTORY_UNLISTABLE')).toEqual([LOCKED_DIR]);
      expect(locationsOf(cold, 'LINK_BROKEN_FILE')).toHaveLength(2);
    });

    it.skipIf(SYMLINKS === null)('beside a declined symlink, comes out in one order cold and warm', async () => {
      const corpus = lockedCorpus('locked-and-linked', (root) => {
        if (SYMLINKS !== null) createSymlink(SYMLINKS, 'two.md', safePath.join(root, LINK_Z));
      });
      const cold = await expectServedIdentically(corpus);

      expect(locationsOf(cold, 'EXTENT_DIRECTORY_UNLISTABLE')).toEqual([LOCKED_DIR]);
      expect(locationsOf(cold, 'EXTENT_SYMLINK_NOT_REALIZED')).toEqual([LINK_Z]);
    });
  });
});

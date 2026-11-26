/**
 * The shared half of the warm-edit seed files (`cache-differential-warm-edit-*.system.test.ts`):
 * each seed edits the corpus after the warm arm's prime, without moving `HEAD`, and is judged by
 * the harness's `editServed` tell, which holds the miss to extracting exactly the keys the seed
 * names as uncovered and serving every other from the stored blob tier.
 *
 * A seed names its uncovered keys from the bytes on disk in the measured state, keyed as a
 * store-on population keys them (`storeOnKeysAt`: a git member by its OID, anything else by its
 * bytes, under `parserKindForPath`), never from the store, so the harness's own check of the list
 * against the primed store is a second opinion.
 */

import { appendFileSync } from 'node:fs';

import { parserKindForPath, type ParserKind } from '@vibe-agent-toolkit/resources';
import { safePath, symlinkCapability } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, expect } from 'vitest';

import {
  byContentKey,
  realizationsOf,
  seedSuite,
  seedTitle,
  storeOnKeysAt,
  treeSeedSuite,
  type ArmDirs,
  type FixtureTree,
  type I0Seed,
  type RecordedRuns,
} from './cache-differential.js';

/** The arms every edit seed runs: store-off, the reference, then the warm arm whose miss it judges. */
export const EDIT_ARMS = ['storeOff', 'warmSameHistory'] as const;

/** The verbs an edit seed measures: the two the `editServed` tell holds counts for. */
const EDIT_SEED_VERBS = ['query', 'vatValidate'] as const;

/**
 * The content key a store-on population files a corpus file's bytes on disk under now.
 *
 * @param corpus - The corpus
 * @param path - The root-relative path
 * @param parserKind - The parser kind it routes to, when a config overrides the built-in table
 * @returns The key
 */
export function contentKeyAt(corpus: string, path: string, parserKind: ParserKind = parserKindForPath(path)): string {
  return contentKeysAt(corpus, [path], parserKind)[0] ?? '';
}

/**
 * {@link contentKeyAt} over several files, git asked once.
 *
 * @param corpus - The corpus
 * @param paths - The root-relative paths
 * @param parserKind - The parser kind they route to, when a config overrides the built-in table
 * @returns The keys, in `paths` order
 */
export function contentKeysAt(corpus: string, paths: readonly string[], parserKind?: ParserKind): string[] {
  return storeOnKeysAt(corpus, paths.map((path) => ({ path, parserKind: parserKind ?? parserKindForPath(path) })));
}

/**
 * Edit a file in place: append a line no other file holds, so its bytes key afresh.
 *
 * @param corpus - The corpus
 * @param path - The root-relative path
 */
export function appendEdit(corpus: string, path: string): void {
  appendFileSync(safePath.join(corpus, path), `\nEdited after the prime: ${path}.\n`);
}

/** What an edit seed states; the arms, verbs and expectation are every edit seed's. */
interface EditSeedSpec {
  readonly name: string;
  readonly needs?: I0Seed['needs'];
  readonly stateA?: NonNullable<I0Seed['stateA']>;
  readonly intermediate?: NonNullable<I0Seed['intermediate']>;
  readonly toB: NonNullable<I0Seed['toB']>;
  readonly beforeRun?: NonNullable<I0Seed['beforeRun']>;
  /** The keys the primed store does not cover, read off the corpus in its measured state. */
  readonly uncovered: (dirs: ArmDirs, corpus: string) => readonly string[];
  /**
   * The uncovered keys whose parse every run refuses, so no store ever covers them. None when
   * omitted: the harness holds the list to the reference's refusal rows, so a seed that plants a
   * refusal and omits it reds.
   */
  readonly refused?: (dirs: ArmDirs, corpus: string) => readonly string[];
  /** Why store-on and store-off read other bytes after this edit, so their dumps differ (`editServed`). */
  readonly storeOffReadsOtherBytes?: string;
  readonly consumed: I0Seed['consumed'];
}

/**
 * An `editServed` seed over the two edit arms and verbs.
 *
 * @param spec - The seed's plant, its uncovered keys and its own checks
 * @returns The seed
 */
export function editSeed(spec: EditSeedSpec): I0Seed {
  const { uncovered, refused, needs, storeOffReadsOtherBytes, ...rest } = spec;
  return {
    ...rest,
    needs: needs ?? null,
    arms: EDIT_ARMS,
    verbs: EDIT_SEED_VERBS,
    expect: {
      editServed: {
        arm: 'warmSameHistory',
        uncovered,
        refused: refused ?? (() => []),
        ...(storeOffReadsOtherBytes === undefined ? {} : { storeOffReadsOtherBytes }),
      },
    },
  };
}

/** The two dumps an edit seed's own checks compare: the warm arm's prime, and store-off's measured run. */
type ComparedRun = 'warmSameHistory:prime' | 'storeOff:measured';

/**
 * The content keys a recorded dump files a path under, one per realization, by content
 * (`byContentKey`): a store-on dump's git key and store-off's key of the same bytes compare equal.
 *
 * @param runs - The consumed runs
 * @param label - Which run
 * @param path - The root-relative path
 * @returns The keys
 */
export function keysOf(runs: RecordedRuns, label: keyof RecordedRuns, path: string): unknown[] {
  const run = runs[label]?.query;
  return realizationsOf(run, path).map((row) => (run === undefined ? row['contentKey'] : byContentKey(run, row['contentKey'])));
}

/**
 * A consumed check over the warm prime and the store-off measured dump, asked by path.
 *
 * @param check - The check, given each dump's keys for a path
 * @returns The consumed runs and the check
 */
export function primeAndReference(check: (keysAt: (label: ComparedRun, path: string) => unknown[]) => void): I0Seed['consumed'] {
  return {
    runs: ['warmSameHistory:prime', 'storeOff:measured'],
    check: (runs) => check((label, path) => keysOf(runs, label, path)),
  };
}

/**
 * A consumed check: the edit is observable, each path's one key in the store-off measured dump
 * differs from the one the warm prime filed.
 *
 * @param paths - The edited paths
 * @returns The consumed runs and the check
 */
export function keysMoved(paths: readonly string[]): I0Seed['consumed'] {
  return primeAndReference((keysAt) => {
    for (const path of paths) {
      const primed = keysAt('warmSameHistory:prime', path);
      const measured = keysAt('storeOff:measured', path);
      expect([primed.length, measured.length], `${path}: one realization in each dump`).toEqual([1, 1]);
      expect(measured, `${path}: the edit moved its key`).not.toEqual(primed);
    }
  });
}

/** Whether this host can plant a seed: only a symlink seed can be unplantable. */
function unplantable(seed: I0Seed): boolean {
  return seed.needs === 'symlinks' && symlinkCapability() === null;
}

/** One edit seed as its file declares it: `it.skipIf(unplantable)(title, run)`. */
interface EditSeedCase {
  readonly title: string;
  /** The host lacks this seed's need: the only reason a seed is skipped. */
  readonly unplantable: boolean;
  readonly run: () => Promise<void>;
}

/**
 * One file's edit seeds, one case each, over the gate fixture or a fixture of the file's own.
 * Registers the file's fixture hooks.
 *
 * @param seeds - Its seeds, each run over a fresh fixture
 * @param testFileUrl - The calling file's `import.meta.url`, which locates the CLI build
 * @param tree - A fixture of the file's own, or the gate fixture when omitted
 * @returns The cases, in seed order
 */
export function editSeedCases(seeds: readonly I0Seed[], testFileUrl: string, tree?: FixtureTree): EditSeedCase[] {
  const suite = tree === undefined ? seedSuite(testFileUrl) : treeSeedSuite(tree, testFileUrl);
  beforeAll(suite.setup);
  afterAll(suite.cleanup);
  return seeds.map((seed) => ({
    title: seedTitle(seed),
    unplantable: unplantable(seed),
    run: async () => {
      expect(await suite.run(seed)).toEqual(seed.arms);
    },
  }));
}

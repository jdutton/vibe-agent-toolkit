/**
 * Every absence-cause member's seed, held both ways against the enumeration
 * (`./absence-causes.ts`): a member with no seed reds, and a seed with no
 * member does not typecheck.
 *
 * ## Two tiers
 *
 * - {@link SYSTEM_SEEDS}: I0 seeds the differential harness plants and judges.
 *   Each system file's whole body is one `it.skipIf` per case of
 *   `seedFile('<key>', import.meta.url)`, one test per seed, so a deleted or skipped seed changes a file the unit test
 *   holds to its template.
 * - {@link LOWER_TIER_SEEDS}: transitional. A member no CLI verb can plant yet
 *   is seeded by the package test that produces it, named here, which calls
 *   `expectAbsenceCause` on the rows it produced. Each flips to a system seed
 *   when a verb can plant it.
 *
 * Its own module, not the enumeration's: the harness imports the enumeration
 * for its census, and these seeds import the harness.
 */

import { chmodSync, existsSync, truncateSync, writeFileSync } from 'node:fs';

import { MANIFEST_UNREADABLE } from '@vibe-agent-toolkit/claude-marketplace';
import {
  BLOB_CONTENT_CHANGED,
  BLOB_PARSE_FAILED,
  BLOB_PARSE_LIMIT_EXCEEDED,
  BLOB_PARSE_WORKER_DIED,
  BLOB_UNREADABLE,
  EXTENT_DIRECTORY_UNLISTABLE,
  EXTENT_SYMLINK_NOT_REALIZED,
  PACKAGE_RESOLUTION_FAILED,
  PACKAGE_SUBPATH_NOT_EXPORTED,
} from '@vibe-agent-toolkit/resources';
import { createSymlink, safePath, symlinkCapability } from '@vibe-agent-toolkit/utils';
import { CANNOT_DENY_READS, overOutputRowsMarkdown } from '@vibe-agent-toolkit/utils/testing';
import { afterAll, beforeAll, expect } from 'vitest';

import { writeFileTree } from '../system/test-common.js';

import type { AbsenceMember } from './absence-causes.js';
import { GATE_FIXTURE, seedSuite, seedTitle, type I0Seed, type RecordedRuns } from './cache-differential.js';

// ── System seeds ────────────────────────────────────────────────────────────

/** Every recorded run of every label a seed consumes contains `text` in its stdout. */
function everyRunNames(text: string): (runs: RecordedRuns) => void {
  return (runs) => {
    for (const [label, byVerb] of Object.entries(runs)) {
      for (const run of Object.values(byVerb ?? {})) expect(run.stdout, `${label} ${run.verb}`).toContain(text);
    }
  };
}

const HUGE_PATH = 'docs/huge.md';
/** Generated once, so both arms read the same bytes (the generator stamps a fresh nonce per call). */
const HUGE_TEXT = overOutputRowsMarkdown('one.md');

/**
 * A committed file over a parse limit, `@import`ed from `CLAUDE.md` so `claude
 * context` reaches it as surely as the resource verbs do: refused alike in
 * every arm, counted once per verb.
 */
const limitBreach: I0Seed = {
  name: 'limitBreach',
  arms: ['storeOff', 'cold'],
  stateA: (corpus, git) => {
    writeFileTree(corpus, { [HUGE_PATH]: HUGE_TEXT, 'CLAUDE.md': `${GATE_FIXTURE['CLAUDE.md'] ?? ''}\n@${HUGE_PATH}\n` });
    git(['add', '--', HUGE_PATH, 'CLAUDE.md']);
    git(['commit', '-q', '-m', 'a file over a parse limit']);
    return Promise.resolve();
  },
  expect: { refuses: { cause: BLOB_PARSE_LIMIT_EXCEEDED, perVerb: { validate: 1, check: 1, query: 1, context: 1 } } },
  consumed: { runs: ['storeOff:measured', 'cold:measured'], check: everyRunNames(HUGE_PATH) },
};

const OVERSIZE_PATH = 'docs/oversize.md';
/**
 * One byte past the population's parse input cap (`inputBytes`, 8 MiB). Not
 * imported: the cap is internal to `resources`. If the cap rises past this
 * size, the seed's first check (a `contentState: oversize` row in the
 * reference dump) reds.
 */
const OVER_INPUT_CAP_BYTES = 8 * 1024 * 1024 + 1;

/**
 * A committed markdown file one byte past the input cap, sparse, so it costs no
 * disk: refused by its size before a byte is read, in every arm alike.
 */
const oversizeMarkdown: I0Seed = {
  name: 'oversizeMarkdown',
  arms: ['storeOff', 'cold'],
  verbs: ['query'],
  stateA: (corpus, git) => {
    const file = safePath.join(corpus, OVERSIZE_PATH);
    writeFileSync(file, '');
    truncateSync(file, OVER_INPUT_CAP_BYTES);
    git(['add', '--', OVERSIZE_PATH]);
    git(['commit', '-q', '-m', 'a file past the input cap']);
    return Promise.resolve();
  },
  expect: { refuses: { cause: 'contentState:oversize', perVerb: { query: 1 } } },
  consumed: { runs: ['storeOff:measured', 'cold:measured'], check: everyRunNames(OVERSIZE_PATH) },
};

/** The directory the OS refuses to list. Gitignored, so the git snapshot does not refuse the run. */
const LOCKED_DIR = 'locked';

/**
 * A gitignored directory at mode 000: the filesystem extent records it
 * unlistable, alike in every arm. The mode is restored after every cell.
 */
const unlistableDirectory: I0Seed = {
  name: 'unlistableDirectory',
  arms: ['storeOff', 'cold'],
  verbs: ['validate', 'query'],
  ...(CANNOT_DENY_READS ? { unplantableHere: 'a mode bit denies nothing on Windows or to root' } : {}),
  stateA: (corpus, git) => {
    writeFileTree(corpus, { '.gitignore': `${LOCKED_DIR}/\n`, [`${LOCKED_DIR}/hidden.md`]: '# Hidden\n' });
    git(['add', '--', '.gitignore']);
    git(['commit', '-q', '-m', 'ignore the locked directory']);
    chmodSync(safePath.join(corpus, LOCKED_DIR), 0o000);
    return Promise.resolve();
  },
  restore: (corpus) => {
    const locked = safePath.join(corpus, LOCKED_DIR);
    if (existsSync(locked)) chmodSync(locked, 0o755);
  },
  expect: { refuses: { cause: EXTENT_DIRECTORY_UNLISTABLE, perVerb: { validate: 1, query: 1 } } },
  consumed: { runs: ['storeOff:measured', 'cold:measured'], check: everyRunNames(LOCKED_DIR) },
};

/** Null on a host that cannot create symbolic links. */
const SYMLINKS = symlinkCapability();
const LINK_PATH = 'docs/linked.md';

/**
 * A committed link to an in-root file: the filesystem extent declines it as a
 * member and records that it did, alike in every arm.
 */
const declinedSymlink: I0Seed = {
  name: 'declinedSymlink',
  arms: ['storeOff', 'cold'],
  verbs: ['validate', 'query'],
  ...(SYMLINKS === null ? { unplantableHere: 'this host cannot create a symbolic link' } : {}),
  stateA: (corpus, git) => {
    if (SYMLINKS === null) throw new Error('declinedSymlink planted on a host that cannot create a symbolic link');
    createSymlink(SYMLINKS, 'two.md', safePath.join(corpus, LINK_PATH));
    git(['add', '--', LINK_PATH]);
    git(['commit', '-q', '-m', 'a link to an in-root file']);
    return Promise.resolve();
  },
  expect: { refuses: { cause: EXTENT_SYMLINK_NOT_REALIZED, perVerb: { validate: 1, query: 1 } } },
  consumed: { runs: ['storeOff:measured', 'cold:measured'], check: everyRunNames(LINK_PATH) },
};

/** The system seed files, each a key here and a `cache-differential-<key>.system.test.ts` file. */
export type SeedFileKey = 'limit' | 'extent';

/** Each system file's seeds. Split across files only to keep each inside the system tier's per-file budget. */
export const SYSTEM_SEEDS: Readonly<Record<SeedFileKey, readonly I0Seed[]>> = {
  limit: [limitBreach, oversizeMarkdown],
  extent: [unlistableDirectory, declinedSymlink],
};

/**
 * The cause a system seed plants: a member key, by its expectation's type.
 *
 * @param seed - A seed
 * @returns Its cause, or undefined for a seed that plants none
 */
export function causeOf(seed: I0Seed): AbsenceMember | undefined {
  return 'refuses' in seed.expect ? seed.expect.refuses.cause : undefined;
}

/**
 * The repository-relative path of a system seed file.
 *
 * @param key - The file's key
 * @returns Its path
 */
export function seedFilePath(key: SeedFileKey): string {
  return `packages/cli/test/system/cache-differential-${key}.system.test.ts`;
}

/**
 * The whole text of a system seed file: one call, so the file holds nothing a
 * seed could be deleted or skipped in.
 *
 * @param key - The file's key
 * @returns The text
 */
export function seedFileText(key: SeedFileKey): string {
  return [
    `/** I0 absence-cause seeds: one test per seed of \`SYSTEM_SEEDS['${key}']\` in \`../helpers/absence-seeds.ts\`. */`,
    '',
    "import { it } from 'vitest';",
    '',
    "import { seedFile } from '../helpers/absence-seeds.js';",
    '',
    `for (const seed of seedFile('${key}', import.meta.url)) it.skipIf(seed.unplantable)(seed.title, seed.run);`,
    '',
  ].join('\n');
}

/** One system seed as its file declares it: `it.skipIf(unplantable)(title, run)`. */
interface SeedCase {
  readonly title: string;
  /** The host cannot make this seed's plant. */
  readonly unplantable: boolean;
  readonly run: () => Promise<void>;
}

/**
 * One system file's cases: one per seed, each over a fresh gate fixture. Registers
 * the file's fixture hooks.
 *
 * @param key - The file's key
 * @param testFileUrl - The calling file's `import.meta.url`, which locates the CLI build
 * @returns The cases, in `SYSTEM_SEEDS[key]` order
 */
export function seedFile(key: SeedFileKey, testFileUrl: string): SeedCase[] {
  const suite = seedSuite(testFileUrl);
  beforeAll(suite.setup);
  afterAll(suite.cleanup);
  return SYSTEM_SEEDS[key].map((seed) => ({
    title: seedTitle(seed),
    unplantable: seed.unplantableHere !== undefined,
    run: async () => {
      expect(await suite.run(seed)).toEqual(seed.arms);
    },
  }));
}

// ── Lower-tier seeds ────────────────────────────────────────────────────────

/** A member seeded by the package test that produces it, until a verb can plant it. */
interface LowerTierSeed {
  readonly member: AbsenceMember;
  /** Repository-relative. */
  readonly file: string;
  /** The test's title as written: `it(<title>, ...)`, `it.each(...)(<title>, ...)` and the like. */
  readonly testName: string;
  /** Why no CLI verb can plant it yet. */
  readonly reason: string;
}

const SNAPSHOT_REFUSES_FIRST = 'The git snapshot refuses the run on any unreadable non-ignored file, and nothing shipped asks for an ignored file\'s content.';
const NO_EXTENT_VERB = 'No CLI verb runs this extent.';
const BLOB_POPULATION_TEST = 'packages/resources/test/projection-blob-population.test.ts';
const PACKAGE_EXTENT_TEST = 'packages/resources/test/projection-package-extent.test.ts';

/** The transitional seeds. */
export const LOWER_TIER_SEEDS: readonly LowerTierSeed[] = [
  {
    member: BLOB_UNREADABLE,
    file: BLOB_POPULATION_TEST,
    testName: 'records an unreadable blob as a condition and keeps going',
    reason: SNAPSHOT_REFUSES_FIRST,
  },
  {
    member: 'contentState:unreadable',
    file: 'packages/resources/test/projection-realizations.test.ts',
    testName: 'records a read that threw as unreadable — a fact about the corpus, not an abort',
    reason: SNAPSHOT_REFUSES_FIRST,
  },
  {
    member: BLOB_CONTENT_CHANGED,
    file: BLOB_POPULATION_TEST,
    testName: 'refuses to derive a blob from bytes that no longer key to it',
    reason: 'A mid-run race no verb can stage.',
  },
  {
    member: BLOB_PARSE_FAILED,
    file: 'packages/resources/test/projection-blob-parse-failure-attribution.test.ts',
    testName: 'records BLOB_PARSE_FAILED for $label',
    reason: 'The parsers do not throw on bytes.',
  },
  {
    member: BLOB_PARSE_WORKER_DIED,
    file: 'packages/resources/test/projection-blob-population-pool.test.ts',
    testName: 'is a per-run worker death carrying its cause, and is named by the population warning',
    reason: 'The parsers do not throw on bytes, and a worker dies only under a test seam.',
  },
  {
    member: PACKAGE_RESOLUTION_FAILED,
    file: PACKAGE_EXTENT_TEST,
    testName: 'records a dependency whose resolution failed for a reason that is neither absence nor an exclusion',
    reason: NO_EXTENT_VERB,
  },
  {
    member: PACKAGE_SUBPATH_NOT_EXPORTED,
    file: PACKAGE_EXTENT_TEST,
    testName: 'records a dependency whose exports map hides its own manifest at the package level',
    reason: NO_EXTENT_VERB,
  },
  {
    member: MANIFEST_UNREADABLE,
    file: 'packages/claude-marketplace/test/projection-plugin-extent-unreadable.test.ts',
    testName: 'says the OS refused the manifest when it did — not that the manifest is malformed',
    reason: NO_EXTENT_VERB,
  },
];

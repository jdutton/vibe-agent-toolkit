/**
 * I0, git's inputs: what changes when only the operator's global git config does.
 *
 * Every plant here goes through the cell's `GIT_CONFIG_GLOBAL` file and the
 * `core.attributesFile` or `core.excludesFile` it names, never repo-local config
 * or `.git/info/*`. A re-checkout deletes the file first, since git skips a file
 * whose index stat still matches.
 *
 * - `globalExcludes` changes which files exist to VAT, so the tree it is filed
 *   under changes and the warm run must miss.
 * - The three checkout seeds change the bytes on disk beneath an unchanged tree
 *   hash, and leave git's stored bytes where they were. A store-on run keys a
 *   tracked file by its object and reads git's bytes, so the warm run is served
 *   exactly what its prime derived, over an LF checkout and a CRLF one alike, and
 *   the key it carries is the object `git hash-object` names for the file on disk
 *   now. Store-off reads the working tree, so it may answer otherwise (documented:
 *   a store-off run parses the checkout's bytes).
 */

import { rmSync, writeFileSync } from 'node:fs';

import { safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  corpusBytes,
  expectEditOracle,
  realizationsOf,
  seedSuite,
  seedTitle,
  type ArmDirs,
  type Git,
  type I0Seed,
  type RecordedRuns,
} from '../helpers/cache-differential.js';

/** The file every hole seed rewrites. It has no links, so `edges` cannot move. */
const SEEDED = 'docs/two.md';

const STABLE_BECAUSE = 'a store-on run keys and reads git\'s stored bytes, which the checkout does not move';

/** Delete the file and check it out again, so git rewrites it under the current config. */
function recheckout(corpus: string, git: Git): void {
  rmSync(safePath.join(corpus, SEEDED));
  git(['checkout', '--', SEEDED]);
  expect(corpusBytes(corpus, SEEDED).length).toBeGreaterThan(0);
}

/** The global attributes file, named from the global config. */
function writeGlobalAttributes(dirs: ArmDirs, git: Git, lines: readonly string[]): void {
  const file = safePath.join(dirs.home, '.gitattributes');
  writeFileSync(file, `${lines.join('\n')}\n`);
  git(['config', '--global', 'core.attributesFile', file]);
}

/**
 * The warm arm keyed the seeded file by one git object on both sides of the checkout change, and
 * that object is the one git names for the file on disk now.
 */
function seededKeyStable(runs: RecordedRuns): void {
  const primed = realizationsOf(runs['warmSameHistory:prime']?.query, SEEDED);
  const measured = realizationsOf(runs['warmSameHistory:measured']?.query, SEEDED);
  expect(primed).toHaveLength(1);
  expect(measured).toHaveLength(1);
  expect(String(primed[0]?.['contentKey'])).toMatch(/^markdown\.git-sha1\.[0-9a-f]{40}$/);
  expect(measured[0]?.['contentKey'], 'the key moved with the checkout').toEqual(primed[0]?.['contentKey']);
  const run = runs['warmSameHistory:measured']?.query;
  if (run === undefined) throw new Error('no warm measured dump');
  expectEditOracle(run);
}

/** One checkout seed: state A and B differ only in a global input, beneath one tree hash. */
function checkoutSeed(name: string, stateA: NonNullable<I0Seed['stateA']>, toB: NonNullable<I0Seed['toB']>): I0Seed {
  return {
    name,
    needs: null,
    arms: ['storeOff', 'warmSameHistory'],
    verbs: ['query'],
    stateA,
    toB,
    expect: { checkoutStable: { arm: 'warmSameHistory', because: STABLE_BECAUSE } },
    consumed: { runs: ['warmSameHistory:prime', 'warmSameHistory:measured'], check: seededKeyStable },
  };
}

const globalExcludes: I0Seed = {
  needs: null,
  name: 'globalExcludes',
  arms: ['storeOff', 'warmSameHistory'],
  verbs: ['query'],
  stateA: (_corpus, git) => {
    git(['rm', '-q', '--cached', '--', SEEDED]);
    git(['commit', '-q', '-m', 'untrack the seeded file']);
    return Promise.resolve();
  },
  toB: (_arm, dirs, _corpus, git) => {
    const file = safePath.join(dirs.home, '.gitignore-global');
    writeFileSync(file, `${SEEDED}\n`);
    git(['config', '--global', 'core.excludesFile', file]);
    return Promise.resolve();
  },
  expect: { agreesAndMisses: { arm: 'warmSameHistory' } },
  consumed: {
    runs: ['warmSameHistory:prime', 'storeOff:measured'],
    check: (runs) => {
      expect(realizationsOf(runs['warmSameHistory:prime']?.query, SEEDED)).toHaveLength(1);
      expect(realizationsOf(runs['storeOff:measured']?.query, SEEDED)).toEqual([]);
    },
  },
};

const autocrlfFlip = checkoutSeed(
  'autocrlfFlip',
  (corpus, git) => {
    git(['config', '--global', 'core.autocrlf', 'true']);
    recheckout(corpus, git);
    expect(corpusBytes(corpus, SEEDED).includes('\r\n'), 'state A holds CRLF').toBe(true);
    return Promise.resolve();
  },
  (_arm, _dirs, corpus, git) => {
    git(['config', '--global', 'core.autocrlf', 'false']);
    recheckout(corpus, git);
    expect(corpusBytes(corpus, SEEDED).includes('\r\n'), 'state B holds LF').toBe(false);
    return Promise.resolve();
  },
);

/** A pointer the fake filter stores in place of a file's bytes. */
const POINTER_PREFIX = 'fake-pointer:';

/** The filter: `clean` stores a pointer (idempotent on one), `smudge` restores the bytes. */
const FAKE_FILTER_SCRIPT = String.raw`
const chunks = [];
process.stdin.on('data', (chunk) => chunks.push(chunk));
process.stdin.on('end', () => {
  const text = Buffer.concat(chunks).toString('utf-8');
  const isPointer = text.startsWith(${JSON.stringify(POINTER_PREFIX)});
  if (process.argv[2] === 'clean') {
    process.stdout.write(isPointer ? text : ${JSON.stringify(POINTER_PREFIX)} + Buffer.from(text).toString('base64') + '\n');
  } else {
    process.stdout.write(isPointer ? Buffer.from(text.slice(${String(POINTER_PREFIX.length)}).trim(), 'base64') : text);
  }
});
`;

/** The filter command, the interpreter and script quoted for the shell git runs it through. */
function filterCommand(script: string, mode: 'clean' | 'smudge'): string {
  // A JSON string is a double-quoted shell word: `\"` and `\\` are the only escapes either needs.
  const quote = (path: string): string => JSON.stringify(toForwardSlash(path));
  return `${quote(process.execPath)} ${quote(script)} ${mode}`;
}

const cleanSmudge = checkoutSeed(
  'cleanSmudge',
  (corpus, git, dirs) => {
    const script = safePath.join(dirs.home, 'fake-filter.cjs');
    writeFileSync(script, FAKE_FILTER_SCRIPT);
    git(['config', '--global', 'filter.fake.clean', filterCommand(script, 'clean')]);
    git(['config', '--global', 'filter.fake.smudge', filterCommand(script, 'smudge')]);
    writeGlobalAttributes(dirs, git, ['*.md filter=fake']);
    git(['add', '--renormalize', '.']);
    git(['commit', '-q', '-m', 'store markdown as pointers']);
    recheckout(corpus, git);
    expect(corpusBytes(corpus, SEEDED).toString('utf-8').startsWith(POINTER_PREFIX), 'state A holds the smudged bytes').toBe(false);
    return Promise.resolve();
  },
  (_arm, _dirs, corpus, git) => {
    git(['config', '--global', '--unset', 'filter.fake.smudge']);
    recheckout(corpus, git);
    expect(corpusBytes(corpus, SEEDED).toString('utf-8').startsWith(POINTER_PREFIX), 'state B holds the pointer').toBe(true);
    return Promise.resolve();
  },
);

const globalAttributesEol = checkoutSeed(
  'globalAttributesEol',
  (corpus) => {
    expect(corpusBytes(corpus, SEEDED).includes('\r\n'), 'state A holds LF').toBe(false);
    return Promise.resolve();
  },
  (_arm, dirs, corpus, git) => {
    writeGlobalAttributes(dirs, git, ['*.md eol=crlf']);
    recheckout(corpus, git);
    // The probe: `eol=crlf` alone (it implies `text`) changes the bytes on disk, the cleaned blob unchanged.
    expect(corpusBytes(corpus, SEEDED).includes('\r\n'), 'state B holds CRLF').toBe(true);
    expect(git(['status', '--porcelain', '--', SEEDED]).trim(), 'the tree is unchanged').toBe('');
    return Promise.resolve();
  },
);

const suite = seedSuite(import.meta.url);

describe('git inputs from the global config', () => {
  beforeAll(suite.setup);
  afterAll(suite.cleanup);

  for (const seed of [globalExcludes, autocrlfFlip, cleanSmudge, globalAttributesEol]) {
    it(seedTitle(seed), async () => {
      expect(await suite.run(seed)).toEqual(seed.arms);
    });
  }
});

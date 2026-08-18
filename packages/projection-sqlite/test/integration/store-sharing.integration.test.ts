/**
 * The claim the projection store exists for: **a second OS process can read what
 * a first one derived.**
 *
 * `store-concurrency.integration.test.ts` proves the storage engine survives
 * several processes at once — no lost row, no torn read — using synthetic
 * bundles. That is a claim about the *engine*. This file is the claim about the
 * *product*: that a real `populate()` in one process is reusable, unchanged and
 * without re-running a single contributor, by a real `populate()` in another.
 *
 * ## Why nothing smaller can test it
 *
 * `vat validate`, `vat verify` and `vat build` each `spawnSync` the vat binary
 * once per phase, so **nothing is shared in-process** — a store held in memory
 * would be discarded before the phase that could reuse it began. The reachable
 * win is therefore cross-*invocation*, not within-verb: `vat validate` and
 * `vat verify` each spawn a byte-identical `resources validate` child, and it is
 * the second of those two invocations that hits. (Stated precisely because it is
 * easy to overclaim here: as of today no top-level verb has two phases that both
 * reach a projection lane, so "phase 2 reuses phase 1's work" is not a win this
 * file demonstrates and not one the code currently offers.)
 *
 * Separate **processes**, never worker threads, for the reason the sibling file
 * gives: POSIX advisory locks are held per process, so two connections inside
 * one process are arbitrated by SQLite's own machinery rather than by the file
 * locks a second process takes. A thread-based harness passes without testing
 * the claim — and here it would also be testing the wrong thing entirely, since
 * a thread shares the module state a fresh `vat` invocation does not.
 *
 * ## The oracle is a string diff, not a judgement
 *
 * Each child emits `exportProjection`'s document: every table sorted by its
 * primary key, and `roots.path` — the one column that legitimately differs
 * between runs — redacted. So "B hydrated what A derived" is one string
 * comparison over twelve tables. A bespoke per-table deep-equal would have to
 * *choose* which columns to compare, and the columns a hydration bug drops are
 * exactly the ones nobody thinks to list.
 *
 * 🪤 **The comparison canonicalizes key order, and that is covering a real
 * defect rather than a nicety.** `serializeProjection` promises bytes that are
 * stable across runs, and across a store round trip they are not: a freshly
 * derived `blob_references` row is built as `{ ...row, ordinal }`
 * (`resources/src/projection/blob-references.ts`, the `candidates.map` that
 * assigns ordinals), so `ordinal` lands **last**, while a row read back from the
 * store is rebuilt in registry column order, where `ordinal` is second — it is
 * half of that table's primary key. The values are identical; only the key order
 * differs, which `JSON.stringify` faithfully preserves into differing bytes.
 * Measured here, on this fixture: two hunks, one per reference row, no other
 * table affected. The consequence outside this file is that a golden committed
 * from a cold run does not match the same corpus exported warm.
 * {@link canonicalDocument} sorts keys so this file measures hydration rather
 * than that defect; when the defect is fixed, delete it and compare the two
 * documents' bytes directly.
 *
 * ## The fixture must exercise something
 *
 * A population that produced no rows would satisfy every assertion below
 * vacuously — an empty projection hydrates to an empty projection, byte for
 * byte, under a completely broken store. The first test is a control that pins
 * non-trivial counts in every table the caching path has to carry, and every
 * later assertion is read against it.
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

import { compareCodeUnits, resolveFromImportMeta, safePath } from '@vibe-agent-toolkit/utils';
import { mkdirSyncReal, normalizedTmpdir } from '@vibe-agent-toolkit/utils/fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/** The population script, beside this file. */
const CHILD = resolveFromImportMeta(import.meta.url, 'store-sharing-child.mjs');

/**
 * The two questions a child can ask — see the child script for what each
 * registers.
 *
 * `broad` declares two closure extents beside the filesystem one; `narrow`
 * declares a single closure extent `broad` never mentions.
 */
type Question = 'broad' | 'narrow';

/**
 * The tree hash every arm shares unless it is specifically about a cold key.
 *
 * An opaque string, which is exactly what `ExtentKey.treeHash` promises: the
 * store neither produces nor interprets it, so a test needs no git to exercise
 * the key.
 */
const TREE_HASH = 'tree-0000000000000000000000000000000000000000';

/** Processes started together in the cold-store arm. */
const SIMULTANEOUS_STARTS = 4;

/**
 * A chain `SKILL.md → b.md → c.md`.
 *
 * More than one edge on purpose: a one-edge closure would reach the same extent
 * whether the driver followed `blob_references` or merely admitted the declared
 * root, so the fixture could not tell a served closure from an empty one. Three
 * documents also give the three closure declarations three distinct starting
 * points, which is what makes `broad` and `narrow` genuinely different
 * questions rather than the same one twice.
 */
const CORPUS: readonly { readonly path: string; readonly content: string }[] = [
  { path: 'skills/foo/SKILL.md', content: '---\nname: foo\n---\n\n# Foo\n\nSee [b](./b.md).\n' },
  { path: 'skills/foo/b.md', content: '# B\n\nOn to [c](./c.md).\n' },
  { path: 'skills/foo/c.md', content: '# C\n\nNothing links out of here.\n' },
];

/** What one child process reported. */
interface Population {
  /**
   * One entry per contributor invocation, `id@pass`.
   *
   * Empty is the observable signature of a hit — see the child script.
   */
  readonly contributorRuns: readonly string[];
  /** `exportProjection`'s twelve tables, primary-key sorted and path-redacted. */
  readonly tables: Readonly<Record<string, readonly Record<string, unknown>[]>>;
  /** Row count per table, for the vacuity control. */
  readonly counts: Readonly<Record<string, number>>;
}

/** A child that finished, whether or not it succeeded. */
interface ChildOutcome {
  /** Its exit code. */
  readonly code: number;
  /** Anything it wrote to stderr, for diagnosing a non-zero code. */
  readonly stderr: string;
  /** Where it was told to write its result. */
  readonly outputPath: string;
}

/** One temp root per test: the corpus, the store, and the children's results. */
let directory: string;

/** Distinguishes one child's result file from another's within a test. */
let childOrdinal = 0;

beforeEach(() => {
  directory = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-projection-sqlite-share-'));
  childOrdinal = 0;
  mkdirSyncReal(corpusPath('skills/foo'), { recursive: true });
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixture paths beneath this test's own mkdtemp root
  for (const file of CORPUS) writeFileSync(corpusPath(file.path), file.content, 'utf-8');
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

/**
 * A path inside this test's corpus.
 *
 * @param relative - Root-relative path
 * @returns The absolute path
 */
function corpusPath(relative: string): string {
  return safePath.join(directory, 'corpus', relative);
}

/**
 * The store directory every child in a test shares.
 *
 * One directory and not one per child: sharing it is the entire subject. It is
 * created beneath this test's own `mkdtemp` root and never exists beforehand, so
 * the first child of every arm opens a **cold** store.
 *
 * @returns The absolute path
 */
function storeDirectory(): string {
  return safePath.join(directory, 'store');
}

/**
 * Start one population process and wait for it to finish.
 *
 * Does not assert: the cold-store arm needs every child's exit code at once, and
 * a helper that threw on the first failure would report one crash and hide three.
 *
 * @param question - Which contributors the child registers
 * @param treeHash - The key half naming the tree; defaults to {@link TREE_HASH}
 * @returns Its exit code, its stderr, and where its result should be
 */
function spawnPopulation(question: Question, treeHash: string = TREE_HASH): Promise<ChildOutcome> {
  childOrdinal += 1;
  const outputPath = safePath.join(directory, `population-${childOrdinal}.json`);
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [CHILD, safePath.join(directory, 'corpus'), storeDirectory(), treeHash, question, outputPath],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    child.on('error', reject);
    child.on('exit', (code) => resolve({ code: code ?? -1, stderr, outputPath }));
  });
}

/**
 * Run one population process to completion and read back what it produced.
 *
 * The exit code is checked before the result is parsed, so a child that died is
 * diagnosed as a crash rather than as a missing file.
 *
 * @param question - Which contributors the child registers
 * @param treeHash - The key half naming the tree; defaults to {@link TREE_HASH}
 * @returns What it reported
 */
async function runPopulation(question: Question, treeHash: string = TREE_HASH): Promise<Population> {
  const outcome = await spawnPopulation(question, treeHash);
  expect(outcome.code, `${question} child: ${outcome.stderr}`).toBe(0);
  return readPopulation(outcome);
}

/**
 * Parse one finished child's result file.
 *
 * @param outcome - A child that exited 0
 * @returns What it reported
 */
function readPopulation(outcome: ChildOutcome): Population {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- a path this file composed, beneath its own mkdtemp root
  return JSON.parse(readFileSync(outcome.outputPath, 'utf-8')) as Population;
}

/**
 * One comparable string per projection, with object key order neutralized.
 *
 * See this file's header: the key order of a row differs between a freshly
 * derived projection and one read back out of the store, for a reason that is a
 * real defect in `blob-references.ts` and has nothing to do with what these
 * tests measure. Row *order* is left exactly as `exportProjection` produced it —
 * that ordering is the property under test, and sorting it here would hide a
 * hydration that returned the right rows in the wrong order.
 *
 * @param population - What a child reported
 * @returns A string equal exactly when two projections hold the same rows
 */
function canonicalDocument(population: Population): string {
  return `${JSON.stringify(sortKeysDeep(population.tables), undefined, 2)}\n`;
}

/**
 * Rewrite every object in a value with its keys in sorted order.
 *
 * Arrays keep their order; only object key order is touched.
 *
 * @param value - Any JSON value
 * @returns The same value with object keys sorted
 */
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => sortKeysDeep(entry));
  if (value === null || typeof value !== 'object') return value;
  const entries = Object.entries(value as Record<string, unknown>);
  entries.sort(([left], [right]) => compareCodeUnits(left, right));
  return Object.fromEntries(entries.map(([key, entry]) => [key, sortKeysDeep(entry)]));
}

describe('the fixture', () => {
  it('produces a non-trivial projection, so no later assertion can pass vacuously', async () => {
    // Read this first. Every claim below is of the form "the second process saw
    // what the first one wrote", and an empty projection satisfies all of them
    // under a completely broken store. These counts are the negative control
    // that makes the rest of the file mean something.
    const { counts } = await runPopulation('broad');

    // Three contexts: the filesystem extent, and the two closures over it.
    expect(counts['resolutionContexts']).toBe(3);
    expect(counts['zoneProvenance']).toBe(3);
    // Three documents plus the directories holding them.
    expect(counts['resources']).toBeGreaterThan(CORPUS.length);
    // Realized in more than one extent, which is what makes the extent tables
    // larger than the corpus rather than equal to it.
    expect(counts['resourceRealizations']).toBeGreaterThan(CORPUS.length);
    expect(counts['resourceExtents']).toBeGreaterThan(CORPUS.length);
    // The blob tier is populated and the reference graph is real — two edges,
    // `SKILL.md → b.md → c.md`. Without these the closures admitted nothing but
    // their declared roots and the store would be carrying almost no rows.
    expect(counts['blobs']).toBeGreaterThanOrEqual(CORPUS.length);
    expect(counts['blobReferences']).toBeGreaterThanOrEqual(2);
    expect(counts['blobSections']).toBeGreaterThan(0);
    // And the roots row the driver places itself.
    expect(counts['roots']).toBe(1);
  }, 60_000);
});

describe('a second process reading a first process\'s extent', () => {
  it('hydrates the document the first process derived, after that process exited', async () => {
    // The headline, and the whole reason the store is on disk rather than in
    // memory. Process A populates a cold store and closes it; A's process is
    // gone before B starts. B opens the same directory, asks the same question
    // about the same tree, and must reconstruct A's projection from rows alone.
    const first = await runPopulation('broad');
    const second = await runPopulation('broad');

    // The hit is asserted FIRST, and it is not decoration. Against a store that
    // answered nothing at all, the document comparison below would stay GREEN —
    // two correct full populations of an unchanged tree also produce identical
    // documents. The oracle can prove a hydration wrong; only the absence of
    // contributor work can prove a hydration HAPPENED.
    expect(second.contributorRuns).toEqual([]);
    expect(first.contributorRuns.length).toBeGreaterThan(0);
    // `selectRequestedRows` rebuilds `roots`, `resources` and `resourceTags` by
    // reachability rather than reading them back under a context, and this is
    // where that reconstruction is falsified across a process boundary: one
    // dropped or surplus row moves the document.
    expect(canonicalDocument(second)).toBe(canonicalDocument(first));
  }, 60_000);

  it('runs no contributor at all, which is the only proof the store answered', async () => {
    // Separated from the comparison above because the two prove different
    // things and fail for different reasons. Identical documents alone would not
    // prove a hit — a correct re-population produces the identical document too,
    // which is exactly what makes the document usable as an oracle. The saving
    // is only ever observable as work that did not happen.
    const first = await runPopulation('broad');
    const second = await runPopulation('broad');

    // Every contributor the first process ran, named, so a regression says which
    // stratum came back rather than only that the count moved.
    expect(first.contributorRuns).toContain('builtin:filesystem@1');
    expect(first.contributorRuns).toContain('closure:alpha@1');
    expect(first.contributorRuns).toContain('closure:beta@1');
    expect(second.contributorRuns).toHaveLength(0);
  }, 60_000);
});

describe('the additive write, which only two processes can see', () => {
  it('keeps a first process\'s closure extents alive through a second process\'s narrower write', async () => {
    // This is the cross-process form of the reason `writeExtent` became
    // additive, and a single-process test structurally cannot reach it: in one
    // process the second population would be served from whatever the first left
    // in hand, so the narrow write that has to *not* delete anything never
    // happens.
    //
    // 🪤 The narrow run asks about an extent the broad run never declares
    // (`gamma`), rather than a subset of the broad question. A subset would be
    // ANSWERED by the store — `selectRequestedContexts` only needs a provenance
    // row per registered contributor — so the run would hit and write nothing at
    // all, and the arm would test the store's patience rather than its writes.
    // What has to be narrower is the WRITE, not the question.
    const broad = await runPopulation('broad');
    const narrow = await runPopulation('narrow');

    // Two controls before the claim, because this arm has two ways of passing
    // for the wrong reason. First: the narrow process must genuinely have
    // MISSED, or it wrote nothing and there was never anything to survive.
    expect(narrow.contributorRuns.length).toBeGreaterThan(0);
    // Second: its write must genuinely be narrower — it carries the filesystem
    // extent and `gamma`, and none of the broad run's two closures. Were the
    // two writes the same width, wholesale replacement would be indistinguishable
    // from an additive merge.
    expect(narrow.counts['resolutionContexts']).toBeLessThan(broad.counts['resolutionContexts'] ?? 0);

    // The claim. A third process asks the BROAD question again. Under a
    // wholesale-replacing `writeExtent` the narrow process deleted `alpha` and
    // `beta` from under the same key, this run finds no provenance row for
    // either, and it misses — so a hit here is exactly the statement that the
    // narrower write left another question's contexts alone.
    const again = await runPopulation('broad');
    expect(again.contributorRuns).toEqual([]);
    // And it is the same answer, not merely an answer: a merge that kept the
    // rows but corrupted them would still report a hit.
    expect(canonicalDocument(again)).toBe(canonicalDocument(broad));
  }, 90_000);
});

describe('a cold store', () => {
  it('admits several processes that start a full population against it at once', async () => {
    // 🪤 The sharpest version of the WAL trap: `PRAGMA journal_mode = WAL` is
    // NOT retried through the busy handler, so simultaneous opens of a
    // brand-new store have been measured producing `ERR_SQLITE_ERROR: database
    // is locked` with a 5,000 ms busy timeout already installed. The sibling
    // file pins that for bare opens; this pins it for the case that actually
    // occurs, which is several `vat` invocations starting together and each
    // running a whole population against a store none of them created.
    //
    // This is the COMMON case, not an exotic one — a `turbo` fan-out, a
    // pre-commit hook and an editor lane can all start within the same second
    // on a machine whose cache directory was just purged.
    const outcomes = await Promise.all(
      Array.from({ length: SIMULTANEOUS_STARTS }, () => spawnPopulation('broad')),
    );

    // Exit codes first, all of them, so four crashes are reported as four rather
    // than as the first one.
    for (const [index, outcome] of outcomes.entries()) {
      expect(outcome.code, `starter ${index}: ${outcome.stderr}`).toBe(0);
    }

    // Every process agreed on the projection. Which of them hit and which
    // re-derived is a race and deliberately NOT asserted — what must hold is
    // that a process served from a store it was racing to create got the same
    // answer as one that derived it.
    const documents = outcomes.map((outcome) => canonicalDocument(readPopulation(outcome)));
    for (const [index, document] of documents.entries()) {
      expect(document, `starter ${index} disagreed`).toBe(documents[0]);
    }
    // Not vacuous: an arm whose children all produced nothing would satisfy the
    // agreement above trivially.
    const first = readPopulation(outcomes[0] as ChildOutcome);
    expect(first.counts['zoneProvenance']).toBe(3);
  }, 90_000);
});

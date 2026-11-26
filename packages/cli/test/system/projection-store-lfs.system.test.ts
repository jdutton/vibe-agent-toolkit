/**
 * The projection store over trees git cannot describe by their bytes alone, through the built CLI.
 *
 * - **Git LFS.** Under `filter=lfs` the tree hash carries a pointer blob, so one hash describes a
 *   markdown file pulled and not pulled. A `git lfs pull` must make the next run derive, and the
 *   run after that must be a store hit that reads and hashes nothing. A tree pulled where no
 *   `filter.lfs.*` key is configured keys as it does with one, and the operator is told once.
 * - **A snapshot git refuses** (an empty nested repository; an untracked file outside a sparse
 *   checkout's cone). The run populates without a store, says so, and answers as a store-off run.
 *
 * The filter is the repository's emulated clean/smudge pair (`packages/utils/test/fixtures/lfs-filter.mjs`)
 * under the fixture's home (`createLfsFixtureRepo`); every CLI run gets the same git isolation
 * (`GIT_CONFIG_NOSYSTEM`, `HOME`, `XDG_CONFIG_HOME`, `GIT_CONFIG_GLOBAL`), so a machine's git-lfs never
 * replaces the emulated filter. Each case owns its scratch directory, store and filter log.
 */

import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

import { mkdirSyncReal, resolveFromImportMeta, safePath, VAT_CACHE_DIR_ENV, WORK_COUNTERS_ENV } from '@vibe-agent-toolkit/utils';
import { createLfsFixtureRepo, type LfsFixtureRepo, lfsOidOf, lfsPointerOf } from '@vibe-agent-toolkit/utils/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PROJECTION_STORE_ENV, PROJECTION_STORE_OFF } from '../../src/utils/projection-store.js';
import { cliDumps } from '../helpers/work-counter-run.js';

import { createIsolatedScratch, executeCli, getBinPath, isolatedScratchEnv } from './test-common.js';

const binPath = getBinPath(import.meta.url);

const FILTER_SCRIPT = resolveFromImportMeta(import.meta.url, '../../../utils/test/fixtures/lfs-filter.mjs');

/** The LFS markdown file, root-relative. */
const LFS_DOC = 'docs/big.md';
/** 3,000-odd bytes of markdown: a pointer is 129, so the sizes tell pulled from not pulled. */
const CONTENT = `# Big\n\n${'lfs content '.repeat(250)}\n`;
/** The files every LFS case commits: the attribute, the LFS file, and one ordinary document. */
const LFS_TREE = {
  '.gitattributes': 'docs/*.md filter=lfs diff=lfs merge=lfs -text\n',
  [LFS_DOC]: CONTENT,
  'README.md': '# Readme\n\nSee [big](docs/big.md).\n',
};

/** The start of the notice a tree with LFS files and no configured filter gets. */
const LFS_FILTER_NOTICE = 'with Git LFS files in it, but this environment configures no git-lfs filter';
/** The words the notice for a tree git cannot key carries. */
const UNKEYABLE_NOTICE = 'git cannot key this tree';

let scratch: string;
let fixture: LfsFixtureRepo;

/** The filter's invocation log: one line per time git ran it. */
const filterLog = (): string => safePath.join(scratch, 'filter.log');

beforeEach(() => {
  scratch = createIsolatedScratch('vat-store-lfs-');
  // The fixture's home is the scratch home `isolatedScratchEnv` names, so the CLI's git and the
  // fixture's git read one empty global config.
  fixture = createLfsFixtureRepo({ dir: scratch, filterScript: FILTER_SCRIPT });
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

interface Run {
  readonly status: number | null;
  readonly document: { readonly data: Record<string, unknown> } & Record<string, unknown>;
  readonly stderr: string;
}

/** How one CLI run is set up. */
interface RunSetup {
  /** The run's `VAT_CACHE_DIR`. */
  readonly cacheDir: string;
  /** Whether the projection store is off. */
  readonly storeOff?: boolean;
  /** Where the run dumps its work counters, if anywhere. */
  readonly countsDir?: string;
}

/**
 * Run `vat resources <verb> --format json` in the fixture repository.
 *
 * @param args - The verb and its flags
 * @param setup - The run's store and counters
 * @returns The exit status, the parsed document and stderr
 */
async function vat(args: readonly string[], setup: RunSetup): Promise<Run> {
  const result = await executeCli(binPath, ['resources', ...args, '--format', 'json'], {
    cwd: fixture.repo,
    env: {
      ...isolatedScratchEnv(scratch),
      ...fixture.env,
      LAB_LFS_LOG: filterLog(),
      [VAT_CACHE_DIR_ENV]: setup.cacheDir,
      ...(setup.storeOff === true && { [PROJECTION_STORE_ENV]: PROJECTION_STORE_OFF }),
      ...(setup.countsDir !== undefined && { [WORK_COUNTERS_ENV]: setup.countsDir }),
    },
  });
  expect(result.stdout, result.stderr).not.toBe('');
  return { status: result.status, document: JSON.parse(result.stdout) as Run['document'], stderr: result.stderr };
}

/** `vat resources validate` against the case's store. */
function validate(setup: RunSetup = { cacheDir: safePath.join(scratch, 'cache') }): Promise<Run> {
  return vat(['validate'], setup);
}

/** A run's answer: the document without its wall time. */
function answerOf(run: Run): Record<string, unknown> {
  return Object.fromEntries(Object.entries(run.document).filter(([field]) => field !== 'durationMs'));
}

/** How many times `needle` occurs in `text`. */
function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

/** Every entry under `dir` named `projection-*`, at any depth, a link included: a store is any of them. */
function projectionStoresUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.name.startsWith('projection-'))
    .map((entry) => safePath.join(entry.parentPath, entry.name));
}

/**
 * The LFS tree committed with the filter configured, then left NOT pulled (its pointer on disk),
 * primed into the store, then pulled (the content written back and its stat refreshed, as
 * `git lfs pull` does).
 *
 * @returns The primed run
 */
async function primedNotPulledThenPulled(): Promise<Run> {
  fixture.configureFilter();
  fixture.commit(LFS_TREE);
  fixture.writeAndRefresh(LFS_DOC, lfsPointerOf(CONTENT));
  const primed = await validate();
  expect(primed.document.data['population'], primed.stderr).toBe('derived');
  fixture.writeAndRefresh(LFS_DOC, CONTENT);
  return primed;
}

describe('the projection store over Git LFS markdown (system test)', () => {
  it('derives after an LFS pull, and keys the pulled file as its content', async () => {
    await primedNotPulledThenPulled();

    const pulled = await validate();
    expect(pulled.document.data['population'], 'the pointer\'s stored facts are not served for the content').toBe('derived');

    const scan = await vat(['scan', '--verbose'], { cacheDir: safePath.join(scratch, 'cache') });
    const files = scan.document.data['files'] as ReadonlyArray<{ readonly path: string; readonly contentKey: string }>;
    expect(files.find((file) => file.path.endsWith(LFS_DOC))?.contentKey).toBe(`markdown.sha256.${lfsOidOf(CONTENT)}`);
  });

  it('serves the pulled tree from the store the next time, reading and hashing nothing', async () => {
    await primedNotPulledThenPulled();
    expect((await validate()).document.data['population']).toBe('derived');

    rmSync(filterLog(), { force: true });
    const countsDir = safePath.join(scratch, 'counts');
    mkdirSyncReal(countsDir, { recursive: true });
    const hit = await validate({ cacheDir: safePath.join(scratch, 'cache'), countsDir });

    expect(hit.document.data['population'], hit.stderr).toBe('store');
    const [dump, ...others] = cliDumps<{ readonly role: string; readonly counters: Record<string, number> }>(countsDir);
    expect(others).toEqual([]);
    expect(dump?.counters['content.read'], 'no file read at key time or after').toBe(0);
    expect(dump?.counters['content.hashed'], 'no file hashed at key time or after').toBe(0);
    expect(existsSync(filterLog()) ? readFileSync(filterLog(), 'utf-8') : '', 'git re-cleaned nothing: the index is stat-clean').toBe('');
  });

  it('keys a pulled tree with no filter configured as it keys it with one, and says so once', async () => {
    fixture.configureFilter();
    fixture.commit(LFS_TREE);
    const primed = await validate();
    expect(primed.document.data['population']).toBe('derived');
    expect(primed.stderr).not.toContain(LFS_FILTER_NOTICE);

    fixture.git('config', '--remove-section', 'filter.lfs');
    const unfiltered = await validate();

    expect(unfiltered.document.data['population'], 'the same key: served').toBe('store');
    expect(occurrences(unfiltered.stderr, LFS_FILTER_NOTICE), unfiltered.stderr).toBe(1);
    expect(unfiltered.stderr).toContain('update-index --refresh');
  });
});

/**
 * Assert a run over the fixture populated without a store: no store directory, the notice, and
 * the answer a store-off run gives.
 */
async function expectAnsweredWithoutAStore(): Promise<void> {
  const cacheDir = safePath.join(scratch, 'cache');
  const run = await validate({ cacheDir });
  const storeOff = await validate({ cacheDir: safePath.join(scratch, 'cache-off'), storeOff: true });

  expect(projectionStoresUnder(cacheDir), run.stderr).toEqual([]);
  expect(run.stderr).toContain(UNKEYABLE_NOTICE);
  expect(run.document.data['population']).toBe('derived');
  expect(run.status).toBe(storeOff.status);
  expect(answerOf(run)).toEqual(answerOf(storeOff));
}

describe('a snapshot git refuses: no store, a notice, the store-off answer (system test)', () => {
  it('an empty nested repository (git init inside the tree, no commit)', async () => {
    fixture.commit({ 'docs/a.md': '# A\n\nSee [gone](./gone.md).\n' });
    const nested = safePath.join(fixture.repo, 'nested');
    mkdirSyncReal(nested, { recursive: true });
    createLfsFixtureRepo({ dir: nested, filterScript: FILTER_SCRIPT });
    writeFileSync(safePath.join(nested, 'repo', 'n.md'), '# N\n');

    await expectAnsweredWithoutAStore();
  });

  // Holds until B2's pin (D20): today git refuses the snapshot outright, so the run has no key.
  it('an untracked file outside a sparse checkout\'s cone', async () => {
    fixture.commit({ 'in/a.md': '# In\n\nSee [gone](./gone.md).\n', 'out/b.md': '# Out\n' });
    fixture.git('sparse-checkout', 'set', '--cone', 'in');
    mkdirSyncReal(safePath.join(fixture.repo, 'out'), { recursive: true });
    writeFileSync(safePath.join(fixture.repo, 'out', 'stray.md'), '# Stray\n');

    await expectAnsweredWithoutAStore();
  });
});

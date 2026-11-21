/**
 * The same-build differential for `vat validate`'s checks overlap: ONE build run twice on the same
 * fixture, tree and store state, overlapped and sequential, with the core count the parent sees as
 * the only variable.
 *
 * - `parent-only-cores.mjs` makes the supervising process report 2 cores (overlapped: the gate may
 *   start the checks child during the resources phase) or 1 (sequential: the gate declines
 *   `cores` at once). The child is left alone.
 * - `VAT_PARSE_POOL_SIZE=1` in both processes of both modes, so the pool is the same width.
 * - `child-only-stderr-marker.mjs` in every run: the child writes its pid to a file and a known
 *   line to its stderr, so the replay of a held stderr is exercised in every arm.
 * - `VAT_VALIDATE_DEBUG_FACTS` in every run: the dump states which mode actually ran, why the gate
 *   declined, and the parent's writes from the spawn to the child's exit. Every arm asserts it, so
 *   an arm whose "overlapped" run silently ran sequential cannot pass.
 * - The store: each run starts from the same state. The cache directory is one path, removed and
 *   (warm) refilled from the seeded copy before every run, then handed to the arm's `prepare`.
 *
 * Asserted per arm by {@link expectSameOutput}: normalized stdout and stderr equal (the one
 * normalizer, `@vibe-agent-toolkit/utils/testing`), phase order equal, and exit code or terminating
 * signal equal.
 */

import { cpSync, existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import { PROJECTION_TABLES, quoteIdentifier, VAT_CACHE_DIR_ENV } from '@vibe-agent-toolkit/resources';
import { mkdirSyncReal, normalizePath, safePath } from '@vibe-agent-toolkit/utils';
import { normalizeCommandOutput, type NormalizeContext } from '@vibe-agent-toolkit/utils/testing';
import { expect } from 'vitest';

import type { GateDecline } from '../../../src/commands/checks-overlap-gate.js';
import { VALIDATE_DEBUG_FACTS_ENV, type ValidateDebugFacts } from '../../../src/commands/validate-debug-facts.js';
import { storeFilesUnder } from '../../helpers/projection-store-probe.js';
import { commitTestFixture } from '../../test-helpers.js';
import { createTestTempDir, writeFileTree } from '../test-common.js';

import { MD_ROWS, preload, writeConfig } from './checks-phase.js';
import { killStillRunning, type LiveVat, startVat } from './live-vat.js';

/** The core count the parent reports in each mode. */
const CORES = { overlapped: 2, sequential: 1 } as const;

/** Which of the two runs. */
export type Mode = keyof typeof CORES;

/** The line `child-only-stderr-marker.mjs` writes. */
export const CHILD_MARKER = 'VAT-TEST-CHILD-MARKER';
/** The bytes of the child's marker line: all a child that runs no failing check writes to stderr. */
export const MARKER_BYTES = Buffer.byteLength(`${CHILD_MARKER}\n`);
/** The resources phase's banner on the parent's stderr. */
export const RESOURCES_BANNER = '▶ Surface: resources';
/** The checks phase's banner on the parent's stderr. */
export const CHECKS_BANNER = '▶ Surface: checks';
/** The fixture's one check, and what each of its findings ends with on stderr. */
const CHECK_NAME = 'mdrows';
const CHECK_FINDING = `[CUSTOM:${CHECK_NAME}]`;

/** The VAT repository root, for the normalizer. */
const VAT_ROOT = fileURLToPath(new URL('../../../../../', import.meta.url));

/** A committed project, and the scratch its store states live in. */
export interface OverlapFixture {
  /** The committed tree every run validates. */
  readonly project: string;
  /** Everything else: the cache, the seeded copy, each run's files. */
  readonly scratch: string;
  /** The one `VAT_CACHE_DIR` every run uses, reset before each. */
  readonly cache: string;
  /** The warm store state, copied into {@link cache} before a warm run. */
  readonly seeded: string;
  /** What the normalizer erases. */
  readonly context: NormalizeContext;
}

/** Per-run files a case's environment and preloads name. */
export interface RunFiles {
  /** Where the child writes its pid. */
  readonly childPid: string;
  /** Created in the child's `exit` handler. */
  readonly childExit: string;
  /** Another file in this run's own directory. */
  readonly path: (name: string) => string;
}

/** How an arm runs each mode. */
export interface ArmOptions {
  /** The store state each run starts from: none, or the seeded one. */
  readonly store: 'cold' | 'warm';
  /** Change the store state after it is reset, before the run: given the cache directory. */
  readonly prepare?: (cache: string) => void;
  /** Further test-only preloads (`test-helpers/<name>`). */
  readonly preloads?: readonly string[];
  /** Further environment, given this run's files. */
  readonly env?: (files: RunFiles) => NodeJS.ProcessEnv;
  /** Act on the running process before it ends (the liveness and interrupt arms), told which mode it is. */
  readonly during?: (running: LiveVat, files: RunFiles, mode: Mode) => Promise<void>;
  /** POSIX: start `vat` as the leader of its own process group, so a case can signal the group as a terminal's Ctrl-C does. */
  readonly ownGroup?: 'session';
}

/** One mode's run, as compared. */
export interface ModeRun {
  readonly mode: Mode;
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  /** Normalized stdout. */
  readonly stdout: string;
  /** Normalized stderr, every holder of it included. */
  readonly stderr: string;
  /** `data.phases`, as `name:status`, in order. */
  readonly phases: readonly string[];
  /** The debug-facts dump, or `undefined` when the run wrote none. */
  readonly facts: ValidateDebugFacts | undefined;
  /** Whether a checks child started at all (it wrote its pid). */
  readonly childStarted: boolean;
  /** The published document. */
  readonly document: Record<string, unknown>;
  /** Wall time from the start to the process's exit with its stdout closed. */
  readonly elapsedMs: number;
}

/** The run a case has in flight, recorded by its `during`, so a red case leaves nothing running. */
export interface InFlight {
  readonly running: LiveVat;
  readonly files: RunFiles;
}

/**
 * Kill what a case left running: the run in flight and the checks child whose pid it wrote, each
 * only while it still runs. For an `afterEach`.
 *
 * @param inFlight - The run the case recorded, if any
 */
export function killInFlight(inFlight: InFlight | undefined): void {
  if (inFlight === undefined) return;
  const { childPid } = inFlight.files;
  const pid = existsSync(childPid) ? Number(readFileSync(childPid, 'utf-8')) : Number.NaN;
  // A pid file caught between its truncate and its write reads as 0, and pid 0 is the whole process group.
  killStillRunning(inFlight.running, Number.isInteger(pid) && pid > 0 ? pid : undefined);
}

/** Both modes of one arm. */
export interface BothModes {
  readonly overlapped: ModeRun;
  readonly sequential: ModeRun;
}

/** How an overlap fixture is built. */
interface OverlapFixtureOptions {
  /** Further committed files, by root-relative path. */
  readonly files?: Readonly<Record<string, string>>;
  /** The committed config's checks: by default one that selects both markdown files. */
  readonly checks?: Parameters<typeof writeConfig>[1];
  /** The seed run's preloads and environment: a check that never finishes needs its bound scaled. */
  readonly seed?: SeedRun;
}

/** What a seed run adds to the plain sequential run. */
type SeedRun = Pick<ArmOptions, 'preloads' | 'env'>;

/**
 * A committed project with two markdown files and its checks (by default one that selects both, so
 * the checks phase has findings to print after the child's stderr), and a warm store state seeded
 * from it.
 *
 * @param prefix - The scratch directory's prefix
 * @param options - Further files, the checks, the seed run
 * @returns The fixture, seeded
 */
export async function createOverlapFixture(prefix: string, options: OverlapFixtureOptions = {}): Promise<OverlapFixture> {
  const scratch = createTestTempDir(prefix);
  const project = safePath.join(scratch, 'project');
  mkdirSyncReal(safePath.join(project, 'docs'), { recursive: true });
  writeFileTree(project, { 'docs/a.md': '# Alpha\n', 'docs/b.md': '# Bravo\n', ...options.files });
  writeConfig(project, options.checks ?? [[CHECK_NAME, MD_ROWS]]);
  commitTestFixture(project);
  const fixture: OverlapFixture = {
    project,
    scratch,
    cache: safePath.join(scratch, 'cache'),
    seeded: safePath.join(scratch, 'seeded'),
    context: { corpusRoot: normalizePath(project, { within: project }), vatRoot: VAT_ROOT, homeDir: homedir() },
  };
  await reseed(fixture, options.seed ?? {});
  return fixture;
}

/**
 * Seed (again) the warm store state from the project as it now stands: one sequential run into an
 * empty cache, kept as the seeded copy. The resources phase writes the store before the checks
 * child is spawned, so a seed run whose child is then killed seeds it all the same.
 *
 * @param fixture - The fixture
 * @param seed - The seed run's preloads and environment
 */
async function reseed(fixture: OverlapFixture, seed: SeedRun): Promise<void> {
  rmSync(fixture.seeded, { recursive: true, force: true });
  const run = await runMode(fixture, 'sequential', [], { store: 'cold', ...seed }, 'seed');
  expect(run.facts, 'the seed run').toEqual(sequentialFacts({ condition: 'cores' }));
  cpSync(fixture.cache, fixture.seeded, { recursive: true });
}

/**
 * Run `vat validate <args>` overlapped, then sequential, each from the same store state.
 *
 * @param fixture - The fixture
 * @param args - Arguments after `validate`
 * @param options - The arm
 * @returns Both runs
 */
export async function runBothModes(fixture: OverlapFixture, args: readonly string[], options: ArmOptions): Promise<BothModes> {
  const overlapped = await runMode(fixture, 'overlapped', args, options, 'overlapped');
  const sequential = await runMode(fixture, 'sequential', args, options, 'sequential');
  return { overlapped, sequential };
}

/**
 * One run in one mode, from the arm's store state.
 *
 * @param fixture - The fixture
 * @param mode - The core count the parent reports
 * @param args - Arguments after `validate`
 * @param options - The arm
 * @param label - Names this run's own directory
 * @returns The run
 */
async function runMode(fixture: OverlapFixture, mode: Mode, args: readonly string[], options: ArmOptions, label: string): Promise<ModeRun> {
  rmSync(fixture.cache, { recursive: true, force: true });
  if (options.store === 'warm') cpSync(fixture.seeded, fixture.cache, { recursive: true });
  options.prepare?.(fixture.cache);

  const own = safePath.join(fixture.scratch, `run-${label}`);
  rmSync(own, { recursive: true, force: true });
  mkdirSyncReal(own, { recursive: true });
  const files: RunFiles = {
    childPid: safePath.join(own, 'child.pid'),
    childExit: safePath.join(own, 'child.exited'),
    path: (name) => safePath.join(own, name),
  };
  const dumps = safePath.join(own, 'facts');
  const startedAt = Date.now();
  const running = startVat(fixture.project, ['validate', ...args], {
    nodeOptions: [preload('parent-only-cores.mjs'), preload('child-only-stderr-marker.mjs'), ...(options.preloads ?? []).map(preload)],
    env: {
      [VAT_CACHE_DIR_ENV]: fixture.cache,
      [VALIDATE_DEBUG_FACTS_ENV]: dumps,
      VAT_PARSE_POOL_SIZE: '1',
      VAT_TEST_CORES: String(CORES[mode]),
      VAT_TEST_CHILD_PID_FILE: files.childPid,
      VAT_TEST_CHILD_EXIT_FILE: files.childExit,
      ...options.env?.(files),
    },
    ...(options.ownGroup === undefined ? {} : { ownGroup: options.ownGroup }),
  });
  await options.during?.(running, files, mode);
  const ending = await running.ended;
  const elapsedMs = Date.now() - startedAt;
  const stderr = await running.drained;
  const data = (ending.document['data'] ?? {}) as { phases?: Array<{ name: string; status: string }> };
  return {
    mode,
    code: ending.code,
    signal: ending.signal,
    stdout: normalizeCommandOutput(ending.stdout, fixture.context),
    stderr: normalizeCommandOutput(stderr, fixture.context),
    phases: (data.phases ?? []).map((phase) => `${phase.name}:${phase.status}`),
    facts: readFacts(dumps),
    childStarted: existsSync(files.childPid),
    document: ending.document,
    elapsedMs,
  };
}

/**
 * The one dump a run wrote, if any.
 *
 * @param directory - The run's `VAT_VALIDATE_DEBUG_FACTS`
 * @returns The dump, or `undefined`
 */
function readFacts(directory: string): ValidateDebugFacts | undefined {
  const written = existsSync(directory) ? readdirSync(directory) : [];
  expect(written.length, `dumps in ${directory}`).toBeLessThanOrEqual(1);
  const [only] = written;
  return only === undefined ? undefined : JSON.parse(readFileSync(safePath.join(directory, only), 'utf-8')) as ValidateDebugFacts;
}

/**
 * The lasting invariant: the two modes are indistinguishable from outside.
 *
 * @param a - One mode's run
 * @param b - The other's
 */
export function expectSameOutput(a: ModeRun, b: ModeRun): void {
  expect(a.stderr, 'normalized stderr').toBe(b.stderr);
  expect(a.stdout, 'normalized stdout').toBe(b.stdout);
  expect(a.phases, 'phase order').toEqual(b.phases);
  expect({ code: a.code, signal: a.signal }, 'exit').toEqual({ code: b.code, signal: b.signal });
}

/**
 * What a sequential run's dump states.
 *
 * @param declinedBy - The gate's decline
 * @returns The dump
 */
export function sequentialFacts(declinedBy: GateDecline): ValidateDebugFacts {
  return {
    checksOverlapped: 0,
    gateDeclinedBy: declinedBy,
    childStderrBytesAtTurn: 0,
    parentStoreWritesUntilChildExit: 0,
    parentParseCacheWritesUntilChildExit: 0,
  };
}

/**
 * What an overlapped run's dump states when the gate admitted it: no parent writes after the spawn.
 *
 * @param childStderrBytesAtTurn - What the child had written before the turn (a matcher where the
 *   arm cannot pin it)
 * @returns The dump
 */
export function overlappedFacts(childStderrBytesAtTurn: unknown): unknown {
  return { checksOverlapped: 1, gateDeclinedBy: null, childStderrBytesAtTurn, parentStoreWritesUntilChildExit: 0, parentParseCacheWritesUntilChildExit: 0 };
}

/**
 * Both runs' dumps: the sequential one declined for its one core (the preload acted), the
 * overlapped one as the arm expects.
 *
 * @param both - The arm's runs
 * @param overlapped - What the overlapped run's dump states (asymmetric matchers allowed)
 */
export function expectFacts(both: BothModes, overlapped: unknown): void {
  expect(both.sequential.facts, 'the sequential run').toEqual(sequentialFacts({ condition: 'cores' }));
  expect(both.overlapped.facts, 'the overlapped run').toEqual(overlapped);
}

/**
 * The child's marker sits after the checks banner and before the phase's first finding.
 *
 * @param run - One mode's run
 */
export function expectMarkerInItsTurn(run: ModeRun): void {
  const banner = run.stderr.indexOf(CHECKS_BANNER);
  const marker = run.stderr.indexOf(CHILD_MARKER);
  const finding = run.stderr.indexOf(CHECK_FINDING);
  expect(banner, `${run.mode}: the checks banner\n${run.stderr}`).toBeGreaterThanOrEqual(0);
  expect(marker, `${run.mode}: the child's marker after the banner\n${run.stderr}`).toBeGreaterThan(banner);
  expect(finding, `${run.mode}: the findings after the marker\n${run.stderr}`).toBeGreaterThan(marker);
}

/**
 * Edit the one projection store under a cache directory, opened read-write, then close it.
 *
 * @param cache - The run's cache directory
 * @param edit - What to do with the open database, given it
 */
export function editStore(cache: string, edit: (database: DatabaseSync) => void): void {
  const [file, ...others] = storeFilesUnder(cache);
  if (file === undefined || others.length > 0) throw new Error(`expected one projection store under ${cache}`);
  const database = new DatabaseSync(file);
  try {
    edit(database);
  } finally {
    database.close();
  }
}

/**
 * The content key the store holds for one member.
 *
 * @param database - The open store
 * @param path - The member's root-relative path
 * @returns Its content key
 */
export function storedContentKey(database: DatabaseSync, path: string): string {
  const realizations = quoteIdentifier(PROJECTION_TABLES.resourceRealizations.name);
  const row = database.prepare(`SELECT "contentKey" AS key FROM ${realizations} WHERE path = ?`).get(path) as { key: string | null } | undefined;
  if (typeof row?.key !== 'string') throw new Error(`the store holds no content key for ${path}`);
  return row.key;
}

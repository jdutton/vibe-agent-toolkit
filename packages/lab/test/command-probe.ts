/**
 * The stand-in vat that the harness and facet suites run instead of a real
 * binary.
 *
 * Not a test file — no `.test.ts` suffix, so the runner does not collect it.
 * Extracted because two suites need the same instrument for opposite reasons,
 * and a second copy would drift: `repeat.test.ts` reads the probe's log to pin
 * the ORDER of the children a repeat loop spawns, while `perf-capture.test.ts`
 * needs the same probe to fail on demand so a facet's "a failed run contributes
 * no timing" rule has something to fail on.
 *
 * The probe appends one JSON line per invocation to `probe.log` **in its working
 * directory**, which is why no test asserts the cwd directly: the log only
 * appears under the temp dir at all if `cwd` was honoured.
 *
 * ## Two ways to ask for a failure, and why both exist
 *
 * Either can be given a code with {@link PROBE_EXIT_CODE_ENV}: "failing" here
 * means "exit non-zero", and whether that non-zero code is a *failure* is the
 * measured command's own declaration.
 *
 * 1. **{@link PROBE_FAIL_TOKEN} in the arguments** — this command always fails,
 *    every repeat. Keyed on argv, so within one capture it can fail one command
 *    while another passes, which is how "a failing command must not poison a
 *    passing one's row" gets a fixture.
 * 2. **{@link PROBE_FAIL_AT_ENV} naming an index** — fail exactly one
 *    invocation. The index counts EVERY child that has already run in this
 *    directory, cache clears included, so it is only unambiguous for a single
 *    warm command. That is deliberate: "1 of 3 repeats failed" and "3 of 3
 *    repeats failed" have to be distinguishable outcomes, or a mutant that drops
 *    the count entirely still looks right.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

import { isPathAbsentError, mkdirSyncReal, normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';

import type { InstrumentVersion } from '../src/envelope/coordinate.js';
import type { ArmEnvironment } from '../src/harness/arm-env.js';
import type { MeasuredCommandSpec } from '../src/harness/commands.js';
import type { RepeatSpec } from '../src/harness/repeat.js';
import type { SequenceStep } from '../src/harness/sequence.js';
import type { CacheMode, CaptureRequest, ResolvedInstrument, ResolvedSubject } from '../src/harness/types.js';

/** Axis C is irrelevant to a probe run; every instrument here shares one. */
export const PROBE_VERSION: InstrumentVersion = {
  version: '0.0.0-test',
  commit: null,
  dirty: null,
  closure: null,
};

/** Base-environment variable, expected in EVERY child including the cache clear. */
export const PROBE_BASE_ENV = 'LAB_PROBE_BASE';

/** Per-repeat variable, expected in the measured run and nowhere else. */
export const PROBE_REPEAT_ENV = 'LAB_PROBE_INDEXED';

/** Set to make a failing child write a chosen string to stderr. */
export const PROBE_STDERR_ENV = 'LAB_PROBE_STDERR';

/** Set to a zero-based child index to fail exactly that one invocation. */
export const PROBE_FAIL_AT_ENV = 'LAB_PROBE_FAIL_AT';

/**
 * Set to the code a "failing" child should exit with, instead of
 * {@link PROBE_FAIL_EXIT}.
 *
 * Exists so a suite can fixture vat's *findings* exit. `1` is not a crash — a
 * spec may commit to it — and the difference between "every repeat exited 1
 * and the spec committed to 1" and "every repeat exited 3" is precisely what
 * `expectedExit` decides. Without a controllable code, no fixture could
 * make those two answers differ.
 */
export const PROBE_EXIT_CODE_ENV = 'LAB_PROBE_EXIT_CODE';

/**
 * Set to a JSON array of strings for the probe to write to stdout, one per
 * invocation, the last entry repeating once the list runs out.
 *
 * A list rather than a single string because the facets that read stdout are
 * exactly the facets that have to notice when two repeats DISAGREE, and a probe
 * that can only say one thing makes that case unfixturable — the suite would be
 * left asserting stability against a probe incapable of instability.
 *
 * Indexed by the count of children that already ran here, so it shares
 * {@link PROBE_FAIL_AT_ENV}'s caveat: unambiguous only for a single warm
 * command, where no cache clear is interleaved.
 */
export const PROBE_STDOUT_ENV = 'LAB_PROBE_STDOUT';

/**
 * Set to a comma-separated list of variable names for the probe to echo to
 * stdout as one JSON object, `null` for a name the child did not receive.
 *
 * Exists so a suite can read back the environment a child ACTUALLY got — the
 * only evidence that an arm-owned variable in the parent (`VAT_BIN`) did not
 * leak through. `null` rather than an omitted key, so "absent" is a value the
 * assertion names rather than one it infers.
 */
export const PROBE_ECHO_ENV = 'LAB_PROBE_ECHO_ENV';

/**
 * Set (to anything) to make the probe write NO `probe.log` into its cwd.
 *
 * Exists for the `verdict` facet, whose cwd is the SUBJECT: a log written there
 * moves the subject's content fingerprint between two arms' captures, and the
 * compare then — correctly — refuses them as a moved subject. With no log,
 * every invocation sees zero prior children, so {@link PROBE_FAIL_AT_ENV} `0`
 * fails EVERY invocation and {@link PROBE_STDOUT_ENV}'s first entry is always
 * the one printed: a per-arm constant, which is what an arm fixture wants.
 */
export const PROBE_NO_LOG_ENV = 'LAB_PROBE_NO_LOG';

/**
 * Comma-separated variable names whose directory the probe stats AT START: its
 * stdout JSON (shared with {@link PROBE_ECHO_ENV}) gains `mode:<NAME>` and
 * `mode:<NAME>/..`, the permission bits of that directory and of its parent,
 * or `null` when absent.
 *
 * Exists so a suite can tell "the directory was there, owner-only, when the
 * verb ran" from "it was made afterwards" — a stat taken after the capture
 * cannot.
 */
export const PROBE_STAT_ENV = 'LAB_PROBE_STAT_ENV';

/**
 * Set (to anything) to make the probe write what a populating VAT run writes: a
 * file in `VAT_PROJECTION_STORE_DIR`, and one parse shard under the parse
 * directory the fake resources package of {@link setupProbe} resolves.
 */
export const PROBE_POPULATE_ENV = 'LAB_PROBE_POPULATE';

/**
 * {@link PROBE_POPULATE_ENV} values for a run that populates only partly: the
 * store and no parse directory at all, or the store and a parse directory
 * holding only an empty subdirectory. `'1'` writes everything.
 */
export const PROBE_POPULATE_STORE_ONLY = 'store-only';
export const PROBE_POPULATE_EMPTY_SHARD_DIR = 'empty-shard-dir';

/**
 * A {@link PROBE_POPULATE_ENV} value that writes the store and a shard even when
 * the arm turned them off. Every other value obeys `VAT_PROJECTION_STORE` and
 * `VAT_CACHE` as vat does, so only this one can show an off switch being ignored.
 */
export const PROBE_POPULATE_IGNORING_SWITCHES = 'ignoring-switches';

/** The cache namespace the probe's fake resources package names. */
const PROBE_NAMESPACE = 'probe-ns';

/** An argument that makes every invocation of that command fail. */
export const PROBE_FAIL_TOKEN = 'boom';

/** Exit code a failing probe reports. Non-zero, and not 1, so it cannot be a coincidence. */
export const PROBE_FAIL_EXIT = 3;

/** What a failing child writes to stderr unless {@link PROBE_STDERR_ENV} overrides it. */
export const PROBE_DEFAULT_STDERR = 'probe was asked to fail';

/** Name of the log file the probe appends to, inside its working directory. */
const PROBE_LOG = 'probe.log';

/**
 * The probe itself: append one line, then exit 0 or {@link PROBE_FAIL_EXIT}.
 *
 * The failure decision is taken from the count of children that ran BEFORE this
 * one, so the index a caller supplies to {@link PROBE_FAIL_AT_ENV} is
 * zero-based and does not include the invocation making the decision.
 *
 * `--version` alone is the lab's untimed start of a build: the probe answers it
 * and exits 0 with no side effect and no log line, so a start is never a child
 * the fail switches or the per-run assertions count.
 */
const PROBE_SOURCE = [
  "if (process.argv[2] === '--version' && process.argv.length === 3) { process.stdout.write('probe'); process.exit(0); }",
  "const { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } = require('node:fs');",
  "const { tmpdir } = require('node:os');",
  "const { dirname, join, resolve } = require('node:path');",
  // The lab hands paths in forward slashes; `join` spells them natively. `resolve` makes one spelling of both.
  'const samePath = (a, b) => a !== undefined && b !== undefined && resolve(a) === resolve(b);',
  'const store = process.env.VAT_PROJECTION_STORE_DIR;',
  'const home = process.env.HOME;',
  'const storeExisted = store === undefined ? null : existsSync(store);',
  'const modeOf = (path) => (path !== undefined && existsSync(path) ? statSync(path).mode & 0o777 : null);',
  'const echoed = {};',
  `for (const name of (process.env.${PROBE_STAT_ENV} ?? '').split(',').filter((n) => n !== '')) {`,
  '  const path = process.env[name];',
  "  echoed['mode:' + name] = modeOf(path);",
  "  echoed['mode:' + name + '/..'] = path === undefined ? null : modeOf(dirname(path));",
  '}',
  'const homeEntries = home === undefined || !existsSync(home) ? null : readdirSync(home).length;',
  // An ARM's tmp only (the store's sibling): counted at start, before anything below writes there.
  "const armTmp = store === undefined ? undefined : join(store, '..', 'tmp');",
  'const tmpEntries = samePath(process.env.TMPDIR, armTmp) && existsSync(armTmp) ? readdirSync(armTmp).length : null;',
  "const falseish = (v) => v !== undefined && ['0', 'false', 'no', 'n', 'off'].includes(v.trim().toLowerCase());",
  `const ignoring = process.env.${PROBE_POPULATE_ENV} === ${JSON.stringify(PROBE_POPULATE_IGNORING_SWITCHES)};`,
  'const cacheOn = ignoring || !falseish(process.env.VAT_CACHE);',
  "const selector = process.env.VAT_PROJECTION_STORE;",
  "const storeOn = ignoring || (cacheOn && (selector === undefined || (selector.trim() !== '' && !falseish(selector))));",
  `if (process.env.${PROBE_POPULATE_ENV} !== undefined) {`,
  "  if (store !== undefined && storeOn) { mkdirSync(store, { recursive: true }); writeFileSync(join(store, 'projection.db'), 'probe'); }",
  `  const parse = join(tmpdir(), '.vat-cache', ${JSON.stringify(PROBE_NAMESPACE)}, 'parse', 'ab');`,
  `  if (cacheOn && process.env.${PROBE_POPULATE_ENV} !== ${JSON.stringify(PROBE_POPULATE_STORE_ONLY)}) mkdirSync(parse, { recursive: true });`,
  `  if (cacheOn && (process.env.${PROBE_POPULATE_ENV} === '1' || ignoring)) writeFileSync(join(parse, 'key.json'), '{}');`,
  '}',
  // Only ever into an ARM's home (the store's sibling), never a real one.
  "if (store !== undefined && samePath(home, join(store, '..', 'home')) && existsSync(home)) writeFileSync(join(home, 'left-by-probe'), 'x');",
  "if (tmpEntries !== null) writeFileSync(join(armTmp, 'left-by-probe-' + String(process.pid)), 'x');",
  `const log = join(process.cwd(), ${JSON.stringify(PROBE_LOG)});`,
  'let priorChildren = 0;',
  'try {',
  String.raw`  priorChildren = readFileSync(log, 'utf-8').split('\n').filter((l) => l !== '').length;`,
  '} catch {',
  '  priorChildren = 0;',
  '}',
  `const failAt = process.env.${PROBE_FAIL_AT_ENV};`,
  `const failed = process.argv.includes(${JSON.stringify(PROBE_FAIL_TOKEN)})`,
  '  || (failAt !== undefined && Number(failAt) === priorChildren);',
  'const line = JSON.stringify({',
  '  args: process.argv.slice(2),',
  `  base: process.env.${PROBE_BASE_ENV} ?? null,`,
  `  perRepeat: process.env.${PROBE_REPEAT_ENV} ?? null,`,
  '  storeExisted,',
  '  homeEntries,',
  '  tmpEntries,',
  '});',
  `if (process.env.${PROBE_NO_LOG_ENV} === undefined) {`,
  String.raw`  appendFileSync(log, line + '\n');`,
  '}',
  `const echoSpec = process.env.${PROBE_ECHO_ENV};`,
  "for (const name of (echoSpec ?? '').split(',').filter((n) => n !== '')) echoed[name] = process.env[name] ?? null;",
  `if (echoSpec !== undefined || process.env.${PROBE_STAT_ENV} !== undefined) process.stdout.write(JSON.stringify(echoed));`,
  `const outSpec = process.env.${PROBE_STDOUT_ENV};`,
  'if (outSpec !== undefined) {',
  '  const outputs = JSON.parse(outSpec);',
  '  process.stdout.write(outputs[Math.min(priorChildren, outputs.length - 1)] ?? "");',
  '}',
  'if (failed) {',
  `  process.stderr.write(process.env.${PROBE_STDERR_ENV} ?? ${JSON.stringify(PROBE_DEFAULT_STDERR)});`,
  '}',
  `const failExit = Number(process.env.${PROBE_EXIT_CODE_ENV} ?? ${String(PROBE_FAIL_EXIT)});`,
  'process.exit(failed ? failExit : 0);',
  '',
].join('\n');

/** One child process, as the probe recorded it. */
export interface ProbeEntry {
  readonly args: string[];
  readonly base: string | null;
  readonly perRepeat: string | null;
  /** Whether `VAT_PROJECTION_STORE_DIR` existed when the child started; `null` when unset. */
  readonly storeExisted: boolean | null;
  /** How many entries `HOME` held when the child started; `null` when unset or missing. */
  readonly homeEntries: number | null;
  /** How many entries the arm's `TMPDIR` held when the child started (the probe then leaves one); `null` outside an arm. */
  readonly tmpEntries: number | null;
}

/** The probe's args, entry by entry — the shape most ordering assertions read. */
export function argsOf(entries: readonly ProbeEntry[]): string[][] {
  return entries.map((entry) => entry.args);
}

/** A temp working directory plus the instrument that logs into it. */
export interface Probe {
  readonly cwd: string;
  /** The arms root for this probe: a SIBLING of `cwd`, never inside it, as the lab requires. */
  readonly armsRoot: string;
  readonly instrument: ResolvedInstrument;
  /** Every child so far, in the order they ran. */
  readonly entries: () => ProbeEntry[];
}

/**
 * Create a fresh probe: its own temp directory, so its log starts empty.
 *
 * @param prefix - Temp-directory prefix, so a stray directory names its suite
 * @returns The working directory, the instrument, and a log reader
 */
export function setupProbe(prefix = 'lab-probe-'): Probe {
  const root = mkdtempSync(safePath.join(normalizedTmpdir(), prefix));
  createdProbeDirs.push(root);
  const cwd = mkdirSyncReal(safePath.join(root, 'subject'));
  const script = safePath.join(cwd, 'probe.cjs');
  writeFileSync(script, PROBE_SOURCE, 'utf-8');
  writeFakeResourcesPackage(cwd);

  return {
    cwd,
    armsRoot: safePath.join(root, 'arms'),
    instrument: { command: process.execPath, leadingArgs: [script], version: PROBE_VERSION },
    entries: () => readProbeLog(cwd),
  };
}

/**
 * A stand-in `@vibe-agent-toolkit/resources` beside the probe, so the harness
 * resolves the probe build's parse directory the way it resolves a real build's
 * (from the instrument's own module resolution) — under whatever `TMPDIR` the
 * arm hands it.
 *
 * @param base - The directory whose `node_modules` gets it: the probe directory, or an npx project
 */
export function writeFakeResourcesPackage(base: string): void {
  const dir = safePath.join(base, 'node_modules', '@vibe-agent-toolkit', 'resources');
  mkdirSyncReal(dir, { recursive: true });
  writeFileSync(
    safePath.join(dir, 'package.json'),
    JSON.stringify({ name: '@vibe-agent-toolkit/resources', type: 'module', exports: { '.': { default: './index.js' } } }),
  );
  writeFileSync(
    safePath.join(dir, 'index.js'),
    [
      "import { tmpdir } from 'node:os';",
      "import { join } from 'node:path';",
      `export function parseCacheDirectory() { return join(tmpdir(), '.vat-cache', ${JSON.stringify(PROBE_NAMESPACE)}, 'parse'); }`,
      '',
    ].join('\n'),
  );
}

/** Every probe directory made so far, so a suite can drop them in one go. */
const createdProbeDirs: string[] = [];

/**
 * Remove every probe directory this module created.
 *
 * Each probe gets its own `mkdtemp` directory and a suite makes one per test, so
 * without this a full run leaves a dozen of them behind on every developer
 * machine and CI agent. Call it from `afterAll`.
 */
export function cleanupProbes(): void {
  for (const dir of createdProbeDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  createdProbeDirs.length = 0;
}

/**
 * Read every line the probe has written, in order.
 *
 * @param cwd - The probe's working directory
 * @returns One entry per child process, or none when nothing ran
 */
export function readProbeLog(cwd: string): ProbeEntry[] {
  let raw: string;
  try {
    raw = readFileSync(safePath.join(cwd, PROBE_LOG), 'utf-8');
  } catch (error) {
    // No file at all is the "nothing ran" case, which a test asserts on.
    if (isPathAbsentError(error)) return [];
    throw error;
  }
  return raw
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as ProbeEntry);
}

/**
 * Build a {@link RepeatSpec} against a probe, defaulting what a case ignores.
 *
 * The arm lives under {@link Probe.out}, beside the probe's working directory,
 * so a suite's arm directories are dropped with its probe.
 *
 * @param probe - Supplies the instrument and the working directory
 * @param overrides - What the case varies
 * @returns A complete spec
 */
export function probeSpec(probe: Probe, overrides: ProbeSpecOverrides = {}): RepeatSpec {
  const { env, args, cache, arm, ...rest } = overrides;
  return {
    instrument: probe.instrument,
    cwd: probe.cwd,
    steps: [probeStep(args ?? ['audit'])],
    runs: 2,
    arm: { root: probeArmsRoot(probe), build: 'probe', arm: arm ?? 'audit', state: cache ?? 'warm' },
    ...rest,
    env: { set: env ?? {}, unset: [] },
  };
}

/**
 * @param probe - A probe
 * @returns The arms root its arms live under
 */
export function probeArmsRoot(probe: Probe): string {
  return probe.armsRoot;
}

/** A command the probe always completes. */
export const PROBE_PASSES: MeasuredCommandSpec = { name: 'audit', args: ['audit'], expectedExit: 0, provenance: 'none', populates: false };

/** A command the probe fails on every repeat, by argv. */
export const PROBE_FAILS: MeasuredCommandSpec = { name: 'broken', args: [PROBE_FAIL_TOKEN], expectedExit: 0, provenance: 'none', populates: false };

/**
 * No repeats at all, cold. Cold on purpose: a cold reset hoisted out of the
 * repeat loop would still run here, where nothing at all should.
 */
export const NO_REPEATS_COLD = Object.freeze({ runs: 0, cache: 'cold' as const });

/** Two repeats of {@link PROBE_FAILS}, cold — so no warm priming run fails before the repeats do. */
export const EVERY_REPEAT_FAILS_COLD = Object.freeze({ runs: 2, commands: [PROBE_FAILS], cache: 'cold' as const });

/**
 * The capture-request fields a facet's probe capture defaults: the probe build,
 * {@link PROBE_PASSES} three times warm, and the probe's arms.
 *
 * @param probe - Supplies the instrument and the arms root
 * @param subject - The resolved subject
 * @param capturedAt - The caller-owned capture time
 * @returns The defaults, for a case's overrides to spread over
 */
export function probeCaptureDefaults(
  probe: Probe,
  subject: ResolvedSubject,
  capturedAt: string,
): Pick<CaptureRequest, 'instrument' | 'subject' | 'commands' | 'runs' | 'cache' | 'capturedAt' | 'arms'> {
  return {
    instrument: probe.instrument,
    subject,
    commands: [PROBE_PASSES],
    runs: 3,
    cache: 'warm',
    capturedAt,
    arms: { root: probeArmsRoot(probe), build: 'probe' },
  };
}

/**
 * One timed VAT step against the probe.
 *
 * @param args - The probe's arguments
 * @param overrides - What the case varies about the step
 * @returns The step
 */
export function probeStep(args: readonly string[], overrides: Partial<SequenceStep> = {}): SequenceStep {
  return {
    name: args[0] ?? 'probe',
    command: { kind: 'vat', args },
    timed: true,
    expectedExit: 0,
    provenance: 'none',
    populates: false,
    ...overrides,
  };
}

/** What a case varies about a probe's repeats; `env` names only what it SETS. */
type ProbeSpecOverrides = Omit<Partial<RepeatSpec>, 'env' | 'arm'> & {
  readonly env?: ArmEnvironment['set'];
  /** The probe's arguments for the default single step. */
  readonly args?: readonly string[];
  /** The arm's cache state. */
  readonly cache?: CacheMode;
  /** The arm's name. */
  readonly arm?: string;
};

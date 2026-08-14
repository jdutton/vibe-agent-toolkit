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

import { normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';

import type { InstrumentVersion } from '../src/envelope/coordinate.js';
import type { RepeatSpec } from '../src/harness/repeat.js';
import type { ResolvedInstrument } from '../src/harness/types.js';

/** Axis C is irrelevant to a probe run; every instrument here shares one. */
export const PROBE_VERSION: InstrumentVersion = { version: '0.0.0-test', commit: null, dirty: null };

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
 * spec may declare it a completed run — and the difference between "every repeat
 * exited 1 and the spec accepts 1" and "every repeat exited 3" is precisely what
 * `completedExitCodes` decides. Without a controllable code, no fixture could
 * make those two answers differ.
 */
export const PROBE_EXIT_CODE_ENV = 'LAB_PROBE_EXIT_CODE';

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
 */
const PROBE_SOURCE = [
  "const { appendFileSync, readFileSync } = require('node:fs');",
  "const { join } = require('node:path');",
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
  '});',
  String.raw`appendFileSync(log, line + '\n');`,
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
}

/** A temp working directory plus the instrument that logs into it. */
export interface Probe {
  readonly cwd: string;
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
  const cwd = mkdtempSync(safePath.join(normalizedTmpdir(), prefix));
  createdProbeDirs.push(cwd);
  const script = safePath.join(cwd, 'probe.cjs');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- test fixture under a fresh temp dir
  writeFileSync(script, PROBE_SOURCE, 'utf-8');

  return {
    cwd,
    instrument: { command: process.execPath, leadingArgs: [script], version: PROBE_VERSION },
    entries: () => readProbeLog(cwd),
  };
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
function readProbeLog(cwd: string): ProbeEntry[] {
  let raw: string;
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test fixture under a fresh temp dir
    raw = readFileSync(safePath.join(cwd, PROBE_LOG), 'utf-8');
  } catch {
    // No file at all is the "nothing ran" case, which a test asserts on.
    return [];
  }
  return raw
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as ProbeEntry);
}

/**
 * Build a {@link RepeatSpec} against a probe, defaulting what a case ignores.
 *
 * @param probe - Supplies the instrument and the working directory
 * @param overrides - What the case varies
 * @returns A complete spec
 */
export function probeSpec(probe: Probe, overrides: Partial<RepeatSpec> = {}): RepeatSpec {
  return {
    instrument: probe.instrument,
    cwd: probe.cwd,
    args: ['audit'],
    runs: 2,
    cache: 'warm',
    ...overrides,
  };
}

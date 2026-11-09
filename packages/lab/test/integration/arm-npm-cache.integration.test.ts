/**
 * A build that writes npm's cache on its first run, under an arm.
 *
 * npm keeps what it fetched under `$HOME/.npm` by default — and an arm's home is
 * emptied before every sequence, so a build (or a tool it spawns) that fetches
 * through npm would time a download in every repetition. Every arm instead gives
 * npm a cache of its own beside its store (`npm_config_cache`, never reset,
 * `prefer-offline`), and every build starts once, untimed, before round 1, so the
 * fetch lands there and never in a timed repetition.
 *
 * The stand-in fetches into whatever cache npm would use and logs whether each
 * run fetched. (No `npx:` build runs this way: one is installed before any arm
 * runs and resolved to its install's entry — `npx-install.integration.test.ts`.)
 *
 * A build whose parse directory a populating step needs, but that does not run
 * as `node <entry>`, is refused before any measured child.
 *
 * Integration-tier: spawns node.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

import { normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { NODE_EXECUTABLE } from '@vibe-agent-toolkit/utils/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runRepeats, type RepeatSpec } from '../../src/harness/repeat.js';
import type { ResolvedInstrument } from '../../src/harness/types.js';
import { PROBE_VERSION, probeStep } from '../command-probe.js';

/** Where the stand-in logs each run. */
const LOG_ENV = 'LAB_NPM_CACHE_LOG';

/** Fetches into npm's cache on first run, as npm does, and logs what it saw. */
const FETCHING_BUILD = [
  "const { appendFileSync, existsSync, mkdirSync, writeFileSync } = require('node:fs');",
  "const { join } = require('node:path');",
  "const cache = process.env.npm_config_cache ?? join(process.env.HOME ?? '', '.npm');",
  "const fetched = !existsSync(join(cache, '_cacache', 'fetched'));",
  "if (fetched) { mkdirSync(join(cache, '_cacache'), { recursive: true }); writeFileSync(join(cache, '_cacache', 'fetched'), 'x'); }",
  `appendFileSync(process.env.${LOG_ENV}, JSON.stringify({`,
  '  argv: process.argv.slice(2),',
  '  fetched,',
  '  cache: process.env.npm_config_cache ?? null,',
  '  preferOffline: process.env.npm_config_prefer_offline ?? null,',
  String.raw`}) + '\n');`,
  '',
].join('\n');

let scratch: string;

beforeEach(() => {
  scratch = mkdtempSync(safePath.join(normalizedTmpdir(), 'lab-arm-npm-cache-'));
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/**
 * @param instrument - The build
 * @param populates - Whether its one step populates (so the cold rule needs its parse directory)
 * @returns A three-round cold arm of it under a fresh arms root, logging to `<scratch>/fetch.log`
 */
function coldArm(instrument: ResolvedInstrument, populates = false): RepeatSpec {
  const cwd = mkdtempSync(safePath.join(scratch, 'cwd-'));
  return {
    instrument,
    cwd,
    steps: [probeStep(['audit'], { populates })],
    runs: 3,
    arm: { root: mkdtempSync(safePath.join(scratch, 'arms-')), build: 'fetching', arm: 'a', state: 'cold' },
    env: { set: { [LOG_ENV]: safePath.join(scratch, 'fetch.log') }, unset: [] },
  };
}

/** @returns Each logged run */
function runs(): { readonly argv: readonly string[]; readonly fetched: boolean; readonly cache: string | null; readonly preferOffline: string | null }[] {
  return readFileSync(safePath.join(scratch, 'fetch.log'), 'utf-8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as ReturnType<typeof runs>[number]);
}

describe('a build that writes npm\'s cache, under an arm', () => {
  it('fetches once, in the untimed start before round 1, into a cache the arm owns — never in a timed repetition', async () => {
    const script = safePath.join(scratch, 'fetching-build.cjs');
    writeFileSync(script, FETCHING_BUILD);
    const spec = coldArm({ command: NODE_EXECUTABLE, leadingArgs: [script], version: PROBE_VERSION });

    const run = await runRepeats(spec);

    expect(run.results.map((result) => result.violation)).toEqual([null, null, null]);
    expect(runs().map((entry) => [entry.argv, entry.fetched])).toEqual([
      [['--version'], true],
      [['audit'], false],
      [['audit'], false],
      [['audit'], false],
    ]);
    for (const entry of runs()) {
      expect(entry.cache?.startsWith(spec.arm.root)).toBe(true);
      expect(entry.preferOffline).toBe('true');
    }
  });

  it('refuses, before any measured child, a populating arm whose build does not run as node <entry>', async () => {
    // `node -e <code>`: it runs (exits 0 on `--version`), but has no entry module to resolve a parse directory from.
    const started = safePath.join(scratch, 'started');
    const code = `require('node:fs').appendFileSync(${JSON.stringify(started)}, 'x')`;
    const spec = coldArm({ command: NODE_EXECUTABLE, leadingArgs: ['-e', code], version: PROBE_VERSION }, true);

    await expect(runRepeats(spec)).rejects.toThrow(/arm 'a': .*does not run as `node <entry>`/u);
    // Each run of the build appends one 'x': the untimed start at most, never a measured repetition.
    expect(existsSync(started) ? readFileSync(started, 'utf-8') : '').toMatch(/^x?$/u);
  });
});

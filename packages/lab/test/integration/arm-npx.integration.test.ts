/**
 * An instrument that fetches its own bytes on first run (`npx`) under an arm.
 *
 * npx keeps what it fetched in npm's cache, under `$HOME/.npm` by default — and
 * an arm's home is emptied before every sequence, so every repetition would
 * time a download. Every arm instead gives npm a cache of its own beside its
 * store (`npm_config_cache`, never reset, `prefer-offline`), and every build
 * starts once, untimed, before round 1, so the fetch lands there and never in
 * a timed repetition.
 *
 * The npx stand-in fetches into whatever cache npm would use, exactly as npx
 * does, and logs whether each run fetched.
 *
 * A build whose parse directory a populating step needs, but that does not run
 * as `node <entry>` (npx), is refused before anything runs.
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
const LOG_ENV = 'LAB_FAKE_NPX_LOG';

/** Fetches into npm's cache on first run, as npx does, and logs what it saw. */
const FAKE_NPX = [
  "const { appendFileSync, existsSync, mkdirSync, writeFileSync } = require('node:fs');",
  "const { join } = require('node:path');",
  "const cache = process.env.npm_config_cache ?? join(process.env.HOME ?? '', '.npm');",
  "const fetched = !existsSync(join(cache, '_npx', 'fake-vat'));",
  "if (fetched) { mkdirSync(join(cache, '_npx'), { recursive: true }); writeFileSync(join(cache, '_npx', 'fake-vat'), 'x'); }",
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
  scratch = mkdtempSync(safePath.join(normalizedTmpdir(), 'lab-arm-npx-'));
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/**
 * @param instrument - The build
 * @param populates - Whether its one step populates (so the cold rule needs its parse directory)
 * @returns A three-round cold arm of it under a fresh arms root, logging to `<scratch>/npx.log`
 */
function coldArm(instrument: ResolvedInstrument, populates = false): RepeatSpec {
  const cwd = mkdtempSync(safePath.join(scratch, 'cwd-'));
  return {
    instrument,
    cwd,
    steps: [probeStep(['audit'], { populates })],
    runs: 3,
    arm: { root: mkdtempSync(safePath.join(scratch, 'arms-')), build: 'npx', arm: 'a', state: 'cold' },
    env: { set: { [LOG_ENV]: safePath.join(scratch, 'npx.log') }, unset: [] },
  };
}

/** @returns Each logged run */
function runs(): { readonly argv: readonly string[]; readonly fetched: boolean; readonly cache: string | null; readonly preferOffline: string | null }[] {
  return readFileSync(safePath.join(scratch, 'npx.log'), 'utf-8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as ReturnType<typeof runs>[number]);
}

describe('an npx-shaped instrument under an arm', () => {
  it('fetches once, in the untimed start before round 1, into a cache the arm owns — never in a timed repetition', async () => {
    const script = safePath.join(scratch, 'fake-npx.cjs');
    writeFileSync(script, FAKE_NPX);
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

  it('refuses, before anything runs, a populating arm whose build does not run as node <entry>', async () => {
    const spec = coldArm({ command: 'npx', leadingArgs: ['--yes', 'vibe-agent-toolkit@0.2.0'], version: PROBE_VERSION }, true);

    await expect(runRepeats(spec)).rejects.toThrow(/arm 'a': .*does not run as `node <entry>`/u);
    expect(existsSync(safePath.join(scratch, 'npx.log'))).toBe(false);
  });
});

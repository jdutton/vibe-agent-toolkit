/**
 * An `npx:` build under a populating step is measurable: the untimed start
 * installs it into the arm's own npm cache, and only then is it asked for its
 * parse directory — from that install, never guessed.
 *
 * The `npx` on PATH is a stand-in: on its first run it lays out one
 * `_npx/<hash>/` project in `npm_config_cache` holding a fake
 * `@vibe-agent-toolkit/resources`, then runs the command probe with the
 * arguments after the spec. POSIX only: a bare `npx` resolves to `npx.cmd`
 * through a shell on win32, which this stand-in does not provide.
 *
 * Integration-tier: every case spawns real child processes.
 */

import { chmodSync, writeFileSync } from 'node:fs';

import { mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

import { runRepeats } from '../../src/harness/repeat.js';
import {
  argsOf,
  cleanupProbes,
  PROBE_POPULATE_ENV,
  probeSpec,
  probeStep,
  setupProbe,
  writeFakeResourcesPackage,
} from '../command-probe.js';

afterAll(cleanupProbes);
afterEach(() => {
  vi.unstubAllEnvs();
});

/** The spec the stand-in is handed, as `resolveInstrument` would pin it. */
const SPEC = '@vibe-agent-toolkit/cli@0.0.0-probe';

/**
 * Put a stand-in `npx` first on PATH.
 *
 * @param root - A scratch directory beside the probe
 * @param probeScript - The command probe it runs for every non-start call
 */
function standInNpx(root: string, probeScript: string): void {
  const template = mkdirSyncReal(safePath.join(root, 'npx-template'));
  writeFileSync(safePath.join(template, 'package.json'), JSON.stringify({ dependencies: { '@vibe-agent-toolkit/cli': '0.0.0-probe' } }));
  writeFakeResourcesPackage(template);
  const bin = mkdirSyncReal(safePath.join(root, 'bin'));
  const npx = safePath.join(bin, 'npx');
  writeFileSync(
    npx,
    [
      `#!${process.execPath}`,
      "const { cpSync, existsSync } = require('node:fs');",
      "const { join } = require('node:path');",
      "const project = join(process.env.npm_config_cache, '_npx', 'f00d');",
      `if (!existsSync(project)) cpSync(${JSON.stringify(template)}, project, { recursive: true });`,
      'const rest = process.argv.slice(4);',
      "if (rest.length === 1 && rest[0] === '--version') { process.stdout.write('0.0.0-probe'); process.exit(0); }",
      `process.argv = [process.argv[0], ${JSON.stringify(probeScript)}, ...rest];`,
      `require(${JSON.stringify(probeScript)});`,
      '',
    ].join('\n'),
  );
  chmodSync(npx, 0o755);
  vi.stubEnv('PATH', `${bin}:${process.env['PATH'] ?? ''}`);
}

describe.skipIf(process.platform === 'win32')('runRepeats — an npx build under a populating step', () => {
  it.for(['cold', 'warm'] as const)('measures a %s arm, its parse directory resolved from the install the start left', async (cache) => {
    const probe = setupProbe('lab-npx-');
    standInNpx(safePath.resolve(probe.cwd, '..'), probe.instrument.leadingArgs[0] ?? '');
    const instrument = { ...probe.instrument, command: 'npx', leadingArgs: ['--yes', SPEC] };
    const populating = probeStep(['audit'], { populates: true });

    const run = await runRepeats({
      ...probeSpec(probe, { runs: 2, cache, steps: [populating], env: { [PROBE_POPULATE_ENV]: '1' } }),
      instrument,
    });

    expect(run.priming?.violation ?? null).toBeNull();
    expect(run.results.map((repetition) => repetition.violation)).toEqual([null, null]);
    expect(argsOf(probe.entries())).toHaveLength(cache === 'warm' ? 3 : 2);
  });
});

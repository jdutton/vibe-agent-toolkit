/**
 * Where a BUILD keeps its parse cache under a given temp directory — asked of
 * the build itself.
 *
 * The cold rule asserts that a sequence's first step wrote at least one parse
 * shard, and the directory to look in is not the lab's to compute: the root and
 * the namespace are each build's own decision (an installed build names its
 * namespace by version, a checkout by a digest of where it lives), and they
 * change between builds. So the lab imports the build's own
 * `@vibe-agent-toolkit/resources`, resolved from the build's own entry point,
 * and calls its `parseCacheDirectory()` under the arm's own VAT-step
 * environment (`armStepEnvironment`) — the one its steps run in, so no
 * inherited variable can steer the answer — and accepts the answer only when it
 * lies under the arm's `tmp/`, the one place a cold reset empties. The cache root
 * alone is never asserted: it also holds the namespace directories VAT creates
 * up front and other tenants, so it is non-empty even when no parse fact was
 * written.
 */

import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

import { isAbsolutePath, isUnderRoot } from '@vibe-agent-toolkit/utils';

import { type ArmDirectories, armStepEnvironment } from './arm-dirs.js';
import { EMPTY_ARM_ENVIRONMENT } from './arm-env.js';
import { runCommand } from './run.js';
import type { ResolvedInstrument } from './types.js';

/** The package whose `parseCacheDirectory()` names a build's parse directory. */
const RESOURCES_PACKAGE = '@vibe-agent-toolkit/resources';

/** Imports the build's resources entry (argv[1]) and prints its parse directory. */
const PRINT_PARSE_DIRECTORY =
  'const m = await import(process.argv[1]); process.stdout.write(m.parseCacheDirectory());';

/** How long asking a build for a path may take before the answer is a refusal. */
const RESOLVE_TIMEOUT_MS = 60_000;

/** A build's parse directory, or why it could not be asked. */
export type ParseDirectoryResolution =
  | { readonly ok: true; readonly dir: string }
  | { readonly ok: false; readonly reason: string };

/**
 * Ask a build where its parse cache lives in an arm.
 *
 * @param instrument - The build; must run as `node <entry>` (a `tree:` or `dist:` instrument)
 * @param dirs - The arm, whose VAT-step environment the build is asked under
 * @returns The directory under `dirs.tmp`, or why it could not be resolved — never a guess
 */
export function resolveParseCacheDirectory(instrument: ResolvedInstrument, dirs: ArmDirectories): ParseDirectoryResolution {
  const entry = instrument.command === process.execPath ? instrument.leadingArgs[0] : undefined;
  if (entry === undefined || !isAbsolutePath(entry)) {
    return {
      ok: false,
      reason:
        'the build does not run as `node <entry>`, so its parse directory cannot be resolved from its own ' +
        'module graph — measure a cold arm with a tree: or dist: instrument',
    };
  }
  let resources: string;
  try {
    resources = createRequire(entry).resolve(RESOURCES_PACKAGE);
  } catch (error) {
    return { ok: false, reason: `the build at '${entry}' does not resolve ${RESOURCES_PACKAGE}: ${String(error)}` };
  }
  const result = runCommand(
    { command: process.execPath, leadingArgs: [] },
    ['--input-type=module', '-e', PRINT_PARSE_DIRECTORY, pathToFileURL(resources).href],
    { cwd: dirs.tmp, env: armStepEnvironment(dirs, EMPTY_ARM_ENVIRONMENT).env, timeoutMs: RESOLVE_TIMEOUT_MS },
  );
  if (result.exitCode !== 0 || result.stdout === '') {
    return {
      ok: false,
      reason: `asking the build for its parse directory failed (${String(result.spawnError ?? result.exitCode)}): ${result.stderr.trim()}`,
    };
  }
  // 'absent' is under tmp too: nothing is written there until the first step runs.
  if (isUnderRoot(dirs.tmp, result.stdout) === 'outside') {
    return {
      ok: false,
      reason: `the build names '${result.stdout}' as its parse directory, not under the arm's tmp '${dirs.tmp}' — a cold reset would not empty it`,
    };
  }
  return { ok: true, dir: result.stdout };
}

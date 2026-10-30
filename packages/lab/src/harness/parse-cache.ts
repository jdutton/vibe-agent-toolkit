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
 * and calls its `parseCacheDirectory()` with the arm's `TMPDIR`. The cache root
 * alone is never asserted: it also holds the namespace directories VAT creates
 * up front and other tenants, so it is non-empty even when no parse fact was
 * written.
 */

import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

import { isAbsolutePath } from '@vibe-agent-toolkit/utils';

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
 * Ask a build where its parse cache lives under `tmp`.
 *
 * @param instrument - The build; must run as `node <entry>` (a `tree:` or `dist:` instrument)
 * @param tmp - The arm's temp directory
 * @returns The directory, or why it could not be resolved — never a guess
 */
export function resolveParseCacheDirectory(instrument: ResolvedInstrument, tmp: string): ParseDirectoryResolution {
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
    { cwd: tmp, env: { set: { TMPDIR: tmp, TEMP: tmp, TMP: tmp }, unset: [] }, timeoutMs: RESOLVE_TIMEOUT_MS },
  );
  if (result.exitCode !== 0 || result.stdout === '') {
    return {
      ok: false,
      reason: `asking the build for its parse directory failed (${String(result.spawnError ?? result.exitCode)}): ${result.stderr.trim()}`,
    };
  }
  return { ok: true, dir: result.stdout };
}

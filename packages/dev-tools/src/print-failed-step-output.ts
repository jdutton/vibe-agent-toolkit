/**
 * Print every stdout/stderr capture vibe-validate wrote for the newest run.
 *
 * `bun run validate` captures a FAILED step's stdout and stderr to files under
 * `<temp>/vibe-validate/steps/<date>/<run>/<Step>/` (a passing step leaves no
 * directory) and summarises them through an extractor that keeps only lines
 * carrying an error keyword. A verdict without one — `NEW unused export: …`,
 * `STALE allowlist entry: …` — never reaches the CI log, so a red step reads as
 * "exited with code 1" and nothing else. This prints the captures verbatim; CI
 * runs it `if: failure()` after the validation step.
 *
 * Usage: bun run print-failed-step-output
 */

import { readdirSync, readFileSync } from 'node:fs';

import { ExitCode } from '@vibe-agent-toolkit/schema';
import { direntKindFollowingSync, safePath } from '@vibe-agent-toolkit/utils';
import { isPathAbsentError, normalizedTmpdir } from '@vibe-agent-toolkit/utils/fs';

import { isEntrypoint, log } from './common.js';

/** Where vibe-validate writes step captures: `$VV_TEMP_DIR` when set (the same override it reads), else the OS temp dir. */
export function stepsRootOf(env: Readonly<Record<string, string | undefined>>, tmpdir: string): string {
  return safePath.join(env['VV_TEMP_DIR'] ?? tmpdir, 'vibe-validate', 'steps');
}

/**
 * The lexically greatest name, or `undefined` for none. Date folders are
 * `YYYY-MM-DD` and run folders `<ISO timestamp>-<hash>`, so lexical order is
 * time order at both levels.
 */
export function newestOf(names: readonly string[]): string | undefined {
  return names.length === 0 ? undefined : [...names].sort((a, b) => a.localeCompare(b)).at(-1);
}

/** stdout first, then stderr; anything else (the JSONL merge) ranks out. */
function captureRank(name: string): number {
  if (name.endsWith('-stdout.txt')) return 0;
  if (name.endsWith('-stderr.txt')) return 1;
  return 2;
}

/** A step's capture files in reading order: stdout, then stderr; the JSONL merge is not repeated. */
export function orderCaptures(names: readonly string[]): string[] {
  return names
    .filter((name) => captureRank(name) < 2)
    .sort((a, b) => captureRank(a) - captureRank(b) || a.localeCompare(b));
}

/** Child directory names of `dir`; a missing `dir` is the empty list. */
function subdirectoriesOf(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => direntKindFollowingSync(dir, entry) === 'directory')
      .map((entry) => entry.name);
  } catch (error) {
    if (isPathAbsentError(error)) return [];
    throw error;
  }
}

function printStep(runDir: string, step: string): number {
  const stepDir = safePath.join(runDir, step);
  const captures = orderCaptures(readdirSync(stepDir));
  for (const name of captures) {
    log(`\n===== ${step}: ${name} =====`, 'cyan');
    process.stdout.write(readFileSync(safePath.join(stepDir, name), 'utf-8'));
  }
  return captures.length;
}

function main(): number {
  const root = stepsRootOf(process.env, normalizedTmpdir());
  const date = newestOf(subdirectoriesOf(root));
  const run = date === undefined ? undefined : newestOf(subdirectoriesOf(safePath.join(root, date)));
  if (date === undefined || run === undefined) {
    log(`No vibe-validate step captures under ${root} — no step failed, or the run wrote elsewhere.`, 'yellow');
    return ExitCode.OK;
  }
  const runDir = safePath.join(root, date, run);
  const steps = subdirectoriesOf(runDir);
  let printed = 0;
  for (const step of steps) printed += printStep(runDir, step);
  log(`\nPrinted ${String(printed)} capture(s) from ${String(steps.length)} failed step(s) in ${runDir}`, 'cyan');
  return ExitCode.OK;
}

if (isEntrypoint(import.meta.url)) {
  process.exit(main());
}

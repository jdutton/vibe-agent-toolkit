/**
 * What a `vat` invocation LOADED, per process — read from the coverage Node writes under
 * `NODE_V8_COVERAGE=<dir>`.
 *
 * Node writes one JSON file per isolate, named `coverage-<pid>-<timestamp>-<thread>.json`, listing
 * every script it loaded by URL. Grouping the files by pid says how many PROCESSES a run started
 * (a worker thread writes its own file under its process's pid) and what each one loaded — so a
 * case can pin "one process, and this module never loaded" as a fact rather than a timing.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';

import { normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { NODE_EXECUTABLE } from '@vibe-agent-toolkit/utils/testing';

/** One process the run started, and every script URL it (or a thread of it) loaded. */
interface LoadedProcess {
  readonly pid: number;
  readonly urls: readonly string[];
}

/** What one spawn loaded, and how it ended. */
interface LoadedRun {
  /** One entry per process that wrote coverage, in pid order. */
  readonly processes: readonly LoadedProcess[];
  /** Every URL every process loaded. */
  readonly urls: readonly string[];
  /** The URLs the spawned process's MAIN thread loaded (thread 0 of {@link pid}), without its workers'. */
  readonly mainThreadUrls: readonly string[];
  /** The pid of the process this helper spawned. */
  readonly pid: number | undefined;
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** `coverage-<pid>-<timestamp>-<thread>.json`: the pid is the first number, the thread id the last (0 is the main thread). */
const COVERAGE_FILE = /^coverage-(?<pid>\d+)-\d+-(?<thread>\d+)\.json$/;

/**
 * Run the built CLI under `NODE_V8_COVERAGE` and report what each process loaded.
 *
 * @param binPath - The built CLI entry point
 * @param args - Arguments to pass to the CLI
 * @param extraEnv - Environment overrides for the spawned process (and anything it spawns)
 * @param cwd - Where the CLI runs
 * @returns The processes, their scripts, and the spawn's result
 */
export function loadedScripts(
  binPath: string,
  args: readonly string[],
  extraEnv: Readonly<Record<string, string>>,
  cwd: string,
): LoadedRun {
  // mkdtempSync, never a `/tmp/...` literal — that has no drive letter and is not absolute on
  // Windows. normalizedTmpdir() rather than os.tmpdir() for the same reason: 8.3 short names.
  const covDir = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-modload-'));
  try {
    const result = spawnSync(NODE_EXECUTABLE, [binPath, ...args], {
      encoding: 'utf-8',
      cwd,
      env: { ...process.env, ...extraEnv, NODE_V8_COVERAGE: covDir },
    });

    const byPid = new Map<number, string[]>();
    const mainThreadUrls: string[] = [];
    for (const file of readdirSync(covDir)) {
      const groups = COVERAGE_FILE.exec(file)?.groups;
      const pid = Number(groups?.['pid']);
      if (!Number.isInteger(pid)) throw new Error(`unexpected coverage file name: ${file}`);
      const parsed: unknown = JSON.parse(readFileSync(safePath.join(covDir, file), 'utf-8'));
      const { result: scripts } = parsed as { result?: { url?: string }[] };
      const fileUrls = (scripts ?? []).flatMap((script) => (script.url ? [script.url] : []));
      byPid.set(pid, [...(byPid.get(pid) ?? []), ...fileUrls]);
      if (pid === result.pid && groups?.['thread'] === '0') mainThreadUrls.push(...fileUrls);
    }
    const processes = [...byPid.entries()]
      .sort(([a], [b]) => a - b)
      .map(([pid, urls]) => ({ pid, urls }));
    return {
      processes,
      urls: processes.flatMap((entry) => entry.urls),
      mainThreadUrls,
      pid: result.pid,
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  } finally {
    rmSync(covDir, { recursive: true, force: true });
  }
}

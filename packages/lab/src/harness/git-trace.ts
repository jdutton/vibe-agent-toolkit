/**
 * Count the git processes a run started, from a `GIT_TRACE2_EVENT` directory.
 *
 * Git writes one file per process into a directory named by `GIT_TRACE2_EVENT`, so a parent and an
 * overlapped child never interleave lines (and Windows needs no append atomicity). Each line is a
 * JSON event; the `start` event carries `argv`. A spawn is one `start` event, and its verb is the
 * first argv element after git's global options, never `argv[1]`. `spawns` counts every git
 * process the trace holds, including git's own children (a `fetch` starts `rev-list` and
 * `maintenance`, each with its own file and `start`), not only the spawns VAT makes.
 */

import { readdirSync, readFileSync } from 'node:fs';

import { safePath } from '@vibe-agent-toolkit/utils';

/** What a trace directory holds. */
interface GitTraceCount {
  /** Git processes started: one per `start` event. */
  readonly spawns: number;
  /** Spawns by verb. */
  readonly byVerb: Readonly<Record<string, number>>;
}

/** Global options that take their value as the next argv element. */
const OPTIONS_WITH_A_VALUE: ReadonlySet<string> = new Set(['-c', '-C', '--git-dir', '--work-tree', '--namespace', '--config-env', '--attr-source', '--super-prefix']);

/** The first argv element after git's global options, or `(none)` when there is none. */
function verbOf(argv: readonly string[]): string {
  let index = 1;
  while (index < argv.length) {
    const arg = argv[index] as string;
    if (OPTIONS_WITH_A_VALUE.has(arg)) {
      index += 2;
    } else if (arg.startsWith('-')) {
      index += 1;
    } else {
      return arg;
    }
  }
  return '(none)';
}

/** Parse one trace line; a malformed line throws naming its file and 1-based line number. */
function parseLine(line: string, file: string, lineNumber: number): unknown {
  try {
    return JSON.parse(line);
  } catch (error) {
    throw new Error(`git trace ${file} line ${lineNumber} is not JSON: ${(error as Error).message}`, { cause: error });
  }
}

/** The argv of a `start` event, or undefined for any other event. */
function startArgv(event: unknown): readonly string[] | undefined {
  if (typeof event !== 'object' || event === null) return undefined;
  const record = event as { event?: unknown; argv?: unknown };
  if (record.event !== 'start' || !Array.isArray(record.argv)) return undefined;
  return record.argv as string[];
}

/**
 * Sum every file of a `GIT_TRACE2_EVENT` directory.
 *
 * @param eventDir - The directory git wrote its per-process trace files into
 * @returns The spawn count and its split by verb
 * @throws Error naming the file and line of a line that is not JSON
 */
export function countGitTrace(eventDir: string): GitTraceCount {
  const counts = new Map<string, number>();
  let spawns = 0;
  for (const name of readdirSync(eventDir).sort((a, b) => a.localeCompare(b))) {
    const file = safePath.join(eventDir, name);
    const lines = readFileSync(file, 'utf8').split('\n');
    for (const [index, line] of lines.entries()) {
      if (line.trim() === '') continue;
      const argv = startArgv(parseLine(line, file, index + 1));
      if (argv === undefined) continue;
      spawns += 1;
      const verb = verbOf(argv);
      counts.set(verb, (counts.get(verb) ?? 0) + 1);
    }
  }
  return { spawns, byVerb: Object.freeze(Object.fromEntries(counts)) };
}

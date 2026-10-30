/**
 * What the `vat validate` checks-phase suites share: running `vat` with a test-only preload, the
 * config they write, and reading the phase entry out of the document.
 *
 * The faults a parent and a child would share (they share the environment and the filesystem) are
 * injected into ONE of them by a test-only preload beside this file, loaded through
 * `NODE_OPTIONS=--import "<file: URL>"` (a `file:` URL, because `--import` takes a module specifier
 * and a bare Windows path is not one; quoted, because a path may hold spaces). Each preload
 * discriminates on `--supervised-by`, which only a supervised child carries. VAT's source gains no knob.
 */

import yaml from 'yaml';

import { fs, getBinPath, safePath } from '../test-common.js';

import { executeCli } from './cli-runner.js';

/** The built `vat` binary every suite here runs. */
export const BIN_PATH = getBinPath(new URL('../x.test.ts', import.meta.url).href);

/** The test-only preload of that name, as a quoted `--import` of its `file:` URL. */
export function preload(name: string): string {
  return `--import "${new URL(name, import.meta.url).href}"`;
}

/** A statement that never terminates: an aggregate over an unbounded recursive CTE. */
export const RUNAWAY_SQL = 'WITH RECURSIVE c(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM c) SELECT count(*) FROM c';
/** Selects the fixture's markdown files, so a check over it always has violations. */
export const MD_ROWS = "SELECT path FROM resource_realizations WHERE ext = '.md'";
/** Selects nothing, so a check over it is a clean pass. */
export const TXT_ROWS = "SELECT path FROM resource_realizations WHERE ext = '.txt'";
export const RUN_INTEGRITY = 'RESOURCE_CHECK_BROKEN';

/** One declared check: its name, statement and (optional) severity. */
type CheckSpec = readonly [name: string, sql: string, severity?: 'error' | 'warning' | 'info'];

/**
 * Write `resources:` with the given checks (none → a block with no `checks`), plus `extra` verbatim
 * at the top level.
 */
export function writeConfig(dir: string, checks: readonly CheckSpec[], extra = ''): void {
  const body = checks.length === 0
    ? 'resources: {}\n'
    : 'resources:\n  checks:\n' + checks.map(([name, sql, severity]) =>
      `    ${name}:\n      description: ${name}\n      sql: "${sql}"\n`
      + (severity === undefined ? '' : `      severity: ${severity}\n`)).join('');
  fs.writeFileSync(safePath.join(dir, 'vibe-agent-toolkit.config.yaml'), extra + body, 'utf-8');
}

export interface PhaseEntry {
  name: string;
  status: string;
  examined?: number;
  summary?: Record<string, number>;
  error?: { code: string; message: string };
  data: Record<string, unknown> | null;
}

export interface Finding {
  code: string;
  message: string;
  severity: string;
}

export interface Run {
  status: number | null;
  stderr: string;
  findings: Finding[];
  /** The whole published document. */
  document: Record<string, unknown>;
  /** The document's own `data` — a standalone `vat resources check` report's. */
  data: Record<string, unknown>;
  phases: PhaseEntry[];
  error: { code: string; message: string } | undefined;
  elapsedMs: number;
}

/**
 * Run `vat <args>` in `cwd` with `extra` added to the environment of BOTH processes. An extra
 * `NODE_OPTIONS` is APPENDED to the ambient one, never substituted for it: the runner's own
 * options (a heap size, a loader) must reach the processes under test too.
 */
export function vat(cwd: string, args: readonly string[], extra: NodeJS.ProcessEnv = {}): Run {
  const startedAt = Date.now();
  const nodeOptions = [process.env['NODE_OPTIONS'], extra['NODE_OPTIONS']].filter((part) => part !== undefined && part !== '').join(' ');
  const env = { ...process.env, ...extra, ...(nodeOptions === '' ? {} : { NODE_OPTIONS: nodeOptions }) };
  const result = executeCli(BIN_PATH, [...args], { cwd, env });
  const doc = (yaml.parse(result.stdout) ?? {}) as Record<string, unknown>;
  const data = (doc['data'] ?? {}) as Record<string, unknown>;
  return {
    status: result.status,
    stderr: result.stderr,
    findings: (doc['findings'] ?? []) as Finding[],
    document: doc,
    data,
    phases: (data['phases'] ?? []) as PhaseEntry[],
    error: doc['error'] as Run['error'],
    elapsedMs: Date.now() - startedAt,
  };
}

/** The checks phase's entry, failing loudly when the run has none. */
export function checksPhase(run: Run): PhaseEntry {
  const phase = run.phases.find((entry) => entry.name === 'checks');
  if (phase === undefined) throw new Error(`no checks phase in ${JSON.stringify(run.phases.map((p) => p.name))}\n${run.stderr}`);
  return phase;
}

/** The names of the checks a document's `data.checks` lists. */
export function checkNames(data: Record<string, unknown> | null): string[] {
  return ((data?.['checks'] ?? []) as Array<{ name: string }>).map((check) => check.name);
}

/** Each check a document's `data.checks` lists, as `name:rows` — what it selected, not what it cost. */
export function checkRows(data: Record<string, unknown> | null): string[] {
  return ((data?.['checks'] ?? []) as Array<{ name: string; rows?: number }>).map((check) => `${check.name}:${String(check.rows)}`);
}

/** How many times `needle` occurs in `haystack`. */
export function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

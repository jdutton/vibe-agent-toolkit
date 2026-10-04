/**
 * The exit-code matrix's path-shaped outcomes: the verbs that take a path as
 * WHERE TO LOOK, the refusal each publishes when nothing can be examined under
 * it, and the runners that lock a path and expect the refusal.
 *
 * Shared by the three `exit-code-matrix-path-*.system.test.ts` files. Each of
 * them runs EVERY verb of {@link PATH_VERBS} for one outcome — the split is by
 * outcome, so no verb is left to one file and there is no slice to get wrong.
 * {@link MATRIX_PATH_OUTCOMES} names the outcomes, and the whole-table file
 * asserts the path files on disk are exactly those.
 */

import { chmodSync, existsSync } from 'node:fs';

import { ExitCode, type RefusalCode } from '@vibe-agent-toolkit/schema';
import { mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';
import { expect } from 'vitest';

import { executeCli } from './cli-runner.js';
import { expectErrorDocument, MATRIX_BIN_PATH, matrixTempDir, ragDb, READABLE, SKILLS_INSTALL_FLAGS, UNREADABLE } from './exit-code-matrix.js';

/**
 * The outcomes the path files run, one file each
 * (`exit-code-matrix-path-<outcome>.system.test.ts`). A path file moved away
 * runs nothing and fails nothing by itself, so `exit-code-matrix.system.test.ts`
 * compares this list with the files on disk, both ways.
 */
export const MATRIX_PATH_OUTCOMES = ['missing', 'unlistable', 'untraversable'] as const;

/** A path-outcome spec file's name; the capture is its outcome. */
export const MATRIX_PATH_FILE = /^exit-code-matrix-path-(.+)\.system\.test\.ts$/;

/**
 * The refusal each ENVELOPE verb among {@link PATH_VERBS} publishes for the two
 * outcomes — keyed by the registry's verb name and asserted both ways in
 * `exit-code-matrix-path-missing.system.test.ts`, so a verb that turns `report`
 * must add its row here.
 */
export const PATH_REFUSALS: Readonly<Record<string, { readonly missing: RefusalCode; readonly unreadable: RefusalCode }>> = {
  audit: { missing: 'USAGE_INVALID', unreadable: 'INPUT_UNREADABLE' },
  'audit settings': { missing: 'USAGE_INVALID', unreadable: 'INPUT_UNREADABLE' },
  'resources check': { missing: 'USAGE_INVALID', unreadable: 'INPUT_UNREADABLE' },
  'resources query': { missing: 'USAGE_INVALID', unreadable: 'INPUT_UNREADABLE' },
  'resources scan': { missing: 'USAGE_INVALID', unreadable: 'INPUT_UNREADABLE' },
  'resources validate': { missing: 'USAGE_INVALID', unreadable: 'INPUT_UNREADABLE' },
  'skill review': { missing: 'USAGE_INVALID', unreadable: 'INPUT_UNREADABLE' },
  'skills validate': { missing: 'USAGE_INVALID', unreadable: 'INPUT_UNREADABLE' },
  'skills build': { missing: 'USAGE_INVALID', unreadable: 'INPUT_UNREADABLE' },
  'skills package': { missing: 'USAGE_INVALID', unreadable: 'INPUT_UNREADABLE' },
  'claude marketplace validate': { missing: 'USAGE_INVALID', unreadable: 'INPUT_UNREADABLE' },
  'agent validate': { missing: 'USAGE_INVALID', unreadable: 'INPUT_UNREADABLE' },
  'skills list': { missing: 'USAGE_INVALID', unreadable: 'INPUT_UNREADABLE' },
  'skills install': { missing: 'USAGE_INVALID', unreadable: 'INPUT_UNREADABLE' },
  'agent import': { missing: 'USAGE_INVALID', unreadable: 'INPUT_UNREADABLE' },
  'rag index': { missing: 'USAGE_INVALID', unreadable: 'INPUT_UNREADABLE' },
  inventory: { missing: 'USAGE_INVALID', unreadable: 'INPUT_UNREADABLE' },
};

/**
 * Every document verb whose path argument is WHERE TO LOOK — a root to scan, a
 * project to locate, a subject to review. A path that names nothing, and a
 * directory the OS will not list, are the same OUTCOME in all of them.
 *
 * ⚠️ `vat claude context [paths...]` is not here, and not by oversight: its
 * paths are QUESTIONS ("what loads at X?"), not a root, and a path the
 * projection never realized is answered with a `kind: unknown` document at exit
 * 0 by design. Whether an unanswerable question should end on 2 is a separate
 * decision about that verb, not this outcome.
 */
export const PATH_VERBS: ReadonlyArray<{ readonly verb: string; readonly args: (path: string) => string[] }> = [
  { verb: 'resources validate', args: (path) => ['resources', 'validate', path] },
  { verb: 'resources scan', args: (path) => ['resources', 'scan', path] },
  { verb: 'resources check', args: (path) => ['resources', 'check', path] },
  { verb: 'resources query', args: (path) => ['resources', 'query', 'SELECT 1', path] },
  { verb: 'audit', args: (path) => ['audit', path] },
  // `--file` names the one document to examine: absent is the invocation's mistake, unreadable is the input's.
  { verb: 'audit settings', args: (path) => ['audit', 'settings', '--file', path] },
  { verb: 'skills validate', args: (path) => ['skills', 'validate', path] },
  { verb: 'skills build', args: (path) => ['skills', 'build', path] },
  // The SKILL.md (or its directory) to package: checked before the project root, since it is the argument.
  { verb: 'skills package', args: (path) => ['skills', 'package', path, '-o', safePath.join(matrixTempDir(), 'package-path-out')] },
  { verb: 'skill review', args: (path) => ['skill', 'review', path, '--yaml'] },
  { verb: 'claude marketplace validate', args: (path) => ['claude', 'marketplace', 'validate', path] },
  { verb: 'agent validate', args: (path) => ['agent', 'validate', path] },
  { verb: 'skills list', args: (path) => ['skills', 'list', path] },
  // The source to install: a directory the OS will not list cannot be looked into for a SKILL.md.
  { verb: 'skills install', args: (path) => ['skills', 'install', path, ...SKILLS_INSTALL_FLAGS] },
  // The SKILL.md to convert: a directory, listable or not, cannot be read as one.
  { verb: 'agent import', args: (path) => ['agent', 'import', path] },
  // The root to crawl; `--db` so the database path is never what refuses.
  { verb: 'rag index', args: (path) => ['rag', 'index', path, '--db', ragDb('path-verb')] },
  // The subject to inventory: a plugin, marketplace or install directory, or a SKILL.md.
  { verb: 'inventory', args: (path) => ['inventory', path] },
];

/**
 * Run `verb` over `target` with `locked` made unreadable, and expect the verb's
 * `unreadable` refusal at exit 2. The mode is restored either way.
 */
export function expectUnreadableRefusal(verb: string, args: (path: string) => string[], target: string, locked: string): void {
  mkdirSyncReal(target, { recursive: true });
  chmodSync(locked, UNREADABLE);
  try {
    const result = executeCli(MATRIX_BIN_PATH, args(target), { cwd: matrixTempDir() });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(ExitCode.ERROR);
    expectErrorDocument(result.stdout, PATH_REFUSALS[verb]?.unreadable);
  } finally {
    chmodSync(locked, READABLE);
  }
}

/**
 * Run `args` in a directory holding only a `vibe-agent-toolkit.config.yaml` made
 * by `makeConfig`, and expect `INPUT_UNREADABLE` at exit 2. The mode is restored either way.
 */
export function expectConfigRefusal(name: string, args: readonly string[], makeConfig: (configPath: string) => void): void {
  const cwd = safePath.join(matrixTempDir(), name);
  mkdirSyncReal(cwd, { recursive: true });
  const configPath = safePath.join(cwd, 'vibe-agent-toolkit.config.yaml');
  makeConfig(configPath);
  try {
    const result = executeCli(MATRIX_BIN_PATH, [...args], { cwd });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(ExitCode.ERROR);
    expectErrorDocument(result.stdout, 'INPUT_UNREADABLE');
  } finally {
    if (existsSync(configPath)) chmodSync(configPath, READABLE);
  }
}

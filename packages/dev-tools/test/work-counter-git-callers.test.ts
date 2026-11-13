/**
 * Every git process a shipped package starts is counted as `git.calls`.
 *
 * Git is reached through `@vibe-validate/git`, and of what it exports two calls
 * start git: `executeGitCommand` and `getGitTreeSnapshot`. Every other route
 * (`runGit`, `getToolVersion('git')`) funnels into the first, so it is counted
 * once, there; a count at the outer call would count it twice.
 *
 * So every module in a shipped package that imports `@vibe-validate/git`, by
 * any spelling (an alias, a namespace, a re-export, a dynamic import), is held
 * here in exactly one of two lists: a counted spawn site, or a module listed
 * with exactly the names it imports, none of which starts git. A new importer
 * fails until it is listed; a listed module that no longer imports fails until
 * it is delisted. A namespace or dynamic import cannot be told apart from a
 * spawn, so it must be a counted spawn site.
 *
 * Out of scope: private packages (the lab, dev-tools, the test agents) and test
 * helpers, which never run in an adopter's process.
 */

import { readFileSync } from 'node:fs';

import { resolveFromImportMeta, safePath } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import { packageSources } from './package-sources.js';

/** The package every git spawn goes through. */
const GIT_PACKAGE = '@vibe-validate/git';

/** The names it exports that start git. */
const SPAWNING_NAMES: ReadonlySet<string> = new Set(['executeGitCommand', 'getGitTreeSnapshot']);

/** What an import that names no binding imports: a namespace, a re-export of everything, a dynamic import. */
const WHOLE_MODULE = '*';

/** The modules that start git, each counting it. */
const GIT_SPAWN_SITES = ['packages/utils/src/git-run.ts', 'packages/utils/src/git-snapshot.ts'];

/** Modules that import the package without starting git, with exactly the names they import. */
const NON_SPAWNING_IMPORTERS: Readonly<Record<string, readonly string[]>> = {};

/** The count each spawn site must make. */
const GIT_COUNT = "countWork('git.calls', 1)";

const REPO_ROOT = resolveFromImportMeta(import.meta.url, '..', '..', '..');

/** The package as a quoted module specifier, in either quote. */
const SPECIFIERS = [`'${GIT_PACKAGE}'`, `"${GIT_PACKAGE}"`];

/**
 * The names one import or export clause takes from the package, by their
 * exported spelling: `{ a as b }` takes `a`.
 *
 * @param clause - The text between `import`/`export` and `from`, whitespace collapsed
 * @returns The exported names, or {@link WHOLE_MODULE}
 */
function namesOfClause(clause: string): string[] {
  const open = clause.indexOf('{');
  const close = clause.indexOf('}');
  if (open === -1 || close < open) return [WHOLE_MODULE];
  const named = clause
    .slice(open + 1, close)
    .split(',')
    .map((part) => (part.trim().startsWith('type ') ? part.trim().slice('type '.length) : part.trim()))
    .map((part) => part.split(' as ')[0]?.trim() ?? '')
    .filter((name) => name !== '');
  // A default binding beside the braces is the module's default export.
  const before = clause.slice(0, open).trim();
  return before === '' || before === 'type' ? named : [...named, 'default'];
}

/**
 * The clause of one statement that imports or re-exports from the package, or
 * `null` when it does not.
 *
 * @param statement - Source text up to (not including) a `;`, whitespace collapsed
 * @returns The text between the keyword (and any `type`) and `from`
 */
function staticClause(statement: string): string | null {
  const from = SPECIFIERS.map((specifier) => ` from ${specifier}`).find((tail) => statement.endsWith(tail));
  if (from === undefined) return null;
  const head = statement.slice(0, -from.length);
  const keyword = Math.max(head.lastIndexOf('import '), head.lastIndexOf('export '));
  if (keyword === -1) return null;
  return head.slice(keyword + 'import '.length).trim();
}

/**
 * Every name a source takes from the package, sorted, or `null` when it does
 * not import it.
 *
 * @param source - One module's text
 * @returns The names, or `null`
 */
function gitPackageImports(source: string): string[] | null {
  const names = new Set<string>();
  for (const raw of source.split(';')) {
    const statement = raw.replaceAll(/\s+/gu, ' ').replaceAll('{ ', '{').trim();
    const clause = staticClause(statement);
    if (clause !== null) for (const name of namesOfClause(clause)) names.add(name);
    const dynamic = SPECIFIERS.some((specifier) =>
      ['import(', 'require('].some((call) => statement.includes(`${call}${specifier})`)),
    );
    if (dynamic) names.add(WHOLE_MODULE);
  }
  return names.size === 0 ? null : [...names].sort((a, b) => a.localeCompare(b));
}

/**
 * @param file - A repo-relative source path under `packages/<dir>/src/`
 * @returns Whether its package is published
 */
function isShipped(file: string): boolean {
  const dir = /^packages\/([^/]+)\//u.exec(file)?.[1] ?? '';
  const manifest = JSON.parse(readFileSync(safePath.join(REPO_ROOT, 'packages', dir, 'package.json'), 'utf-8')) as {
    private?: boolean;
  };
  return manifest.private !== true;
}

/** @returns Whether the file is a test helper that ships beside runtime code */
function isTestHelper(file: string): boolean {
  return file.includes('/src/testing/') || file.endsWith('/src/testing.ts') || file.includes('test-helpers');
}

/** @returns Whether any of `names` may start git */
function maySpawn(names: readonly string[]): boolean {
  return names.some((name) => name === WHOLE_MODULE || SPAWNING_NAMES.has(name));
}

describe('what a module takes from the git package', () => {
  it.each([
    ["import { executeGitCommand } from '@vibe-validate/git';", ['executeGitCommand']],
    ["import { executeGitCommand as run, GIT_MODE_SYMLINK } from '@vibe-validate/git';", ['executeGitCommand', 'GIT_MODE_SYMLINK']],
    ["import {\n  getGitTreeSnapshot as snap,\n} from \"@vibe-validate/git\";", ['getGitTreeSnapshot']],
    ["import * as git from '@vibe-validate/git';", ['*']],
    ["export { executeGitCommand as run } from '@vibe-validate/git';", ['executeGitCommand']],
    ["export * from '@vibe-validate/git';", ['*']],
    ["const git = await import('@vibe-validate/git');", ['*']],
    ["import type { GitRunOptions } from '@vibe-validate/git';", ['GitRunOptions']],
    ["import { executeGitCommand } from '@vibe-validate/git-other';", null],
  ] as const)('%s', (source, expected) => {
    expect(gitPackageImports(source)).toEqual(expected);
  });
});

describe('git calls in shipped packages', () => {
  const sources = packageSources();
  const importers = new Map(
    [...sources]
      .filter(([file]) => isShipped(file) && !isTestHelper(file))
      .map(([file, source]) => [file, gitPackageImports(source)] as const)
      .filter((entry): entry is readonly [string, string[]] => entry[1] !== null),
  );

  it('lists every importer once, as a spawn site or a non-spawning module, and nothing else', () => {
    const listed = [...GIT_SPAWN_SITES, ...Object.keys(NON_SPAWNING_IMPORTERS)].sort((a, b) => a.localeCompare(b));
    expect([...importers.keys()].sort((a, b) => a.localeCompare(b))).toEqual(listed);
  });

  it.each(GIT_SPAWN_SITES)('%s may start git, and counts each one', (file) => {
    expect(maySpawn(importers.get(file) ?? [])).toBe(true);
    expect(sources.get(file)).toContain(GIT_COUNT);
  });

  it('holds each non-spawning module to exactly its listed names, none that starts git', () => {
    for (const [file, names] of Object.entries(NON_SPAWNING_IMPORTERS)) {
      expect(importers.get(file), file).toEqual([...names].sort((a, b) => a.localeCompare(b)));
      expect(maySpawn(names), file).toBe(false);
    }
  });
});

/**
 * Helpers `eslint.config.js` builds its ignores and its build guard from, and that
 * `typecheck-task.js` shares the same build guard through, kept apart so they can be unit-tested
 * without loading every plugin (`packages/dev-tools/test/eslint-config-support.test.ts`). Only
 * `workspacePackages()` and `missingDeclaredTypes()` read the filesystem, resolved against this
 * file; every other helper takes the text or the lister it needs.
 * Types: `eslint-config-support.d.ts`.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';

/**
 * The repository's ignore files. `generate-lint-config.ts --check` asserts this list equals the
 * tracked `.gitignore` files and that both lint tasks hash every one of them.
 */
export const IGNORE_FILES = ['.gitignore', 'packages/dev-tools/corpus/compat-empirical/run/.gitignore'];

/**
 * One ignore file's patterns as flat-config ignores, so ESLint never lints a file turbo does not
 * hash (turbo hashes only what git does not ignore). It follows gitignore's anchoring: a pattern
 * with a slash before its end is relative to the ignore file's directory, one without matches at
 * any depth, a trailing slash means the directory's contents, and `!` re-includes.
 *
 * @param {string} text - The ignore file's contents
 * @param {string} ignoreFile - Its repo-relative path, forward-slashed
 * @returns {string[]}
 */
export function gitignorePatterns(text, ignoreFile) {
  const base = ignoreFile.includes('/') ? ignoreFile.slice(0, ignoreFile.lastIndexOf('/') + 1) : '';
  return text.split(/\r?\n/).flatMap((raw) => {
    // A `#` starts a comment only at the start of a line in an ignore file.
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) return [];
    const negated = line.startsWith('!');
    let pattern = negated ? line.slice(1) : line;
    const dirOnly = pattern.endsWith('/');
    if (dirOnly) pattern = pattern.slice(0, -1);
    const anchored = pattern.includes('/');
    pattern = anchored ? `${base}${pattern.replace(/^\//, '')}` : `${base}**/${pattern}`;
    const globs = dirOnly ? [`${pattern}/**`] : [pattern, `${pattern}/**`];
    return globs.map((glob) => (negated ? `!${glob}` : glob));
  });
}

/**
 * Every `types` value in a manifest: the top-level field and each one under `exports`, at any
 * depth. A wildcard (`./dist/*.d.ts`) names no one file to check, so it is refused.
 *
 * @param {Record<string, unknown>} manifest - A parsed `package.json`
 * @param {string} where - The manifest's path, for the refusal
 * @returns {string[]}
 */
export function declaredTypesFiles(manifest, where) {
  const found = typeof manifest.types === 'string' ? [manifest.types] : [];
  const visit = (node) => {
    if (node === null || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node)) {
      if (key === 'types' && typeof value === 'string') found.push(value);
      else visit(value);
    }
  };
  visit(manifest.exports);
  const wildcard = found.find((types) => types.includes('*'));
  if (wildcard !== undefined) {
    throw new Error(`${where} declares a wildcard types path (${wildcard}). The lint build guard checks that each declared types file exists, and a wildcard names no one file: list each subpath export, or teach declaredTypesFiles() in eslint-config-support.js to expand it.`);
  }
  return [...new Set(found)];
}

/**
 * Why a cached lint or typecheck task must not run, or `undefined` when it may.
 *
 * Both tasks check a program against the workspace's emitted declarations and turbo keys both on
 * those declarations, so a run over a missing or stale `dist/` would type against `any` or an old
 * signature and be cached as a pass. One signal says the declarations are fresh: the root `lint`,
 * `lint:fix` and `typecheck` scripts set `VAT_BUILT=1` only after `turbo run build`. A package's
 * `lint` script sets `VAT_LINT_TASK=1` so that only the cached task is refused: an editor, a direct
 * `eslint` run and a test that loads the config set neither signal. Every typecheck task runs
 * through `typecheck-task.js`, so it is always the cached task.
 *
 * @param {'lint' | 'typecheck'} task - The task asking
 * @param {Record<string, string | undefined>} env - The process environment
 * @param {() => string[]} listMissingTypes - Repo-relative declared types files that do not exist
 * @returns {string | undefined}
 */
export function programTaskRefusal(task, env, listMissingTypes) {
  if (task === 'lint' && env.VAT_LINT_TASK !== '1') return undefined;
  const rootScript = task === 'lint' ? '`bun run lint` (or `bun run lint:fix`)' : '`bun run typecheck`';
  if (env.VAT_BUILT !== '1') {
    return `A ${task} task reads workspace types from dist/ and is cached on them, so it runs only after a build: run ${rootScript} from the repo root, which builds first.`;
  }
  const missing = listMissingTypes();
  if (missing.length > 0) {
    return `A ${task} task reads workspace types from dist/, and these are not built: ${missing.join(', ')}. Run ${rootScript} from the repo root, which builds first.`;
  }
  return undefined;
}

/**
 * Every workspace package: its directory under `packages/` and its manifest name.
 *
 * @returns {Array<{ dir: string, name: string }>}
 */
export function workspacePackages() {
  // 🪤 Resolved against THIS FILE, never against the cwd. `readdirSync('packages')`
  // is relative to wherever the process was started, so any invocation from inside a
  // package — `turbo run lint`, which sets cwd to the package it is linting —
  // died with `ENOENT: scandir 'packages'` before linting a line. Not a finding
  // and not a lint error: a config load failure, exit 2, in every package.
  //
  // A `URL` rather than a `path.join`: this file is subject to the `no-raw-node-path`
  // rule, and a relative `URL` needs no exemption to be correct on Windows either.
  const packagesDir = new URL('packages/', import.meta.url);
  return readdirSync(packagesDir, { withFileTypes: true })
    // Followed inline (this file cannot import the utils helper): a workspace
    // package reached through a link is still a package with a name to guard.
    .filter((entry) => (entry.isSymbolicLink() ? statSync(new URL(`${entry.name}/`, packagesDir)).isDirectory() : entry.isDirectory()))
    .flatMap((entry) => {
      const manifest = new URL(`${entry.name}/package.json`, packagesDir);
      if (!existsSync(manifest)) return [];
      const { name } = JSON.parse(readFileSync(manifest, 'utf8'));
      if (typeof name !== 'string' || name.length === 0) return [];
      return [{ dir: entry.name, name }];
    });
}

/**
 * Every declared `types` file of every workspace package that does not exist, repo-relative.
 *
 * @returns {string[]}
 */
export function missingDeclaredTypes() {
  return workspacePackages().flatMap(({ dir }) => {
    const where = `packages/${dir}/package.json`;
    const manifest = JSON.parse(readFileSync(new URL(where, import.meta.url), 'utf8'));
    return declaredTypesFiles(manifest, where)
      .filter((types) => !existsSync(new URL(`packages/${dir}/${types}`, import.meta.url)))
      .map((types) => `packages/${dir}/${types.replace(/^\.\//, '')}`);
  });
}

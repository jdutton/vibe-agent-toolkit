/**
 * Every package source file, read from the tree, for the structure tests that
 * hold a convention over all of `packages/＊/src`.
 */

import { readFileSync } from 'node:fs';

import { isPathAbsentError, resolveFromImportMeta, safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';
import { crawlDirectorySync } from '@vibe-agent-toolkit/utils/crawl';

/** The repository root. */
const REPO_ROOT = resolveFromImportMeta(import.meta.url, '..', '..', '..');

/** The TypeScript sources every convention test holds a rule over. */
const TYPESCRIPT_SOURCES = ['packages/*/src/**/*.ts'] as const;

/**
 * Every file a shipping package loads at runtime: the TypeScript sources plus
 * their CommonJS and ESM variants, and the ESLint rules `utils` ships on its
 * `./eslint` subpath, which live outside `src`. Gitignored build output (the
 * generated `vendor/typescript.cjs`) is never crawled: the crawl answers from
 * git, which ignores it.
 */
const SHIPPING_CODE = [
  ...TYPESCRIPT_SOURCES,
  'packages/*/src/**/*.{cts,mts,cjs,mjs,js}',
  'packages/utils/eslint/**/*.{ts,cts,mts,cjs,mjs,js}',
] as const;

/** The sources, once read per glob set — see {@link packageSources}. */
const read = new Map<readonly string[], ReadonlyMap<string, string>>();

/** @returns The files `include` matches, read once per test file */
function sourcesOnce(include: readonly string[]): ReadonlyMap<string, string> {
  let sources = read.get(include);
  if (sources === undefined) {
    sources = readSources(include);
    read.set(include, sources);
  }
  return sources;
}

/**
 * Every package TypeScript source file, repo-relative, with its text. Untracked
 * files count (a new file is held before it is committed); a tracked file
 * deleted but not yet committed is skipped — the crawl answers from git's index.
 *
 * Read once per test file: the tree does not change while a file runs, and the
 * crawl plus a read of every source is the bulk of a caller's cost.
 *
 * @returns Repo-relative forward-slash path → file text
 */
export function packageSources(): ReadonlyMap<string, string> {
  return sourcesOnce(TYPESCRIPT_SOURCES);
}

/**
 * {@link packageSources}, widened to every code file a package ships: `.cts`,
 * `.mts`, `.cjs`, `.mjs` and `.js` in `src`, and `utils`' ESLint rules. For a
 * boundary over what a shipped file LOADS, where a `require` in a `.cjs` rule is
 * as much a load as an `import` in a `.ts` module.
 *
 * @returns Repo-relative forward-slash path → file text
 */
export function shippingCodeSources(): ReadonlyMap<string, string> {
  return sourcesOnce(SHIPPING_CODE);
}

/** @returns Repo-relative forward-slash path → file text, read from the tree now */
function readSources(include: readonly string[]): ReadonlyMap<string, string> {
  const files = crawlDirectorySync({
    outputs: [],
    baseDir: REPO_ROOT,
    include: [...include],
    includeUntracked: true,
    absolute: false,
    unreadable: { refuse: { root: REPO_ROOT, remedy: 'Fix the directory permissions and re-run.', side: 'source' } },
  });
  const out = new Map<string, string>();
  for (const file of files) {
    try {
      out.set(toForwardSlash(file), readFileSync(safePath.join(REPO_ROOT, file), 'utf-8'));
    } catch (error) {
      if (!isPathAbsentError(error)) throw error;
    }
  }
  return out;
}

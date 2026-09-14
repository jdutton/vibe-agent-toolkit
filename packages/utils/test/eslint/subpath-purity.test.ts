/**
 * `./eslint` reaches nothing outside itself except the two Node builtins its
 * entry point needs to list its own directory — and above all not `eslint`.
 *
 * That is the property the whole "ship the rules as a subpath instead of a separate
 * package" decision rests on. An ESLint plugin is data: each rule module exports a
 * plain object, and ESLint calls into it. Nothing in the pack ever loads ESLint. So
 * the twelve *runtime* subpaths keep resolving in a tree with no ESLint installed,
 * `eslint` can be an OPTIONAL peer dependency (no unmet-peer warning for consumers
 * who only wanted `safePath.join()`), and this entry adds no dependency to the
 * package. Let one `require('eslint')` in — for a type, for `RuleTester`, for
 * anything — and all three of those stop being true at once.
 *
 * Two halves, pinned separately. The RULE modules reach nothing at all — a rule
 * that read a `package.json` would be a rule that requires `node:fs`, and that
 * is why `no-self-package-import` takes its package name as an option. The
 * ENTRY POINT reaches exactly `node:fs` and `node:path`, because the manifest is
 * the directory listing (see `index.cjs`); two builtins that ship with every
 * Node install cost the optional-peer property nothing.
 *
 * `test/subpath-purity.test.ts` cannot see this: it walks TypeScript `import ... from`
 * statements under `src/`, and these are hand-written `.cjs` files outside it. Same
 * contract, different parser.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { resolveFromImportMeta } from '../../src/fs.js';
import { safePath } from '../../src/path.js';
import { stripCommentLines } from '../test-helpers.js';

const eslintDir = resolveFromImportMeta(import.meta.url, '..', '..', 'eslint');

/**
 * `require('x')` and `import('x')`, ignoring anything inside a comment line.
 *
 * `import()` is in here deliberately even though nothing uses it today. Dynamic
 * import is legal in CommonJS and is exactly what a rule author reaching for
 * ESLint's types or `RuleTester` at runtime would write — a `require`-only
 * matcher would let that through while still reporting an empty external set,
 * i.e. the guard would go green precisely when its claim became false.
 */
const MODULE_SPECIFIER = /(?:require|import)\(\s*['"]([^'"]+)['"]\s*\)/gu;

interface Reached {
  /** Every non-relative specifier: `node:*` builtins and bare package names alike. */
  external: Set<string>;
  /** Every `.cjs` file actually visited, so the walk can be proven non-trivial. */
  visited: Set<string>;
}

/**
 * Walk the pack's `require()` graph from its entry point.
 *
 * An unresolvable relative specifier is a hard error rather than a skip: a walker
 * that silently drops edges returns an empty `external` set and makes the
 * assertions below pass vacuously.
 */
function walkRequireGraph(entryPath: string): Reached {
  const external = new Set<string>();
  const visited = new Set<string>();
  const queue = [entryPath];

  while (queue.length > 0) {
    const current = queue.pop();
    if (current === undefined || visited.has(current)) continue;
    visited.add(current);

    if (!existsSync(current)) {
      throw new Error(`eslint subpath walker could not resolve module: ${current}`);
    }
    const source = stripCommentLines(readFileSync(current, 'utf8'));

    for (const match of source.matchAll(MODULE_SPECIFIER)) {
      const specifier = match[1];
      if (specifier === undefined) continue;
      if (specifier.startsWith('.')) {
        queue.push(safePath.join(safePath.resolve(current, '..'), specifier));
      } else {
        external.add(specifier);
      }
    }
  }

  return { external, visited };
}

const rulesDir = safePath.join(eslintDir, 'rules');
const ruleFiles = readdirSync(rulesDir).filter((f) => f.endsWith('.cjs'));

/** The union of every rule module's require graph — the whole pack minus its entry point. */
function walkEveryRule(): Reached {
  const external = new Set<string>();
  const visited = new Set<string>();
  for (const file of ruleFiles) {
    const reached = walkRequireGraph(safePath.join(rulesDir, file));
    for (const specifier of reached.external) external.add(specifier);
    for (const module of reached.visited) visited.add(module);
  }
  return { external, visited };
}

const reached = walkEveryRule();
const entry = walkRequireGraph(safePath.join(eslintDir, 'index.cjs'));

describe('the ./eslint subpath reaches nothing outside itself', () => {
  it('rule modules require no external module at all', () => {
    expect([...reached.external].sort((a, b) => a.localeCompare(b))).toEqual([]);
  });

  it('the entry point requires exactly the two builtins that list the directory', () => {
    expect([...entry.external].sort((a, b) => a.localeCompare(b))).toEqual(['node:fs', 'node:path']);
  });

  // Stated separately from the blanket assertions above because this is the one
  // that would break the optional peer dependency, and a future reader should see
  // why it is called out rather than assume the empty set was incidental.
  it('never requires eslint itself', () => {
    expect(reached.external.has('eslint')).toBe(false);
    expect(entry.external.has('eslint')).toBe(false);
  });
});

describe('the walker actually walked (negative controls)', () => {
  /**
   * Pinned to the directory listing, not a floor.
   *
   * `toBeGreaterThan(20)` would have let five rule modules fall out of the pack
   * and stayed green. The entry point discovers rules by listing the directory,
   * so a static walker cannot follow that edge; the walk is seeded from every
   * `.cjs` under `rules/` instead, and equality says the seeds reached exactly
   * themselves and each other — nothing outside `rules/`, nothing missing.
   */
  it('reaches every .cjs file in the pack, and nothing else', () => {
    expect(reached.visited.size).toBe(ruleFiles.length);
    expect(reached.visited.size).toBeGreaterThan(10);
  });

  // `no-unix-shell-commands` require()s the factory lazily, inside `create()`.
  // A line-anchored or top-of-file-only scanner would miss that edge entirely.
  it('follows a require() nested inside a function body', () => {
    expect([...reached.visited].some((file) => file.endsWith('no-command-direct-factory.cjs'))).toBe(true);
  });

  it('throws rather than silently skipping an unresolvable require', () => {
    expect(() => walkRequireGraph(safePath.join(eslintDir, 'does-not-exist.cjs'))).toThrow(
      /could not resolve module/u,
    );
  });
});

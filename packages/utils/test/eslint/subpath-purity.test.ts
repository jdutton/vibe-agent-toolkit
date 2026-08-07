/**
 * `./eslint` reaches nothing — not a Node builtin, not a third-party package, and
 * above all not `eslint` itself.
 *
 * That is the property the whole "ship the rules as a subpath instead of a separate
 * package" decision rests on. An ESLint plugin is data: each module here exports a
 * plain object, and ESLint calls into it. Nothing in the pack ever loads ESLint. So
 * the twelve *runtime* subpaths keep resolving in a tree with no ESLint installed,
 * `eslint` can be an OPTIONAL peer dependency (no unmet-peer warning for consumers
 * who only wanted `safePath.join()`), and this entry adds no dependency to the
 * package. Let one `require('eslint')` in — for a type, for `RuleTester`, for
 * anything — and all three of those stop being true at once.
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

    // eslint-disable-next-line security/detect-non-literal-fs-filename -- paths derived from eslintDir
    if (!existsSync(current)) {
      throw new Error(`eslint subpath walker could not resolve module: ${current}`);
    }
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- paths derived from eslintDir
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

const reached = walkRequireGraph(safePath.join(eslintDir, 'index.cjs'));

describe('the ./eslint subpath reaches nothing outside itself', () => {
  it('requires no external module at all', () => {
    expect([...reached.external].sort((a, b) => a.localeCompare(b))).toEqual([]);
  });

  // Stated separately from the blanket assertion above because this is the one
  // that would break the optional peer dependency, and a future reader should see
  // why it is called out rather than assume the empty set was incidental.
  it('never requires eslint itself', () => {
    expect(reached.external.has('eslint')).toBe(false);
  });
});

describe('the walker actually walked (negative controls)', () => {
  /**
   * Pinned to the directory listing, not a floor.
   *
   * `toBeGreaterThan(20)` would have let five rule modules fall out of `index.cjs`
   * and stayed green — and, worse, said nothing about a module that ships in the
   * tarball while being reachable from nothing. Equality catches both directions:
   * a rule dropped from the registry, and an orphan left behind by a rename.
   */
  it('reaches every .cjs file in the pack, and the pack ships nothing unreachable', () => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path derived from eslintDir
    const ruleFiles = readdirSync(safePath.join(eslintDir, 'rules')).filter((f) => f.endsWith('.cjs'));
    expect(reached.visited.size).toBe(ruleFiles.length + 1); // + index.cjs
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

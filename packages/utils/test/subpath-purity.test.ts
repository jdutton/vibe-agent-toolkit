import { existsSync, readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { resolveFromImportMeta } from '../src/fs.js';
import { safePath } from '../src/path.js';

import { stripCommentLines } from './test-helpers.js';

const srcDir = resolveFromImportMeta(import.meta.url, '..', 'src');

/** Everything an entry module's transitive source graph pulls in from outside itself. */
interface ReachedModules {
  /** `node:*` builtins, verbatim (`node:fs/promises` stays distinct from `node:fs`). */
  builtins: Set<string>;
  /** Bare specifiers reduced to their package name (`@scope/pkg/sub` → `@scope/pkg`). */
  thirdParty: Set<string>;
}

const IMPORT_SPECIFIER = /from\s+'([^']+)'/gu;

/** `picomatch` → `picomatch`; `@scope/pkg/sub` → `@scope/pkg`. Not a filesystem path. */
const PACKAGE_NAME = /^(@[^/]+\/[^/]+|[^/]+)/u;

function packageNameOf(specifier: string): string {
  return PACKAGE_NAME.exec(specifier)?.[1] ?? specifier;
}

/**
 * Collect every `node:*` builtin AND every third-party package reachable from an
 * entry module's source graph.
 *
 * Walks top-level `from '...'` specifiers transitively through relative imports,
 * mapping the emitted `.js` extension back to the `.ts` source. Any relative
 * specifier that does not resolve to a real source file is a hard error rather
 * than a silent skip — a walker that quietly drops edges returns an empty set
 * and makes every purity assertion below pass vacuously. (`test/fixtures/
 * dangling-import/entry.ts` exercises that throw, so the guarantee is
 * demonstrated rather than merely asserted in a comment.)
 *
 * Bare specifiers are collected rather than dropped: builtin-only purity says
 * nothing about whether an entry is installable in an environment where the
 * package's dependencies are absent, which is the property the README's
 * "Resolves with zero deps installed?" column claims.
 */
function collectReachedModules(entryPath: string): ReachedModules {
  const builtins = new Set<string>();
  const thirdParty = new Set<string>();
  const seen = new Set<string>();
  const queue = [entryPath];

  while (queue.length > 0) {
    const current = queue.pop();
    if (current === undefined || seen.has(current)) continue;
    seen.add(current);

    // eslint-disable-next-line security/detect-non-literal-fs-filename -- paths derived from srcDir
    if (!existsSync(current)) {
      throw new Error(`subpath-purity walker could not resolve source file: ${current}`);
    }
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- paths derived from srcDir
    const source = stripCommentLines(readFileSync(current, 'utf8'));

    for (const match of source.matchAll(IMPORT_SPECIFIER)) {
      const specifier = match[1];
      if (specifier === undefined) continue;

      if (specifier.startsWith('node:')) {
        builtins.add(specifier);
      } else if (specifier.startsWith('.')) {
        const resolved = safePath.join(safePath.resolve(current, '..'), specifier);
        queue.push(resolved.replace(/\.js$/u, '.ts'));
      } else {
        thirdParty.add(packageNameOf(specifier));
      }
    }
  }

  return { builtins, thirdParty };
}

/** Reached modules for a `src/` entry, in deterministic order for equality assertions. */
function reachedFromEntry(entryFile: string): { builtins: string[]; thirdParty: string[] } {
  const reached = collectReachedModules(safePath.join(srcDir, entryFile));
  const sort = (values: Set<string>): string[] =>
    [...values].sort((a, b) => a.localeCompare(b));
  return { builtins: sort(reached.builtins), thirdParty: sort(reached.thirdParty) };
}

describe('pure subpath entries reach no Node builtin', () => {
  it.each(['zod.ts', 'yaml.ts', 'template-entry.ts'])(
    '%s has an empty node: builtin set',
    (entry) => {
      expect(reachedFromEntry(entry).builtins).toEqual([]);
    },
  );

  // `path.ts` and `glob.ts` legitimately reach `node:path` — both re-export from
  // `path-core.ts`, whose sole import is `node:path`. What must never appear here
  // is `node:fs`, `node:os`, or `node:url`.
  it.each(['path.ts', 'glob.ts'])('%s reaches node:path and nothing else', (entry) => {
    expect(reachedFromEntry(entry).builtins).toEqual(['node:path']);
  });
});

/**
 * The README's "Resolves with zero deps installed?" column is a claim about
 * third-party reach, not builtin reach. Every `yes` row below is an entry whose
 * expected third-party set is `[]`; asserting the exact set (rather than only
 * "is it empty") means adding a dependency to a *non*-portable entry also has to
 * be a deliberate, reviewed edit.
 */
describe('every subpath entry reaches exactly the third-party packages the README documents', () => {
  it.each([
    { entry: 'path.ts', thirdParty: [] },
    { entry: 'zod.ts', thirdParty: [] },
    { entry: 'glob.ts', thirdParty: [] },
    { entry: 'fs.ts', thirdParty: [] },
    { entry: 'testing.ts', thirdParty: [] },
    { entry: 'asset.ts', thirdParty: [] },
    // The reason this entry exists: dependency-free, unlike the `.` barrel that
    // was briefly its only route. If this row ever gains a package, the entry has
    // lost its purpose rather than merely gained a dependency.
    { entry: 'project.ts', thirdParty: [] },
    { entry: 'yaml.ts', thirdParty: ['yaml'] },
    { entry: 'template-entry.ts', thirdParty: ['handlebars'] },
    { entry: 'process.ts', thirdParty: ['which'] },
    { entry: 'git.ts', thirdParty: ['ignore', 'which'] },
    { entry: 'crawl.ts', thirdParty: ['picomatch', 'which'] },
    { entry: 'index.ts', thirdParty: ['handlebars', 'ignore', 'picomatch', 'which', 'yaml'] },
  ])('$entry reaches $thirdParty', ({ entry, thirdParty }) => {
    expect(reachedFromEntry(entry).thirdParty).toEqual(thirdParty);
  });
});

describe('the walker actually detects what it claims to (negative controls)', () => {
  it('finds node:fs and node:os reachable from fs.ts', () => {
    const { builtins } = reachedFromEntry('fs.ts');
    expect(builtins).toContain('node:fs');
    expect(builtins).toContain('node:os');
  });

  // If bare specifiers were dropped (the bug this collector was extended to fix),
  // every third-party expectation above would be trivially satisfiable by `[]`.
  it('finds picomatch reachable from crawl.ts', () => {
    expect(reachedFromEntry('crawl.ts').thirdParty).toContain('picomatch');
  });

  // The "cannot pass vacuously" guarantee, exercised rather than asserted: a graph
  // with an edge the walker cannot follow must fail loudly, not return a small set.
  it('throws rather than silently skipping an unresolvable relative import', () => {
    const dangling = resolveFromImportMeta(
      import.meta.url,
      'fixtures',
      'dangling-import',
      'entry.ts',
    );
    expect(() => collectReachedModules(dangling)).toThrow(/could not resolve source file/u);
  });
});

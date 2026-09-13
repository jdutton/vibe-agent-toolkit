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

/**
 * Every shape that puts a module edge into a source file.
 *
 * ⛔ This used to be `/from\s+'([^']+)'/gu`, which saw ONE of them. It was blind
 * to `await import('pkg')`, to a bare `import 'pkg'` side-effect edge, and to
 * every double-quoted specifier — so the exact trap this repo has already
 * recorded ("a lazy import defers evaluation, not installation, so the wasm
 * runtime still ships to every rag adopter") walked straight through the gate
 * built to stop it, and the walker would have reported the entry pure.
 *
 * `\b(?:from|import|require)` then `[\s(]*` then the quote: one unnested
 * quantifier, so there is no backtracking to pay for. `export … from` is covered
 * by `from`; `import.meta.url` is not, because `.` is not in `[\s(]`.
 */
const IMPORT_SPECIFIER = /\b(?:from|require|import)[\s(]*['"]([^'"]+)['"]/gu;

/**
 * The character set a module specifier is drawn from.
 *
 * Admitting double quotes made the matcher reach prose it never saw before:
 * `fs-utils.ts` builds the message `(referenced from "${referrer}")`, whose
 * `from "…"` is textually an import edge and semantically a sentence. Screening
 * the CAPTURE rather than narrowing the matcher keeps every real shape in scope
 * — no specifier may contain `$`, a brace, a space or a backslash, so nothing
 * screened out here could have been an edge.
 */
const MODULE_SPECIFIER = /^[\w@./:~+-]+$/u;

/** `picomatch` → `picomatch`; `@scope/pkg/sub` → `@scope/pkg`. Not a filesystem path. */
const PACKAGE_NAME = /^(@[^/]+\/[^/]+|[^/]+)/u;

function packageNameOf(specifier: string): string {
  return PACKAGE_NAME.exec(specifier)?.[1] ?? specifier;
}

/**
 * Collect every `node:*` builtin AND every third-party package reachable from an
 * entry module's source graph.
 *
 * Walks every specifier {@link IMPORT_SPECIFIER} recognises — static, dynamic,
 * side-effect and re-export, in either quote style — transitively through
 * relative imports, mapping the emitted `.js` extension back to the `.ts`
 * source. (`test/fixtures/import-shapes/entry.ts` carries one edge of each
 * shape, so the breadth is exercised rather than claimed.) Any relative
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
      if (specifier === undefined || !MODULE_SPECIFIER.test(specifier)) continue;

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

/** Deterministic order, so the sets below can be asserted by equality. */
function sorted(values: Set<string>): string[] {
  return [...values].sort((a, b) => a.localeCompare(b));
}

/** Reached modules for a `src/` entry, in deterministic order for equality assertions. */
function reachedFromEntry(entryFile: string): { builtins: string[]; thirdParty: string[] } {
  const reached = collectReachedModules(safePath.join(srcDir, entryFile));
  return { builtins: sorted(reached.builtins), thirdParty: sorted(reached.thirdParty) };
}

describe('pure subpath entries reach no Node builtin', () => {
  // `text.ts` is here BY DESIGN, not by accident: `decodeTextContent` decides
  // what bytes say and never fetches them, so bytes from a git blob, an HTTP
  // body or a zip entry decode through the same function as bytes from disk. The
  // read-a-file half deliberately lives on `./fs` instead. If this row ever gains
  // a builtin, that split has been undone.
  it.each(['zod.ts', 'yaml.ts', 'text.ts'])(
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
/** The git package `runGit` wraps; reached by every entry that can run git. */
const VV_GIT = '@vibe-validate/git';

describe('every subpath entry reaches exactly the third-party packages the README documents', () => {
  it.each([
    { entry: 'path.ts', thirdParty: [] },
    { entry: 'zod.ts', thirdParty: [] },
    { entry: 'text.ts', thirdParty: [] },
    { entry: 'glob.ts', thirdParty: [] },
    { entry: 'fs.ts', thirdParty: [] },
    { entry: 'testing.ts', thirdParty: [] },
    { entry: 'asset.ts', thirdParty: [] },
    // The reason this entry exists: dependency-free, unlike the `.` barrel that
    // was briefly its only route. If this row ever gains a package, the entry has
    // lost its purpose rather than merely gained a dependency.
    { entry: 'project.ts', thirdParty: [] },
    { entry: 'yaml.ts', thirdParty: ['yaml'] },
    // `@vibe-validate/git` arrived on these four with `runGit`, which is now a
    // wrapper over that package's `executeGitCommand`. Note `which` LEAVING
    // `git.ts` and `crawl.ts` in the same change: those entries used to resolve
    // the git binary themselves, and no longer run git at all except through
    // `runGit`. An entry regaining `which` here means a second spawn route has
    // reappeared, which is the thing that chokepoint exists to prevent.
    { entry: 'process.ts', thirdParty: [VV_GIT, 'which'] },
    { entry: 'git.ts', thirdParty: [VV_GIT, 'ignore'] },
    { entry: 'crawl.ts', thirdParty: [VV_GIT, 'picomatch'] },
    // Declares no dependency of its own — it inherits both by spawning through
    // `./process`. That is why it is a subpath: reachability is the criterion,
    // not the import a module happens to write.
    { entry: 'skill-test/index.ts', thirdParty: [VV_GIT, 'which'] },
    // ⛔ THE ROW THAT MUST STAY EMPTY. Every other row above says "this entry
    // costs its consumer these packages"; this one says the entry with ~245
    // in-repo importers plus published adopters costs them NOTHING. A package
    // appearing here is not a test to update — it is a domain that has leaked
    // back onto the barrel and needs its own entry, the way `./skill-test`
    // did. An approved-list cannot express that, which is why this is `[]`
    // asserted by equality rather than a set of blessed names.
    { entry: 'index.ts', thirdParty: [] },
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

  /**
   * The detector itself, exercised on one edge of every shape.
   *
   * The rows above can only be trusted to the extent the walker can SEE an edge.
   * With the old `/from\s+'([^']+)'/gu` this fixture reported one package out of
   * five: a bare side-effect import, a double-quoted import, and both dynamic
   * `import()` forms were invisible — and a lazy dynamic import is exactly how a
   * heavy optional runtime ends up installed for every adopter while the entry
   * still looks pure.
   *
   * `node:crypto` is the transitive half: it is reachable only THROUGH the
   * `export … from` edge, so its presence proves the walker followed that edge
   * instead of merely logging its specifier.
   */
  it('sees a module edge of every shape, and no sentence that looks like one', () => {
    const entry = resolveFromImportMeta(
      import.meta.url,
      'fixtures',
      'import-shapes',
      'entry.ts',
    );
    const reached = collectReachedModules(entry);

    expect(sorted(reached.thirdParty)).toEqual([
      'cjs-required-pkg',
      'double-quoted-pkg',
      'dynamic-double-pkg',
      'dynamic-single-pkg',
      'side-effect-pkg',
    ]);
    expect(sorted(reached.builtins)).toEqual(['node:crypto']);
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

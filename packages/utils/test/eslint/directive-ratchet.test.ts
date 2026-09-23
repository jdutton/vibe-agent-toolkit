/**
 * A ceiling on live `eslint-disable` directives, per rule, over every package's `src`.
 *
 * `reportUnusedDisableDirectives` prevents STALE directives, but nothing
 * bounded LIVE ones — which is how one rule reached 1,352 before it was turned
 * off. This test turns the residue into a one-way door: every rule that is
 * disabled anywhere in `src` has a stored ceiling below, asserted BOTH ways.
 *
 * - A count above its ceiling fails: a new suppression has to be argued for by
 *   raising the number here, in a diff a reviewer sees, beside the reason.
 * - A count BELOW its ceiling also fails: a suppression that went away must
 *   take its ceiling down with it, so the number can never drift back up for
 *   free. The list may only shrink.
 * - A rule disabled in `src` with no entry here fails: an unlisted rule is a
 *   new suppression vocabulary, and the first one is the moment to decide
 *   whether it belongs at all.
 *
 * Counted over the WORKING TREE as git sees it — tracked plus untracked and
 * not ignored, minus deleted — the way `comment-density.ts` lists its files.
 * The index alone was tried first: it made every new `src` file invisible
 * until staged, so the ceilings were seeded without three untracked files'
 * directives and the pre-commit hook's unit tier failed four cases the moment
 * `git add -A` ran. An IGNORED scratch file still cannot move the numbers.
 * Over `src` only: the test tier has its own relaxations in `eslint.config.js`
 * and its directives are fixture-shaped.
 */

import { existsSync, readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { resolveFromImportMeta } from '../../src/fs.js';
import { runGit } from '../../src/git-run.js';
import { safePath } from '../../src/path.js';

const REPO_ROOT = resolveFromImportMeta(import.meta.url, '..', '..', '..', '..');

/**
 * Today's counts, measured by this test's own `countDirectives` on the day the
 * ratchet landed. Lower an entry when its count drops; raise one only with a
 * reason in the diff; delete it at zero.
 */
const CEILINGS: Readonly<Record<string, number>> = {
  '@typescript-eslint/await-thenable': 1,
  '@typescript-eslint/explicit-module-boundary-types': 6,
  '@typescript-eslint/no-explicit-any': 24,
  '@typescript-eslint/no-non-null-assertion': 1,
  '@typescript-eslint/no-require-imports': 1,
  '@typescript-eslint/prefer-nullish-coalescing': 2,
  'import/order': 1,
  'local/no-bare-dynamic-import-path': 1,
  'local/no-bare-symlink-in-tests': 3,
  // `failure-reason.ts`: a property read that throws IS "declared nothing";
  // reason inline at the directive.
  'local/no-blind-catch': 2,
  // The two lexical helpers the rule points every caller at, plus the one
  // import-specifier classifier that is not a containment check at all.
  'local/no-dotdot-containment': 3,
  // +1 each: `clean-build.ts` is the build script of `utils` itself and
  // cannot import the wrappers from a `dist/` it has not produced.
  'local/no-fs-mkdirSync': 5,
  // +3: two in `claude-context-rules.ts` split `paths:` globs, whose separator
  // is the gitignore dialect's `/` on every host — and a `\` there is an
  // ESCAPE, so normalising it would change the glob; one in `builtin-checks.ts`
  // splits a `realization_conditions.path`, forward-slashed by `relativize()`.
  'local/no-hardcoded-path-split': 12,
  // `path-core.ts`: `toForwardSlashAnyPlatform` is the converter the rule's
  // autofix writes, so its own body is the one hand-rolled replace.
  'local/no-manual-path-normalize': 1,
  'local/no-path-startswith': 11,
  'local/no-raw-node-path': 2,
  'local/no-raw-text-decode': 6,
  'local/no-unsafe-root-join': 2,
  // `installed-plugins-registry.ts`: Claude Code's own format number, an
  // external fact. The reason is inline at the directive.
  'local/no-version-literal': 1,
  'max-depth': 1,
  'no-void': 1,
  'security/detect-child-process': 1,
  // `generate-tsconfig-refs.ts`: assembled from a module constant, never input.
  'security/detect-non-literal-regexp': 21,
  'security/detect-possible-timing-attacks': 1,
  'security/detect-unsafe-regex': 10,
  'sonarjs/cognitive-complexity': 2,
  'sonarjs/deprecation': 3,
  'sonarjs/different-types-comparison': 1,
  'sonarjs/disabled-auto-escaping': 1,
  'sonarjs/function-return-type': 3,
  'sonarjs/no-alphabetical-sort': 1,
  'sonarjs/no-nested-functions': 1,
  'sonarjs/no-os-command-from-path': 1,
  'sonarjs/pseudo-random': 4,
  'sonarjs/regex-complexity': 2,
  'sonarjs/unused-import': 4,
  'sonarjs/void-use': 1,
  'unicorn/prefer-structured-clone': 5,
};

/** `// eslint-disable…` or `/* eslint-disable…` — a directive, as opposed to prose that mentions one. */
const DIRECTIVE_OPENER = /(?:\/\/|\/\*)\s*eslint-disable(?:-next-line|-line)?\s/u;

/**
 * The rules a directive line names, or `[]` when the line is not a directive
 * (or is a bare `eslint-disable` naming none). The `-- reason` and a closing
 * block-comment marker are dropped; parsed by hand rather than with one regex
 * because the "rest of line, minus an optional suffix" shape backtracks.
 */
function rulesNamedOn(line: string): string[] {
  const opener = DIRECTIVE_OPENER.exec(line);
  if (!opener) return [];
  let rest = line.slice(opener.index + opener[0].length);
  const reason = rest.indexOf(' --');
  if (reason !== -1) rest = rest.slice(0, reason);
  const close = rest.indexOf('*/');
  if (close !== -1) rest = rest.slice(0, close);
  return rest.split(',').map((name) => name.trim()).filter((name) => name.length > 0 && !name.startsWith('--'));
}

/** `git ls-files -z <args>` over the package `src` trees, as repo-relative paths. */
function gitListing(args: readonly string[]): string[] {
  const { stdout } = runGit(['ls-files', '-z', ...args, '--', 'packages/*/src/**'], { cwd: REPO_ROOT, trim: false });
  return stdout.split('\0').filter((rel) => rel.length > 0);
}

/** Every source file under a package `src` directory in the working tree, repo-relative. */
function workingTreeSrcFiles(): string[] {
  const deleted = new Set(gitListing(['--deleted']));
  return gitListing(['--cached', '--others', '--exclude-standard'])
    .filter((line) => /\.(?:ts|cts|mts|js|cjs|mjs)$/u.test(line))
    // Deleted but not yet staged (a rename mid-flight) is not a file to count.
    .filter((line) => !deleted.has(line) && existsSync(safePath.join(REPO_ROOT, line)));
}

/** `rule -> number of directive lines naming it`, over the given files. */
export function countDirectives(files: readonly string[], readFile: (path: string) => string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const file of files) {
    for (const line of readFile(file).split('\n')) {
      for (const rule of rulesNamedOn(line)) {
        counts.set(rule, (counts.get(rule) ?? 0) + 1);
      }
    }
  }
  return counts;
}

describe('countDirectives', () => {
  const read = (contents: Record<string, string>) => (path: string): string => contents[path] ?? '';

  it('counts every rule named on a directive line, once per line', () => {
    const counts = countDirectives(['a.ts'], read({
      'a.ts': [
        '// eslint-disable-next-line x/one -- reason',
        '/* eslint-disable x/one, y/two -- reason */',
        'const a = 1; // eslint-disable-line y/two -- reason',
        '// eslint-enable x/one',
        '// a comment that mentions eslint-disable in prose',
      ].join('\n'),
    }));
    expect([...counts.entries()].sort(([a], [b]) => a.localeCompare(b))).toStrictEqual([['x/one', 2], ['y/two', 2]]);
  });

  it('ignores a bare eslint-disable that names no rule', () => {
    expect(countDirectives(['a.ts'], read({ 'a.ts': '/* eslint-disable */' })).size).toBe(0);
  });
});

describe('eslint-disable directives in package src trees are ratcheted per rule', () => {
  const files = workingTreeSrcFiles();
  const counts = countDirectives(files, (file) => readFileSync(safePath.join(REPO_ROOT, file), 'utf8'));

  it('counted a non-trivial population', () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it.each(Object.entries(CEILINGS))('%s stays at its ceiling of %i', (rule, ceiling) => {
    const actual = counts.get(rule) ?? 0;
    expect(actual, `${rule}: ${actual} directives, ceiling ${ceiling} — raise the ceiling with a reason, or lower it to match`).toBe(ceiling);
  });

  it('every disabled rule has a ceiling', () => {
    const unlisted = [...counts.keys()].filter((rule) => !(rule in CEILINGS)).sort((a, b) => a.localeCompare(b));
    expect(unlisted, 'a rule disabled in src with no ceiling above').toStrictEqual([]);
  });

  it('every ceiling names a rule that is still disabled somewhere', () => {
    const stale = Object.keys(CEILINGS).filter((rule) => !counts.has(rule)).sort((a, b) => a.localeCompare(b));
    expect(stale, 'a ceiling whose rule is no longer disabled anywhere — delete it').toStrictEqual([]);
  });
});

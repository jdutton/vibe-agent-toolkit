/**
 * A gate on VAT's OWN packaged output.
 *
 * Every other check in `bun run validate` reasons about SOURCE. Nothing compared
 * BUILT OUTPUT against a baseline, so a packager or rewriter change could silently
 * rewrite every shipped file and all 14 steps stayed green. That is not
 * hypothetical — two defects shipped through a fully-green validate:
 *
 *  1. An unanchored inline-link regex let a stray unpaired `[` in prose start a
 *     match that ran to the NEXT link, DELETING ~200 characters of prose from
 *     `vat-skill-distribution`'s shipped SKILL.md.
 *  2. The strip template rendered `{{link.text}}`, which `transformContent` reads
 *     from an href-keyed "first occurrence wins" map, so a second link sharing an
 *     href shipped the FIRST link's text — `vat-skill-review` shipped "See cached
 *     guidance for a cached copy" where the author wrote the filename.
 *
 * Both were found by hand, by building `dist` at HEAD~, snapshotting, rebuilding,
 * and diffing. This test makes that ritual automatic: the golden trees under
 * `test/golden/<package>/skills/` are the reviewed, expected packaged output, and
 * any change to them must show up as a reviewable diff in the pull request that
 * causes it.
 *
 * **This test asserts nothing about whether the output is GOOD** — only that it is
 * what a human last approved. A drift failure is a prompt to read the diff, not
 * automatically a bug. When the change is intended, regenerate and review:
 *
 *     UPDATE_DRIFT_GOLDEN=1 bun run test:system
 *
 * ## What this gate covers, and the two holes that were closed
 *
 * It originally compared `SKILL.md` and nothing else, and `continue`d past a skill
 * whose built `SKILL.md` was absent. Both were blind spots the link rewriter fits
 * through exactly:
 *
 *  - **Whole tree, not one file.** A bundle is a directory. The rewriter's most
 *    interesting work — rewriting `../SKILL.md` and sibling-reference links inside
 *    a bundled `resources/*.md` — happens in files that are not `SKILL.md`. Every
 *    packaged file's bytes are compared, AND the set of files itself: a file that
 *    stops shipping and a file that newly appears are both drift.
 *  - **An absent build FAILS.** `continue` on a missing path meant a bundle that
 *    failed to build, got renamed, or was dropped from the golden set reported
 *    GREEN — the same green-without-running shape this repo keeps meeting. No built
 *    tree is now a failure that names the build command, and no golden tree is a
 *    failure that says the bundle is unreviewed. The file's ONLY remaining skip is
 *    `skipIf(UPDATING)`, and it skips the comparisons in the one mode where they
 *    would compare a copy against its own source.
 *
 * ## Why two packages, and why both goldens live here
 *
 * `vat-development-agents` ships 13 skills that are each a lone `SKILL.md`;
 * `vat-example-cat-agents` is the repo's ONLY multi-file bundle (a `SKILL.md` plus
 * three bundled `resources/*.md`), so it is the only place in the tree where the
 * rewriter rewrites a link in a non-`SKILL.md` packaged file. A gate on the
 * rewriter that cannot see that bundle is a gate on nothing. Its golden lives here,
 * under this test's own fixture directory, because the gate — not the example
 * package — is what owns the baseline.
 *
 * ## Line endings: compared byte-exact, on purpose
 *
 * `.gitattributes` pins `* text=auto eol=lf` and `*.md text eol=lf`, so both the
 * authored sources the packager reads and the golden files it is compared against
 * are LF on every platform including Windows. Nothing here normalizes EOLs before
 * comparing: normalizing would make this gate blind to a packaging rewriter that
 * emits CRLF or mixed endings, which is a live open finding, and it is precisely
 * the class of output drift a byte gate exists to catch. To keep such a failure
 * from reading as an inscrutable diff, a difference that is ONLY line endings is
 * detected and reported as such.
 *
 * Freshness: `bun run validate` runs `bun run build` (which is `turbo run build &&
 * turbo run build:skills`, covering both packages) before any test phase, so both
 * `dist/skills` trees are current when this runs there. Run standalone against a
 * stale `dist/` and you are comparing the golden against whatever was built last —
 * the test fails closed if a `dist/` is missing entirely, but it cannot detect
 * staleness, so build first if you are running it on its own.
 */
/* eslint-disable security/detect-non-literal-fs-filename -- Every path is derived from
   this file's own URL and a directory listing under it; nothing is caller-controlled. */
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { compareCodeUnits, mkdirSyncReal, safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';
import { beforeAll, describe, expect, it } from 'vitest';

/** Package root — two levels up from `test/system/`. */
const PACKAGE_ROOT = toForwardSlash(fileURLToPath(new URL('../../', import.meta.url)));
/** The monorepo's `packages/` directory, so a sibling package's `dist/` is reachable. */
const PACKAGES_DIR = safePath.join(PACKAGE_ROOT, '..');
const GOLDEN_ROOT = safePath.join(PACKAGE_ROOT, 'test', 'golden');

const UPDATING = process.env.UPDATE_DRIFT_GOLDEN === '1';
const itUnlessUpdating = it.skipIf(UPDATING);

/** One packaged bundle tree under this gate. */
interface GoldenBundle {
  /** Directory name under `packages/`, and the golden subdirectory name. */
  readonly pkg: string;
  /** Why this package is in the gate — read this before deleting an entry. */
  readonly covers: string;
}

const BUNDLES: readonly GoldenBundle[] = [
  { pkg: 'vat-development-agents', covers: '13 single-file skills (the dogfood plugin)' },
  {
    pkg: 'vat-example-cat-agents',
    covers: "the repo's only MULTI-FILE bundle — the only packaged non-SKILL.md files the rewriter touches",
  },
];

const BUILD_HINT =
  'Build first:\n' +
  '    bun run build\n' +
  '(that is `turbo run build && turbo run build:skills`, which covers both packages;\n' +
  ' `bun run validate` does it for you before the test phases.)';

const UPDATE_HINT =
  'If this change is INTENDED, regenerate the golden and review the diff as part of your PR:\n' +
  '    UPDATE_DRIFT_GOLDEN=1 bun run test:system\n' +
  'If it is NOT intended, a packager/rewriter change altered shipped bundle content.';

function builtSkillsDirFor(bundle: GoldenBundle): string {
  return safePath.join(PACKAGES_DIR, bundle.pkg, 'dist', 'skills');
}

function goldenSkillsDirFor(bundle: GoldenBundle): string {
  return safePath.join(GOLDEN_ROOT, bundle.pkg, 'skills');
}

/**
 * Every file under `root`, as forward-slash paths relative to it, in code-unit
 * order. Code-unit and not `localeCompare`: the ordering is compared across
 * machines, and collation is locale-dependent (see `compareCodeUnits`).
 */
function filesUnder(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { recursive: true, encoding: 'utf-8' })
    .map((entry) => toForwardSlash(entry))
    .filter((rel) => fs.statSync(safePath.join(root, rel)).isFile())
    .sort(compareCodeUnits);
}

/** CR/LF census, so an EOL-only difference reports a number instead of a shrug. */
function eolCensus(text: string): string {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const cr = (text.match(/\r/g) ?? []).length - crlf;
  const lf = (text.match(/\n/g) ?? []).length - crlf;
  return `${crlf} CRLF, ${lf} bare LF, ${cr} bare CR`;
}

/** First differing line with two lines of leading context, rendered as a diff. */
function renderHunk(goldenLines: string[], builtLines: string[], at: number): string[] {
  const context = goldenLines.slice(Math.max(0, at - 2), at).map((line) => `      ${line}`);
  return [
    ...context,
    `    - ${goldenLines[at] ?? '<end of golden — built has extra lines>'}`,
    `    + ${builtLines[at] ?? '<end of built — golden has extra lines>'}`,
  ];
}

/**
 * A difference a human can act on: how many lines moved, and the first one shown
 * as a `-golden / +built` hunk. An EOL-only difference is called out by name so a
 * Windows red is attributable instead of mysterious.
 */
function describeDifference(golden: string, built: string): string {
  if (golden.replaceAll('\r\n', '\n') === built.replaceAll('\r\n', '\n')) {
    return (
      '    differs ONLY in line endings — the content is identical.\n' +
      `      golden: ${eolCensus(golden)}\n` +
      `      built:  ${eolCensus(built)}\n` +
      '    `.gitattributes` pins `*.md text eol=lf`, so both sides should be pure LF on every\n' +
      '    platform. A CRLF here means the PACKAGER wrote it, not the checkout.'
    );
  }

  const goldenLines = golden.split('\n');
  const builtLines = built.split('\n');
  const max = Math.max(goldenLines.length, builtLines.length);
  const differing: number[] = [];
  for (let i = 0; i < max; i++) {
    if (goldenLines[i] !== builtLines[i]) differing.push(i);
  }
  if (differing.length === 0) {
    return `    ${golden.length} golden bytes vs ${built.length} built bytes, identical line-by-line (trailing bytes differ)`;
  }

  const first = differing[0] ?? 0;
  return [
    `    ${differing.length} line(s) differ; first at line ${first + 1} (- golden, + built):`,
    ...renderHunk(goldenLines, builtLines, first),
  ].join('\n');
}

/** A `-`/`+` listing of a file-set change, so the reader sees the paths, not a count. */
function renderPathList(heading: string, marker: string, paths: readonly string[]): string {
  if (paths.length === 0) return '';
  const lines = paths.map((rel) => `    ${marker} ${rel}`);
  return `  ${heading}\n${lines.join('\n')}`;
}

/** Mirror the built tree into the golden tree; refuse to delete anything. */
function regenerateGolden(builtDir: string, goldenDir: string): void {
  const built = filesUnder(builtDir);
  for (const rel of built) {
    const target = safePath.join(goldenDir, rel);
    mkdirSyncReal(safePath.join(target, '..'), { recursive: true });
    fs.copyFileSync(safePath.join(builtDir, rel), target);
  }

  // A file that stops shipping must drop out of the golden too, or it lingers
  // forever as coverage of output nobody produces. Refuse to delete it here: a
  // deletion is the one edit that silently REMOVES coverage, so it stays a
  // deliberate human act with a git diff behind it.
  const stale = filesUnder(goldenDir).filter((rel) => !built.includes(rel));
  if (stale.length > 0) {
    throw new Error(
      `Golden holds ${stale.length} file(s) the build no longer produces:\n` +
        stale.map((rel) => `  ${goldenDir}/${rel}`).join('\n') +
        '\nDelete them by hand — this test will not remove files.',
    );
  }
}

describe.each(BUNDLES)('packaged output drift: $pkg (system)', (bundle) => {
  const builtDir = builtSkillsDirFor(bundle);
  const goldenDir = goldenSkillsDirFor(bundle);

  beforeAll(() => {
    if (UPDATING && fs.existsSync(builtDir)) regenerateGolden(builtDir, goldenDir);
  });

  it('has a BUILT bundle tree to compare — an absent build fails, it does not skip', () => {
    expect(
      fs.existsSync(builtDir),
      `No built skills at ${builtDir} (${bundle.pkg} covers: ${bundle.covers}).\n` +
        'This test compares BUILT output, so an absent build is a FAILURE, not a skip:\n' +
        'a bundle that fails to build, gets renamed, or is dropped would otherwise report green.\n' +
        BUILD_HINT,
    ).toBe(true);
    expect(filesUnder(builtDir).length, `the build produced no files under ${builtDir}.\n${BUILD_HINT}`).toBeGreaterThan(
      0,
    );
  });

  // `skipIf(UPDATING)`, and nowhere else in this file, is the ONLY skip: under
  // UPDATE_DRIFT_GOLDEN=1 the golden was just overwritten from the build, so
  // comparing them would assert that a copy equals its source. Every other absence
  // — no build, no golden — is a failure.
  itUnlessUpdating('has a REVIEWED golden tree — an unreviewed bundle fails, it does not skip', () => {
    expect(
      filesUnder(goldenDir).length,
      `No golden recorded at ${goldenDir} (${bundle.pkg} covers: ${bundle.covers}).\n` +
        'Its packaged output is therefore UNREVIEWED and this gate would be blind to it.\n' +
        UPDATE_HINT,
    ).toBeGreaterThan(0);
  });

  itUnlessUpdating('ships exactly the files the golden records', () => {
    const built = filesUnder(builtDir);
    const golden = filesUnder(goldenDir);

    const missing = golden.filter((rel) => !built.includes(rel));
    const unexpected = built.filter((rel) => !golden.includes(rel));
    const report = [
      renderPathList('STOPPED SHIPPING (golden has, build does not):', '-', missing),
      renderPathList('NEWLY SHIPPING (build has, golden does not):', '+', unexpected),
    ]
      .filter(Boolean)
      .join('\n');

    expect(
      { missing, unexpected },
      `Packaged file SET changed for ${bundle.pkg}.\n${report}\n\n${UPDATE_HINT}`,
    ).toEqual({ missing: [], unexpected: [] });
  });

  itUnlessUpdating('ships byte-identical content for every packaged file', () => {
    const golden = filesUnder(goldenDir);
    const drifted: string[] = [];

    for (const rel of filesUnder(builtDir)) {
      if (!golden.includes(rel)) continue; // reported by the file-SET assertion above
      const goldenBytes = fs.readFileSync(safePath.join(goldenDir, rel));
      const builtBytes = fs.readFileSync(safePath.join(builtDir, rel));
      if (goldenBytes.equals(builtBytes)) continue;
      drifted.push(`  ${rel}:\n${describeDifference(goldenBytes.toString('utf-8'), builtBytes.toString('utf-8'))}`);
    }

    expect(
      drifted,
      `Packaged content drifted for ${bundle.pkg}.\n\n${drifted.join('\n\n')}\n\n${UPDATE_HINT}`,
    ).toEqual([]);
  });
});

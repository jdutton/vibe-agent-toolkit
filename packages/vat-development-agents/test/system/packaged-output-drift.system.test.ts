/**
 * A gate on VAT's OWN packaged output.
 *
 * Every other check in `bun run validate` reasons about SOURCE. Nothing compared
 * BUILT OUTPUT against a baseline, so a packager or rewriter change could silently
 * rewrite every shipped SKILL.md and all 14 steps stayed green. That is not
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
 * and diffing. This test makes that ritual automatic: the golden tree under
 * `test/golden/skills/` is the reviewed, expected packaged output, and any change
 * to it must show up as a reviewable diff in the pull request that causes it.
 *
 * **This test asserts nothing about whether the output is GOOD** — only that it is
 * what a human last approved. A drift failure is a prompt to read the diff, not
 * automatically a bug. When the change is intended, regenerate and review:
 *
 *     UPDATE_DRIFT_GOLDEN=1 bun run test:system
 *
 * Freshness: `bun run validate` runs the dogfood `vat build` before any test phase,
 * so `dist/` is current when this runs there. Run standalone against a stale `dist/`
 * and you are comparing the golden against whatever was built last — the test fails
 * closed if `dist/` is missing entirely, but it cannot detect staleness, so build
 * first if you are running it on its own.
 */
/* eslint-disable security/detect-non-literal-fs-filename -- Every path is derived from
   this file's own URL and a directory listing under it; nothing is caller-controlled. */
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { mkdirSyncReal, safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

/** Package root — two levels up from `test/system/`. */
const PACKAGE_ROOT = toForwardSlash(fileURLToPath(new URL('../../', import.meta.url)));
const BUILT_SKILLS_DIR = safePath.join(PACKAGE_ROOT, 'dist', 'skills');
const GOLDEN_SKILLS_DIR = safePath.join(PACKAGE_ROOT, 'test', 'golden', 'skills');

const UPDATING = process.env.UPDATE_DRIFT_GOLDEN === '1';

/** The packaged file every skill has, and the one all known drift has landed in. */
const SKILL_FILE = 'SKILL.md';

/** Skill names present in a directory, sorted so the comparison is order-stable. */
function skillNamesIn(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

/** First differing line, rendered with context — enough to judge a diff from CI logs. */
function firstDifference(golden: string, built: string): string {
  const goldenLines = golden.split('\n');
  const builtLines = built.split('\n');
  const max = Math.max(goldenLines.length, builtLines.length);
  for (let i = 0; i < max; i++) {
    if (goldenLines[i] !== builtLines[i]) {
      return [
        `first difference at line ${i + 1}:`,
        `  golden: ${JSON.stringify(goldenLines[i] ?? '<missing>')}`,
        `  built:  ${JSON.stringify(builtLines[i] ?? '<missing>')}`,
      ].join('\n');
    }
  }
  return 'files differ only in trailing content';
}

const UPDATE_HINT =
  'If this change is INTENDED, regenerate the golden and review the diff as part of your PR:\n' +
  '    UPDATE_DRIFT_GOLDEN=1 bun run test:system\n' +
  'If it is NOT intended, a packager/rewriter change altered shipped skill content.';

describe('packaged output drift (system)', () => {
  it('builds the dogfood skills before comparing', () => {
    expect(
      fs.existsSync(BUILT_SKILLS_DIR),
      `No built skills at ${BUILT_SKILLS_DIR}. This test compares BUILT output, so build first:\n` +
        '    bun run build\n' +
        '(`bun run validate` does this for you before the test phases.)',
    ).toBe(true);
  });

  it('ships exactly the skills the golden tree records', () => {
    const built = skillNamesIn(BUILT_SKILLS_DIR);

    if (UPDATING) {
      // A removed skill must drop out of the golden tree too, or it lingers forever.
      for (const name of skillNamesIn(GOLDEN_SKILLS_DIR)) {
        if (!built.includes(name)) {
          throw new Error(
            `Golden holds '${name}' but the build no longer produces it. ` +
              `Delete test/golden/skills/${name}/ by hand — this test will not remove files.`,
          );
        }
      }
    }

    expect(built.length, 'the dogfood build produced no skills at all').toBeGreaterThan(0);

    if (!UPDATING) {
      expect(built, `Skill set changed.\n${UPDATE_HINT}`).toEqual(skillNamesIn(GOLDEN_SKILLS_DIR));
    }
  });

  it('ships byte-identical SKILL.md content for every skill', () => {
    const drifted: string[] = [];

    for (const name of skillNamesIn(BUILT_SKILLS_DIR)) {
      const builtPath = safePath.join(BUILT_SKILLS_DIR, name, SKILL_FILE);
      if (!fs.existsSync(builtPath)) continue;
      const built = fs.readFileSync(builtPath, 'utf-8');
      const goldenPath = safePath.join(GOLDEN_SKILLS_DIR, name, SKILL_FILE);

      if (UPDATING) {
        mkdirSyncReal(safePath.join(GOLDEN_SKILLS_DIR, name), { recursive: true });
        fs.writeFileSync(goldenPath, built, 'utf-8');
        continue;
      }

      if (!fs.existsSync(goldenPath)) {
        drifted.push(`${name}: no golden recorded`);
        continue;
      }
      const golden = fs.readFileSync(goldenPath, 'utf-8');
      if (golden !== built) {
        drifted.push(`${name}: content drifted\n${firstDifference(golden, built)}`);
      }
    }

    expect(drifted, `Packaged skill content drifted.\n\n${drifted.join('\n\n')}\n\n${UPDATE_HINT}`).toEqual([]);
  });
});

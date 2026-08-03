/* eslint-disable security/detect-non-literal-fs-filename -- every path here is a temp dir the test owns */
/**
 * One agent-instruction file must produce ONE finding per `vat audit` run, no
 * matter how many skills sit above it.
 *
 * `detectPackagedAgentInstructionFiles` matches at ANY depth under the scanned
 * skill's own directory. `vat audit` guarded the one overlap it thought about —
 * a plugin's whole-subtree crawl, so a skill nested inside a plugin stands down —
 * but there was no equivalent guard for a skill nested under another SKILL, and
 * the ancestor's crawl reaches every descendant just the same. A chain of 20
 * nested skills holding one `CLAUDE.md` each produced **210 warnings for 20
 * files** (20·21/2), quadratic in nesting depth, in the `issueCounts.warnings`
 * a CI gate reads.
 *
 * The guard is CONDITIONAL on the ancestor having actually crawled, which is why
 * the last test here exists: a `repo-source` ancestor reports nothing, so
 * standing its descendants down would convert double-counting into blindness.
 */

import { writeFileSync } from 'node:fs';

import { mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, describe, expect, it } from 'vitest';

import { createTempDirTracker } from '../../system/test-common.js';
import { commitTestFixture, runAudit } from '../../test-helpers.js';

const { createTempDir, cleanupTempDirs } = createTempDirTracker('vat-nested-skill-crawl-');

const CODE = 'PACKAGED_AGENT_INSTRUCTION_FILE';

/** Depth of the nesting chain. Every extra level costs one more finding per file. */
const DEPTH = 8;

/** The committed source skill in the repo-source-ancestor fixture. */
const SOURCE_SKILL = 'source-skill';

/** Write a valid-enough SKILL.md plus the `CLAUDE.md` the crawl is meant to find. */
function placeSkillWithGuidance(dir: string, name: string): void {
  mkdirSyncReal(dir, { recursive: true });
  writeFileSync(
    safePath.join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: A fixture skill used to reproduce the nested-crawl double count.\n---\n\n# ${name}\n`,
    'utf-8',
  );
  writeFileSync(safePath.join(dir, 'CLAUDE.md'), `# guidance for ${name}\n`, 'utf-8');
}

/** `root/chain/` → `chain/nested/` → … , one skill and one CLAUDE.md per level. */
function buildNestedChain(root: string, depth: number): void {
  let dir = safePath.join(root, 'chain');
  for (let level = 1; level <= depth; level++) {
    placeSkillWithGuidance(dir, `level-${String(level)}`);
    dir = safePath.join(dir, 'nested');
  }
}

/** `root/flat/skill-N/`, siblings with no skill above them. */
function buildFlatSiblings(root: string, count: number): void {
  for (let index = 1; index <= count; index++) {
    placeSkillWithGuidance(safePath.join(root, 'flat', `skill-${String(index)}`), `flat-${String(index)}`);
  }
}

/** Every `PACKAGED_AGENT_INSTRUCTION_FILE` finding in the run, across all results. */
async function packagedFindings(
  target: string,
  options: Parameters<typeof runAudit>[1] = {},
): Promise<{ total: number; perResult: { path: string; count: number }[] }> {
  const results = await runAudit(target, options);
  const perResult = results
    .map((result) => ({
      path: result.path,
      count: result.issues.filter((issue) => issue.code === CODE).length,
    }))
    .filter((row) => row.count > 0);
  return { total: perResult.reduce((sum, row) => sum + row.count, 0), perResult };
}

describe('vat audit — agent-instruction files under nested skills', () => {
  afterEach(() => {
    cleanupTempDirs();
  });

  it('reports each file ONCE down a chain of nested skills, not once per ancestor', async () => {
    // Outside any git repository, so every tree here classifies as distributed
    // and the presence crawl actually runs.
    const root = createTempDir();
    buildNestedChain(root, DEPTH);

    const { total } = await packagedFindings(root);

    // DEPTH files, DEPTH findings. The defect produced DEPTH·(DEPTH+1)/2.
    expect(total).toBe(DEPTH);
  });

  it('attributes the whole subtree to the OUTERMOST skill, in one result', async () => {
    // Which result carries them matters as much as the count: the shallowest
    // crawl is the one that owns the subtree, exactly as a plugin's does.
    const root = createTempDir();
    buildNestedChain(root, DEPTH);

    const { perResult } = await packagedFindings(root);

    expect(perResult).toHaveLength(1);
    expect(perResult[0]?.path).toBe(safePath.join(root, 'chain', 'SKILL.md'));
    expect(perResult[0]?.count).toBe(DEPTH);
  });

  it('still reports every sibling skill when none of them is nested', async () => {
    // The control. Without it, "one finding per file" is equally satisfied by a
    // guard that silences every skill but the first one it meets anywhere.
    const root = createTempDir();
    buildFlatSiblings(root, DEPTH);

    const { total, perResult } = await packagedFindings(root);

    expect(total).toBe(DEPTH);
    expect(perResult).toHaveLength(DEPTH);
  });

  it('does NOT stand a distributed descendant down under a repo-source ancestor', async () => {
    // The ancestor is committed source, so its crawl never runs and reports
    // nothing at all. A guard that suppresses on the mere PRESENCE of an
    // ancestor SKILL.md turns this run silent — trading a double count for a
    // missed finding, which is the worse direction.
    const root = createTempDir();
    writeFileSync(safePath.join(root, '.gitignore'), 'built/\n', 'utf-8');
    placeSkillWithGuidance(safePath.join(root, SOURCE_SKILL), SOURCE_SKILL);
    commitTestFixture(root);
    placeSkillWithGuidance(safePath.join(root, SOURCE_SKILL, 'built', 'demo'), 'built-demo');

    // --include-artifacts, or the gitignored subtree is never walked at all.
    const { total, perResult } = await packagedFindings(root, { includeArtifacts: true });

    expect(total).toBe(1);
    expect(perResult[0]?.path).toBe(
      safePath.join(root, SOURCE_SKILL, 'built', 'demo', 'SKILL.md'),
    );
  });
});

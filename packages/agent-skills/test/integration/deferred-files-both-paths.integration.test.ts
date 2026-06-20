/* eslint-disable security/detect-non-literal-fs-filename -- Test code with temp directories */
import { writeFileSync } from 'node:fs';

import { mkdirSyncReal, resetProjectRootCaches, safeExecSync, normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { packageSkill } from '../../src/skill-packager.js';
import { validateSkillForPackaging } from '../../src/validators/packaging-validator.js';

// ---------------------------------------------------------------------------
// Link-code constants (string literals avoids importing internal types)
// ---------------------------------------------------------------------------

const LINK_DEFERRED_ARTIFACT = 'LINK_DEFERRED_ARTIFACT';
const LINK_MISSING_TARGET = 'LINK_MISSING_TARGET';
const LINK_TO_GITIGNORED_FILE = 'LINK_TO_GITIGNORED_FILE';
const FILES_SOURCE_GITIGNORED = 'FILES_SOURCE_GITIGNORED';

/** The set of codes we compare between source and build paths (AC-10c). */
const COMPARED_CODES = new Set([
  LINK_DEFERRED_ARTIFACT,
  LINK_MISSING_TARGET,
  LINK_TO_GITIGNORED_FILE,
  FILES_SOURCE_GITIGNORED,
]);

// ---------------------------------------------------------------------------
// Shared fixture constants
// ---------------------------------------------------------------------------

const SKILL_NAME = 'deferred-both-paths';
/** Description must be ≥50 chars to pass validation. */
const SKILL_DESC =
  'Integration harness proving source-time and build-time link validation agree on deferred artifacts.';

/**
 * files: config — source is project-root-relative, dest is skill-dir-relative.
 *
 * With skill at <root>/skills/probe/SKILL.md:
 *   source: 'build/gen/idx.json'  → resolves to <root>/build/gen/idx.json
 *   dest:   'data/idx.json'       → resolves to <root>/skills/probe/data/idx.json
 *
 * The project-root-relative dest path is therefore 'skills/probe/data/idx.json'.
 * The SKILL.md link `[index](data/idx.json)` targets that dest (deferred).
 */
const FILES_CONFIG = [{ source: 'build/gen/idx.json', dest: 'data/idx.json' }];

/**
 * Subdir where the skill lives inside the git repo.
 * This is the critical difference from the previous version of this test:
 * skillDir (skills/probe) !== projectRoot, which exercises the root-cause bug.
 */
const SKILL_SUBDIR = 'skills/probe';

// ---------------------------------------------------------------------------
// Fixture setup — a real git repo with a gitignored build artifact
// ---------------------------------------------------------------------------

interface Fixture {
  dir: string;
  skillPath: string;
}

/**
 * Build a temp git repo containing:
 *  - .gitignore  →  build/
 *  - build/gen/idx.json  (EXISTS but gitignored)
 *  - skills/probe/SKILL.md  with the given body  ← skill is in a SUBDIRECTORY
 *
 * The skill is placed in a subdirectory (skills/probe/) so skillDir !== projectRoot.
 * This exercises the root-cause of issue #127: computeDeferredPaths must resolve
 * dest paths relative to skillDir and emit project-root-relative paths so that
 * checkDeferred() in walk-link-graph can match them correctly.
 */
function buildFixture(prefix: string, skillBody: string): Fixture {
  const dir = safePath.join(normalizedTmpdir(), `${prefix}-${Date.now()}`);
  mkdirSyncReal(dir, { recursive: true });

  // Real git repo — lets `git check-ignore` run authentically.
  safeExecSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  safeExecSync('git', ['config', 'user.email', 'test@test'], { cwd: dir });
  safeExecSync('git', ['config', 'user.name', 'test'], { cwd: dir });

  writeFileSync(safePath.join(dir, '.gitignore'), 'build/\n');

  // Create the skill in a subdirectory (the key change from prior version).
  const skillDir = safePath.join(dir, SKILL_SUBDIR);
  mkdirSyncReal(skillDir, { recursive: true });

  const frontmatter = `---\nname: ${SKILL_NAME}\ndescription: "${SKILL_DESC}"\n---`;
  const skillPath = safePath.join(skillDir, 'SKILL.md');
  writeFileSync(skillPath, `${frontmatter}\n\n${skillBody}`);

  // Stage and commit .gitignore + skill SKILL.md so `git ls-files` (used by the
  // file crawler) finds them and adds them to the ResourceRegistry. Without
  // a commit, git ls-files returns an empty set and the registry stays empty,
  // which causes walkLinkGraph to skip the skill's links entirely.
  safeExecSync('git', ['add', '.gitignore', `${SKILL_SUBDIR}/SKILL.md`], { cwd: dir });
  safeExecSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir });

  // Create gitignored build artifact AFTER the initial commit so it is
  // present on disk but not tracked. The real git check-ignore will classify
  // it as ignored, exercising the C1 narrowing logic.
  mkdirSyncReal(safePath.join(dir, 'build', 'gen'), { recursive: true });
  writeFileSync(safePath.join(dir, 'build', 'gen', 'idx.json'), '{"generated":true}');

  return { dir, skillPath };
}

/**
 * Extract the subset of link-related codes from any emitted-issues array.
 * Operates only on COMPARED_CODES to make the AC-10c equality assertion precise.
 */
function extractLinkCodes(issues: ReadonlyArray<{ code: string }>): Set<string> {
  return new Set(issues.map((i) => i.code).filter((c) => COMPARED_CODES.has(c)));
}

// ---------------------------------------------------------------------------
// Per-test fixture lifecycle
// ---------------------------------------------------------------------------

interface TestContext {
  fixture: Fixture | null;
}

function makeContext(): TestContext {
  return { fixture: null };
}

// ---------------------------------------------------------------------------
// Row runner: run BOTH paths and return their code-sets
// ---------------------------------------------------------------------------

interface BothPathsResult {
  sourceCodes: Set<string>;
  buildCodes: Set<string>;
  outputPath: string;
}

async function runBothPaths(
  skillPath: string,
  outputPath: string,
): Promise<BothPathsResult> {
  // Source path — no injected gitTracker; real git check-ignore runs.
  const sourceResult = await validateSkillForPackaging(
    skillPath,
    { files: FILES_CONFIG },
    'source',
  );

  // Build path — no injected gitTracker; real git check-ignore runs.
  // packageSkill throws if a files: source does not exist — our source DOES exist (gitignored ≠ absent).
  const buildResult = await packageSkill(skillPath, {
    outputPath,
    files: FILES_CONFIG,
  });

  return {
    sourceCodes: extractLinkCodes(sourceResult.allErrors),
    buildCodes: extractLinkCodes(buildResult.postBuildIssues ?? []),
    outputPath: buildResult.outputPath,
  };
}

/**
 * Build the fixture, register it in ctx, run both validation paths, assert
 * AC-10c agreement, and return the code-sets for per-row assertions.
 *
 * Must be at module scope (satisfies local/no-test-scoped-functions).
 */
async function runRow(
  ctx: TestContext,
  prefix: string,
  skillBody: string,
): Promise<BothPathsResult> {
  const fixture = buildFixture(prefix, skillBody);
  ctx.fixture = fixture;

  const result = await runBothPaths(
    fixture.skillPath,
    safePath.join(fixture.dir, 'out'),
  );

  // AC-10c: both paths must agree on the same set of link codes.
  expect(result.sourceCodes).toEqual(result.buildCodes);

  return result;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('deferred-files both-paths agreement (AC-10c)', () => {
  const ctx = makeContext();

  beforeEach(() => {
    ctx.fixture = null;
    // Clear the module-level findProjectRoot cache so each test's temp git
    // repo is discovered independently. Without this, the first fixture's
    // dir is cached as the project root for ancestor dirs shared by all
    // sibling fixture dirs (the OS temp directory), causing subsequent tests
    // to try to crawl the already-deleted first fixture's directory.
    resetProjectRootCaches();
  });

  afterEach(async () => {
    if (ctx.fixture) {
      const { rmSync } = await import('node:fs');
      rmSync(ctx.fixture.dir, { recursive: true, force: true });
    }
  });

  // Row 1 — Deferred dest: SKILL.md links data/idx.json (the dest; absent in source tree).
  // The skill is in skills/probe/SKILL.md; dest 'data/idx.json' is authored relative to
  // skillDir, resolving to skills/probe/data/idx.json from projectRoot. This tests the
  // root-cause fix: computeDeferredPaths must emit the project-root-relative dest path
  // so checkDeferred() can match it correctly.
  it('row 1 — deferred dest: both paths emit LINK_DEFERRED_ARTIFACT, not LINK_MISSING_TARGET (skill in subdir)', async () => {
    const { sourceCodes, buildCodes } = await runRow(
      ctx,
      'deferred-dest',
      '# Skill\n\nSee [index](data/idx.json).',
    );

    // Specific assertions: LINK_DEFERRED_ARTIFACT must be present.
    expect(sourceCodes.has(LINK_DEFERRED_ARTIFACT)).toBe(true);
    expect(buildCodes.has(LINK_DEFERRED_ARTIFACT)).toBe(true);

    // Must NOT contain LINK_MISSING_TARGET (deferred, not missing).
    expect(sourceCodes.has(LINK_MISSING_TARGET)).toBe(false);
    expect(buildCodes.has(LINK_MISSING_TARGET)).toBe(false);

    // Must NOT contain LINK_TO_GITIGNORED_FILE for this link (dest is not gitignored).
    expect(sourceCodes.has(LINK_TO_GITIGNORED_FILE)).toBe(false);
    expect(buildCodes.has(LINK_TO_GITIGNORED_FILE)).toBe(false);

    // FILES_SOURCE_GITIGNORED fires because the source (build/gen/idx.json) IS gitignored.
    expect(sourceCodes.has(FILES_SOURCE_GITIGNORED)).toBe(true);
    expect(buildCodes.has(FILES_SOURCE_GITIGNORED)).toBe(true);
  });

  // Row 2 — C1 leak: SKILL.md links the gitignored SOURCE path build/gen/idx.json (exists).
  // The link uses a path relative to the skillDir (skills/probe/), but the target resolves
  // to <root>/build/gen/idx.json which IS gitignored and present on disk.
  it('row 2 — C1 leak: gitignored present source still emits LINK_TO_GITIGNORED_FILE on both paths (skill in subdir)', async () => {
    const { sourceCodes, buildCodes } = await runRow(
      ctx,
      'c1-leak',
      '# Skill\n\nSee [index](../../build/gen/idx.json).',
    );

    // C1 narrowing: present gitignored source must NOT defer — it must flag.
    expect(sourceCodes.has(LINK_TO_GITIGNORED_FILE)).toBe(true);
    expect(buildCodes.has(LINK_TO_GITIGNORED_FILE)).toBe(true);

    // FILES_SOURCE_GITIGNORED is also present (the files: source is gitignored).
    expect(sourceCodes.has(FILES_SOURCE_GITIGNORED)).toBe(true);
    expect(buildCodes.has(FILES_SOURCE_GITIGNORED)).toBe(true);

    // Must NOT defer (it is NOT a dest, and it EXISTS — so C1 keeps the normal code).
    expect(sourceCodes.has(LINK_DEFERRED_ARTIFACT)).toBe(false);
    expect(buildCodes.has(LINK_DEFERRED_ARTIFACT)).toBe(false);
  });

  // Row 3 — Genuinely missing: link to a non-declared, non-existent path.
  it('row 3 — genuinely missing: both paths emit LINK_MISSING_TARGET for a non-declared absent link (skill in subdir)', async () => {
    const { sourceCodes, buildCodes } = await runRow(
      ctx,
      'missing-link',
      '# Skill\n\nSee [nowhere](nonexistent/path.md).',
    );

    // A genuinely missing, non-deferred link must raise LINK_MISSING_TARGET.
    expect(sourceCodes.has(LINK_MISSING_TARGET)).toBe(true);
    expect(buildCodes.has(LINK_MISSING_TARGET)).toBe(true);

    // No deferred artifact — this path is not declared in files: config.
    expect(sourceCodes.has(LINK_DEFERRED_ARTIFACT)).toBe(false);
    expect(buildCodes.has(LINK_DEFERRED_ARTIFACT)).toBe(false);

    // FILES_SOURCE_GITIGNORED still fires on both paths because the build/gen/idx.json
    // files: source is gitignored regardless of what the link is.
    expect(sourceCodes.has(FILES_SOURCE_GITIGNORED)).toBe(true);
    expect(buildCodes.has(FILES_SOURCE_GITIGNORED)).toBe(true);
  });
});

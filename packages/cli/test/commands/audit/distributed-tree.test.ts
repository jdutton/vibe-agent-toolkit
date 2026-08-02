/* eslint-disable security/detect-non-literal-fs-filename -- every path here is a temp dir the test owns */
/**
 * The provenance classifier behind `PACKAGED_AGENT_INSTRUCTION_FILE`'s audit lane.
 *
 * Every fixture that asserts anything about tracked-ness `git init`s and commits
 * for real. A `mkdtemp` directory with no repo has NO gitignore semantics at all,
 * so a fixture that skips `git init` cannot tell "source" from "distributed" — it
 * would agree with any implementation, including a no-op.
 */

import { existsSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';

import { mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, describe, expect, it } from 'vitest';

import {
  classifyScannedSkillTree,
  distributedTreeFindings,
  resetGitTrackerCache,
} from '../../../src/commands/audit/distributed-tree.js';
import { createTempDirTracker } from '../../system/test-common.js';
import { commitTestFixture, initTestGitRepo } from '../../test-helpers.js';

const { createTempDir, cleanupTempDirs } = createTempDirTracker('vat-tree-provenance-');

const SKILL_REL_DIR = 'skills/demo';
const SOURCE: Awaited<ReturnType<typeof classifyScannedSkillTree>> = 'repo-source';
const DISTRIBUTED: Awaited<ReturnType<typeof classifyScannedSkillTree>> = 'distributed';
const INDETERMINATE: Awaited<ReturnType<typeof classifyScannedSkillTree>> = 'indeterminate';

/** Create `<root>/<relDir>/SKILL.md` and return its absolute path. */
function placeSkill(root: string, relDir: string): string {
  const dir = safePath.join(root, relDir);
  mkdirSyncReal(dir, { recursive: true });
  const skillMd = safePath.join(dir, 'SKILL.md');
  writeFileSync(skillMd, '---\nname: demo\ndescription: x\n---\n', 'utf-8');
  return skillMd;
}

/** Drop a `CLAUDE.md` beside a SKILL.md so the presence crawl has something to find. */
function placeGuidanceBeside(skillMd: string): void {
  writeFileSync(safePath.join(skillMd, '..', 'CLAUDE.md'), '# repo guidance\n', 'utf-8');
}

/**
 * Make `git ls-files` fail inside `root` while leaving `.git` present on disk.
 *
 * Renaming `HEAD` is the cheapest reproduction of the whole family: git exits 128,
 * `gitLsFiles` returns `null`, and `gitFindRoot` — a pure `existsSync` walk — still
 * reports the directory as a repository. `git` missing from `PATH` and an
 * unreadable `.git` reach the identical `null` through the same call.
 */
function breakGitMetadata(root: string): void {
  renameSync(safePath.join(root, '.git', 'HEAD'), safePath.join(root, '.git', 'HEAD.bak'));
}

/** Create a symlink, or report that this host will not let us (Windows without admin). */
function trySymlink(target: string, link: string): boolean {
  try {
    symlinkSync(target, link);
    return true;
  } catch {
    return false;
  }
}

/**
 * Classify `skillMd` with `CLAUDE_CONFIG_DIR` pointed at `claudeDir`, restoring
 * whatever the environment held before. The classifier reads the variable on
 * every call precisely so a fixture can move the install root.
 */
async function classifyWithInstallRoot(
  claudeDir: string,
  skillMd: string,
): ReturnType<typeof classifyScannedSkillTree> {
  const previous = process.env['CLAUDE_CONFIG_DIR'];
  process.env['CLAUDE_CONFIG_DIR'] = claudeDir;
  try {
    return await classifyScannedSkillTree(skillMd);
  } finally {
    if (previous === undefined) delete process.env['CLAUDE_CONFIG_DIR'];
    else process.env['CLAUDE_CONFIG_DIR'] = previous;
  }
}

describe('classifyScannedSkillTree', () => {
  afterEach(() => {
    // The tracker cache is keyed by git root and each fixture reuses none, but a
    // stale entry would still outlive its temp dir inside one vitest worker.
    resetGitTrackerCache();
    cleanupTempDirs();
  });

  it('calls a committed skill in a repo repo-source', async () => {
    const root = createTempDir();
    const skillMd = placeSkill(root, SKILL_REL_DIR);
    commitTestFixture(root);

    await expect(classifyScannedSkillTree(skillMd)).resolves.toBe(SOURCE);
  });

  it('calls an untracked-but-not-ignored skill repo-source', async () => {
    // Authoring in progress. Demanding a commit before a tree counts as source
    // would make the first audit of a brand-new skill the loudest one.
    const root = createTempDir();
    initTestGitRepo(root);
    const skillMd = placeSkill(root, SKILL_REL_DIR);

    await expect(classifyScannedSkillTree(skillMd)).resolves.toBe(SOURCE);
  });

  it('calls a gitignored build output distributed', async () => {
    const root = createTempDir();
    writeFileSync(safePath.join(root, '.gitignore'), 'dist/\n', 'utf-8');
    placeSkill(root, SKILL_REL_DIR);
    commitTestFixture(root);
    const bundled = placeSkill(root, `dist/${SKILL_REL_DIR}`);

    await expect(classifyScannedSkillTree(bundled)).resolves.toBe(DISTRIBUTED);
  });

  it('calls a tree outside any git repository distributed', async () => {
    const skillMd = placeSkill(createTempDir(), 'unpacked/demo');

    await expect(classifyScannedSkillTree(skillMd)).resolves.toBe(DISTRIBUTED);
  });

  it('calls an install-root tree distributed even when git tracks it', async () => {
    // Claude Code installs marketplaces by `git clone`, so an installed tree IS
    // tracked source — of somebody else's repo. Location has to outrank git here
    // or every installed finding disappears.
    const claudeDir = createTempDir();
    const skillMd = placeSkill(claudeDir, SKILL_REL_DIR);
    commitTestFixture(claudeDir);

    await expect(classifyWithInstallRoot(claudeDir, skillMd)).resolves.toBe(DISTRIBUTED);
  });

  it('leaves a tree that merely sits NEXT TO an install root alone', async () => {
    // Guards the separator in the prefix test itself, and it can only do that if
    // the fixture is a sibling of a directory the clause actually compares
    // against. The roots are `<claudeDir>/skills`, `<claudeDir>/plugins` and
    // `<claudeDir>/plugins/marketplaces` — NOT `claudeDir` itself — so a fixture
    // at `<parent>/.claude-work` next to `<parent>/.claude` is not a prefix of
    // any root under either spelling of the test, and agrees with a bare
    // `startsWith` implementation as readily as with the correct one.
    // `<claudeDir>/skills-work` is the sibling that separates them: it shares the
    // `<claudeDir>/skills` prefix and is outside it.
    const parent = createTempDir();
    const claudeDir = safePath.join(parent, '.claude');
    mkdirSyncReal(safePath.join(claudeDir, 'skills'), { recursive: true });
    const skillMd = placeSkill(claudeDir, 'skills-work/demo');
    // Committed, so clause 2 says source: only a prefix test that ignores the
    // separator can produce `distributed` here.
    commitTestFixture(parent);

    await expect(classifyWithInstallRoot(claudeDir, skillMd)).resolves.toBe(SOURCE);
  });

  // A3 — the classifier used to FAIL OPEN here. `gitLsFiles` returns null for a
  // missing binary, a corrupt `.git` and an unreadable `.git` alike; that null
  // collapsed to "not ignored", which reads as source, which is silence. A
  // security-adjacent detector that switches itself off when a subprocess is
  // missing — and says nothing — is worse than one that was never written.
  it('refuses to answer when git cannot be consulted, instead of calling the tree source', async () => {
    const root = createTempDir();
    const skillMd = placeSkill(root, SKILL_REL_DIR);
    commitTestFixture(root);

    // Control, same fixture, same call: with git healthy this IS source. Without
    // it the two answers would be indistinguishable and this test would agree
    // with any implementation.
    await expect(classifyScannedSkillTree(skillMd)).resolves.toBe(SOURCE);

    resetGitTrackerCache();
    breakGitMetadata(root);

    await expect(classifyScannedSkillTree(skillMd)).resolves.toBe(INDETERMINATE);
  });

  // A9 — `~/.claude` symlinked into a dotfiles checkout is a common setup, and
  // auditing that checkout by its REAL path used to miss clause 1 entirely:
  // both sides were compared unresolved.
  it('sees through a symlinked Claude config dir to the real install root', async () => {
    const repo = createTempDir();
    const realDir = safePath.join(repo, 'realclaude');
    const skillMd = placeSkill(realDir, SKILL_REL_DIR);
    commitTestFixture(repo);
    const linkDir = safePath.join(repo, 'linkclaude');
    if (!trySymlink(realDir, linkDir)) return;

    // Everything is committed, so clause 2 says `repo-source`; only clause 1 can
    // produce the right answer, and only if it canonicalises first.
    await expect(classifyWithInstallRoot(linkDir, skillMd)).resolves.toBe(DISTRIBUTED);
  });

  // C7 — `Set.has` on the git active set is case-SENSITIVE while the `existsSync`
  // qualifier beside it is case-INsensitive, so a differently-cased spelling of a
  // tracked file read as "absent from the set and present on disk" ⇒ ignored ⇒
  // distributed. Reachable by tab-completion or a case-normalising layer.
  it('is not fooled by a case-variant spelling of a tracked source path', async () => {
    const root = createTempDir();
    placeSkill(root, 'skills/demo');
    commitTestFixture(root);

    const variant = safePath.join(root, 'Skills', 'demo', 'SKILL.md');
    // On a case-SENSITIVE filesystem this path names nothing, so there is no
    // second spelling to be confused by and nothing to assert.
    if (!existsSync(variant)) return;

    await expect(classifyScannedSkillTree(variant)).resolves.toBe(SOURCE);
  });
});

describe('distributedTreeFindings', () => {
  afterEach(() => {
    resetGitTrackerCache();
    cleanupTempDirs();
  });

  it('reports the agent-instruction files of a distributed tree', async () => {
    const root = createTempDir();
    const skillMd = placeSkill(root, `dist/${SKILL_REL_DIR}`);
    placeGuidanceBeside(skillMd);

    const issues = await distributedTreeFindings(skillMd, root, true);

    expect(issues.map((i) => i.code)).toEqual(['PACKAGED_AGENT_INSTRUCTION_FILE']);
  });

  // A3's reporting half. The degradation has to reach `issues`/`issueCounts` —
  // this repo has already learned that a stderr notice is not a reported finding.
  it('reports ONE indeterminate finding, not silence, when git cannot be consulted', async () => {
    const root = createTempDir();
    const skillMd = placeSkill(root, SKILL_REL_DIR);
    placeGuidanceBeside(skillMd);
    commitTestFixture(root);

    // Control: healthy git says source, so nothing is reported.
    expect(await distributedTreeFindings(skillMd, root, true)).toEqual([]);

    resetGitTrackerCache();
    breakGitMetadata(root);

    const issues = await distributedTreeFindings(skillMd, root, true);
    expect(issues.map((i) => i.code)).toEqual(['TREE_PROVENANCE_INDETERMINATE']);
    expect(issues[0]?.severity).toBe('warning');
  });

  // Proportionality: a tree holding no agent-instruction file has nothing whose
  // classification was lost, so an unanswerable git is not worth saying. Without
  // this, every skill in a git-less container warns about nothing.
  it('stays silent when git cannot be consulted and the tree holds nothing to classify', async () => {
    const root = createTempDir();
    const skillMd = placeSkill(root, SKILL_REL_DIR);
    commitTestFixture(root);
    resetGitTrackerCache();
    breakGitMetadata(root);

    expect(await distributedTreeFindings(skillMd, root, true)).toEqual([]);
  });
});

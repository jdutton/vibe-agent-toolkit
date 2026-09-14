/**
 * `vat audit`'s directory population, enumerated through the `crawl` lane —
 * the behaviours the audit inherited from the lane the day its own walker was
 * retired, pinned over real trees.
 *
 * The pure classification is unit-tested in
 * `test/commands/audit/scan-population.test.ts`; this file is about what the
 * LANE hands back: gitignored territory in or out, the never-crawl list under
 * every flag, a refused directory degraded to a refusal rather than a throw,
 * and the two exclude sources with their two bases.
 */

import { chmodSync, writeFileSync } from 'node:fs';

import { safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';
import { mkdirSyncReal } from '@vibe-agent-toolkit/utils/fs';
import { safeExecSync } from '@vibe-agent-toolkit/utils/process';
import { CANNOT_DENY_READS, tempDirTracker } from '@vibe-agent-toolkit/utils/testing';
import picomatch from 'picomatch';
import { afterEach, describe, expect, it } from 'vitest';

import { enumerateAuditPopulation, type AuditScanSubject } from '../../src/commands/audit/scan-population.js';

const tracker = tempDirTracker('vat-audit-scan-population-');

const SKILL = '---\nname: x\ndescription: A fixture skill for the population lane.\n---\n\n# x\n';

/** Write a file, creating its directories. */
function place(root: string, relative: string, body = SKILL): string {
  const abs = safePath.join(root, relative);
  mkdirSyncReal(safePath.resolve(abs, '..'), { recursive: true });
  writeFileSync(abs, body);
  return abs;
}

/** The subjects as `[kind, root-relative path]`, sorted, for a `toEqual`. */
function shape(root: string, subjects: readonly AuditScanSubject[]): [string, string][] {
  return subjects
    .map((s): [string, string] => [s.kind, toForwardSlash(safePath.relative(root, s.kind === 'plugin' ? s.dir : s.path))])
    .sort((a, b) => a[1].localeCompare(b[1]));
}

/** A tree with one source skill and three copies where no lane should look by default. */
function buildArtifactTree(root: string): void {
  safeExecSync('git', ['init', '-q'], { cwd: root, allowGit: true });
  writeFileSync(safePath.join(root, '.gitignore'), 'dist/\nnode_modules/\n');
  for (const dir of ['skills/hello', 'dist/skills/hello', 'node_modules/pkg/skill', '.claude/worktrees/wt/skills/hello']) {
    place(root, `${dir}/SKILL.md`);
  }
}

const DEFAULTS = { recursive: true, userExcludes: [], projectExcludes: null } as const;

describe('enumerateAuditPopulation', () => {
  afterEach(() => {
    tracker.cleanupAll();
  });

  it('answers from git by default: the source skill, none of the ignored copies', async () => {
    const root = tracker.create();
    buildArtifactTree(root);

    const { subjects, refusals } = await enumerateAuditPopulation({ ...DEFAULTS, scanDir: root, respectGitignore: true });

    expect(shape(root, subjects)).toEqual([['skill', 'skills/hello/SKILL.md']]);
    expect(refusals).toEqual([]);
  });

  it('sees an untracked skill on the git route — the author has not committed yet', async () => {
    const root = tracker.create();
    buildArtifactTree(root);
    place(root, 'skills/draft/SKILL.md');

    const { subjects } = await enumerateAuditPopulation({ ...DEFAULTS, scanDir: root, respectGitignore: true });

    expect(shape(root, subjects).map(([, p]) => p)).toContain('skills/draft/SKILL.md');
  });

  it('with gitignore lifted, walks dist/ but still never node_modules/ or a worktree', async () => {
    const root = tracker.create();
    buildArtifactTree(root);

    const { subjects } = await enumerateAuditPopulation({ ...DEFAULTS, scanDir: root, respectGitignore: false });

    // The lane's never-crawl list is not a gitignore rule and no flag lifts it.
    expect(shape(root, subjects)).toEqual([
      ['skill', 'dist/skills/hello/SKILL.md'],
      ['skill', 'skills/hello/SKILL.md'],
    ]);
  });

  it('outside git, walks the tree and applies the same never-crawl list', async () => {
    const root = tracker.create();
    for (const dir of ['a', 'node_modules/pkg', 'sub/.git/objects']) place(root, `${dir}/SKILL.md`);
    place(root, 'plug/.claude-plugin/plugin.json', '{}');

    const { subjects } = await enumerateAuditPopulation({ ...DEFAULTS, scanDir: root, respectGitignore: true });

    expect(shape(root, subjects)).toEqual([
      ['skill', 'a/SKILL.md'],
      ['plugin', 'plug'],
    ]);
  });

  // Both routes, because they prune differently: the WALK route's crawl
  // prunes a bare-named directory itself, while the GIT route filters files
  // only and the population re-applies `--exclude` with the ancestor rule.
  // With the walk case alone, that re-application could be deleted and every
  // test stay green while `vat audit --exclude vendor` inside a repository
  // silently audited `vendor/` — the route adopters actually use.
  it.each([
    ['walk', false],
    ['git', true],
  ])('applies the operator’s --exclude relative to the scan root, pruning a directory named bare (%s route)', async (_route, inRepo) => {
    const root = tracker.create();
    if (inRepo) safeExecSync('git', ['init', '-q'], { cwd: root, allowGit: true });
    for (const dir of ['keep', 'vendor/copy', 'fixtures/broken']) place(root, `${dir}/SKILL.md`);

    const { subjects } = await enumerateAuditPopulation({
      ...DEFAULTS, scanDir: root, respectGitignore: true, userExcludes: ['vendor', 'fixtures/**'],
    });

    expect(shape(root, subjects)).toEqual([['skill', 'keep/SKILL.md']]);
  });

  it('applies the project’s resources.exclude against the PROJECT root, not the scan root', async () => {
    const project = tracker.create();
    const scanDir = safePath.join(project, 'packages/x');
    for (const dir of ['packages/x/skills/a', 'packages/x/fixtures/b']) place(project, `${dir}/SKILL.md`);
    // Written about the project: `packages/x/fixtures/**`, which matches nothing scan-relative.
    const projectExcludes = { isMatch: picomatch(['packages/x/fixtures/**'], { dot: true }), base: project };

    const { subjects } = await enumerateAuditPopulation({ ...DEFAULTS, scanDir, respectGitignore: true, projectExcludes });

    expect(shape(scanDir, subjects)).toEqual([['skill', 'skills/a/SKILL.md']]);
  });

  it('under --no-recursive, keeps the root’s files and the immediate subdirectories’ plugin markers', async () => {
    const root = tracker.create();
    place(root, 'installed_plugins.json', '{}');
    place(root, 'plug/.claude-plugin/plugin.json', '{}');
    place(root, 'plug/skills/deep/SKILL.md');
    place(root, 'skills/nested/SKILL.md');

    const { subjects } = await enumerateAuditPopulation({ ...DEFAULTS, scanDir: root, recursive: false, respectGitignore: true });

    expect(shape(root, subjects)).toEqual([
      ['registry', 'installed_plugins.json'],
      ['plugin', 'plug'],
    ]);
  });

  it('reports a nested config strictly beneath the root, and never the root’s own', async () => {
    const root = tracker.create();
    place(root, 'vibe-agent-toolkit.config.yaml', 'version: 1\n');
    place(root, 'pkg/vibe-agent-toolkit.config.yaml', 'version: 1\n');

    const { nestedConfigs } = await enumerateAuditPopulation({ ...DEFAULTS, scanDir: root, respectGitignore: true });

    expect(nestedConfigs.map((p) => toForwardSlash(safePath.relative(root, p)))).toEqual(['pkg/vibe-agent-toolkit.config.yaml']);
  });

  it.skipIf(CANNOT_DENY_READS)('hands a directory it could not list back as a refusal, and keeps the readable siblings', async () => {
    const root = tracker.create();
    place(root, 'good/SKILL.md');
    const locked = safePath.join(root, 'locked');
    place(root, 'locked/SKILL.md');
    chmodSync(locked, 0o000);
    try {
      const { subjects, refusals } = await enumerateAuditPopulation({ ...DEFAULTS, scanDir: root, respectGitignore: true });

      expect(shape(root, subjects)).toEqual([['skill', 'good/SKILL.md']]);
      expect(refusals.map((r) => [toForwardSlash(safePath.relative(root, r.directory)), r.code])).toEqual([['locked', 'EACCES']]);
    } finally {
      chmodSync(locked, 0o755);
    }
  });
});

import fs from 'node:fs';

import type { SkillsConfig } from '@vibe-agent-toolkit/resources';
import { normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { runGitOrThrow } from '@vibe-agent-toolkit/utils/git';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { discoverSkillsFromConfig } from '../../src/commands/skills/skill-discovery.js';

/**
 * Regression coverage for the `skills.include` parent-traversal bug:
 * `discoverSkillsFromConfig` previously crawled only inside `projectRoot`,
 * so include patterns containing `..` could never match anything. Build,
 * verify, and skills-validate all share this discovery path; audit was
 * unaffected only because it has its own filesystem-first walker.
 */
const INSIDE = 'inside-skill';
const OUTSIDE = 'outside-skill';
const PRIVATE = 'private-skill';
const COMMITTED = 'committed-skill';
const UNCOMMITTED = 'uncommitted-skill';

/** The include pattern every adopter writes; both fixtures below use it. */
const SKILLS_GLOB = 'skills/**/SKILL.md';

/** Write `<dir>/SKILL.md` with the frontmatter name discovery reads. */
function writeSkill(dir: string, name: string, description: string): void {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- dir derives from mkdtempSync
  fs.mkdirSync(dir, { recursive: true });
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- dir derives from mkdtempSync
  fs.writeFileSync(
    safePath.join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}\n`,
  );
}

/** Names of the discovered skills, sorted so assertions are order-independent. */
async function discoveredNames(
  include: string[],
  projectRoot: string,
  exclude?: string[],
): Promise<string[]> {
  const config = (exclude ? { include, exclude } : { include }) as SkillsConfig;
  const skills = await discoverSkillsFromConfig(config, projectRoot);
  return skills.map(s => s.name).sort((a, b) => a.localeCompare(b));
}

describe('discoverSkillsFromConfig — include patterns with `..` traversal', () => {
  let tempDir: string;
  let packageRoot: string;

  beforeAll(() => {
    tempDir = fs.mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-skills-traversal-'));

    // Layout:
    //   tempDir/
    //     docs/skills/outside/SKILL.md     ← above the package via "../"
    //     pkg/                             ← packageRoot (config lives here)
    //       skills/inside/SKILL.md
    //       skills/private/SKILL.md        ← exists, excluded by tests
    packageRoot = safePath.join(tempDir, 'pkg');
    writeSkill(safePath.join(packageRoot, 'skills', 'inside'), INSIDE, 'lives inside the package');
    writeSkill(
      safePath.join(packageRoot, 'skills', 'private'),
      PRIVATE,
      'should be droppable via exclude',
    );
    writeSkill(
      safePath.join(tempDir, 'docs', 'skills', 'outside'),
      OUTSIDE,
      'lives above the package via ..',
    );
  });

  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('finds skills inside the package via standard include patterns', async () => {
    expect(await discoveredNames([SKILLS_GLOB], packageRoot)).toEqual([INSIDE, PRIVATE]);
  });

  it('finds skills above the package via `..` in include patterns', async () => {
    expect(await discoveredNames(['../docs/skills/*/SKILL.md'], packageRoot)).toEqual([OUTSIDE]);
  });

  it('combines patterns above and below the package root', async () => {
    const names = await discoveredNames(
      ['skills/inside/**/SKILL.md', '../docs/skills/*/SKILL.md'],
      packageRoot,
    );
    expect(names).toEqual([INSIDE, OUTSIDE]);
  });

  it('finds a skill named by a literal include path (no glob metachars)', async () => {
    expect(await discoveredNames(['skills/inside/SKILL.md'], packageRoot)).toEqual([INSIDE]);
  });

  it('drops skills matched by user-supplied exclude patterns', async () => {
    const names = await discoveredNames([SKILLS_GLOB], packageRoot, ['**/private/**']);
    expect(names).toEqual([INSIDE]);
  });

  it('returns empty when an include pattern points to a nonexistent base', async () => {
    expect(await discoveredNames(['../does-not-exist/*/SKILL.md'], packageRoot)).toEqual([]);
  });
});

/**
 * Regression coverage for skill discovery inside a git repository.
 *
 * `crawlDirectory` answers a crawl with `git ls-files` whenever the base is in a
 * repo, and that query defaults to TRACKED files only. A skill the author has
 * just written — the single most common state a skill is ever in — is therefore
 * invisible to `vat skills validate`, `vat skills build`, and `vat verify`, and
 * nothing says so: the count silently drops by one and the exit code stays 0.
 *
 * This fixture MUST `git init` its temp dir and leave one SKILL.md uncommitted.
 * The sibling suite above lives in a bare temp dir outside any repository, which
 * takes the manual-walk fallback — so it finds untracked files either way and
 * cannot distinguish the two answers.
 */
describe('discoverSkillsFromConfig — inside a git repository', () => {
  let repoRoot: string;

  beforeAll(() => {
    repoRoot = fs.mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-skills-git-'));
    runGitOrThrow(['init', '-q', '-b', 'main'], { cwd: repoRoot });

    writeSkill(safePath.join(repoRoot, 'skills', 'committed'), COMMITTED, 'staged, so tracked');
    // Staging is enough to make `git ls-files` report a file as tracked; no
    // commit (and so no user identity config) is needed to tell the two apart.
    runGitOrThrow(['add', 'skills/committed/SKILL.md'], { cwd: repoRoot });

    // Deliberately NOT staged — this is the case the fix exists for.
    writeSkill(
      safePath.join(repoRoot, 'skills', 'uncommitted'),
      UNCOMMITTED,
      'written but never staged',
    );
  });

  afterAll(() => {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });

  it('finds an uncommitted SKILL.md alongside a tracked one', async () => {
    expect(await discoveredNames([SKILLS_GLOB], repoRoot)).toEqual([
      COMMITTED,
      UNCOMMITTED,
    ]);
  });

  it('still honours excludes for untracked skills', async () => {
    const names = await discoveredNames([SKILLS_GLOB], repoRoot, ['**/uncommitted/**']);
    expect(names).toEqual([COMMITTED]);
  });
});

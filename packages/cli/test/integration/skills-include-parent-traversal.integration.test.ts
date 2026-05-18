import fs from 'node:fs';

import type { SkillsConfig } from '@vibe-agent-toolkit/resources';
import { normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
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
    const insideDir = safePath.join(packageRoot, 'skills', 'inside');
    const privateDir = safePath.join(packageRoot, 'skills', 'private');
    const outsideDir = safePath.join(tempDir, 'docs', 'skills', 'outside');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- tempDir from mkdtempSync
    fs.mkdirSync(insideDir, { recursive: true });
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- tempDir from mkdtempSync
    fs.mkdirSync(privateDir, { recursive: true });
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- tempDir from mkdtempSync
    fs.mkdirSync(outsideDir, { recursive: true });

    // eslint-disable-next-line security/detect-non-literal-fs-filename -- tempDir from mkdtempSync
    fs.writeFileSync(
      safePath.join(insideDir, 'SKILL.md'),
      '---\nname: inside-skill\ndescription: lives inside the package\n---\n# Inside\n',
    );
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- tempDir from mkdtempSync
    fs.writeFileSync(
      safePath.join(privateDir, 'SKILL.md'),
      '---\nname: private-skill\ndescription: should be droppable via exclude\n---\n# Private\n',
    );
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- tempDir from mkdtempSync
    fs.writeFileSync(
      safePath.join(outsideDir, 'SKILL.md'),
      '---\nname: outside-skill\ndescription: lives above the package via ..\n---\n# Outside\n',
    );
  });

  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('finds skills inside the package via standard include patterns', async () => {
    const skills = await discoverSkillsFromConfig(
      { include: ['skills/**/SKILL.md'] } as SkillsConfig,
      packageRoot,
    );
    const names = skills.map(s => s.name).sort((a, b) => a.localeCompare(b));
    expect(names).toEqual([INSIDE, PRIVATE]);
  });

  it('finds skills above the package via `..` in include patterns', async () => {
    const skills = await discoverSkillsFromConfig(
      { include: ['../docs/skills/*/SKILL.md'] } as SkillsConfig,
      packageRoot,
    );
    expect(skills.map(s => s.name)).toEqual([OUTSIDE]);
  });

  it('combines patterns above and below the package root', async () => {
    const skills = await discoverSkillsFromConfig(
      {
        include: ['skills/inside/**/SKILL.md', '../docs/skills/*/SKILL.md'],
      } as SkillsConfig,
      packageRoot,
    );
    const names = skills.map(s => s.name).sort((a, b) => a.localeCompare(b));
    expect(names).toEqual([INSIDE, OUTSIDE]);
  });

  it('finds a skill named by a literal include path (no glob metachars)', async () => {
    const skills = await discoverSkillsFromConfig(
      { include: ['skills/inside/SKILL.md'] } as SkillsConfig,
      packageRoot,
    );
    expect(skills.map(s => s.name)).toEqual([INSIDE]);
  });

  it('drops skills matched by user-supplied exclude patterns', async () => {
    const skills = await discoverSkillsFromConfig(
      {
        include: ['skills/**/SKILL.md'],
        exclude: ['**/private/**'],
      } as SkillsConfig,
      packageRoot,
    );
    expect(skills.map(s => s.name)).toEqual([INSIDE]);
  });

  it('returns empty when an include pattern points to a nonexistent base', async () => {
    const skills = await discoverSkillsFromConfig(
      { include: ['../does-not-exist/*/SKILL.md'] } as SkillsConfig,
      packageRoot,
    );
    expect(skills).toEqual([]);
  });
});

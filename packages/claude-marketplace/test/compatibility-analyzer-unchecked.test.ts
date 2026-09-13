/**
 * The compatibility analyzer reports what it could NOT read, itself, and reads
 * everything it can.
 *
 * 🚩 Two ways one plugin's verdict used to describe files the analyzer never
 * read. Its walk used `Dirent.isDirectory()`, which is `false` for a symlink,
 * so a skill directory reached through a link was pushed as a FILE (extension
 * `''`) and never descended — `summary.skillFiles: 1` for a plugin with two,
 * and no evidence for the linked one, while the audit's validator lane read it
 * and reported `CAPABILITY_LOCAL_SHELL`. And ONE unreadable file or unlistable
 * directory threw out of the whole analysis, so `vat audit` rendered
 * `compatibility: { analyzed: false }` for a plugin whose every other file was
 * readable. The analyzer is the one that enumerated and read; it says what it
 * skipped, per path, and analyzes the rest.
 *
 * The fixture is shared with the settings checker's suite of the same shape
 * (`settings-compat-checker-unchecked.test.ts`): both lanes walk the plugin
 * through one helper, and both are held to the same layout.
 */

import * as fs from 'node:fs/promises';

import { safePath, symlinkCapability } from '@vibe-agent-toolkit/utils';
import { CANNOT_DENY_READS } from '@vibe-agent-toolkit/utils/testing';
import { describe, expect, it } from 'vitest';

import { analyzeCompatibility } from '../src/compatibility-analyzer.js';
import type { CompatibilityResult } from '../src/types.js';

import {
  BASH_SKILL,
  LINKED_SKILL_FILES,
  PLAIN_SKILL,
  SKILLS,
  linkCycle,
  linkSharedSkills,
  setupRefusedSkillFixture,
  writeSkill,
} from './refused-skill-fixture.js';

const LOCKED_SKILL = 'skills/locked-file/SKILL.md';

const getFixture = setupRefusedSkillFixture('vat-analyzer-unchecked-');

/** The files (root-relative) the analyzer found `allowed-tools: Bash` in, each once. */
function bashEvidenceFiles(result: CompatibilityResult): string[] {
  const files = result.evidence
    .filter((e) => e.patternId === 'ALLOWED_TOOLS_LOCAL_SHELL')
    .map((e) => e.location.file);
  return [...new Set(files)].sort((a, b) => a.localeCompare(b));
}

describe('analyzeCompatibility — skills reached through a symlink', () => {
  const cap = symlinkCapability();

  it.skipIf(cap === null)('reads a symlinked skill DIRECTORY and a symlinked SKILL.md like plain ones', async () => {
    if (cap === null) return;
    await linkSharedSkills(cap, getFixture());
    const { pluginDir } = getFixture();

    const result = await analyzeCompatibility(pluginDir, pluginDir);

    expect(bashEvidenceFiles(result)).toEqual(LINKED_SKILL_FILES);
    expect(result.summary.skillFiles).toBe(2);
    expect(result.unchecked).toEqual([]);
  });

  it.skipIf(cap === null)('does not loop on a symlink cycle, and sees each file once', async () => {
    if (cap === null) return;
    await linkCycle(cap, getFixture());
    const { pluginDir } = getFixture();

    const result = await analyzeCompatibility(pluginDir, pluginDir);

    const files = result.evidence.map((e) => e.location.file);
    expect(files.length).toBeGreaterThan(0);
    // No path reached through `loop/back/...`: the cycle terminated at the link.
    expect(files.some((f) => f.includes('loop/back/'))).toBe(false);
  });
});

describe.skipIf(CANNOT_DENY_READS)('analyzeCompatibility — a path the filesystem refuses', () => {
  it('lists an unreadable SKILL.md under `unchecked`, root-relative, and still analyzes its siblings', async () => {
    const { pluginDir } = getFixture();
    await writeSkill(safePath.join(pluginDir, SKILLS, 'plain'), BASH_SKILL('plain'));
    const lockedFile = await writeSkill(safePath.join(pluginDir, SKILLS, 'locked-file'), BASH_SKILL('locked-file'));
    await getFixture().lock(lockedFile);

    const result = await analyzeCompatibility(pluginDir, pluginDir);

    expect(bashEvidenceFiles(result)).toContain(PLAIN_SKILL);
    expect(bashEvidenceFiles(result)).not.toContain(LOCKED_SKILL);
    const unchecked = result.unchecked.find((u) => u.path === LOCKED_SKILL);
    expect(unchecked?.reason).toMatch(/EACCES|EPERM/);
    // The reason names the refused path the way every other location in the document is spelled.
    expect(unchecked?.reason).not.toContain(pluginDir);
    expect(unchecked?.reason).toContain(LOCKED_SKILL);
    // Counts describe what was ANALYZED — every skill here declares Bash, so the
    // skills read are exactly the files with that evidence; the refused one is
    // accounted for under `unchecked`, not counted as a skill file.
    expect(result.summary.skillFiles).toBe(bashEvidenceFiles(result).length);
  });

  it('lists an unlistable skill directory under `unchecked` with the scandir reason, and still analyzes its siblings', async () => {
    const { pluginDir } = getFixture();
    const lockedDir = safePath.join(pluginDir, SKILLS, 'locked-dir');
    await writeSkill(lockedDir, BASH_SKILL('locked'));
    await getFixture().lock(lockedDir);

    const result = await analyzeCompatibility(pluginDir, pluginDir);

    expect(bashEvidenceFiles(result)).toContain(PLAIN_SKILL);
    const unchecked = result.unchecked.find((u) => u.path === 'skills/locked-dir');
    expect(unchecked?.reason).toMatch(/EACCES|EPERM/);
    expect(unchecked?.reason).toContain('scandir');
    expect(unchecked?.reason).not.toContain(pluginDir);
  });

  it('anchors `unchecked[].path` at `locationRoot`, like every evidence location', async () => {
    const { root, pluginDir } = getFixture();

    const result = await analyzeCompatibility(pluginDir, root);

    expect(result.unchecked.map((u) => u.path).sort((a, b) => a.localeCompare(b))).toEqual([
      'plugin/skills/locked-dir',
      'plugin/skills/locked-file/SKILL.md',
    ]);
    expect(bashEvidenceFiles(result)).toContain(`plugin/${PLAIN_SKILL}`);
  });
});

describe('analyzeCompatibility — a file the analyzer cannot parse', () => {
  it('lists an unparseable hooks.json under `unchecked` with the parser message, and still analyzes the skills', async () => {
    const { pluginDir } = getFixture();
    await writeSkill(safePath.join(pluginDir, SKILLS, 'plain'), BASH_SKILL('plain'));
    await fs.writeFile(safePath.join(pluginDir, 'hooks.json'), '{ not json', 'utf-8');

    const result = await analyzeCompatibility(pluginDir, pluginDir);

    expect(bashEvidenceFiles(result)).toContain(PLAIN_SKILL);
    const unchecked = result.unchecked.find((u) => u.path === 'hooks.json');
    expect(unchecked?.reason).toMatch(/JSON/);
    expect(result.summary.hookFiles).toBe(0);
  });

  it('reports nothing unchecked for a plugin whose every file it read', async () => {
    const { root } = getFixture();
    const clean = safePath.join(root, 'clean-plugin');
    await fs.mkdir(safePath.join(clean, '.claude-plugin'), { recursive: true });
    await fs.writeFile(safePath.join(clean, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'clean' }), 'utf-8');
    await writeSkill(safePath.join(clean, SKILLS, 'a'), BASH_SKILL('a'));

    const result = await analyzeCompatibility(clean, clean);

    expect(bashEvidenceFiles(result)).toEqual(['skills/a/SKILL.md']);
    expect(result.unchecked).toEqual([]);
  });
});

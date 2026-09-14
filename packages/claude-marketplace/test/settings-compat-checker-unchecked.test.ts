/**
 * The settings checker reports what it could NOT compare, itself.
 *
 * 🚩 It used to answer with `SettingsConflict[]` alone, and every path it
 * failed to see fell out of that answer as "no conflict": a skill directory it
 * could not list (`chmod 000`), a SKILL.md it could not read, a frontmatter
 * that would not parse — and, worst, a skill reached through a SYMLINK, which
 * the walk's `Dirent.isFile()`/`isDirectory()` both answer `false` for. The
 * audit's validator lane reads those same symlinked skills (`existsSync`
 * follows the link) and reports their `allowed-tools`, so one run printed
 * `CAPABILITY_LOCAL_SHELL` on `skills/linked/SKILL.md` beside
 * `settings: compatible: true` under a `deny: ["Bash"]` that blocks it.
 *
 * `vat audit` tried to recover the unchecked list from the validator's own
 * result codes, which is blind to a directory (no SKILL.md result exists for
 * it) and unreachable for an unreadable file (the compat analyzer threw first).
 * The checker is the one that enumerated and read; it says what it skipped.
 *
 * The fixture is shared with the analyzer's suite of the same shape
 * (`compatibility-analyzer-unchecked.test.ts`): both lanes walk the plugin
 * through one helper, and both are held to the same layout.
 */

import * as fs from 'node:fs/promises';

import { safePath, symlinkCapability } from '@vibe-agent-toolkit/utils';
import { refuseAsyncFs , CANNOT_DENY_READS } from '@vibe-agent-toolkit/utils/testing';
import { describe, expect, it } from 'vitest';

import { checkSettingsCompatibility } from '../src/settings/settings-compat-checker.js';
import type { EffectiveSettings } from '../src/settings/settings-merger.js';

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

const DENY_BASH: EffectiveSettings = {
  permissions: {
    allow: [],
    ask: [],
    deny: [{ rule: 'Bash', provenance: { level: 'managed', file: 'managed-settings.json' } }],
  },
};

const getFixture = setupRefusedSkillFixture('vat-compat-unchecked-');

/** The skill files (plugin-relative) the checker reported a Bash conflict on. */
function conflictFiles(check: Awaited<ReturnType<typeof checkSettingsCompatibility>>): string[] {
  return check.conflicts.map((c) => /^Tool "Bash" in (.*) blocked/.exec(c.detail)?.[1] ?? c.detail).sort((a, b) => a.localeCompare(b));
}

describe('checkSettingsCompatibility — skills reached through a symlink', () => {
  const cap = symlinkCapability();

  it.skipIf(cap === null)('checks a symlinked skill DIRECTORY and a symlinked SKILL.md like plain ones', async () => {
    if (cap === null) return;
    await linkSharedSkills(cap, getFixture());

    const check = await checkSettingsCompatibility(getFixture().pluginDir, DENY_BASH);

    expect(conflictFiles(check)).toEqual(LINKED_SKILL_FILES);
    expect(check.unchecked).toEqual([]);
  });

  it.skipIf(cap === null)('does not loop on a symlink cycle', async () => {
    if (cap === null) return;
    await linkCycle(cap, getFixture());

    // Terminates, and still finds everything reachable exactly once.
    const check = await checkSettingsCompatibility(getFixture().pluginDir, DENY_BASH);
    const files = conflictFiles(check);
    expect(new Set(files).size).toBe(files.length);
  });
});

describe.skipIf(CANNOT_DENY_READS)('checkSettingsCompatibility — a path the filesystem refuses', () => {
  it('lists an unlistable skill directory under `unchecked`, and still checks its siblings', async () => {
    const { pluginDir } = getFixture();
    const lockedDir = safePath.join(pluginDir, SKILLS, 'locked-dir');
    await writeSkill(lockedDir, BASH_SKILL('locked'));
    await writeSkill(safePath.join(pluginDir, SKILLS, 'plain'), BASH_SKILL('plain'));
    await getFixture().lock(lockedDir);

    const check = await checkSettingsCompatibility(pluginDir, DENY_BASH);

    expect(conflictFiles(check)).toContain(PLAIN_SKILL);
    const unchecked = check.unchecked.find((u) => u.path === lockedDir);
    expect(unchecked?.reason).toMatch(/EACCES|EPERM/);
  });

  it('lists an unreadable SKILL.md under `unchecked`, with the OS reason', async () => {
    const { pluginDir } = getFixture();
    const lockedFile = await writeSkill(safePath.join(pluginDir, SKILLS, 'locked-file'), BASH_SKILL('locked-file'));
    await getFixture().lock(lockedFile);

    const check = await checkSettingsCompatibility(pluginDir, DENY_BASH);

    expect(conflictFiles(check)).not.toContain('skills/locked-file/SKILL.md');
    const unchecked = check.unchecked.find((u) => u.path === lockedFile);
    expect(unchecked?.reason).toMatch(/EACCES|EPERM/);
  });
});

describe('checkSettingsCompatibility — a SKILL.md whose frontmatter cannot be read', () => {
  it.each([
    ['malformed YAML', '---\nname: x\nallowed-tools: [Bash\n---\n', 'Failed to parse YAML'],
    ['an empty block', '---\n\n---\n# x\n', 'not a YAML mapping'],
    ['a scalar block', '---\nhello\n---\n# x\n', 'not a YAML mapping'],
  ])('lists %s under `unchecked`, carrying the parser message', async (_label, content, reason) => {
    const { pluginDir } = getFixture();
    const file = await writeSkill(safePath.join(pluginDir, SKILLS, 'unparseable'), content);

    const check = await checkSettingsCompatibility(pluginDir, DENY_BASH);

    expect(conflictFiles(check)).not.toContain('skills/unparseable/SKILL.md');
    expect(check.unchecked.find((u) => u.path === file)?.reason).toContain(reason);
  });

  it('reports nothing unchecked for a plugin whose every skill it read', async () => {
    const clean = safePath.join(getFixture().root, 'clean-plugin');
    await writeSkill(safePath.join(clean, SKILLS, 'a'), BASH_SKILL('a'));

    const check = await checkSettingsCompatibility(clean, DENY_BASH);

    expect(conflictFiles(check)).toEqual(['skills/a/SKILL.md']);
    expect(check.unchecked).toEqual([]);
  });
});

describe('checkSettingsCompatibility — a hooks.json the OS refuses', () => {
  const DISABLE_HOOKS: EffectiveSettings = {
    permissions: { allow: [], ask: [], deny: [] },
    disableAllHooks: { value: true, provenance: { level: 'managed', file: 'managed-settings.json' } },
  };

  /**
   * "Is there a hooks.json?" is answered by `fs.access`, and a refusal used to
   * answer `false` — "no hooks" — for a plugin whose hooks the org policy
   * disables. The refusal now propagates, and `vat audit` reports the plugin as
   * one it could not check rather than as compatible.
   */
  it('propagates the refusal rather than answering "no hooks"', async () => {
    const plugin = safePath.join(getFixture().root, 'hooks-refused-plugin');
    await writeSkill(safePath.join(plugin, SKILLS, 'a'), BASH_SKILL('a'));
    const hooksPath = safePath.join(plugin, 'hooks.json');
    await fs.writeFile(hooksPath, '{}', 'utf-8');

    const restore = refuseAsyncFs('access', hooksPath, 'EACCES');
    try {
      await expect(checkSettingsCompatibility(plugin, DISABLE_HOOKS)).rejects.toThrow(/EACCES/);
    } finally {
      restore();
    }
  });

  it('reports the hook conflict when hooks.json is there and readable (positive case)', async () => {
    const plugin = safePath.join(getFixture().root, 'hooks-present-plugin');
    await writeSkill(safePath.join(plugin, SKILLS, 'a'), BASH_SKILL('a'));
    await fs.writeFile(safePath.join(plugin, 'hooks.json'), '{}', 'utf-8');

    const check = await checkSettingsCompatibility(plugin, DISABLE_HOOKS);
    expect(check.conflicts.map((c) => c.type)).toEqual(['hook-disabled']);
  });

  it('reports no hook conflict when hooks.json is absent (positive case)', async () => {
    const plugin = safePath.join(getFixture().root, 'hooks-absent-plugin');
    await writeSkill(safePath.join(plugin, SKILLS, 'a'), BASH_SKILL('a'));

    const check = await checkSettingsCompatibility(plugin, DISABLE_HOOKS);
    expect(check.conflicts).toEqual([]);
  });
});

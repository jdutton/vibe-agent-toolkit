/* eslint-disable security/detect-non-literal-fs-filename -- every path here is a temp dir the test owns */
/**
 * `vat audit --user` must audit each installed subject ONCE.
 *
 * The three "sibling" install roots are not siblings: `marketplacesDir` is
 * `<claudeDir>/plugins/marketplaces`, INSIDE `pluginsDir`. The run walked
 * `plugins/` recursively — reaching every installed marketplace — and then
 * walked `marketplaces/` again, so every marketplace-installed plugin and skill
 * was audited twice in one run and appeared under two identical `path:` entries.
 * On one real machine that reported 12 `PACKAGED_AGENT_INSTRUCTION_FILE` rows
 * for 7 distinct files; because the whole subject is re-audited, every finding
 * class doubles, not one code.
 *
 * The containment premise is asserted against a real walk, not assumed: if a
 * recursive scan of `plugins/` did NOT already reach the marketplace subject,
 * dropping the nested root would be a coverage loss rather than a dedup.
 */

import { writeFileSync } from 'node:fs';

import { mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, describe, expect, it } from 'vitest';

import { userScanTargets } from '../../../src/commands/audit.js';
import { createTempDirTracker } from '../../system/test-common.js';
import { runAudit } from '../../test-helpers.js';

const { createTempDir, cleanupTempDirs } = createTempDirTracker('vat-user-scan-targets-');

/** A stand-in `$CLAUDE_CONFIG_DIR` for the path-only assertions (nothing is read). */
const CLAUDE_DIR = '/home/u/.claude';

/** The three install roots, as `getClaudeUserPaths` lays them out under a config dir. */
function installRoots(claudeDir: string): { plugins: string; skills: string; marketplaces: string } {
  const plugins = safePath.join(claudeDir, 'plugins');
  return {
    plugins,
    skills: safePath.join(claudeDir, 'skills'),
    marketplaces: safePath.join(plugins, 'marketplaces'),
  };
}

/**
 * A marketplace-installed skill, at the depth Claude Code installs it to.
 *
 * Deliberately manifest-free: the defect is in the LIST OF ROOTS, so the
 * subject only has to be something both walks would report. Adding
 * `.claude-plugin/` manifests would test the plugin lane instead.
 */
function placeInstalledSkill(claudeDir: string): string {
  const dir = safePath.join(
    installRoots(claudeDir).marketplaces, 'demo-mp', 'plugins', 'demo-plugin', 'skills', 'demo',
  );
  mkdirSyncReal(dir, { recursive: true });
  const skillMd = safePath.join(dir, 'SKILL.md');
  writeFileSync(
    skillMd,
    '---\nname: demo\ndescription: An installed fixture skill, deep enough to sit under both roots.\n---\n\n# demo\n',
    'utf-8',
  );
  return skillMd;
}

describe('userScanTargets', () => {
  it('drops the marketplaces root, which a recursive walk of plugins/ already covers', () => {
    const { plugins, skills, marketplaces } = installRoots(CLAUDE_DIR);

    expect(userScanTargets([plugins, skills, marketplaces], true)).toEqual(
      [plugins, skills].map((dir) => safePath.resolve(dir)),
    );
  });

  it('keeps every root under --no-recursive, where nothing covers anything else', () => {
    // A top-level-only walk of `plugins/` never descends into `marketplaces/`,
    // so the same filter there would replace a double count with no coverage.
    const { plugins, skills, marketplaces } = installRoots(CLAUDE_DIR);

    expect(userScanTargets([plugins, skills, marketplaces], false)).toHaveLength(3);
  });

  it('keeps genuine siblings — the filter is containment, not de-duplication by name', () => {
    const { plugins, skills } = installRoots(CLAUDE_DIR);

    expect(userScanTargets([plugins, skills], true)).toEqual(
      [plugins, skills].map((dir) => safePath.resolve(dir)),
    );
  });

  it('keeps a root that merely shares a prefix with another', () => {
    // `plugins-old` is not inside `plugins`; a prefix test without the separator
    // would silently stop scanning it.
    const { plugins } = installRoots(CLAUDE_DIR);

    expect(userScanTargets([plugins, `${plugins}-old`], true)).toHaveLength(2);
  });
});

describe('the containment premise userScanTargets rests on', () => {
  afterEach(() => {
    cleanupTempDirs();
  });

  it('a recursive walk of plugins/ already reports the marketplace-installed subject', async () => {
    const claudeDir = createTempDir();
    const skillMd = placeInstalledSkill(claudeDir);

    const results = await runAudit(installRoots(claudeDir).plugins);

    expect(results.map((r) => r.path)).toContain(skillMd);
  });

  it('a NON-recursive walk of plugins/ does not, which is why the filter is gated', async () => {
    const claudeDir = createTempDir();
    const skillMd = placeInstalledSkill(claudeDir);

    const results = await runAudit(installRoots(claudeDir).plugins, { recursive: false });

    expect(results.map((r) => r.path)).not.toContain(skillMd);
  });
});

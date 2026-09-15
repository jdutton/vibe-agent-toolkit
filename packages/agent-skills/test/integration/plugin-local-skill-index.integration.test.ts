/**
 * `indexPluginLocalSkills` against a real git repository: git tracking decides which
 * skill dirs under a plugin's `skills/` the plugin build ships, and why the others do not.
 * The in-memory cases are unit tests (`test/plugin-distribution-layout.test.ts`).
 */

import { writeFileSync } from 'node:fs';

import type { ProjectConfig } from '@vibe-agent-toolkit/resources';
import { mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import { indexPluginLocalSkills } from '../../src/plugin-distribution-layout.js';
import { runGit } from '../skill-source/test-helpers.js';
import { setupTempDir } from '../test-helpers.js';

const PLUGIN = 'tree-plugin';
const TRACKED = 'tracked-skill';
const FRESH = 'fresh-skill';
const IGNORED = 'ignored-skill';

const config: ProjectConfig = {
  version: 1,
  claude: { marketplaces: { prod: { owner: { name: 'Test Owner' }, plugins: [{ name: PLUGIN, skills: [] }] } } },
};

describe('indexPluginLocalSkills in a git repository', () => {
  const { getTempDir } = setupTempDir('vat-plugin-local-index-git-');

  it('locates only tracked skill dirs, and says why the others do not ship — never for a gitignored one', () => {
    const root = getTempDir();
    const skillsDir = safePath.join(root, 'plugins', PLUGIN, 'skills');
    const mdOf = (dir: string): string => safePath.join(skillsDir, dir, 'SKILL.md');
    for (const dir of [TRACKED, FRESH, IGNORED, `${TRACKED}/nested`]) {
      mkdirSyncReal(safePath.join(skillsDir, dir), { recursive: true });
      writeFileSync(mdOf(dir), `# ${dir}\n`);
    }
    writeFileSync(safePath.join(root, '.gitignore'), `${IGNORED}/\n`);
    runGit(['init', '-q'], root);
    runGit(['add', '--', '.gitignore', safePath.join('plugins', PLUGIN, 'skills', TRACKED)], root);

    const index = indexPluginLocalSkills(config, root);

    expect(index.locations.map((loc) => loc.skillDirPath)).toEqual([TRACKED]);
    expect(index.locationOf(mdOf(FRESH))).toBeUndefined();
    expect(index.exclusionOf(mdOf(FRESH))).toEqual({
      kind: 'untracked',
      pluginName: PLUGIN,
      skillSourceDir: safePath.join(skillsDir, FRESH),
    });
    expect(index.exclusionOf(mdOf(`${TRACKED}/nested`))).toMatchObject({ kind: 'nested', outer: { skillDirPath: TRACKED } });
    expect(index.exclusionOf(mdOf(IGNORED))).toBeUndefined();
  });
});

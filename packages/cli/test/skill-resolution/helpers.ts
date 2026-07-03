/**
 * Synthetic-fixture builder for {@link resolveSkillReference} tests.
 *
 * Fabricates a throwaway temp project that declares pool skills (via
 * `skills.include`) and/or plugin-local tree-copy skills (via a marketplace
 * plugin whose `plugins/<plug>/skills/<name>/SKILL.md` exists on disk). The
 * shapes mirror production — never a real adopter skill.
 */
/* eslint-disable security/detect-non-literal-fs-filename -- test helper builds synthetic fixtures at dynamic temp paths */
import { writeFileSync } from 'node:fs';

import { computeTreeCopiedSkillLocations } from '@vibe-agent-toolkit/agent-skills';
import { mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';

import { createTestTempDir } from '../system/test-common.js';

const MARKETPLACE_NAME = 'fixture-mp';
const PLUGIN_NAME = 'fixture-plug';

export interface ReferenceFixtureSpec {
  /** Pool skills declared via `skills.include`, built to `dist/skills/<name>`. */
  pool?: string[];
  /** Plugin-local tree-copy skills under `plugins/<plug>/skills/<name>`. */
  pluginLocal?: string[];
}

export interface ReferenceFixture {
  root: string;
  poolSkillMd: (name: string) => string;
  poolDistDir: (name: string) => string;
  pluginDistDir: (name: string) => string;
}

function writeSkillMd(skillDir: string, name: string): void {
  mkdirSyncReal(skillDir, { recursive: true });
  writeFileSync(
    safePath.join(skillDir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: Synthetic ${name} fixture skill for reference-resolution tests.\n---\n\n# ${name}\n\nSynthetic body.\n`,
  );
}

function buildConfigYaml(spec: ReferenceFixtureSpec): string {
  const include: string[] = [];
  if (spec.pool && spec.pool.length > 0) include.push('skills/*/SKILL.md');
  if (spec.pluginLocal && spec.pluginLocal.length > 0) {
    include.push(`plugins/${PLUGIN_NAME}/skills/*/SKILL.md`);
  }

  const lines = ['version: 1'];
  if (include.length > 0) {
    lines.push('skills:', '  include:');
    for (const pattern of include) lines.push(`    - "${pattern}"`);
  }
  if (spec.pluginLocal && spec.pluginLocal.length > 0) {
    lines.push(
      'claude:',
      '  marketplaces:',
      `    ${MARKETPLACE_NAME}:`,
      '      owner:',
      '        name: Fixture Owner',
      '      plugins:',
      `        - name: ${PLUGIN_NAME}`,
      '          description: Synthetic plugin for reference-resolution tests.',
      `          source: plugins/${PLUGIN_NAME}`,
      '          skills: []',
    );
  }
  return `${lines.join('\n')}\n`;
}

export function setupReferenceFixture(spec: ReferenceFixtureSpec): ReferenceFixture {
  const root = safePath.resolve(createTestTempDir('vat-skill-ref-'));

  for (const name of spec.pool ?? []) {
    writeSkillMd(safePath.join(root, 'skills', name), name);
  }

  if (spec.pluginLocal && spec.pluginLocal.length > 0) {
    const pluginRoot = safePath.join(root, 'plugins', PLUGIN_NAME);
    mkdirSyncReal(safePath.join(pluginRoot, '.claude-plugin'), { recursive: true });
    writeFileSync(
      safePath.join(pluginRoot, '.claude-plugin', 'plugin.json'),
      `${JSON.stringify(
        { name: PLUGIN_NAME, version: '0.1.0', description: 'Synthetic fixture plugin.', license: 'MIT' },
        null,
        2,
      )}\n`,
    );
    for (const name of spec.pluginLocal) {
      writeSkillMd(safePath.join(pluginRoot, 'skills', name), name);
    }
  }

  writeFileSync(safePath.join(root, 'vibe-agent-toolkit.config.yaml'), buildConfigYaml(spec));

  return {
    root,
    poolSkillMd: (name) => safePath.resolve(root, 'skills', name, 'SKILL.md'),
    poolDistDir: (name) => safePath.join(root, 'dist', 'skills', name),
    pluginDistDir: (name) => {
      const location = computeTreeCopiedSkillLocations(loadFixtureConfig(spec), root).find(
        (loc) => loc.skillDirName === name,
      );
      if (location === undefined) {
        throw new Error(`fixture has no plugin-local location for '${name}'`);
      }
      return location.skillOutputDir;
    },
  };
}

/** Minimal config object mirroring the YAML, for {@link computeTreeCopiedSkillLocations}. */
function loadFixtureConfig(spec: ReferenceFixtureSpec): Parameters<typeof computeTreeCopiedSkillLocations>[0] {
  if (!spec.pluginLocal || spec.pluginLocal.length === 0) {
    return { claude: { marketplaces: {} } } as never;
  }
  return {
    claude: {
      marketplaces: {
        [MARKETPLACE_NAME]: {
          owner: { name: 'Fixture Owner' },
          plugins: [{ name: PLUGIN_NAME, source: `plugins/${PLUGIN_NAME}` }],
        },
      },
    },
  } as never;
}

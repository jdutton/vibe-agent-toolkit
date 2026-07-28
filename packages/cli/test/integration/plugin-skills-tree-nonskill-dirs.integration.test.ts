/* eslint-disable security/detect-non-literal-fs-filename -- paths are test-owned temp dirs */
/**
 * A plugin's `skills/` tree may hold directories that are NOT skills: a `shared/`
 * helper dir, a `_templates/` dir, or the parent of a nested
 * `skills/<group>/<skill>/SKILL.md`. Nothing packages those, so the verbatim
 * tree-copy is their only route into the bundle.
 *
 * The regression this guards: the tree-copy's exclusion list was once EVERY
 * directory under `skills/`, while the packager only produced the ones holding a
 * SKILL.md. A non-skill directory was therefore excluded by one phase and skipped
 * by the other — it shipped NOWHERE, with no diagnostic. The exclusion list is now
 * derived from what the packager actually produced, so the two sets cannot diverge.
 */
import { existsSync } from 'node:fs';

import { mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, describe, expect, it } from 'vitest';

import { runClaudePluginBuild } from '../../src/commands/claude/plugin/build.js';
import type { Logger } from '../../src/utils/logger.js';
import { cleanupTestTempDir, createTestTempDir, writeTestFile } from '../system/test-common.js';

/** Build progress is irrelevant here; keep it out of the test output. */
const SILENT_LOGGER: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};

const MARKETPLACE = 'mp';
const SKILLS_DIR = 'skills';
const SKILL_FILE = 'SKILL.md';

const PACKAGED_SKILL = 'real-skill';
const NESTED_SKILL = 'nested-skill';
const PLUGIN = 'full-plugin';

/** Minimal valid SKILL.md — no links, so the packaged output is just this file. */
function skillMd(name: string): string {
  return `---
name: ${name}
description: Synthetic fixture skill used to exercise plugin-local skill packaging.
---

# ${name}

Body text with no links, so nothing else is bundled.
`;
}

function writeFixture(tempDir: string): string {
  writeTestFile(safePath.join(tempDir, 'package.json'), JSON.stringify({ name: 't', version: '1.0.0' }));
  writeTestFile(
    safePath.join(tempDir, 'vibe-agent-toolkit.config.yaml'),
    `version: 1
skills:
  include: ["plugins/*/skills/**/SKILL.md"]
claude:
  marketplaces:
    ${MARKETPLACE}:
      owner:
        name: Test Org
      plugins:
        - name: ${PLUGIN}
          description: Plugin whose skills/ tree holds non-skill directories
          skills: []
`,
  );

  const plugin = safePath.join(tempDir, 'plugins', PLUGIN);
  const skills = safePath.join(plugin, SKILLS_DIR);

  // A real plugin-local skill: the packager produces this one.
  mkdirSyncReal(safePath.join(skills, PACKAGED_SKILL), { recursive: true });
  writeTestFile(safePath.join(skills, PACKAGED_SKILL, SKILL_FILE), skillMd(PACKAGED_SKILL));

  // Three shapes that no phase packages, and which must therefore tree-copy.
  mkdirSyncReal(safePath.join(skills, 'shared'), { recursive: true });
  writeTestFile(safePath.join(skills, 'shared', 'helper.md'), '# Shared helper\n');
  mkdirSyncReal(safePath.join(skills, '_templates'), { recursive: true });
  writeTestFile(safePath.join(skills, '_templates', 'skeleton.md'), '# Skeleton\n');
  mkdirSyncReal(safePath.join(skills, 'group', NESTED_SKILL), { recursive: true });
  writeTestFile(safePath.join(skills, 'group', NESTED_SKILL, SKILL_FILE), skillMd(NESTED_SKILL));

  return safePath.join(
    tempDir, 'dist', '.claude', 'plugins', 'marketplaces', MARKETPLACE, 'plugins', PLUGIN,
  );
}

describe('plugin build — non-skill directories under skills/ (integration)', () => {
  let tempDir: string;

  afterEach(() => {
    cleanupTestTempDir(tempDir);
  });

  it('tree-copies every skills/ subdirectory the packager did not produce, and packages the one it did', async () => {
    tempDir = createTestTempDir('vat-plugin-nonskill-dirs-');
    const outDir = writeFixture(tempDir);

    const results = await runClaudePluginBuild(tempDir, { logger: SILENT_LOGGER });

    const plugin = results[0]?.plugins[0];
    expect(plugin?.localSkillsPackaged).toBe(1);

    // The packaged skill: produced by packageSkill, not copied.
    expect(existsSync(safePath.join(outDir, SKILLS_DIR, PACKAGED_SKILL, SKILL_FILE))).toBe(true);

    // The non-skill directories still ship — this is the content-loss regression.
    expect(existsSync(safePath.join(outDir, SKILLS_DIR, 'shared', 'helper.md'))).toBe(true);
    expect(existsSync(safePath.join(outDir, SKILLS_DIR, '_templates', 'skeleton.md'))).toBe(true);
    expect(existsSync(safePath.join(outDir, SKILLS_DIR, 'group', NESTED_SKILL, SKILL_FILE))).toBe(true);
  });
});

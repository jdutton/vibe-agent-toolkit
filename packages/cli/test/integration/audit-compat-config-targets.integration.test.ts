/* eslint-disable security/detect-non-literal-fs-filename -- Test code with temp directories */

/**
 * Integration test: config-layer `targets` flow through to `vat audit --compat`.
 *
 * Exercises the wiring from 0.1.32 limitation #2: when a VAT project declares
 * `skills.defaults.targets` (or per-skill overrides) in
 * `vibe-agent-toolkit.config.yaml`, plugin-level compat analysis must honor
 * those declarations so `vat audit .` and `vat skills validate` reach
 * consistent verdicts.
 *
 * Drives {@link runCompatAnalysis} directly with a synthetic
 * {@link VATProjectContext} so the test is fast and hermetic — no subprocess
 * needed. The subprocess path is covered by `test/system/audit-compat.system.test.ts`.
 */

import fs from 'node:fs';

import type { SkillPackagingConfig, ValidationResult } from '@vibe-agent-toolkit/agent-skills';
import type { CompatibilityResult } from '@vibe-agent-toolkit/claude-marketplace';
import { normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runCompatAnalysis, type VATProjectContext } from '../../src/commands/audit.js';

const silentLogger = {
  info: (_msg: string) => {},
  error: (_msg: string) => {},
  debug: (_msg: string) => {},
};

const COMPAT_TARGET_UNDECLARED = 'COMPAT_TARGET_UNDECLARED';
const COMPAT_TARGET_INCOMPATIBLE = 'COMPAT_TARGET_INCOMPATIBLE';
const TARGET_CLAUDE_CODE = 'claude-code' as const;
const TARGET_CLAUDE_CHAT = 'claude-chat' as const;

/**
 * Build a minimal Claude plugin directory with a SKILL.md that emits a
 * CAPABILITY_LOCAL_SHELL observation (fenced bash block).
 */
function buildShellPluginFixture(parentDir: string, pluginName: string): {
  pluginDir: string;
  skillPath: string;
} {
  const pluginDir = safePath.join(parentDir, pluginName);
  const claudeDir = safePath.join(pluginDir, '.claude-plugin');
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(
    safePath.join(claudeDir, 'plugin.json'),
    JSON.stringify({ name: pluginName, version: '1.0.0' }), // no `targets` → config wins
  );

  const skillDir = safePath.join(pluginDir, 'skills', pluginName);
  fs.mkdirSync(skillDir, { recursive: true });
  const skillPath = safePath.join(skillDir, 'SKILL.md');
  fs.writeFileSync(
    skillPath,
    `---
name: ${pluginName}
description: Test skill that runs local shell commands.
---

# ${pluginName}

\`\`\`bash
echo "hello from local shell"
\`\`\`
`,
  );

  return { pluginDir, skillPath };
}

/**
 * Build a minimal ValidationResult shaped like what audit produces for a
 * detected plugin directory — enough for runCompatAnalysis to pick it up.
 */
function makePluginResult(pluginDir: string): ValidationResult {
  return {
    path: pluginDir,
    type: 'claude-plugin',
    status: 'success',
    summary: '0 errors, 0 warnings, 0 info',
    issues: [],
  };
}

/**
 * Shared driver: build a VATProjectContext from skill-path → config pairs,
 * run compat analysis for a single plugin, and return the verdict codes.
 */
async function runAndGetVerdicts(
  pluginDir: string,
  skillConfigs: ReadonlyArray<readonly [string, SkillPackagingConfig]>,
): Promise<{ compat: CompatibilityResult | undefined; codes: string[] }> {
  const vatContext: VATProjectContext = {
    skillConfigs: new Map(skillConfigs.map(([p, c]) => [safePath.resolve(p), c])),
  };
  const compatMap = await runCompatAnalysis(
    [makePluginResult(pluginDir)],
    silentLogger,
    undefined,
    vatContext,
  );
  const compat = compatMap.get(pluginDir);
  const codes = compat?.verdicts.map(v => v.code) ?? [];
  return { compat, codes };
}

describe('vat audit --compat honors config-layer targets (integration)', () => {
  let tempDir: string;

  beforeAll(() => {
    tempDir = fs.mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-audit-compat-config-'));
  });

  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('suppresses COMPAT_TARGET_UNDECLARED when config declares claude-code for the skill', async () => {
    const { pluginDir, skillPath } = buildShellPluginFixture(tempDir, 'plugin-code');

    const { compat, codes } = await runAndGetVerdicts(pluginDir, [
      [skillPath, { targets: [TARGET_CLAUDE_CODE] }],
    ]);

    expect(compat).toBeDefined();
    expect(compat?.declaredTargets).toEqual([TARGET_CLAUDE_CODE]);
    expect(codes).not.toContain(COMPAT_TARGET_UNDECLARED);
    expect(codes).not.toContain(COMPAT_TARGET_INCOMPATIBLE);
  });

  it('surfaces COMPAT_TARGET_INCOMPATIBLE when config declares claude-chat but skill needs local shell', async () => {
    const { pluginDir, skillPath } = buildShellPluginFixture(tempDir, 'plugin-chat');

    const { compat, codes } = await runAndGetVerdicts(pluginDir, [
      [skillPath, { targets: [TARGET_CLAUDE_CHAT] }],
    ]);

    expect(compat?.declaredTargets).toEqual([TARGET_CLAUDE_CHAT]);
    expect(codes).toContain(COMPAT_TARGET_INCOMPATIBLE);
  });

  it('unions targets across multiple skills in the same plugin', async () => {
    const { pluginDir, skillPath } = buildShellPluginFixture(tempDir, 'plugin-multi');
    // Add a second skill under the same plugin with a different target.
    const secondSkillDir = safePath.join(pluginDir, 'skills', 'extra');
    fs.mkdirSync(secondSkillDir, { recursive: true });
    const secondSkillPath = safePath.join(secondSkillDir, 'SKILL.md');
    fs.writeFileSync(
      secondSkillPath,
      `---
name: extra
description: A second skill with a different declared target.
---

# extra

No shell here.
`,
    );

    const { compat, codes } = await runAndGetVerdicts(pluginDir, [
      [skillPath, { targets: [TARGET_CLAUDE_CODE] }],
      [secondSkillPath, { targets: [TARGET_CLAUDE_CHAT] }],
    ]);

    expect(compat?.declaredTargets).toEqual(expect.arrayContaining([TARGET_CLAUDE_CODE, TARGET_CLAUDE_CHAT]));
    expect(compat?.declaredTargets).toHaveLength(2);
    // claude-chat lacks local shell → incompatible verdict still fires against the
    // plugin's local-shell capability observation.
    expect(codes).toContain(COMPAT_TARGET_INCOMPATIBLE);
  });

  it('falls back to undeclared when no skills in the plugin declare targets', async () => {
    const { pluginDir } = buildShellPluginFixture(tempDir, 'plugin-no-decl');

    // Empty skillConfigs → should behave like null context.
    const { codes } = await runAndGetVerdicts(pluginDir, []);

    expect(codes).toContain(COMPAT_TARGET_UNDECLARED);
  });

  it('ignores skill configs that live outside the plugin directory', async () => {
    const { pluginDir } = buildShellPluginFixture(tempDir, 'plugin-isolated');
    // Register a skill path that is NOT inside pluginDir.
    const otherSkill = safePath.join(tempDir, 'unrelated', 'SKILL.md');
    fs.mkdirSync(safePath.join(otherSkill, '..'), { recursive: true });
    fs.writeFileSync(otherSkill, '---\nname: unrelated\ndescription: Outside the plugin.\n---\n');

    const { codes } = await runAndGetVerdicts(pluginDir, [
      [otherSkill, { targets: [TARGET_CLAUDE_CODE] }],
    ]);

    // No in-plugin skill declared targets → undeclared state preserved.
    expect(codes).toContain(COMPAT_TARGET_UNDECLARED);
  });
});

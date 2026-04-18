/* eslint-disable security/detect-non-literal-fs-filename -- Test code with temp directories */

/**
 * Integration test: config-level `targets` flow through to compat verdicts.
 *
 * Verifies the WS4 wiring:
 *  1. validateSkillForPackaging emits CAPABILITY_* observations / issues.
 *  2. The CLI verdict helper combines those observations with the configured
 *     targets to produce COMPAT_TARGET_* verdicts.
 *  3. Targets that cover the capability suppress the verdict;
 *     targets that lack the capability surface COMPAT_TARGET_INCOMPATIBLE;
 *     no targets at all surfaces COMPAT_TARGET_UNDECLARED.
 */

import fs from 'node:fs';

import { validateSkillForPackaging, type SkillPackagingConfig } from '@vibe-agent-toolkit/agent-skills';
import { normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { applyConfigVerdicts } from '../../src/utils/verdict-helpers.js';

const SKILL_BODY = `---
name: shell-skill
description: A skill that calls into a local shell environment.
---

# Shell Skill

This skill runs commands locally:

\`\`\`bash
echo "hello from local shell"
\`\`\`
`;

describe('config-level targets → compat verdicts (integration)', () => {
  let tempDir: string;
  let skillPath: string;

  beforeAll(() => {
    tempDir = fs.mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-config-targets-'));
    skillPath = safePath.join(tempDir, 'SKILL.md');
    fs.writeFileSync(skillPath, SKILL_BODY);
  });

  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('emits CAPABILITY_LOCAL_SHELL but no COMPAT_TARGET_* when targets cover the capability (claude-code)', async () => {
    const packagingConfig: SkillPackagingConfig = {
      targets: ['claude-code'],
    };
    const result = await validateSkillForPackaging(skillPath, packagingConfig);
    applyConfigVerdicts(result, packagingConfig.targets, skillPath);

    const capabilityCodes = result.allErrors
      .filter(i => i.code.startsWith('CAPABILITY_'))
      .map(i => i.code);
    expect(capabilityCodes).toContain('CAPABILITY_LOCAL_SHELL');

    const compatTargetCodes = result.allErrors
      .filter(i => i.code.startsWith('COMPAT_TARGET_'))
      .map(i => i.code);
    expect(compatTargetCodes).toEqual([]);
  });

  it('emits COMPAT_TARGET_UNDECLARED (info) when no targets are declared', async () => {
    const packagingConfig: SkillPackagingConfig = {};
    const result = await validateSkillForPackaging(skillPath, packagingConfig);
    applyConfigVerdicts(result, packagingConfig.targets, skillPath);

    const undeclared = result.allErrors.filter(i => i.code === 'COMPAT_TARGET_UNDECLARED');
    expect(undeclared.length).toBeGreaterThanOrEqual(1);
    expect(undeclared[0]?.severity).toBe('info');

    const incompatible = result.allErrors.filter(i => i.code === 'COMPAT_TARGET_INCOMPATIBLE');
    expect(incompatible).toHaveLength(0);
  });

  it('emits COMPAT_TARGET_INCOMPATIBLE (warning) when target lacks the capability (claude-chat)', async () => {
    const packagingConfig: SkillPackagingConfig = {
      targets: ['claude-chat'],
    };
    const result = await validateSkillForPackaging(skillPath, packagingConfig);
    applyConfigVerdicts(result, packagingConfig.targets, skillPath);

    const incompatible = result.allErrors.filter(i => i.code === 'COMPAT_TARGET_INCOMPATIBLE');
    expect(incompatible.length).toBeGreaterThanOrEqual(1);
    expect(incompatible[0]?.severity).toBe('warning');

    // Warning verdicts also land in activeWarnings.
    const activeIncompatible = result.activeWarnings.filter(
      i => i.code === 'COMPAT_TARGET_INCOMPATIBLE',
    );
    expect(activeIncompatible.length).toBeGreaterThanOrEqual(1);
  });
});

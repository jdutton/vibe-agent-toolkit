/* eslint-disable security/detect-non-literal-fs-filename -- Test code with temp directories */

/**
 * Integration test: a present-but-broken `vibe-agent-toolkit.config.yaml` is a
 * hard error for skill-resolving commands, but tolerated by the bulk linter.
 *
 * Regression guard: PR #135 migrated `vat skill review` from the throwing
 * `loadConfig` to the shared `resolveSkillPackagingConfig` (→ `loadConfigCached`),
 * which used to swallow a broken config to `undefined`. That silently downgraded
 * review (and would let `vat skill test` stage the wrong subject). A broken
 * config now surfaces as `ConfigLoadError`; `vat audit` still catches it and
 * falls back to config-free validation so a bulk scan is never aborted.
 */

import fs from 'node:fs';

import { normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { resolveSkillPackagingConfig } from '../../src/skill-resolution/packaging-config.js';
import { ConfigLoadError, resetLoadedConfigCache } from '../../src/utils/config-loader.js';
import { gitAddAll, initTestGitRepo, runAudit } from '../test-helpers.js';

describe('broken governing config behavior (integration)', () => {
  let tempDir: string;
  let skillPath: string;

  beforeAll(() => {
    tempDir = fs.mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-broken-cfg-'));
    initTestGitRepo(tempDir);

    // package.json marker + a schema-invalid config (version must be a number).
    fs.writeFileSync(safePath.join(tempDir, 'package.json'), JSON.stringify({ name: 'broken-cfg-fixture' }));
    fs.writeFileSync(safePath.join(tempDir, 'vibe-agent-toolkit.config.yaml'), 'version: not-a-number\n');

    skillPath = safePath.join(tempDir, 'resources', 'skills', 'SKILL.md');
    fs.mkdirSync(safePath.join(tempDir, 'resources', 'skills'), { recursive: true });
    fs.writeFileSync(
      skillPath,
      `---
name: broken-cfg-skill
description: A test skill whose nearest-ancestor config is present but broken.
---

# broken-cfg-skill

Body content for a skill under a broken governing config.
`,
    );

    gitAddAll(tempDir);
  });

  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  // The config cache is process-global; reset so each assertion re-reads it.
  beforeEach(() => resetLoadedConfigCache());

  it('resolveSkillPackagingConfig throws ConfigLoadError (review/skill-test path surfaces it)', async () => {
    await expect(resolveSkillPackagingConfig(skillPath)).rejects.toBeInstanceOf(ConfigLoadError);
  });

  it('vat audit tolerates the broken config and still validates the skill (falls back, no abort)', async () => {
    // Audit the SKILL.md directly so it routes through the config-aware
    // validateSingleSkill path (which resolves the governing config). The broken
    // config must be caught there and fall back to config-free validation rather
    // than aborting the scan with a ConfigLoadError.
    const results = await runAudit(skillPath, {});
    const result = results.find(r => r.path.includes('SKILL.md'));
    expect(result).toBeDefined();
  });
});

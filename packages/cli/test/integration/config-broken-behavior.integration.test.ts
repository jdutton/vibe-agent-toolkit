/* eslint-disable security/detect-non-literal-fs-filename -- Test code with temp directories */

/**
 * Integration test: the MAP of what a present-but-broken
 * `vibe-agent-toolkit.config.yaml` does to each command that meets one.
 *
 * There is no single right answer, so the map is the specification: a command
 * that resolves a skill THROUGH the config must refuse to guess, and a command
 * that merely reads someone else's tree must not die on it. Every row below is
 * measured behaviour, not intent — when a change moves a command from one column
 * to the other, this file is where that shows up.
 *
 * | Subject | Broken config | Absent config |
 * |---|---|---|
 * | `resolveSkillPackagingConfig` (`vat skill review`, `vat skill test`) | throws `ConfigLoadError` | — |
 * | `vat audit` | tolerates, falls back to config-free validation | — |
 * | `vat claude context` | **hard error, exit 2** | exit 0 |
 * | `vat inventory <plugin>` | tolerates, warns, exit 0 | exit 0, silent |
 * | `collectionsOption` (all three population lanes) | throws | `{}` |
 *
 * Rows 1–2 are the original guard: PR #135 migrated `vat skill review` from the
 * throwing `loadConfig` to the shared `resolveSkillPackagingConfig` (→
 * `loadConfigCached`), which used to swallow a broken config to `undefined`. That
 * silently downgraded review (and would let `vat skill test` stage the wrong
 * subject). A broken config now surfaces as `ConfigLoadError`; `vat audit` still
 * catches it and falls back so a bulk scan is never aborted.
 *
 * Rows 3–5 arrived with parse routing by declared MIME type. Every population
 * lane now READS `resources.collections` off the project root
 * (`collectionsOption`) to decide which parser runs, so commands that never
 * opened the config before now open it:
 *
 * - `vat claude context` is a deliberate behaviour REGRESSION — it read no config
 *   at all before, and a broken one now exits 2 like every other config-dependent
 *   command. Pinned here so the change is a decision rather than a surprise.
 * - `vat inventory` must NOT follow it. Its subject is frequently a THIRD PARTY's
 *   plugin, and root discovery is config-anchored, so someone else's unparseable
 *   YAML would otherwise decide whether our read-only inventory runs. It degrades
 *   to the link walk and says so — naming the CONFIG, not our own membership
 *   lane, which is the misattribution this row exists to keep fixed.
 * - The absent-config column is the one nobody would notice breaking: all three
 *   population lanes depend on "no config file ⇒ `{}`, never a throw", and a
 *   tightening of `loadConfig` would take out all three at once.
 */

import fs from 'node:fs';

import { normalizedTmpdir, safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { resolveSkillPackagingConfig } from '../../src/skill-resolution/packaging-config.js';
import { ConfigLoadError, resetLoadedConfigCache } from '../../src/utils/config-loader.js';
import { collectionsOption } from '../../src/utils/population-wiring.js';
import { executeCli, getBinPath } from '../system/test-common.js';
import { gitAddAll, initTestGitRepo, runAudit } from '../test-helpers.js';

const binPath = getBinPath(import.meta.url);

/** The line `vat inventory` must NOT print for a config failure — it names our lane, not the cause. */
const MISATTRIBUTED = 'the projection membership lane failed';

/**
 * A plugin directory with one skill, under `root`.
 *
 * `vat inventory` reaches the projection membership lane only for the
 * plugin-directory subject shape, and only when discovery finds at least one
 * SKILL.md — a plugin of commands alone populates nothing and would tolerate any
 * config by doing nothing at all.
 *
 * @param root - The tree the plugin sits in (whose config governs it)
 * @returns The plugin directory to hand `vat inventory`
 */
function writePluginFixture(root: string): string {
  const pluginDir = safePath.join(root, 'plugin');
  fs.mkdirSync(safePath.join(pluginDir, '.claude-plugin'), { recursive: true });
  fs.mkdirSync(safePath.join(pluginDir, 'skills', 'demo'), { recursive: true });
  fs.writeFileSync(
    safePath.join(pluginDir, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'demo-plugin', description: 'A demo plugin.', version: '0.0.1' }),
  );
  fs.writeFileSync(
    safePath.join(pluginDir, 'skills', 'demo', 'SKILL.md'),
    `---
name: demo
description: A demo skill whose governing config decides the parse routing.
---

# demo

Body content.
`,
  );
  return pluginDir;
}

describe('broken governing config behavior (integration)', () => {
  let tempDir: string;
  let skillPath: string;
  let pluginDir: string;
  /** The same tree shape with NO config file at all — the other column of the map. */
  let noConfigDir: string;
  let noConfigPluginDir: string;

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
    pluginDir = writePluginFixture(tempDir);

    gitAddAll(tempDir);

    // The control tree: identical but for the config file, and a git root so
    // `findProjectRoot` still resolves — without a root the inventory lane
    // declines before it would ever read a config, which would make the
    // absent-config row prove nothing.
    noConfigDir = fs.mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-absent-cfg-'));
    initTestGitRepo(noConfigDir);
    fs.writeFileSync(safePath.join(noConfigDir, 'package.json'), JSON.stringify({ name: 'absent-cfg-fixture' }));
    noConfigPluginDir = writePluginFixture(noConfigDir);
    gitAddAll(noConfigDir);
  });

  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    fs.rmSync(noConfigDir, { recursive: true, force: true });
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

  it('vat claude context fails hard on the broken config (exit 2) — it reads one now, and did not before', async () => {
    const result = await executeCli(binPath, ['claude', 'context'], { cwd: tempDir });

    expect(result.status).toBe(2);
    // The error document still goes to stdout in the command's own shape, so a
    // consumer parsing it sees a status rather than a truncated answer.
    expect(result.stdout).toContain('status: error');
    expect(result.stdout).toContain('Failed to load config');
    expect(result.stderr).toContain('claude context failed');
  });

  it('vat inventory tolerates the broken config, exits 0, and blames the CONFIG rather than its own lane', async () => {
    const result = await executeCli(binPath, ['inventory', pluginDir], { cwd: tempDir });

    expect(result.status).toBe(0);
    // Still a complete inventory: the link walk answered membership.
    expect(result.stdout).toContain('name: demo');
    // The diagnosis, and the exact wording that was wrong before: a config that
    // will not parse is not a failure of the projection membership lane.
    expect(result.stderr).toContain('vibe-agent-toolkit.config.yaml governing');
    // Which config: the one at the root the plugin resolved to, spelled out, so
    // the reader of a third party's tree knows whose YAML to go and look at.
    // Forward-slashed on both sides — the warning is built with `safePath`.
    expect(toForwardSlash(result.stderr)).toContain(toForwardSlash(tempDir));
    expect(result.stderr).not.toContain(MISATTRIBUTED);
  });

  it('an ABSENT config is not a broken one: collectionsOption answers {} and never throws', () => {
    // Every population lane (claude context, claude budget, inventory, the
    // resource loader) funnels through this one read, so this is the pin that
    // keeps a `loadConfig` tightening from silently taking out all of them.
    expect(collectionsOption(noConfigDir)).toEqual({});
  });

  it('vat inventory on a config-less tree populates silently (exit 0, no degradation warning)', async () => {
    const result = await executeCli(binPath, ['inventory', noConfigPluginDir], { cwd: noConfigDir });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('name: demo');
    expect(result.stderr).not.toContain('[vat] Warning');
  });
});

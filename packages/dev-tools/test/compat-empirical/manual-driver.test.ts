/**
 * Regression test for ManualDriverBase.setup idempotency.
 *
 * Background: setup() builds a bundleRoot from `${prefix}-${pid}`. Same PID
 * means same path, so a second setup() call without an intervening teardown
 * would silently reuse the prior bundleRoot — leaking the first run's bundles
 * into the second "run" via the install() existsSync reuse branch. The fix
 * adds a teardown-first guard at the top of setup().
 *
 * This test confirms repeat-setup() does NOT inherit state from a prior
 * install().
 */

/* eslint-disable security/detect-non-literal-fs-filename -- harness-controlled tmpdir paths */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';

import { mkdirSyncReal, normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { StagedSkill } from '../../src/compat-empirical/corpus/fetch-sources.js';
import { ManualDriverBase } from '../../src/compat-empirical/runtimes/shared/manual-driver.js';

let tmpRoot: string;
let stagedRoot: string;

function makeStagedSkill(entryId: string): StagedSkill {
  const rootDir = safePath.join(stagedRoot, entryId);
  const skillPath = safePath.join(rootDir, 'SKILL.md');
  rmSync(rootDir, { recursive: true, force: true });
  mkdirSyncReal(rootDir, { recursive: true });
  writeFileSync(skillPath, `# ${entryId}\n`, 'utf8');
  return { entryId, rootDir, skillPath };
}

beforeEach(() => {
  tmpRoot = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-manual-driver-test-'));
  stagedRoot = safePath.join(tmpRoot, 'staged');
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('ManualDriverBase.setup idempotency', () => {
  it('clears prior bundles when setup() is called twice without teardown', async () => {
    const driver = new ManualDriverBase({
      target: 'claude-chat',
      driverMode: 'manual',
      tmpdirPrefix: 'vat-manual-driver-idempotency-test',
      instructionText: 'noop',
    });

    await driver.setup();
    const firstSkill = makeStagedSkill('skill-one');
    const firstInstall = await driver.install(firstSkill);
    // Capture the prior bundle path. After a second setup() without teardown,
    // it should no longer exist on disk — the guard tears down first.
    const priorBundlePath = firstInstall.notes.replace(/^bundle prepared at /, '');
    expect(existsSync(priorBundlePath)).toBe(true);

    await driver.setup();
    expect(existsSync(priorBundlePath)).toBe(false);

    await driver.teardown();
  });

  it('install() after a second setup() prepares a fresh bundle (not reused)', async () => {
    const driver = new ManualDriverBase({
      target: 'claude-chat',
      driverMode: 'manual',
      tmpdirPrefix: 'vat-manual-driver-idempotency-test-2',
      instructionText: 'noop',
    });

    await driver.setup();
    const skill = makeStagedSkill('skill-one');
    const firstInstall = await driver.install(skill);
    expect(firstInstall.notes).toMatch(/^bundle prepared at /);

    await driver.setup();
    const secondInstall = await driver.install(skill);
    // Without the idempotency guard, the second install would see the
    // surviving bundle from the first install and return "bundle reused".
    expect(secondInstall.notes).toMatch(/^bundle prepared at /);

    await driver.teardown();
  });
});

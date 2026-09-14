/**
 * `vat verify`'s `packaged-content` phase over a PARTIALLY built `dist/`.
 *
 * The reproduced case: two skills discovered, `vat build`, `rm -rf
 * dist/skills/beta`. The phase used to publish `status: success,
 * bundlesInspected: 1` and exit 0 — a verdict over half the build. It must now
 * publish `bundlesExpected: 2` beside `bundlesInspected: 1`, name `beta` as
 * missing, and refuse (exit 1). The control arm, both bundles present, must
 * stay `success` with the two counts equal.
 *
 * Discovery is wired exactly as `vat verify` wires it, so the fixture cannot
 * pass by the test handing the phase a list it never derived.
 */

import { rmSync, writeFileSync } from 'node:fs';

import { mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, describe, expect, it } from 'vitest';

import { exitCodeForPhases } from '../../src/commands/phase-utils.js';
import { discoverSkillsFromConfig } from '../../src/commands/skills/skill-discovery.js';
import {
  checkPackagedAgentInstructionFiles,
  runPackagedContentPhase,
  type PackagedContentCrawl,
  type PackagedContentPhaseResult,
} from '../../src/commands/verify.js';
import { loadConfig } from '../../src/utils/config-loader.js';
import { createTempDirTracker } from '../system/test-common.js';
import { recordingLogger } from '../test-doubles.js';

const { createTempDir, cleanupTempDirs } = createTempDirTracker('vat-verify-pc-coverage-');

const SKILLS = ['alpha', 'beta'] as const;
const BETA_BUNDLE = 'dist/skills/beta';

/** Two discovered skills, both built into `dist/skills/`. */
function setupTwoBuiltSkills(): string {
  const root = createTempDir();
  writeFileSync(
    safePath.join(root, 'vibe-agent-toolkit.config.yaml'),
    'version: 1\nskills:\n  include:\n    - "skills/*/SKILL.md"\n',
    'utf-8',
  );
  for (const name of SKILLS) {
    const sourceDir = safePath.join(root, 'skills', name);
    mkdirSyncReal(sourceDir, { recursive: true });
    writeFileSync(
      safePath.join(sourceDir, 'SKILL.md'),
      `---\nname: ${name}\ndescription: Fixture skill ${name} for the packaged-content coverage test.\n---\n\n# ${name}\n`,
      'utf-8',
    );
    const bundleDir = safePath.join(root, 'dist', 'skills', name);
    mkdirSyncReal(bundleDir, { recursive: true });
    writeFileSync(safePath.join(bundleDir, 'SKILL.md'), `# ${name}\n`, 'utf-8');
  }
  return root;
}

async function discoveredIn(root: string): Promise<Awaited<ReturnType<typeof discoverSkillsFromConfig>>> {
  const config = loadConfig(root);
  return config?.skills ? discoverSkillsFromConfig(config.skills, root, 'refuse') : [];
}

async function crawlIn(root: string): Promise<PackagedContentCrawl> {
  return checkPackagedAgentInstructionFiles(root, await discoveredIn(root));
}

async function phaseIn(root: string): Promise<{ phase: PackagedContentPhaseResult; stderr: string }> {
  const { logger, lines } = recordingLogger();
  const phase = runPackagedContentPhase(root, await discoveredIn(root), logger);
  return { phase, stderr: lines.join('\n') };
}

/**
 * The refusal shape for a run whose `beta` bundle is not a directory: the crawl
 * counts 1 of 2 and names `beta`; the phase is `error`, carries ONE
 * run-integrity finding naming `beta`, and exits 1.
 */
async function expectBetaMissing(root: string): Promise<{ phase: PackagedContentPhaseResult; stderr: string }> {
  const crawl = await crawlIn(root);
  expect(crawl.bundlesInspected).toBe(1);
  expect(crawl.bundlesExpected).toBe(2);
  expect(crawl.bundlesMissing).toEqual([BETA_BUNDLE]);

  const outcome = await phaseIn(root);
  expect(outcome.phase.status).toBe('error');
  expect(outcome.phase.issues.map((i) => i.code)).toEqual(['RESOURCE_CHECK_BROKEN']);
  expect(outcome.phase.issues[0]?.message).toContain(BETA_BUNDLE);
  expect(exitCodeForPhases([outcome.phase])).toBe(1);
  return outcome;
}

describe('packaged-content over a partially built dist/', () => {
  afterEach(() => {
    cleanupTempDirs();
  });

  it('control: both bundles present ⇒ success, expected === inspected === 2', async () => {
    const root = setupTwoBuiltSkills();

    const crawl = await crawlIn(root);
    expect(crawl).toEqual({ bundlesInspected: 2, bundlesExpected: 2, bundlesMissing: [], issues: [] });

    const { phase } = await phaseIn(root);
    expect(phase.status).toBe('success');
    expect(phase.bundlesExpected).toBe(2);
    expect(phase.bundlesInspected).toBe(2);
    expect(exitCodeForPhases([phase])).toBe(0);
  });

  it('one bundle deleted ⇒ error naming `beta`, exit 1', async () => {
    const root = setupTwoBuiltSkills();
    rmSync(safePath.join(root, 'dist', 'skills', 'beta'), { recursive: true, force: true });

    const { phase, stderr } = await expectBetaMissing(root);
    expect(phase.bundlesMissing).toEqual([BETA_BUNDLE]);
    expect(phase.issues[0]?.message).not.toContain('alpha');
    // stderr and the document carry one list (run-integrity invariant 6).
    expect(stderr).toContain('RESOURCE_CHECK_BROKEN');
    expect(stderr).toContain(BETA_BUNDLE);
  });

  it('a regular FILE where the bundle dir should be ⇒ missing by name, not a throw', async () => {
    // "Exists" is not "is a directory". A file at `dist/skills/beta` passed
    // `existsSync`, was counted as built, and the crawl then threw `Base path
    // is not a directory: /abs/…` out of the whole command — exit 2, no
    // document, an absolute path on stderr — where the missing-bundle lane
    // would have named it at exit 1 with the document.
    const root = setupTwoBuiltSkills();
    rmSync(safePath.join(root, 'dist', 'skills', 'beta'), { recursive: true, force: true });
    writeFileSync(safePath.join(root, 'dist', 'skills', 'beta'), 'not a dir\n', 'utf-8');

    const { phase } = await expectBetaMissing(root);
    // Named in the run's coordinates, never the build host's.
    expect(phase.issues[0]?.message).not.toContain(root);
  });

  it('a stale skills.config key is not an expected bundle (the consistency phase owns that)', async () => {
    // `skills.config.ghost` names a skill discovery does not reach. Its bundle is
    // still LOOKED FOR (a stale glob may leave one in dist/), but its absence is
    // not this phase's refusal: consistency-check already reports the key.
    const root = setupTwoBuiltSkills();
    writeFileSync(
      safePath.join(root, 'vibe-agent-toolkit.config.yaml'),
      'version: 1\nskills:\n  include:\n    - "skills/*/SKILL.md"\n  config:\n    ghost: {}\n',
      'utf-8',
    );

    const crawl = await crawlIn(root);
    expect(crawl).toEqual({ bundlesInspected: 2, bundlesExpected: 2, bundlesMissing: [], issues: [] });
  });
});

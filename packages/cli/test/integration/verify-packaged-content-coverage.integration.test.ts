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
 * The second half pins the in-place (`publish: false`) contract: such a skill's
 * pool bundle is never expected, while a plugin-local skill's always is.
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
    expect(crawl).toEqual({ bundlesInspected: 2, bundlesExpected: 2, bundlesInPlace: 0, bundlesMissing: [], issues: [] });

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
    expect(crawl).toEqual({ bundlesInspected: 2, bundlesExpected: 2, bundlesInPlace: 0, bundlesMissing: [], issues: [] });
  });
});

// ---------------------------------------------------------------------------
// In-place (publish: false) skills
//
// A project that runs `vat build --only claude`: its plugin-local skills ship
// (tree-copied into the plugin); its other skills are in `skills.include` for
// validation only and used in place. The phase used to expect a pool bundle for
// EVERY discovered skill, so it could not tell "build never ran" from "build ran
// as configured". `publish: false` (merged from `skills.defaults` and
// `skills.config.<name>`) declares an in-place skill — never bundled, never
// expected. Plugin-local skills are outside `publish`'s scope and always expected.
//
// A skill that is BOTH discovered by `skills.include` and plugin-local is, with
// `publish` unset, expected TWICE — a full build really does produce its pool
// bundle AND its plugin-tree copy — so the `--only claude` fix is one line,
// `skills.defaults.publish: false`.
// ---------------------------------------------------------------------------

const MARKETPLACE = 'mp';
const PLUGIN = 'plug';
const PLUGIN_LOCAL = 'shipped';
const POOL = 'used-in-place';
const POOL_BUNDLE = `dist/skills/${POOL}`;
const PLUGIN_LOCAL_POOL_BUNDLE = `dist/skills/${PLUGIN_LOCAL}`;
const PLUGIN_TREE_BUNDLE = `dist/.claude/plugins/marketplaces/${MARKETPLACE}/plugins/${PLUGIN}/skills/${PLUGIN_LOCAL}`;

function writeSkillMd(dir: string, name: string): void {
  mkdirSyncReal(dir, { recursive: true });
  writeFileSync(safePath.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: In-place fixture ${name}.\n---\n`, 'utf-8');
}

/**
 * Two discovered skills: `shipped` is plugin-local (tree-copied via
 * `claude.marketplaces`) AND discovered by `skills.include`; `used-in-place` is a
 * pool-only skill. `publish` writes the flag where named. `dist/` is left as
 * `vat build --only claude` leaves it — the plugin tree dir present, no
 * `dist/skills` — plus whichever pool bundles `poolBundles` names.
 */
function setupProject(opts: {
  publish: 'per-skill-false' | 'defaults-false' | 'unset';
  poolBundles: readonly string[];
}): string {
  const root = createTempDir();
  const publishLines = {
    'per-skill-false': `  config:\n    ${POOL}:\n      publish: false\n`,
    'defaults-false': '  defaults:\n    publish: false\n',
    unset: '',
  }[opts.publish];
  writeFileSync(
    safePath.join(root, 'vibe-agent-toolkit.config.yaml'),
    'version: 1\n'
      + 'skills:\n'
      + '  include:\n'
      + '    - "skills/*/SKILL.md"\n'
      + `    - "plugins/${PLUGIN}/skills/*/SKILL.md"\n`
      + publishLines
      + 'claude:\n'
      + '  marketplaces:\n'
      + `    ${MARKETPLACE}:\n`
      + '      owner:\n'
      + '        name: Test Org\n'
      + '      plugins:\n'
      + `        - name: ${PLUGIN}\n`
      + '          description: Plugin whose skills ship by location\n'
      + `          source: plugins/${PLUGIN}\n`
      + '          skills: []\n',
    'utf-8',
  );
  writeSkillMd(safePath.join(root, 'skills', POOL), POOL);
  writeSkillMd(safePath.join(root, 'plugins', PLUGIN, 'skills', PLUGIN_LOCAL), PLUGIN_LOCAL);
  // The claude phase's output for the plugin-local skill.
  writeSkillMd(safePath.join(root, PLUGIN_TREE_BUNDLE), PLUGIN_LOCAL);
  for (const name of opts.poolBundles) writeSkillMd(safePath.join(root, 'dist', 'skills', name), name);
  return root;
}

async function inPlaceCrawlIn(root: string): Promise<PackagedContentCrawl> {
  const discovered = await discoveredIn(root);
  // Both skills are discovered either way — `publish` narrows what is EXPECTED, never what exists.
  expect(discovered.map((s) => s.name).sort((a, b) => a.localeCompare(b))).toEqual([PLUGIN_LOCAL, POOL]);
  const crawl = checkPackagedAgentInstructionFiles(root, discovered);
  return { ...crawl, bundlesMissing: [...crawl.bundlesMissing].sort((a, b) => a.localeCompare(b)) };
}

/** The refusal shape: one run-integrity finding, exit 1. */
async function expectRefused(root: string): Promise<void> {
  const { phase } = await phaseIn(root);
  expect([phase.status, ...phase.issues.map((i) => i.code), exitCodeForPhases([phase])]).toEqual(['error', 'RESOURCE_CHECK_BROKEN', 1]);
}

describe('packaged-content with in-place (publish: false) skills', () => {
  afterEach(() => {
    cleanupTempDirs();
  });

  it('positive control (the rc.7 blindness fix): publish unset ⇒ BOTH discovered skills expect a pool bundle, the tree copy too ⇒ 1 of 3, exit 1', async () => {
    const root = setupProject({ publish: 'unset', poolBundles: [] });

    const crawl = await inPlaceCrawlIn(root);
    expect(crawl).toMatchObject({
      bundlesInspected: 1,
      bundlesExpected: 3,
      bundlesMissing: [PLUGIN_LOCAL_POOL_BUNDLE, POOL_BUNDLE],
    });
    await expectRefused(root);
  });

  it('skills.defaults.publish: false ⇒ no pool bundle is expected; the plugin-tree copy still is ⇒ 1 of 1, exit 0', async () => {
    const root = setupProject({ publish: 'defaults-false', poolBundles: [] });

    const crawl = await inPlaceCrawlIn(root);
    expect(crawl).toEqual({ bundlesInspected: 1, bundlesExpected: 1, bundlesInPlace: 2, bundlesMissing: [], issues: [] });

    const { phase } = await phaseIn(root);
    expect(phase.status).toBe('success');
    expect(phase.bundlesExpected).toBe(1);
    expect(phase.bundlesInspected).toBe(1);
    expect(exitCodeForPhases([phase])).toBe(0);
  });

  it('per-skill publish: false on the pool-only skill narrows expected by ONE — the discovered plugin-local skill still expects its pool bundle', async () => {
    const root = setupProject({ publish: 'per-skill-false', poolBundles: [] });

    const crawl = await inPlaceCrawlIn(root);
    expect(crawl).toMatchObject({ bundlesInspected: 1, bundlesExpected: 2, bundlesMissing: [PLUGIN_LOCAL_POOL_BUNDLE] });
    await expectRefused(root);
  });

  it('a plugin-local skill is expected whatever publish says: delete its tree dir ⇒ missing by path, exit 1', async () => {
    const root = setupProject({ publish: 'defaults-false', poolBundles: [] });
    rmSync(safePath.join(root, PLUGIN_TREE_BUNDLE), { recursive: true, force: true });

    const crawl = await inPlaceCrawlIn(root);
    expect(crawl).toMatchObject({ bundlesInspected: 0, bundlesExpected: 1, bundlesMissing: [PLUGIN_TREE_BUNDLE] });
    await expectRefused(root);
  });

  it('the rc.7 case must not regress: publish unset, everything built, one pool bundle deleted by hand ⇒ still missing, exit 1', async () => {
    const root = setupProject({ publish: 'unset', poolBundles: [PLUGIN_LOCAL, POOL] });
    expect(await inPlaceCrawlIn(root)).toMatchObject({ bundlesInspected: 3, bundlesExpected: 3, bundlesMissing: [] });

    rmSync(safePath.join(root, 'dist', 'skills', POOL), { recursive: true, force: true });
    expect(await inPlaceCrawlIn(root)).toMatchObject({ bundlesInspected: 2, bundlesExpected: 3, bundlesMissing: [POOL_BUNDLE] });
    await expectRefused(root);
  });

  it('an in-place skill whose STALE bundle sits in dist/skills is inspected, not expected', async () => {
    const root = setupProject({ publish: 'defaults-false', poolBundles: [POOL] });

    const crawl = await inPlaceCrawlIn(root);
    // Distributed output is looked at (it is in dist/); nothing in this run builds it.
    expect(crawl).toEqual({ bundlesInspected: 2, bundlesExpected: 1, bundlesInPlace: 2, bundlesMissing: [], issues: [] });
    expect(exitCodeForPhases([(await phaseIn(root)).phase])).toBe(0);
  });

  it('every discovered skill in place and no plugin ⇒ 0 expected, 0 inspected, 2 in place: a visible no-op, exit 0', async () => {
    const root = poolOnlyProject('skills/*/SKILL.md');

    const { phase, stderr } = await phaseIn(root);
    expect([phase.status, phase.issues.map((i) => i.code), exitCodeForPhases([phase])]).toEqual(['success', [], 0]);
    expect(stderr).toContain('all 2 discovered skill(s) are in place');
    expect(await crawlIn(root)).toEqual({ bundlesInspected: 0, bundlesExpected: 0, bundlesInPlace: 2, bundlesMissing: [], issues: [] });
    expect(phase).toMatchObject({ bundlesInspected: 0, bundlesExpected: 0, bundlesInPlace: 2 });
  });

  it('publish: false over a glob that discovers NOTHING is still the zero-bundle refusal — in-place counts discovered skills, never config', async () => {
    const root = poolOnlyProject('nothing/*/SKILL.md');

    expect(await crawlIn(root)).toMatchObject({ bundlesInspected: 0, bundlesExpected: 0, bundlesInPlace: 0 });
    await expectRefused(root);
  });
});

/** The two `alpha`/`beta` source skills, nothing built, every skill `publish: false` via `skills.defaults`, no plugins. */
function poolOnlyProject(includeGlob: string): string {
  const root = setupTwoBuiltSkills();
  rmSync(safePath.join(root, 'dist'), { recursive: true, force: true });
  writeFileSync(
    safePath.join(root, 'vibe-agent-toolkit.config.yaml'),
    `version: 1\nskills:\n  include:\n    - "${includeGlob}"\n  defaults:\n    publish: false\n`,
    'utf-8',
  );
  return root;
}

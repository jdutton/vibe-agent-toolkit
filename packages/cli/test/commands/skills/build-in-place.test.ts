/**
 * `vat skills build` and IN-PLACE skills (`publish: false`), at the unit seam.
 *
 * The system test drives the real binary; these pin the same partition, info
 * line, `--skill` refusal and published counts in-process. The phase runner's
 * I/O neighbours (config load, discovery, project-root policy) are stubbed; the
 * plugin-local cases write a real project to a temp dir, because whether a skill
 * ships with its plugin is answered by listing what the plugin build packages.
 */

import { indexPluginLocalSkills } from '@vibe-agent-toolkit/agent-skills';
import type { ProjectConfig, SkillsConfig } from '@vibe-agent-toolkit/resources';
import { safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as yaml from 'yaml';

import {
  buildBuildDocument,
  formatBuiltSuccessLine,
  inPlaceSkillRefusal,
  logInPlaceSkills,
  outputBuildYaml,
  partitionInPlaceSkills,
  runSkillsBuildPhase,
  type BuildSkillSpec,
} from '../../../src/commands/skills/build.js';
import type { DiscoveredSkill } from '../../../src/commands/skills/command-helpers.js';
import {
  pluginProjectConfig,
  pluginSkillDir,
  writeSkillProject,
  type FixtureSkill,
} from '../../helpers/plugin-local-fixture.js';
import { createTempDirTracker } from '../../system/test-common.js';
import { recordingLogger } from '../../test-doubles.js';

const tempDirs = createTempDirTracker('vat-build-plugin-local-');

const harness = vi.hoisted(() => ({
  config: undefined as Pick<ProjectConfig, 'claude'> & { skills: SkillsConfig } | undefined,
  /** The project root the phase runs in — a real temp dir for the plugin-local cases, which list it. */
  cwd: '/project',
  discovered: [] as DiscoveredSkill[],
  lines: [] as string[],
}));

vi.mock('../../../src/utils/config-loader.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  loadConfig: () => harness.config,
}));
vi.mock('../../../src/commands/skills/skill-discovery.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  discoverSkillsFromConfig: () => Promise.resolve(harness.discovered),
}));
vi.mock('../../../src/utils/project-root-policy.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  requireProjectRoot: () => harness.cwd,
}));
vi.mock('../../../src/commands/skills/command-helpers.js', async (importOriginal) => {
  const { recordingLogger: recorder } = await import('../../test-doubles.js');
  return {
    ...(await importOriginal<object>()),
    setupCommandContext: () => {
      const { logger, lines } = recorder();
      harness.lines = lines;
      return { logger, cwd: harness.cwd, startTime: Date.now() };
    },
  };
});

const IN_PLACE_KEY = 'publish: false';
const IN_PLACE = 'in-place';
/** The declared name of the plugin-local skill. */
const PLUGIN_LOCAL = 'shipped';

/** The repo-only skill beside the plugin-local one; its directory is not named after it. */
const KEPT: FixtureSkill = { dir: 'skills/kept-dir', name: 'kept' };
/** The plugin-local skill: under plugin `p`'s `skills/` dir, in a directory not named after it. */
const SHIPPED: FixtureSkill = { dir: pluginSkillDir('shipped-dir'), name: PLUGIN_LOCAL };

function skill(name: string): DiscoveredSkill {
  return { name, sourcePath: safePath.resolve(`/project/skills/${name}/SKILL.md`) };
}

function specs(names: readonly string[]): BuildSkillSpec[] {
  return names.map((name) => ({ skill: skill(name), packagingConfig: { publish: false } as BuildSkillSpec['packagingConfig'] }));
}

function namesOf(list: readonly BuildSkillSpec[]): string[] {
  return list.map((spec) => spec.skill.name);
}

/**
 * Write a `skills.defaults.publish: false` project to a temp dir — by default {@link KEPT}
 * beside {@link SHIPPED} — and point the stubbed phase at it.
 */
function givenPluginProject(
  skills: readonly FixtureSkill[] = [KEPT, SHIPPED],
  git: Parameters<typeof writeSkillProject>[2] = 'none',
): void {
  harness.cwd = tempDirs.createTempDir();
  harness.config = pluginProjectConfig(false) as typeof harness.config;
  harness.discovered = writeSkillProject(harness.cwd, skills, git);
}

/** Stub a project with one published skill (`built`) and one in-place skill (`kept`). */
function givenProject(): void {
  harness.config = { skills: { include: ['skills/**'], config: { kept: { publish: false } } } };
  harness.discovered = [skill('built'), skill('kept')];
}

function resetHarness(): void {
  harness.config = undefined;
  harness.cwd = '/project';
  harness.discovered = [];
  tempDirs.cleanupTempDirs();
}

/** The plugin-local index for the stubbed project — the one the phase itself builds. */
function pluginLocalIndex(): ReturnType<typeof indexPluginLocalSkills> {
  return indexPluginLocalSkills(harness.config as ProjectConfig, harness.cwd);
}

/** Run `logInPlaceSkills` over `count` generated names; return every logged line. */
function inPlaceLines(count: number): { names: string[]; lines: string[] } {
  const names = Array.from({ length: count }, (_, i) => `skill-${String(i + 1).padStart(2, '0')}`);
  const { logger, lines } = recordingLogger();
  logInPlaceSkills(specs(names), logger);
  return { names, lines };
}

/** Capture everything `fn` writes to stdout. */
async function captureStdout(fn: () => unknown): Promise<string> {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    chunks.push(String(chunk));
    return true;
  });
  try {
    await fn();
  } finally {
    spy.mockRestore();
  }
  return chunks.join('');
}

describe('partitionInPlaceSkills', () => {
  afterEach(resetHarness);

  it('sets publish:false skills aside, in discovery order, honouring defaults and per-skill overrides', () => {
    const { buildSpecs, inPlace } = partitionInPlaceSkills(
      [skill('a'), skill('b'), skill('c')],
      { include: ['skills/**'], defaults: { publish: false }, config: { b: { publish: true, linkFollowDepth: 1 } } },
      indexPluginLocalSkills({ version: 1 }, '/project'),
    );

    expect(namesOf(buildSpecs)).toEqual(['b']);
    expect(buildSpecs[0]?.packagingConfig).toMatchObject({ publish: true, linkFollowDepth: 1 });
    expect(namesOf(inPlace)).toEqual(['a', 'c']);
  });

  it('bundles every skill when nothing says publish:false', () => {
    const { buildSpecs, inPlace } = partitionInPlaceSkills(
      [skill('a'), skill('b')],
      { include: ['skills/**'] },
      indexPluginLocalSkills({ version: 1 }, '/project'),
    );

    expect(namesOf(buildSpecs)).toEqual(['a', 'b']);
    expect(inPlace).toEqual([]);
  });

  it('never counts a plugin-local publish:false skill as in place: it is set aside as plugin-only', () => {
    givenPluginProject();

    const { buildSpecs, inPlace, pluginOnly } = partitionInPlaceSkills(
      harness.discovered,
      { include: ['**/SKILL.md'], defaults: { publish: false } },
      pluginLocalIndex(),
    );

    expect([namesOf(buildSpecs), namesOf(inPlace), namesOf(pluginOnly)]).toEqual([[], [KEPT.name], [PLUGIN_LOCAL]]);
  });

  it('still bundles a plugin-local skill into the pool when it is published', () => {
    givenPluginProject([SHIPPED]);

    const { buildSpecs, inPlace, pluginOnly } = partitionInPlaceSkills(
      harness.discovered,
      { include: ['**/SKILL.md'] },
      pluginLocalIndex(),
    );

    expect([namesOf(buildSpecs), inPlace, pluginOnly]).toEqual([[PLUGIN_LOCAL], [], []]);
  });
});

describe('logInPlaceSkills — one info line, names capped at ten', () => {
  it('logs nothing when no skill is in place', () => {
    expect(inPlaceLines(0).lines).toEqual([]);
  });

  it('names all of exactly ten skills with no "more" tail', () => {
    const { names, lines } = inPlaceLines(10);

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('Skipping 10 in-place skill(s)');
    expect(lines[0]).toContain(IN_PLACE_KEY);
    expect(lines[0]).toContain(names.join(', '));
    expect(lines[0]).not.toContain('more');
  });

  it('names the first ten of eleven and counts the rest', () => {
    const { names, lines } = inPlaceLines(11);

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('Skipping 11 in-place skill(s)');
    expect(lines[0]).toContain(`${names.slice(0, 10).join(', ')} … and 1 more`);
    expect(lines[0]).not.toContain(names[10]);
  });
});

describe('inPlaceSkillRefusal — --skill on an in-place skill', () => {
  it('refuses, naming the config key that makes the skill in-place', () => {
    const refusal = inPlaceSkillRefusal('a', specs(['a']));

    expect(refusal).toBeInstanceOf(Error);
    expect(refusal?.message).toContain('Skill "a" is an in-place skill');
    expect(refusal?.message).toContain('skills.config.a.publish is false');
    expect(refusal?.message).toContain('drop --skill');
  });

  it('does not refuse without --skill, or when the named skill is published', () => {
    expect(inPlaceSkillRefusal(undefined, specs(['a']))).toBeUndefined();
    expect(inPlaceSkillRefusal('a', [])).toBeUndefined();
  });
});

describe('the published build report carries the set-aside counts', () => {
  const run = { results: [], failures: [], runIssues: [], skillsWithErrors: [], validationFailures: [], outputCommitted: true };

  it('formats the success line with the in-place tail only when there is one', () => {
    expect(formatBuiltSuccessLine(3, 0)).toBe('\nBuilt 3 skill(s) successfully');
    expect(formatBuiltSuccessLine(3, 2)).toBe('\nBuilt 3 skill(s) successfully (2 in-place skill(s) not bundled)');
  });

  it('publishes skillsInPlace and skillsPluginOnly in the header and their names in the body', async () => {
    const names = ['a', 'b'];
    const document = buildBuildDocument(run, { inPlace: names, pluginOnly: [PLUGIN_LOCAL] }, 5);

    expect(document).toMatchObject({
      skillsInPlace: 2,
      skillsPluginOnly: 1,
      skillsInPlaceNames: names,
      skillsPluginOnlyNames: [PLUGIN_LOCAL],
    });
    expect(document['skillsInPlaceNames']).not.toBe(names);

    const stdout = await captureStdout(() => outputBuildYaml(document));
    const header = stdout.split('\n').slice(0, 5).join('\n');
    expect(header).toContain('skillsInPlace: 2');
    expect(header).toContain('skillsPluginOnly: 1');
    expect(yaml.parse(stdout)).toMatchObject({ skillsInPlaceNames: names, skillsPluginOnlyNames: [PLUGIN_LOCAL] });
  });
});

/** Dry-run the stubbed project; return the exit code and the parsed stdout document. */
async function dryRunDocument(): Promise<{ exitCode: number | undefined; document: unknown }> {
  let outcome: Awaited<ReturnType<typeof runSkillsBuildPhase>> | undefined;
  const stdout = await captureStdout(async () => {
    outcome = await runSkillsBuildPhase(undefined, { dryRun: true });
  });
  return { exitCode: outcome?.exitCode, document: yaml.parse(stdout) };
}

/** `--skill <name>` against the stubbed project; return the exit code and the refusal text. */
async function refusalFor(name: string): Promise<{ exitCode: number; error: string }> {
  const outcome = await runSkillsBuildPhase(undefined, { skill: name });
  return { exitCode: outcome.exitCode, error: String((outcome.document as { error: string }).error) };
}

/** Whether the phase logged the one info line `Skipping <count> <label>…: <names>`. */
function loggedSetAside(count: number, label: string, names: string): boolean {
  return harness.lines.some((line) => line.startsWith(`Skipping ${count} ${label}`) && line.endsWith(`: ${names}`));
}

describe('runSkillsBuildPhase — in-place wiring', () => {
  afterEach(resetHarness);

  it('a dry run previews the partition on both streams', async () => {
    givenProject();

    const { exitCode, document } = await dryRunDocument();

    expect(exitCode).toBe(0);
    expect(document).toMatchObject({ skillsFound: 1, skillsInPlace: 1, skillsInPlaceNames: ['kept'] });
    expect(harness.lines).toContain('Found 1 skill(s) to build');
    expect(loggedSetAside(1, 'in-place skill(s)', 'kept')).toBe(true);
  });

  it('--skill naming an in-place skill exits 1 with the refusal as the document', async () => {
    givenProject();

    const outcome = await runSkillsBuildPhase(undefined, { skill: 'kept' });

    expect(outcome.exitCode).toBe(1);
    expect(outcome.failed).toBe(true);
    expect(outcome.document).toMatchObject({ status: 'error' });
    expect(String((outcome.document as { error: string }).error)).toContain('skills.config.kept.publish is false');
  });

  it('a dry run counts the plugin-local skill as plugin-only, never as in-place', async () => {
    givenPluginProject();

    const { exitCode, document } = await dryRunDocument();

    expect(exitCode).toBe(0);
    expect(document).toMatchObject({
      skillsFound: 0,
      skillsInPlace: 1,
      skillsInPlaceNames: [KEPT.name],
      skillsPluginOnly: 1,
      skillsPluginOnlyNames: [PLUGIN_LOCAL],
    });
    expect(loggedSetAside(1, 'in-place skill(s)', KEPT.name)).toBe(true);
    expect(harness.lines.filter((line) => line.includes(IN_PLACE) && line.includes(PLUGIN_LOCAL))).toEqual([]);
    expect(loggedSetAside(1, 'plugin-local skill(s)', PLUGIN_LOCAL)).toBe(true);
  });

  it('an UNTRACKED skill under a plugin skills/ dir does not ship with its plugin, so under publish:false it is in place', async () => {
    givenPluginProject([SHIPPED], { untracked: [SHIPPED.dir] });

    const { document } = await dryRunDocument();

    expect(document).toMatchObject({ skillsInPlace: 1, skillsInPlaceNames: [PLUGIN_LOCAL], skillsPluginOnly: 0 });
    expect(harness.lines.filter((line) => line.includes('plugin-local'))).toEqual([]);
    expect((await refusalFor(PLUGIN_LOCAL)).error).toContain(`Skill "${PLUGIN_LOCAL}" is an in-place skill`);
  });

  it('a repo-only skill sharing its declared name with a plugin-local one is in place, not plugin-only', async () => {
    givenPluginProject([{ dir: 'skills/twin-dir', name: PLUGIN_LOCAL }, SHIPPED]);

    const { document } = await dryRunDocument();

    expect(document).toMatchObject({ skillsInPlace: 1, skillsPluginOnly: 1 });
  });

  it('--skill naming a plugin-local publish:false skill exits 1 without calling it in-place', async () => {
    givenPluginProject();

    const { exitCode, error } = await refusalFor(PLUGIN_LOCAL);

    expect(exitCode).toBe(1);
    expect(error).not.toContain(IN_PLACE);
    expect(error).toContain('plugin-local');
    expect(error).toContain('claude');
  });

  it('control: in the same project --skill on the repo-only skill is still the in-place refusal', async () => {
    givenPluginProject();

    const { exitCode, error } = await refusalFor(KEPT.name);

    expect(exitCode).toBe(1);
    expect(error).toContain(`Skill "${KEPT.name}" is an in-place skill`);
  });
});

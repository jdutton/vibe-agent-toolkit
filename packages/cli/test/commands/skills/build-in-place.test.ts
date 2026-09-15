/**
 * `vat skills build` and IN-PLACE skills (`publish: false`), at the unit seam.
 *
 * The system test drives the real binary; these pin the same partition, info
 * line, `--skill` refusal and published counts without a project on disk. The
 * phase runner's I/O neighbours (config load, discovery, project-root policy,
 * and the plugin-local index) are stubbed so the dry-run and refusal wiring is
 * exercised in-process. The index listing a real project and git repository is
 * `test/integration/skills-build-plugin-local.integration.test.ts`.
 */

import type * as agentSkills from '@vibe-agent-toolkit/agent-skills';
import type { SkillsConfig } from '@vibe-agent-toolkit/resources';
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
import { fakePluginLocalIndex } from '../../helpers/plugin-local-fixture.js';
import { recordingLogger } from '../../test-doubles.js';

const harness = vi.hoisted(() => ({
  config: undefined as { skills: SkillsConfig } | undefined,
  discovered: [] as DiscoveredSkill[],
  /** What the phase's `indexPluginLocalSkills` returns; unset, the real (empty) index. */
  pluginLocal: undefined as agentSkills.PluginLocalSkillIndex | undefined,
  lines: [] as string[],
}));

vi.mock('@vibe-agent-toolkit/agent-skills', async (importOriginal) => {
  const original = await importOriginal<typeof agentSkills>();
  return {
    ...original,
    indexPluginLocalSkills: (...args: Parameters<typeof original.indexPluginLocalSkills>) =>
      harness.pluginLocal ?? original.indexPluginLocalSkills(...args),
  };
});
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
  requireProjectRoot: () => '/project',
}));
vi.mock('../../../src/commands/skills/command-helpers.js', async (importOriginal) => {
  const { recordingLogger: recorder } = await import('../../test-doubles.js');
  return {
    ...(await importOriginal<object>()),
    setupCommandContext: () => {
      const { logger, lines } = recorder();
      harness.lines = lines;
      return { logger, cwd: '/project', startTime: Date.now() };
    },
  };
});

const IN_PLACE_KEY = 'publish: false';
const IN_PLACE = 'in-place';
/** The declared name of the plugin-local skill. */
const PLUGIN_LOCAL = 'shipped';
const KEPT = 'kept';

function skill(name: string, dir = `skills/${name}`): DiscoveredSkill {
  return { name, sourcePath: safePath.resolve(`/project/${dir}/SKILL.md`) };
}

/** The plugin-local skill: under plugin `p`'s `skills/` dir, in a directory not named after it. */
const SHIPPED = skill(PLUGIN_LOCAL, 'plugins/p/skills/shipped-dir');

function specs(names: readonly string[]): BuildSkillSpec[] {
  return names.map((name) => ({ skill: skill(name), packagingConfig: { publish: false } as BuildSkillSpec['packagingConfig'] }));
}

function namesOf(list: readonly BuildSkillSpec[]): string[] {
  return list.map((spec) => spec.skill.name);
}

/** No skill is plugin-local. */
const NO_PLUGIN_LOCAL = fakePluginLocalIndex([]);

/**
 * Stub a `skills.defaults.publish: false` project — by default {@link KEPT} beside
 * {@link SHIPPED} — whose plugin-local index holds {@link SHIPPED}.
 */
function givenPluginProject(skills: readonly DiscoveredSkill[] = [skill(KEPT, 'skills/kept-dir'), SHIPPED]): void {
  harness.config = { skills: { include: ['**/SKILL.md'], defaults: { publish: false } } };
  harness.discovered = [...skills];
  harness.pluginLocal = fakePluginLocalIndex([SHIPPED]);
}

/** Stub a project with one published skill (`built`) and one in-place skill (`kept`). */
function givenProject(): void {
  harness.config = { skills: { include: ['skills/**'], config: { kept: { publish: false } } } };
  harness.discovered = [skill('built'), skill(KEPT)];
}

function resetHarness(): void {
  harness.config = undefined;
  harness.discovered = [];
  harness.pluginLocal = undefined;
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
  it('sets publish:false skills aside, in discovery order, honouring defaults and per-skill overrides', () => {
    const { buildSpecs, inPlace } = partitionInPlaceSkills(
      [skill('a'), skill('b'), skill('c')],
      { include: ['skills/**'], defaults: { publish: false }, config: { b: { publish: true, linkFollowDepth: 1 } } },
      NO_PLUGIN_LOCAL,
    );

    expect(namesOf(buildSpecs)).toEqual(['b']);
    expect(buildSpecs[0]?.packagingConfig).toMatchObject({ publish: true, linkFollowDepth: 1 });
    expect(namesOf(inPlace)).toEqual(['a', 'c']);
  });

  it('bundles every skill when nothing says publish:false', () => {
    const { buildSpecs, inPlace } = partitionInPlaceSkills([skill('a'), skill('b')], { include: ['skills/**'] }, NO_PLUGIN_LOCAL);

    expect(namesOf(buildSpecs)).toEqual(['a', 'b']);
    expect(inPlace).toEqual([]);
  });

  it('never counts a plugin-local publish:false skill as in place: it is set aside as plugin-only', () => {
    const { buildSpecs, inPlace, pluginOnly } = partitionInPlaceSkills(
      [skill(KEPT), SHIPPED],
      { include: ['**/SKILL.md'], defaults: { publish: false } },
      fakePluginLocalIndex([SHIPPED]),
    );

    expect([namesOf(buildSpecs), namesOf(inPlace), namesOf(pluginOnly)]).toEqual([[], [KEPT], [PLUGIN_LOCAL]]);
  });

  it('still bundles a plugin-local skill into the pool when it is published', () => {
    const { buildSpecs, inPlace, pluginOnly } = partitionInPlaceSkills(
      [SHIPPED],
      { include: ['**/SKILL.md'] },
      fakePluginLocalIndex([SHIPPED]),
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

  it('formats the success line with each set-aside tail only when there is one', () => {
    expect(formatBuiltSuccessLine(3, { inPlace: 0, pluginOnly: 0 })).toBe('\nBuilt 3 skill(s) successfully');
    expect(formatBuiltSuccessLine(3, { inPlace: 2, pluginOnly: 0 })).toBe('\nBuilt 3 skill(s) successfully (2 in-place skill(s) not bundled)');
    expect(formatBuiltSuccessLine(3, { inPlace: 0, pluginOnly: 1 })).toBe(
      '\nBuilt 3 skill(s) successfully (1 plugin-only skill(s) shipped with their plugin)',
    );
    expect(formatBuiltSuccessLine(3, { inPlace: 2, pluginOnly: 1 })).toBe(
      '\nBuilt 3 skill(s) successfully (2 in-place skill(s) not bundled, 1 plugin-only skill(s) shipped with their plugin)',
    );
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
    expect(document).toMatchObject({ skillsFound: 1, skillsInPlace: 1, skillsInPlaceNames: [KEPT] });
    expect(harness.lines).toContain('Found 1 skill(s) to build');
    expect(loggedSetAside(1, 'in-place skill(s)', KEPT)).toBe(true);
  });

  it('--skill naming an in-place skill exits 1 with the refusal as the document', async () => {
    givenProject();

    const outcome = await runSkillsBuildPhase(undefined, { skill: KEPT });

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
      skillsInPlaceNames: [KEPT],
      skillsPluginOnly: 1,
      skillsPluginOnlyNames: [PLUGIN_LOCAL],
    });
    expect(loggedSetAside(1, 'in-place skill(s)', KEPT)).toBe(true);
    expect(harness.lines.filter((line) => line.includes(IN_PLACE) && line.includes(PLUGIN_LOCAL))).toEqual([]);
    expect(loggedSetAside(1, 'plugin-local skill(s)', PLUGIN_LOCAL)).toBe(true);
  });

  it('a repo-only skill sharing its declared name with a plugin-local one is in place, not plugin-only', async () => {
    givenPluginProject([skill(PLUGIN_LOCAL, 'skills/twin-dir'), SHIPPED]);

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

    const { exitCode, error } = await refusalFor(KEPT);

    expect(exitCode).toBe(1);
    expect(error).toContain(`Skill "${KEPT}" is an in-place skill`);
  });
});

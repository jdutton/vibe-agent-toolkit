/**
 * `vat skills build` and IN-PLACE skills (`publish: false`), at the unit seam.
 *
 * The system test drives the real binary; these pin the same partition, info
 * line, `--skill` refusal and published counts without a project on disk. The
 * phase runner's I/O neighbours (config load, discovery, project-root policy)
 * are stubbed so the dry-run and refusal wiring is exercised in-process.
 */

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
import { recordingLogger } from '../../test-doubles.js';

const harness = vi.hoisted(() => ({
  config: undefined as { skills: SkillsConfig } | undefined,
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

function skill(name: string): DiscoveredSkill {
  return { name, sourcePath: safePath.resolve(`/project/skills/${name}/SKILL.md`) };
}

function specs(names: readonly string[]): BuildSkillSpec[] {
  return names.map((name) => ({ skill: skill(name), packagingConfig: { publish: false } as BuildSkillSpec['packagingConfig'] }));
}

function namesOf(list: readonly BuildSkillSpec[]): string[] {
  return list.map((spec) => spec.skill.name);
}

/** Stub a project with one published skill (`built`) and one in-place skill (`kept`). */
function givenProject(): void {
  harness.config = { skills: { include: ['skills/**'], config: { kept: { publish: false } } } };
  harness.discovered = [skill('built'), skill('kept')];
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
    );

    expect(namesOf(buildSpecs)).toEqual(['b']);
    expect(buildSpecs[0]?.packagingConfig).toMatchObject({ publish: true, linkFollowDepth: 1 });
    expect(namesOf(inPlace)).toEqual(['a', 'c']);
  });

  it('bundles every skill when nothing says publish:false', () => {
    const { buildSpecs, inPlace } = partitionInPlaceSkills([skill('a'), skill('b')], { include: ['skills/**'] });

    expect(namesOf(buildSpecs)).toEqual(['a', 'b']);
    expect(inPlace).toEqual([]);
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

describe('the published build report carries the in-place count', () => {
  const run = { results: [], failures: [], runIssues: [], skillsWithErrors: [], validationFailures: [], outputCommitted: true };

  it('formats the success line with the in-place tail only when there is one', () => {
    expect(formatBuiltSuccessLine(3, 0)).toBe('\nBuilt 3 skill(s) successfully');
    expect(formatBuiltSuccessLine(3, 2)).toBe('\nBuilt 3 skill(s) successfully (2 in-place skill(s) not bundled)');
  });

  it('publishes skillsInPlace in the header and the names in the body', async () => {
    const names = ['a', 'b'];
    const document = buildBuildDocument(run, names, 5);

    expect(document).toMatchObject({ skillsInPlace: 2, skillsInPlaceNames: names });
    expect(document['skillsInPlaceNames']).not.toBe(names);

    const stdout = await captureStdout(() => outputBuildYaml(document));
    const header = stdout.split('\n').slice(0, 4).join('\n');
    expect(header).toContain('skillsInPlace: 2');
    expect(yaml.parse(stdout)).toMatchObject({ skillsInPlace: 2, skillsInPlaceNames: names });
  });
});

describe('runSkillsBuildPhase — in-place wiring', () => {
  afterEach(() => {
    harness.config = undefined;
    harness.discovered = [];
  });

  it('a dry run previews the partition on both streams', async () => {
    givenProject();

    let outcome: Awaited<ReturnType<typeof runSkillsBuildPhase>> | undefined;
    const stdout = await captureStdout(async () => {
      outcome = await runSkillsBuildPhase(undefined, { dryRun: true });
    });

    expect(outcome?.exitCode).toBe(0);
    expect(yaml.parse(stdout.slice(0, stdout.indexOf('skills:')))).toMatchObject({ skillsFound: 1, skillsInPlace: 1 });
    expect(harness.lines).toContain('Found 1 skill(s) to build');
    expect(harness.lines.some((line) => line.startsWith('Skipping 1 in-place skill(s)') && line.endsWith(': kept'))).toBe(true);
  });

  it('--skill naming an in-place skill exits 1 with the refusal as the document', async () => {
    givenProject();

    const outcome = await runSkillsBuildPhase(undefined, { skill: 'kept' });

    expect(outcome.exitCode).toBe(1);
    expect(outcome.failed).toBe(true);
    expect(outcome.document).toMatchObject({ status: 'error' });
    expect(String((outcome.document as { error: string }).error)).toContain('skills.config.kept.publish is false');
  });
});

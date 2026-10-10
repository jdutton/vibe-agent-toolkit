/**
 * System tests for `vat skill test configure`: the report it publishes, and the
 * one lane that publishes no report — `--print`, whose stdout is the updated
 * config text and nothing else, so it can be redirected over the file.
 */

import { readFileSync } from 'node:fs';

import { mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, describe, expect, it } from 'vitest';
import yaml from 'yaml';

import { SKILL_TEST_CONFIGURE_REPORT_SCHEMA } from '../../src/commands/skill/test/configure-schema.js';

import { createTempDirTracker, executeCli, getBinPath, writeTestFile } from './test-common.js';

const CONFIG_FILENAME = 'vibe-agent-toolkit.config.yaml';
/** `skills:` is only valid alongside an `include:`. The comment is what `--print` must carry through. */
const CONFIG = '# kept by the edit\nskills:\n  include:\n    - "skills/*/SKILL.md"\n';

const binPath = getBinPath(import.meta.url);
const { createTempDir, cleanupTempDirs } = createTempDirTracker('vat-skill-test-configure-');

/**
 * A project directory holding `config` and a declared `my-skill` (configure refuses
 * an undeclared skill), or only a `.git/` when `config` is undefined.
 */
function projectWith(config: string | undefined): string {
  const dir = createTempDir();
  if (config === undefined) {
    mkdirSyncReal(safePath.join(dir, '.git'), { recursive: true });
  } else {
    writeTestFile(safePath.join(dir, CONFIG_FILENAME), config);
    mkdirSyncReal(safePath.join(dir, 'skills', 'my-skill'), { recursive: true });
    writeTestFile(safePath.join(dir, 'skills', 'my-skill', 'SKILL.md'), '---\nname: my-skill\ndescription: A skill configured by a test.\n---\n\n# my-skill\n');
  }
  return dir;
}

/** `vat skill test configure <skill> <args>` in `cwd`. */
async function configureSkill(cwd: string, skill: string, ...args: string[]): ReturnType<typeof executeCli> {
  return executeCli(binPath, ['skill', 'test', 'configure', skill, ...args], { cwd });
}

/** `vat skill test configure my-skill <args>` in `cwd`. */
async function configure(cwd: string, ...args: string[]): ReturnType<typeof executeCli> {
  return configureSkill(cwd, 'my-skill', ...args);
}

/** The run refused, exit 2, publishing the report's error branch carrying `error`. */
function expectRefused(result: Awaited<ReturnType<typeof executeCli>>, error: Record<string, unknown>): void {
  expect(result.status, result.stderr).toBe(2);
  expect(SKILL_TEST_CONFIGURE_REPORT_SCHEMA.parse(yaml.parse(result.stdout))).toMatchObject({ status: 'error', error });
}

describe('vat skill test configure (system)', () => {
  afterEach(() => {
    cleanupTempDirs();
  });

  it('configure --print writes the raw config and nothing else to stdout', async () => {
    const project = projectWith(CONFIG);
    const result = await configure(project, '--max-turns', '5', '--print');

    expect(result.status, result.stderr).toBe(0);
    // The config text itself: the comment survives, the knob is in, and no report rides along.
    expect(result.stdout.startsWith('# kept by the edit\n')).toBe(true);
    expect(yaml.parse(result.stdout)).toMatchObject({ skills: { config: { 'my-skill': { test: { maxTurns: 5 } } } } });
    expect(result.stdout).not.toMatch(/^status:/m);
    // `--print` never writes the file.
    expect(readFileSync(safePath.join(project, CONFIG_FILENAME), 'utf-8')).toBe(CONFIG);
  });

  it('publishes a report naming the config it updated, exit 0', async () => {
    const project = projectWith(CONFIG);
    const result = await configure(project, '--max-turns', '5');
    const report = SKILL_TEST_CONFIGURE_REPORT_SCHEMA.parse(yaml.parse(result.stdout));

    expect(result.status, result.stderr).toBe(0);
    expect(report).toMatchObject({ status: 'ok', examined: 1, data: { configPath: CONFIG_FILENAME, skill: 'my-skill' } });
    expect(readFileSync(safePath.join(project, CONFIG_FILENAME), 'utf-8')).toContain('maxTurns: 5');
  });

  it('refuses an invalid knob value as USAGE_INVALID, exit 2', async () => {
    const project = projectWith(CONFIG);
    const result = await configure(project, '--max-turns', '0');

    expectRefused(result, { code: 'USAGE_INVALID' });
    expect(result.stderr).not.toContain('VAT bug');
  });

  // The surgical editor refuses the file's own shape — the adopter's config to
  // fix, never INTERNAL_ERROR with a stack and "report it as a VAT bug".
  it.each([
    ['is not valid YAML', 'skills: [unterminated\n'],
    ['holds a collection where the knob goes', `${CONFIG}  config:\n    my-skill:\n      test:\n        maxTurns:\n          nested: 1\n`],
  ])('refuses a config that %s as CONFIG_INVALID, exit 2', async (_label, config) => {
    const project = projectWith(config);
    const result = await configure(project, '--max-turns', '5');

    expectRefused(result, { code: 'CONFIG_INVALID' });
    expect(readFileSync(safePath.join(project, CONFIG_FILENAME), 'utf-8')).toBe(config);
  });

  it('refuses a skill the config does not declare as USAGE_INVALID, exit 2, leaving the config untouched', async () => {
    const project = projectWith(CONFIG);
    const result = await configureSkill(project, 'nosuch', '--max-turns', '5');

    expectRefused(result, { code: 'USAGE_INVALID', message: expect.stringContaining("'nosuch'") });
    expect(readFileSync(safePath.join(project, CONFIG_FILENAME), 'utf-8')).toBe(CONFIG);
  });

  it('refuses a project with no config file as CONFIG_INVALID, exit 2', async () => {
    const project = projectWith(undefined);
    const result = await configure(project, '--max-turns', '5');

    expectRefused(result, { code: 'CONFIG_INVALID' });
  });
});

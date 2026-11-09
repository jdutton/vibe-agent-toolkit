/**
 * Reading turbo's dry-run graph and `turbo.json` fails closed: anything that is
 * not a graph with tasks, or a config with a `tasks` object, throws, so the
 * rule reports that it did not run instead of passing an empty population.
 */

import { writeFileSync } from 'node:fs';

import { safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isTurboDryRun, parseTurboConfig, parseTurboDryRun, readTurboTaskGraph } from '../src/built-output-edges.js';

import { cleanupTestTempDir, createTestTempDir } from './test-helpers.js';

const DEFINITION = { outputs: ['dist/**'], cache: true, dependsOn: ['^build'], inputs: [], env: [], outputLogs: 'full' };
const NODE = {
  taskId: '@scope/a#build',
  task: 'build',
  package: '@scope/a',
  command: 'tsc',
  dependencies: ['@scope/b#build'],
  outputs: ['dist/**'],
  excludedOutputs: ['dist/skills/**'],
  resolvedTaskDefinition: DEFINITION,
};

describe('parseTurboDryRun', () => {
  it('reads each real task, with an `outputs: []` task and no exclusions (printed as null) as empty', () => {
    const tasks = parseTurboDryRun(
      JSON.stringify({ tasks: [NODE, { ...NODE, taskId: '@scope/a#test:unit', task: 'test:unit', outputs: null, excludedOutputs: null }] }),
    );

    expect([...tasks.keys()]).toEqual(['@scope/a#build', '@scope/a#test:unit']);
    expect(tasks.get('@scope/a#build')).toEqual({
      task: 'build',
      package: '@scope/a',
      command: 'tsc',
      dependencies: ['@scope/b#build'],
      outputs: ['dist/**'],
      excludedOutputs: ['dist/skills/**'],
      definition: DEFINITION,
    });
    expect(tasks.get('@scope/a#test:unit')).toMatchObject({ outputs: [], excludedOutputs: [] });
  });

  it('drops the placeholder turbo lists for a task the package has no script for', () => {
    const tasks = parseTurboDryRun(JSON.stringify({ tasks: [NODE, { ...NODE, taskId: '@scope/a#test:system', command: '<NONEXISTENT>' }] }));

    expect([...tasks.keys()]).toEqual(['@scope/a#build']);
  });

  it('throws on text that is not JSON', () => {
    expect(() => parseTurboDryRun('• Packages in scope: …')).toThrow('printed no JSON');
  });

  it.each([
    ['no tasks key', {}],
    ['an empty task list', { tasks: [] }],
    ['a task without outputs', { tasks: [{ ...NODE, outputs: undefined }] }],
    ['a task whose dependencies are not strings', { tasks: [{ ...NODE, dependencies: [1] }] }],
    ['a task without a command', { tasks: [{ ...NODE, command: undefined }] }],
    ['a task without a resolved definition', { tasks: [{ ...NODE, resolvedTaskDefinition: undefined }] }],
    ['a resolved definition without env', { tasks: [{ ...NODE, resolvedTaskDefinition: { ...DEFINITION, env: undefined } }] }],
    ['null', null],
  ])('throws on %s, and isTurboDryRun says no', (_label, value) => {
    expect(isTurboDryRun(value)).toBe(false);
    expect(() => parseTurboDryRun(JSON.stringify(value))).toThrow('printed no task graph');
  });
});

describe('parseTurboConfig', () => {
  it('reads the task names, and the package entries, from commented JSON', () => {
    const config = parseTurboConfig('{\n  // a comment\n  "tasks": { "build": {}, "@scope/a#test:unit": {}, "@scope/b#lint": {}, },\n}');

    expect(config).toEqual({ names: ['build', 'lint', 'test:unit'], overrides: ['@scope/a#test:unit', '@scope/b#lint'] });
  });

  it('throws on a config with no tasks object', () => {
    expect(() => parseTurboConfig('{ "pipeline": {} }')).toThrow('has no `tasks` object');
  });
});

describe('readTurboTaskGraph', () => {
  let root: string;
  beforeEach(() => {
    root = createTestTempDir({ prefix: 'turbo-graph-' });
  });
  afterEach(() => {
    cleanupTestTempDir(root);
  });

  it('throws when the repository has no turbo.json', () => {
    expect(() => readTurboTaskGraph(root)).toThrow(/ENOENT/);
  });

  it("throws, carrying turbo's stderr, when turbo cannot run", () => {
    writeFileSync(safePath.join(root, 'turbo.json'), '{ "tasks": { "build": {} } }');

    expect(() => readTurboTaskGraph(root)).toThrow(/turbo run --dry=json failed \(exit 1\):\n[\s\S]*Cannot find module/);
  });
});

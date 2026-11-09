/**
 * Reading turbo's dry-run graph and `turbo.json` fails closed: anything that is
 * not a graph with tasks, or a config with a `tasks` object, throws, so the
 * rule reports that it did not run instead of passing an empty population.
 */

import { writeFileSync } from 'node:fs';

import { safePath } from '@vibe-agent-toolkit/utils';
import { runGitOrThrow } from '@vibe-agent-toolkit/utils/git';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isTurboDryRun, parseTurboConfig, parseTurboDryRun, readTurboTaskGraph, tierDefinitions } from '../src/built-output-edges.js';

import { cleanupTestTempDir, createTestTempDir } from './test-helpers.js';

/**
 * One node as turbo 2.10.12 prints it: `outputs` holds the inclusions and
 * `excludedOutputs` the `!` globs without their `!`, while the resolved
 * definition keeps the `!` among its outputs, prints an omitted `inputs` as
 * `[]` and has lost `$TURBO_DEFAULT$` — which is why parity reads turbo.json.
 */
const NODE = {
  taskId: '@scope/a#build',
  task: 'build',
  package: '@scope/a',
  hash: '0123456789abcdef',
  command: 'tsc',
  dependencies: ['@scope/b#build'],
  dependents: [],
  outputs: ['*.tsbuildinfo', 'dist/**', 'generated/**'],
  excludedOutputs: ['dist/skills/**'],
  resolvedTaskDefinition: {
    outputs: ['!dist/skills/**', '*.tsbuildinfo', 'dist/**', 'generated/**'],
    cache: true,
    dependsOn: ['^build'],
    inputs: [],
    outputLogs: 'full',
    persistent: false,
    interruptible: false,
    env: [],
    passThroughEnv: null,
    interactive: false,
  },
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
      outputs: ['*.tsbuildinfo', 'dist/**', 'generated/**'],
      excludedOutputs: ['dist/skills/**'],
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
    ['a task whose exclusions are not strings', { tasks: [{ ...NODE, excludedOutputs: [1] }] }],
    ['null', null],
  ])('throws on %s, and isTurboDryRun says no', (_label, value) => {
    expect(isTurboDryRun(value)).toBe(false);
    expect(() => parseTurboDryRun(JSON.stringify(value))).toThrow('printed no task graph');
  });
});

describe('parseTurboConfig', () => {
  it('reads the task names, and each task as declared, from commented JSON', () => {
    const config = parseTurboConfig('{\n  // a comment\n  "tasks": { "build": {}, "@scope/a#test:unit": { "cache": false }, "@scope/b#lint": {}, },\n}');

    expect(config.names).toEqual(['build', 'lint', 'test:unit']);
    expect([...config.tasks]).toEqual([
      ['build', {}],
      ['@scope/a#test:unit', { cache: false }],
      ['@scope/b#lint', {}],
    ]);
  });

  it('throws on a config with no tasks object', () => {
    expect(() => parseTurboConfig('{ "pipeline": {} }')).toThrow('has no `tasks` object');
  });
});

describe('tierDefinitions', () => {
  const GENERIC = { dependsOn: ['^build'], outputs: [], env: ['CI'] };
  const root = (extra: Record<string, Record<string, unknown>>): Map<string, Record<string, unknown>> => new Map(Object.entries({ build: {}, 'test:unit': GENERIC, ...extra }));
  const NORMAL = { outputs: [], cache: true, dependsOn: ['^build'], inputs: ['$TURBO_DEFAULT$'], env: ['CI'] };

  it('reads an omitted and an empty inputs alike, as $TURBO_DEFAULT$', () => {
    const tiers = tierDefinitions(root({ '@scope/a#test:unit': { ...GENERIC, inputs: [] } }), []);

    expect(tiers.generic.get('test:unit')).toEqual(NORMAL);
    expect(tiers.overrides).toEqual([{ site: 'turbo.json ("@scope/a#test:unit")', task: 'test:unit', definition: NORMAL }]);
  });

  it("reads a package turbo.json entry merged, key by key, over the root's", () => {
    const tiers = tierDefinitions(root({}), [{ dir: 'a', name: '@scope/a', tasks: new Map([['test:unit', { env: ['CI', 'EXTRA'] }], ['build', {}]]) }]);

    expect(tiers.overrides).toEqual([{ site: 'packages/a/turbo.json ("test:unit")', task: 'test:unit', definition: { ...NORMAL, env: ['CI', 'EXTRA'] } }]);
  });

  it('ignores a package entry for a task that is no test tier', () => {
    expect(tierDefinitions(root({ '@scope/a#build': {} }), []).overrides).toEqual([]);
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
    // A repository, so the package turbo.json files can be listed before turbo runs.
    runGitOrThrow(['init', '-q'], { cwd: root });
    writeFileSync(safePath.join(root, 'turbo.json'), '{ "tasks": { "build": {} } }');

    expect(() => readTurboTaskGraph(root)).toThrow(/turbo run --dry=json failed \(exit 1\):\n[\s\S]*Cannot find module/);
  });
});

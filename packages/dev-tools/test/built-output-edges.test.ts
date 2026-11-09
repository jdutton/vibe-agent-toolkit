/**
 * Reading turbo's dry-run graph fails closed: anything that is not a graph with
 * tasks throws, so the rule reports that it did not run instead of passing an
 * empty population.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isTurboDryRun, parseTurboDryRun, readTurboTaskGraph } from '../src/built-output-edges.js';

import { cleanupTestTempDir, createTestTempDir } from './test-helpers.js';

const NODE = {
  taskId: '@scope/a#build',
  task: 'build',
  package: '@scope/a',
  command: 'tsc',
  dependencies: ['@scope/b#build'],
  outputs: ['dist/**'],
};

describe('parseTurboDryRun', () => {
  it('reads each real task, with an `outputs: []` task (printed as null) as no outputs', () => {
    const graph = parseTurboDryRun(JSON.stringify({ tasks: [NODE, { ...NODE, taskId: '@scope/a#test:unit', task: 'test:unit', outputs: null }] }));

    expect([...graph.keys()]).toEqual(['@scope/a#build', '@scope/a#test:unit']);
    expect(graph.get('@scope/a#build')).toEqual({ task: 'build', package: '@scope/a', command: 'tsc', dependencies: ['@scope/b#build'], outputs: ['dist/**'] });
    expect(graph.get('@scope/a#test:unit')?.outputs).toEqual([]);
  });

  it('drops the placeholder turbo lists for a task the package has no script for', () => {
    const graph = parseTurboDryRun(JSON.stringify({ tasks: [NODE, { ...NODE, taskId: '@scope/a#test:system', command: '<NONEXISTENT>' }] }));

    expect([...graph.keys()]).toEqual(['@scope/a#build']);
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
    ['null', null],
  ])('throws on %s, and isTurboDryRun says no', (_label, value) => {
    expect(isTurboDryRun(value)).toBe(false);
    expect(() => parseTurboDryRun(JSON.stringify(value))).toThrow('printed no task graph');
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

  it('throws, carrying turbo\'s stderr, when turbo cannot run', () => {
    expect(() => readTurboTaskGraph(root)).toThrow(/turbo run --dry=json failed \(exit 1\):\n[\s\S]*Cannot find module/);
  });
});

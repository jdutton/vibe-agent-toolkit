/**
 * The evaluator's cost is bounded by memoising each call per callee and
 * argument values: a helper chain that calls its predecessor twice at every
 * level evaluates each level once, not 2^depth times. Counted in evaluations,
 * never in wall time.
 */

import { writeFileSync } from 'node:fs';

import { safePath } from '@vibe-agent-toolkit/utils';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { locate, Module, nameOnlyProgram, PathEvaluator } from '../src/built-output-paths.js';

import { cleanupTestTempDir, createTestTempDir } from './test-helpers.js';

const DEPTH = 18;
const REL = 'chain.test.ts';

/** `f0` joins one segment; every `f<n>` returns `f<n-1>` on both branches of a conditional. */
function chainSource(depth: number): string {
  const lines = ["import { safePath } from '@vibe-agent-toolkit/utils';", "function f0(d: string) { return safePath.join(d, 'packages'); }"];
  for (let level = 1; level <= depth; level++) {
    lines.push(`function f${level.toString()}(d: string) { return flag ? f${(level - 1).toString()}(d) : f${(level - 1).toString()}(d); }`);
  }
  lines.push(`export const OUT = safePath.join(f${depth.toString()}(import.meta.dirname), 'alpha', 'dist');`);
  return lines.join('\n');
}

describe('PathEvaluator on a deep helper chain', () => {
  let root: string;
  beforeEach(() => {
    root = createTestTempDir({ prefix: 'built-output-paths-' });
  });
  afterEach(() => {
    cleanupTestTempDir(root);
  });

  it(`evaluates each of ${DEPTH.toString()} levels once, and still resolves the path`, () => {
    const path = safePath.join(root, REL);
    writeFileSync(path, chainSource(DEPTH));
    const program = nameOnlyProgram([path]);
    const file = program.getSourceFile(path);
    if (file === undefined) throw new Error('the fixture did not parse');
    const module = new Module(file, REL, program.getTypeChecker());
    const evaluator = new PathEvaluator(root, new Set([REL]), new Map(), new Map([[REL, module]]));
    const statement = file.statements.at(-1);
    const declaration = statement !== undefined && ts.isVariableStatement(statement) ? statement.declarationList.declarations[0] : undefined;
    if (declaration?.initializer === undefined) throw new Error('the fixture has no OUT');

    const values = evaluator.values(module, declaration.initializer);

    expect(values.map((pieces) => locate(pieces).segments)).toEqual([['packages', 'alpha', 'dist']]);
    // One evaluation per level and the outer call; a lost memo makes it 2^18.
    expect(evaluator.evaluatedCalls).toBeLessThanOrEqual(DEPTH + 1);
  });
});

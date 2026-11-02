/**
 * `eslint-rule-factory`'s `rewrite` declaration is required and validated at
 * construction: a rule whose declaration the factory cannot read must refuse to
 * build, never fall into a default autofix that emits the wrong call.
 */
import { describe, expect, it } from 'vitest';

import { loadLocalRuleModule } from './rule-tester.js';

type Factory = (config: Record<string, unknown>) => unknown;

const createRule = loadLocalRuleModule<Factory>('eslint-rule-factory.cjs');

const BASE = {
  unsafeFn: 'mkdirSync',
  unsafeModule: 'node:fs',
  safeFn: 'mkdirSyncReal',
  safeModule: '@vibe-agent-toolkit/utils/fs',
  message: 'Use mkdirSyncReal()',
  docs: { category: 'Filesystem and process', bans: 'x', useInstead: 'y', recommended: false },
};

function build(rewrite: unknown): () => unknown {
  return () => createRule(rewrite === undefined ? BASE : { ...BASE, rewrite });
}

describe('eslint-rule-factory rewrite declaration', () => {
  it.each([
    ['omitted', undefined],
    ["the string 'suggest'", 'suggest'],
    ['an empty object', {}],
    ['appendArgument with no suggestion', { appendArgument: 'X' }],
    ['a non-string suggestion', { appendArgument: 'X', suggestion: 3 }],
    ['autofixAsStatement with no suggestion', { autofixAsStatement: true }],
    ['both appendArgument and autofixAsStatement', { appendArgument: 'X', autofixAsStatement: true, suggestion: 's' }],
  ])('refuses %s', (_label, rewrite) => {
    expect(build(rewrite)).toThrow(TypeError);
  });

  it.each([
    ["'fix'", 'fix'],
    ['appendArgument + suggestion', { appendArgument: 'X', suggestion: 's' }],
    ['autofixAsStatement + suggestion', { autofixAsStatement: true, suggestion: 's' }],
  ])('builds %s', (_label, rewrite) => {
    expect(build(rewrite)).not.toThrow();
  });
});

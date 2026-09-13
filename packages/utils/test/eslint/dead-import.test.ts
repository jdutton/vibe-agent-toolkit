/**
 * The shared dead-import helper, exercised directly on its own module list.
 *
 * Every rule wired to it today pre-filters to its own module before handing a
 * declaration over, so the allow-list inside the helper is unreachable through
 * any of them — and an untested unreachable guard is exactly the one a future
 * rule discovers the hard way. This calls the helper with declarations the
 * production callers never pass it.
 */

import type { Rule } from 'eslint';
import { describe, expect, it } from 'vitest';

import { fix, localRulesConfig } from './linter-harness.js';
import { loadLocalRuleModule } from './rule-tester.js';

describe('reportDeadUnsafeImports only ever removes a listed module', () => {
  const { reportDeadUnsafeImports } = loadLocalRuleModule<{
    reportDeadUnsafeImports: (
      context: unknown,
      sourceCode: unknown,
      importNodes: unknown[],
      safeBoundInSource: boolean,
      replacementCalled: boolean,
    ) => void;
  }>('dead-import.cjs');

  /** Hands the helper EVERY import declaration in the file, unfiltered. */
  const unfilteredRule = {
    meta: {
      type: 'problem' as const,
      fixable: 'code' as const,
      schema: [],
      messages: {
        deadUnsafeImport: "'{{local}}' from '{{module}}'",
      },
    },
    create(context: Rule.RuleContext): Rule.RuleListener {
      const { sourceCode } = context;
      return {
        'Program:exit'() {
          reportDeadUnsafeImports(
            context,
            sourceCode,
            sourceCode.ast.body.filter((node) => node.type === 'ImportDeclaration'),
            true,
            true,
          );
        },
      };
    },
  };

  const config = localRulesConfig({ r: unfilteredRule as Rule.RuleModule });
  const removedFrom = (code: string): string => fix(code, config).output;

  it.each([
    ['node:path', true],
    ['path', true],
    ['node:child_process', true],
    // Side-effect-free-ness is decided at authoring time for a CLOSED list, and
    // these are not on it. A builtin nobody wired up is still not ours to delete,
    // and a userland module may run anything at import time.
    ['node:crypto', false],
    ['react', false],
    ['./local-module.js', false],
  ])('%s removable=%s', (module, removable) => {
    const source = `import dead from '${module}';\nexport const x = 1;`;
    expect(removedFrom(source).includes(`'${module}'`)).toBe(!removable);
  });
});

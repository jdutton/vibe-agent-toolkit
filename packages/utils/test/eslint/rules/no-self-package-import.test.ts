import { describe, it } from 'vitest';

import { expectRulePasses, RULE_TESTER_CASES, type RuleCases } from '../rule-tester.js';

const NAME = 'no-self-package-import';
const AGENT_RUNTIME = [{ packageName: '@vibe-agent-toolkit/agent-runtime' }];

/**
 * `no-self-package-import` is told which package it is inside, via a required
 * `packageName` option — it reads no files, because every module on the `./eslint`
 * subpath must require nothing at all (`subpath-purity.test.ts`). That also makes
 * these cases independent of the working directory the suite runs from.
 *
 * The load-bearing case is `selfImportOfTheShippedDefect`: the exact import that
 * reddened CI on both ubuntu and windows at `0e8b74f9`. A guard nobody has
 * watched fire on the real defect is an assumption, not a guard.
 *
 * The other one worth naming is the `rag` / `rag-lancedb` leg. Matching a
 * self-reference with `startsWith(packageName)` alone would report
 * `@vibe-agent-toolkit/rag-lancedb` as a self-import of `@vibe-agent-toolkit/rag`
 * — the same unanchored-prefix bug the exempt-path matchers were written to kill.
 */
const CASES: RuleCases = {
  valid: [
    {
      name: 'the relative import that replaced the defect',
      options: AGENT_RUNTIME,
      code: "import type { SessionStore } from './types.js';",
    },
    {
      name: 'a genuinely different package',
      options: AGENT_RUNTIME,
      code: "import { safePath } from '@vibe-agent-toolkit/utils';",
    },
    {
      name: 'a sibling whose name merely EXTENDS this one',
      options: [{ packageName: '@vibe-agent-toolkit/rag' }],
      code: "import { connect } from '@vibe-agent-toolkit/rag-lancedb';",
    },
    {
      name: 'a node builtin',
      options: AGENT_RUNTIME,
      code: "import { readFile } from 'node:fs/promises';",
    },
  ],
  invalid: [
    {
      name: 'selfImportOfTheShippedDefect',
      options: AGENT_RUNTIME,
      code: "import type { SessionStore } from '@vibe-agent-toolkit/agent-runtime';",
      errors: [{ messageId: 'useRelativeImport' }],
    },
    {
      name: 'a declared subpath of the same package',
      options: AGENT_RUNTIME,
      code: "import { makeSession } from '@vibe-agent-toolkit/agent-runtime/session/test-helpers';",
      errors: [{ messageId: 'useRelativeImport' }],
    },
    {
      name: 'a barrel re-exporting through its own name',
      options: AGENT_RUNTIME,
      code: "export * from '@vibe-agent-toolkit/agent-runtime';",
      errors: [{ messageId: 'useRelativeImport' }],
    },
    {
      name: 'a named re-export through its own name',
      options: AGENT_RUNTIME,
      code: "export { SessionNotFoundError } from '@vibe-agent-toolkit/agent-runtime';",
      errors: [{ messageId: 'useRelativeImport' }],
    },
    {
      name: 'a dynamic import',
      options: AGENT_RUNTIME,
      code: "const m = await import('@vibe-agent-toolkit/agent-runtime');",
      errors: [{ messageId: 'useRelativeImport' }],
    },
    {
      name: 'an import() in TYPE position, which no other visitor reaches',
      options: AGENT_RUNTIME,
      code: "type S = import('@vibe-agent-toolkit/agent-runtime').SessionStore;",
      errors: [{ messageId: 'useRelativeImport' }],
    },
    {
      name: 'a require() call',
      options: AGENT_RUNTIME,
      code: "const m = require('@vibe-agent-toolkit/agent-runtime');",
      errors: [{ messageId: 'useRelativeImport' }],
    },
  ],
};

describe(NAME, () => {
  it(RULE_TESTER_CASES, () => { expectRulePasses(NAME, CASES); });
});

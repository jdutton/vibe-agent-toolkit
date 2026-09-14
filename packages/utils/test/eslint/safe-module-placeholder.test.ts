/**
 * A message placeholder and the schema that fills it must not drift apart.
 *
 * `{{safeModule}}` is only ever substituted because the rule read the option and
 * passed it as report `data`. A rule that interpolates it WITHOUT declaring the
 * option in `meta.schema` cannot be pointed at a consumer's seam — its advice
 * would keep naming this package's subpath while the fixers around it wrote the
 * consumer's, which is the same fixer/docs divergence that made the autofix
 * target a blocker in the first place.
 *
 * Declaring the option is only half of it. The other half — that the rule
 * actually passes `safeModule` as report `data` — cannot be seen structurally:
 * a rule may declare the option, read it, and still omit it from a single
 * `context.report` call, at which point ESLint renders the literal
 * `{{safeModule}}` into the message a developer reads. So the second suite
 * below RENDERS every one of these rules and asserts no placeholder survives.
 *
 * The set of rules is pinned by MEMBERSHIP, not by count: each one must have a
 * snippet here that provokes it, so a rule that grows the placeholder without a
 * row here fails rather than drifting.
 */

import type { Rule } from 'eslint';
import { describe, expect, it } from 'vitest';

import { BUFFER_UTF8_DECODE, namedImport, NODE_CHILD_PROCESS, PATH_IMPORT, RULE, SEAM } from './fixtures.js';
import { lint, localRulesConfig } from './linter-harness.js';
import { loadLocalRuleModule } from './rule-tester.js';

const PLUGIN_ENTRY = '../index.cjs';

/** One snippet per rule that interpolates `{{safeModule}}`, chosen to provoke it. */
const SAFE_MODULE_RULE_TRIGGERS: Record<string, string> = {
  [RULE.rawPath]: `${PATH_IMPORT}const p = path.join(a, b);`,
  'no-path-sep-in-strings': `${PATH_IMPORT}const s = 'a' + path.sep + 'b';`,
  // Reports path calls in ARGUMENT position, not receiver position.
  'no-path-operations-in-comparisons': `${PATH_IMPORT}const y = base.startsWith(path.relative(a, b));`,
  'no-manual-path-normalize': "const n = p.split(path.sep).join('/');",
  'no-hardcoded-path-split': "const parts = p.split('/');",
  'no-path-startswith': "const x = filePath.startsWith('/a');",
  'no-os-tmpdir': "import { tmpdir } from 'node:os';\nconst t = tmpdir();",
  'no-fs-mkdirSync': "import { mkdirSync } from 'node:fs';\nmkdirSync(d, { recursive: true });",
  'no-fs-realpathSync': "import { realpathSync } from 'node:fs';\nconst r = realpathSync(p);",
  'no-fs-promises-cp': "import { cp } from 'node:fs/promises';\nawait cp(a, b);",
  [RULE.execSync]: `${namedImport('execSync', NODE_CHILD_PROCESS)}\nexecSync('ls');`,
  'no-url-pathname-for-fs': "const p = new URL('../fixtures/x.yaml', import.meta.url).pathname;",
  'no-bare-dynamic-import-path': 'const m = await import(configPath);',
  'no-raw-text-decode': BUFFER_UTF8_DECODE,
};

describe('every {{safeModule}} placeholder is backed by the option that fills it', () => {
  const plugin = loadLocalRuleModule<{
    rules: Record<string, Rule.RuleModule>;
  }>(PLUGIN_ENTRY);

  const rulesUsingPlaceholder = Object.entries(plugin.rules).filter(([, rule]) =>
    Object.values(rule.meta?.messages ?? {}).some((message) => message.includes('{{safeModule}}')),
  );

  it('exercises exactly the rules that use it (guards against a vacuous pass)', () => {
    // Membership, not cardinality: an unchanged count can mask changed occupants.
    const byName = (a: string, b: string): number => a.localeCompare(b);
    expect(rulesUsingPlaceholder.map(([name]) => name).sort(byName)).toStrictEqual(
      Object.keys(SAFE_MODULE_RULE_TRIGGERS).sort(byName),
    );
  });

  it.each(rulesUsingPlaceholder)('%s declares the safeModule option', (_name, rule) => {
    const schema = rule.meta?.schema;
    expect(Array.isArray(schema)).toBe(true);
    const [options] = schema as [{ properties?: Record<string, unknown> }];
    expect(options.properties).toHaveProperty('safeModule');
  });

  it.each(rulesUsingPlaceholder)('%s renders the configured module, not the placeholder', (name, rule) => {
    const messages = lint(
      SAFE_MODULE_RULE_TRIGGERS[name] ?? '',
      localRulesConfig({ [name]: rule }, { [name]: { safeModule: SEAM } }),
    );

    // A snippet that stopped provoking its rule would make the assertions below
    // vacuously true, so require a report before inspecting one.
    expect(messages.length).toBeGreaterThan(0);
    for (const { message } of messages) {
      expect(message).not.toContain('{{');
      expect(message).toContain(SEAM);
    }
  });
});

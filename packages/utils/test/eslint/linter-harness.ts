/**
 * `Linter`-driven helpers for the suites that run a rule to its `--fix`
 * FIXPOINT rather than through RuleTester's single pass.
 *
 * RuleTester applies exactly one round of fixes and compares a string. The
 * properties the adopter-measured defects violated — "no dangling identifier
 * after `--fix` settles", "no dead import left behind" — are properties of the
 * fixpoint, so they need `verifyAndFix` plus a second linter asking the
 * compiler's question (`no-undef`, `no-unused-vars`) of the result.
 */

import { Linter, type Rule } from 'eslint';

import { LINTED_FILE } from './fixtures.js';
import { loadLocalRule } from './rule-tester.js';

export const LANGUAGE_OPTIONS = { ecmaVersion: 2024, sourceType: 'module' } as const;

/** A flat config enabling exactly the named local rules, each at `error` (with optional options). */
export function localRulesConfig(
  rules: Record<string, Rule.RuleModule>,
  options: Record<string, object | undefined> = {},
): Linter.Config[] {
  return [
    {
      files: ['**/*.ts'],
      plugins: { local: { rules } },
      rules: Object.fromEntries(
        Object.keys(rules).map((name) => [
          `local/${name}`,
          options[name] ? (['error', options[name]] as const) : ('error' as const),
        ]),
      ),
      languageOptions: LANGUAGE_OPTIONS,
    },
  ];
}

/** `localRulesConfig` for one rule loaded by name from the pack. */
export function ruleConfig(name: string, options?: object): Linter.Config[] {
  return localRulesConfig({ [name]: loadLocalRule(`${name}.cjs`) }, { [name]: options });
}

export function lint(code: string, config: Linter.Config[]): Linter.LintMessage[] {
  return new Linter().verify(code, config, { filename: LINTED_FILE });
}

export function fix(code: string, config: Linter.Config[]): Linter.FixReport {
  return new Linter().verifyAndFix(code, config, { filename: LINTED_FILE });
}

/**
 * Messages from one CORE rule over `code`, with the named local rules DEFINED
 * but switched off.
 *
 * The rules must still be defined even though they are off — an `eslint-disable`
 * naming a rule the config does not know reports "Definition for rule … was not
 * found", and that lands in the same message list this is reading. The first
 * draft of this helper omitted it and produced a failure that looked exactly
 * like a dangling identifier. With the rule off its disable directive becomes
 * "unused", and ESLint 9 warns about that by default — into the same list — so
 * that report is switched off too.
 */
function coreRuleMessages(
  coreRule: 'no-undef' | 'no-unused-vars',
  code: string,
  definedRules: Record<string, Rule.RuleModule>,
): string[] {
  const config: Linter.Config[] = [
    {
      files: ['**/*.ts'],
      plugins: { local: { rules: definedRules } },
      rules: {
        [coreRule]: 'error',
        ...Object.fromEntries(Object.keys(definedRules).map((name) => [`local/${name}`, 'off' as const])),
      },
      linterOptions: { reportUnusedDisableDirectives: 'off' },
      languageOptions: LANGUAGE_OPTIONS,
    },
  ];
  return lint(code, config).map(({ message }) => message);
}

/** Bindings, not strings: `no-undef` answers the question `tsc` would. */
export function unboundIn(code: string, definedRules: Record<string, Rule.RuleModule> = {}): string[] {
  return coreRuleMessages('no-undef', code, definedRules);
}

/** The binding a fixer left SPARE rather than dangling — what `no-undef` cannot see. */
export function unusedIn(code: string): string[] {
  return coreRuleMessages('no-unused-vars', code, {});
}

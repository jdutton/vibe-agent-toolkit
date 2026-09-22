/**
 * What `vat resources check --help` says about the built-in checks.
 *
 * 🔑 RENDERED from `BUILTIN_CHECKS` and `CODE_REGISTRY`, never transcribed. A
 * hand-kept list named one built-in after a second had shipped, and a
 * hand-copied statement backs a claim `check.ts` makes to the operator that
 * would go silently false the moment a column is renamed.
 */

import { BUILTIN_CHECKS } from '@vibe-agent-toolkit/resources';
import { CODE_REGISTRY } from '@vibe-agent-toolkit/schema';

/**
 * Every built-in's SQL twin, as a `resources.checks` block a reader can paste.
 *
 * ONE `resources: checks:` header for every twin: a header per block made the
 * pasted text two `resources:` keys, which YAML refuses. The description is
 * JSON-quoted because a built-in's own description contains `paths: `, which
 * unquoted YAML reads as a nested map.
 *
 * @returns The YAML block, indented four spaces for the help text
 */
export function builtinSqlTwins(): string {
  return [
    '    resources:',
    '      checks:',
    ...BUILTIN_CHECKS.map((check) => [
      `        my-${check.name}:`,
      `          description: ${JSON.stringify(check.description)}`,
      '          sql: |',
      ...check.sqlTwin.split('\n').map((line) => `            ${line}`),
    ].join('\n')),
  ].join('\n');
}

/**
 * Every built-in's name, one-line assertion, and the code it emits at the
 * registry's default severity.
 *
 * @returns The list, indented for the help text
 */
export function builtinCheckList(): string {
  return BUILTIN_CHECKS.map((check) => [
    `  ${check.name}`,
    `      ${check.description}.`,
    `      Emits ${check.code} (default: ${CODE_REGISTRY[check.code].defaultSeverity}).`,
  ].join('\n')).join('\n');
}

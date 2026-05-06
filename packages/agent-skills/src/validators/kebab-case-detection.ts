/**
 * Kebab-case naming detector.
 *
 * Plugin-dev's "Name requirements" section: kebab-case is mandatory for
 * both plugin names and skill names. Both the ClaudePluginSchema and
 * agent-skill frontmatter schema enforce the regex via Zod, but Zod
 * surfaces only a generic schema error. This detector emits a named
 * info-severity code so audit output names the convention specifically.
 *
 * The detector is additive — Zod parse continues to error on invalid
 * names (PLUGIN_INVALID_SCHEMA / SKILL_NAME_INVALID), and this code
 * provides a more actionable second message at info severity.
 */

import { CODE_REGISTRY } from './code-registry.js';
import type { ValidationIssue } from './types.js';

// eslint-disable-next-line security/detect-unsafe-regex -- Simple pattern with bounded length, safe from ReDoS (mirrors the regex in ClaudePluginSchema)
const KEBAB_CASE_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export type KebabCaseSurface = 'plugin' | 'skill';

/**
 * Returns a ValidationIssue when `name` violates kebab-case, or undefined
 * when the name is empty (let upstream "missing name" validators handle
 * that case).
 */
export function detectKebabCaseViolation(
  surface: KebabCaseSurface,
  name: string,
  location: string,
): ValidationIssue | undefined {
  if (name.length === 0) {
    return undefined;
  }
  if (KEBAB_CASE_RE.test(name)) {
    return undefined;
  }

  const code = surface === 'plugin'
    ? 'PLUGIN_NAME_NOT_KEBAB_CASE'
    : 'SKILL_NAME_NOT_KEBAB_CASE';
  const entry = CODE_REGISTRY[code];
  const subject = surface === 'plugin' ? 'plugin' : 'skill';
  return {
    severity: entry.defaultSeverity,
    code,
    message: `${subject} name "${name}" is not kebab-case (lowercase alphanumeric with single hyphens, e.g. "my-${subject}").`,
    location,
    fix: entry.fix,
    reference: entry.reference,
  };
}

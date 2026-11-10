/**
 * The built-in checks' names, apart from their predicates so the config schema can refuse a
 * declared check that takes one without importing the predicates. `builtin-checks.ts` names each
 * check from here, and its test holds the two lists equal in both directions.
 */

/** The dead-`paths:`-glob check. */
export const CLAUDE_RULE_GLOB_INERT_NAME = 'claude-rule-glob-inert';
/** The unparseable-frontmatter check. */
export const CLAUDE_RULE_FRONTMATTER_INVALID_NAME = 'claude-rule-frontmatter-invalid';
/** The linked-rules check. */
export const CLAUDE_RULE_LINK_UNCHECKED_NAME = 'claude-rule-link-unchecked';

/** Every built-in's name, in run order, for a `--check` guard, an operator-facing list and the config refusal. */
export const BUILTIN_CHECK_NAMES: readonly string[] = [
  CLAUDE_RULE_GLOB_INERT_NAME,
  CLAUDE_RULE_FRONTMATTER_INVALID_NAME,
  CLAUDE_RULE_LINK_UNCHECKED_NAME,
];

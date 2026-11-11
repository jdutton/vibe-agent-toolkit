/**
 * Claude Code's per-directory memory file and directory names — a LEAF module
 * with no imports of its own.
 *
 * The rules modules (`claude-context-rules.ts`, `claude-rules-scope.ts`) read
 * these names, and `claude-context-rules.ts` is also loaded by the worker-side
 * memory reader (`claude-memory.ts`, for `harnessPaths`). Taking the names
 * from this leaf rather than from `claude-code.ts` keeps the rules modules off
 * the profile's import graph, so no cycle can form through it and every
 * reader here can use an ordinary top-level `const`. `claude-code.ts` builds its own `entryNames` field from these same
 * exports, so there is exactly one place that spells the literals.
 */

/** Per-directory memory files, in the order the launch walk reads them. */
export const CLAUDE_CODE_ENTRY_NAMES = {
  project: ['CLAUDE.md', '.claude/CLAUDE.md'],
  local: 'CLAUDE.local.md',
  rulesDirectory: '.claude/rules',
  ruleExtension: '.md',
} as const;

/** The second project location's directory segment. */
export const CLAUDE_CODE_DOT_CLAUDE = '.claude';

/** {@link CLAUDE_CODE_ENTRY_NAMES.rulesDirectory}, segmented. */
export const CLAUDE_CODE_RULES_DIR_SEGMENTS = [CLAUDE_CODE_DOT_CLAUDE, 'rules'] as const;

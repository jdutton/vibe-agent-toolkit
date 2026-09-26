/**
 * Claude Code's per-directory memory file and directory names — a LEAF module
 * with no imports of its own.
 *
 * `claude-code.ts` depends on `claude-memory.ts` (for `factsOf`), which
 * depends on `claude-context-rules.ts` (for `harnessPaths`). If
 * `claude-context-rules.ts` or `claude-rules-scope.ts` imported these names
 * from `claude-code.ts` instead of from here, that would close a real cycle —
 * `claude-code.ts → claude-memory.ts → claude-context-rules.ts →
 * claude-code.ts` — whose safety would then depend on nothing reading a
 * `CLAUDE_CODE`-derived top-level `const` before the cycle finishes
 * unwinding (a load-order-dependent TDZ throw waiting to happen the next time
 * someone hoists a read). Depending on this leaf instead removes the cycle
 * outright, so every reader here can go back to an ordinary top-level
 * `const`. `claude-code.ts` builds its own `entryNames` field from these same
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

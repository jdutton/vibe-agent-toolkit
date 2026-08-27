/**
 * Permission rule matching — replicates Claude Code's actual permission matching logic.
 *
 * Two distinct systems depending on tool type:
 * - Bash rules: custom regex builder (exact | prefix | wildcard)
 * - Read/Edit/Write/Glob path rules: node-ignore (gitignore spec)
 *
 * Sources: decompiled from Claude Code binary v2.1.52 (nA0() function).
 *
 * @vendor-claim reviewed=2026-04-08 verify=First run the matcher against the published behavior table at https://code.claude.com/docs/en/permissions — it falsifies cheaply and already found 7 divergences. Only a decompile of a current Claude Code binary can CONFIRM equivalence to nA0(); do that second, and only bump reviewed= for the decompile.
 *
 * Note the version discrepancy this pin creates: docs/skill-quality-and-compatibility.md
 * establishes plugin-loader semantics from Claude Code 2.1.126, while the matching
 * logic here was read out of 2.1.52. Nothing reconciles the two, and no test can:
 * these are semantics of somebody else's binary, so the suite below can only assert
 * that our replica is self-consistent, never that it still matches the real one.
 * The `reviewed=` date above is the 2.1.52 read, not a re-confirmation against 2.1.126.
 *
 * KNOWN STALE, AND KNOWN WRONG IN SEVEN PLACES. The structural gate
 * (`validateVendorClaimFreshness` in packages/dev-tools/src/validate-repo-structure.ts, 90-day
 * window, severity `warning`) has this annotation past due. It is a warning, so it blocks nothing.
 *
 * ⚠️ This block used to say "do not re-investigate — there is no cheaper substitute, no public
 * spec." That was true when written and is false now, and the instruction not to look is why the
 * change went unnoticed for months. Treat a do-not-re-investigate note as an EXPIRING claim.
 * `https://code.claude.com/docs/en/permissions` now publishes a worked rule-vs-command match table,
 * names the gitignore spec, enumerates the command separators and the wrapper list, and pins
 * behaviors to Claude Code versions. It cannot confirm equivalence to `nA0()` — only a decompile
 * does that — but it falsifies at zero cost, and running this matcher against it produced seven
 * divergences:
 *
 * 1. A trailing ` *` does not match the bare command: `Bash(ls *)` refuses `ls`. False negative.
 * 2. No compound-command splitting. A rule must match each subcommand across `&&`, `||`, `;`, `|`,
 *    `|&`, `&` and newlines; this matches the whole string, so `Bash(safe-cmd *)` reports
 *    `safe-cmd && other-cmd` as permitted. False POSITIVE — the one with a direction.
 *    ⚠️ `safe-cmd; rm -rf /` is refused by ACCIDENT (no space before `;`), not by this rule.
 * 3. No wrapper stripping (`timeout`, `time`, `nice`, `nohup`, `stdbuf`, `command`, `builtin`,
 *    `noglob`, bare `xargs`).
 * 4. No leading env-assignment stripping (`NODE_ENV=test npm test`).
 * 5. `xargs` is honored on the `:*` lane and not the ` *` lane, though the two forms are documented
 *    as equivalent.
 * 6. `PATH_TOOLS` is over-broad: Claude Code consults path rules for `Edit` and `Read` only, and
 *    warns at startup for the rest (v2.1.210+).
 * 7. MCP tool-name globs (`mcp__server__*`) are unsupported.
 *
 * Also reported and not re-measured here: allow-vs-deny depth asymmetry for single-segment relative
 * patterns, and a leading `/` anchoring at the settings source rather than cwd.
 *
 * ⛔ Do NOT bump `reviewed=` for any of this — nothing was confirmed, only falsified, and the date
 * is the only watcher this claim has. Fixing the seven is tracked in issue #207.
 */

import { createRequire } from 'node:module';
import { homedir } from 'node:os';

import { safePath } from '@vibe-agent-toolkit/utils';
import type { Ignore } from 'ignore';

// createRequire is needed because ignore@6 is CJS and NodeNext module resolution
// doesn't allow calling the default import directly via ESM interop
const _require = createRequire(import.meta.url);
type IgnoreFactory = (options?: object) => Ignore;
 
const createIgnore: IgnoreFactory = _require('ignore');

/** Classification of a Bash permission rule */
export type BashRuleType = 'exact' | 'prefix' | 'wildcard';

/** Parsed Bash rule */
export interface ParsedBashRule {
  type: BashRuleType;
  /** Normalised rule content (after whitespace normalisation) */
  content: string;
  /** Compiled regex for matching (wildcard type only) */
  regex?: RegExp | undefined;
}

/** Tool names that use path-based matching (node-ignore / gitignore spec) */
const PATH_TOOLS = new Set(['Read', 'Edit', 'Write', 'Glob', 'NotebookRead', 'NotebookEdit']);

/**
 * Normalise whitespace in a rule string:
 * - Collapse multiple spaces to single space
 * - Strip leading/trailing whitespace
 */
function normaliseWhitespace(s: string): string {
  return s.trim().replaceAll(/\s+/g, ' ');
}

/**
 * Parse a full permission rule string into tool name and optional content.
 * Examples:
 *   "Bash(npm run *)" → { toolName: "Bash", content: "npm run *" }
 *   "Edit"            → { toolName: "Edit", content: undefined }
 *   "Read(./.env)"    → { toolName: "Read", content: "./.env" }
 */
export function parsePermissionRule(rule: string): {
  toolName: string;
  content: string | undefined;
} {
  const normalised = normaliseWhitespace(rule);
  const parenIdx = normalised.indexOf('(');

  if (parenIdx === -1) {
    return { toolName: normalised, content: undefined };
  }

  const toolName = normalised.slice(0, parenIdx);
  // Strip surrounding parens
  const content = normalised.endsWith(')')
    ? normalised.slice(parenIdx + 1, -1)
    : normalised.slice(parenIdx + 1);

  return { toolName, content: normaliseWhitespace(content) };
}

/**
 * Classify a Bash rule content string into exact | prefix | wildcard.
 */
export function classifyBashRule(content: string): BashRuleType {
  // Legacy prefix syntax: ends with ":*" (e.g. "npm run:*")
  if (content.endsWith(':*')) {
    return 'prefix';
  }

  // Wildcard: contains unescaped "*"
  // An escaped star is \*  — check for bare * not preceded by backslash
  if (/(?<!\\)\*/.test(content)) {
    return 'wildcard';
  }

  return 'exact';
}

/**
 * Parse a Bash rule content string into a ParsedBashRule for matching.
 */
export function parseBashRuleContent(content: string): ParsedBashRule {
  const normalised = normaliseWhitespace(content);
  const type = classifyBashRule(normalised);

  if (type === 'wildcard') {
    // Build anchored regex:
    // 1. Escape all regex special chars except backslash (used for \* escape)
    // 2. Replace unescaped * with .* (matches anything including spaces)
    // 3. Replace \* with literal *
    const escaped = normalised
      // Escape regex special chars (except * and \)
      .replaceAll(/[.+?^${}()|[\]]/g, String.raw`\$&`)
      // Replace unescaped * with .*
      .replaceAll(/(?<!\\)\*/g, '.*')
      // Replace \* with literal *
      .replaceAll(String.raw`\*`, String.raw`\*`);

    // eslint-disable-next-line security/detect-non-literal-regexp -- regex built from sanitized wildcard pattern, not raw user input
    return { type, content: normalised, regex: new RegExp(`^${escaped}$`) };
  }

  if (type === 'prefix') {
    // Strip the ":*" suffix to get the base
    const base = normalised.slice(0, -2);
    return { type, content: base };
  }

  return { type, content: normalised };
}

/**
 * Check whether a Bash command string matches a parsed Bash rule.
 *
 * @param command - The actual command to test (e.g. "git push origin main")
 * @param parsedRule - The parsed rule to match against
 */
export function matchesParsedBashRule(command: string, parsedRule: ParsedBashRule): boolean {
  const normCommand = normaliseWhitespace(command);

  switch (parsedRule.type) {
    case 'exact':
      return normCommand === parsedRule.content;

    case 'prefix': {
      // Prefix matches: base itself, or base + space + anything, or "xargs " + base, etc.
      const base = parsedRule.content;
      return (
        normCommand === base ||
        normCommand.startsWith(`${base} `) ||
        normCommand === `xargs ${base}` ||
        normCommand.startsWith(`xargs ${base} `)
      );
    }

    case 'wildcard':
      return parsedRule.regex?.test(normCommand) ?? false;

    default:
      return false;
  }
}

/**
 * Check whether a Bash command matches a full Bash permission rule string.
 * Rule format: "Bash(npm run *)" or "Bash(git commit)" or bare "Bash"
 *
 * A bare "Bash" (no parens) matches all Bash calls.
 *
 * @param command - The actual command
 * @param rule - Full rule string e.g. "Bash(npm run *)"
 */
export function matchesBashRule(command: string, rule: string): boolean {
  const { toolName, content } = parsePermissionRule(rule);

  if (toolName !== 'Bash') return false;

  // Bare "Bash" — matches all calls
  if (content === undefined || content === '*') return true;

  const parsed = parseBashRuleContent(content);
  return matchesParsedBashRule(command, parsed);
}

/**
 * Check whether a file path matches a Read/Edit/Write/Glob permission rule.
 * Uses node-ignore (gitignore spec) for matching.
 *
 * Path prefixes handled:
 * - "./"  → relative to cwd
 * - "~/"  → relative to homedir
 * - "//"  → absolute (strip one /)
 * - "/"   → relative to project root (cwd)
 * - no prefix → relative to cwd
 *
 * @param filePath - The absolute file path to check
 * @param ruleContent - The path pattern from the rule (e.g. ".env", "~/.ssh/id_rsa")
 * @param cwd - Current working directory (for relative paths)
 */
export function matchesPathRule(
  filePath: string,
  ruleContent: string,
  cwd: string = process.cwd()
): boolean {
  const home = homedir();
  const normalised = normaliseWhitespace(ruleContent);

  let root: string;
  let pattern: string;

  if (normalised.startsWith('//')) {
    // Absolute path: strip one slash
    root = '/';
    pattern = normalised.slice(1);
  } else if (normalised.startsWith('~/')) {
    // Home-relative
    root = home;
    pattern = normalised.slice(2);
  } else if (normalised.startsWith('./')) {
    // CWD-relative
    root = cwd;
    pattern = normalised.slice(2);
  } else {
    // Default: CWD-relative
    root = cwd;
    pattern = normalised;
  }

  const ig = createIgnore().add(pattern);
  const relative = safePath.relative(root, filePath);

  // node-ignore can't match paths that go "up" (..)
  if (relative.startsWith('..')) return false;

  return ig.ignores(relative);
}

/**
 * Check whether a tool call is blocked by a permission rule.
 *
 * Handles both Bash rules (regex-based) and path-tool rules (gitignore-based).
 * A bare tool name (e.g. "Edit") matches all uses of that tool.
 *
 * @param toolName - The tool being called (e.g. "Bash", "Edit")
 * @param toolInput - For Bash: the command string. For path tools: the file path.
 * @param rule - Full permission rule string
 * @param cwd - Current working directory (for path-tool matching)
 */
export function matchesPermissionRule(
  toolName: string,
  toolInput: string,
  rule: string,
  cwd: string = process.cwd()
): boolean {
  const { toolName: ruleTool, content } = parsePermissionRule(rule);

  // Tool names are case-sensitive
  if (ruleTool !== toolName) return false;

  // Bare tool name — matches all calls to this tool
  if (content === undefined) return true;

  if (toolName === 'Bash') {
    return matchesBashRule(toolInput, rule);
  }

  if (PATH_TOOLS.has(toolName)) {
    return matchesPathRule(toolInput, content, cwd);
  }

  // MCP tools and others: bare match only (already handled above)
  // Any content match is treated as wildcard
  if (content === '*') return true;

  return false;
}

/**
 * Check whether `narrowRule` is subsumed by `broadRule`.
 * A broad rule subsumes a narrow rule if the broad rule matches everything the narrow one does.
 *
 * Examples:
 *   isSubsumedBy("Bash(git push *)", "Bash(git *)") → true
 *   isSubsumedBy("Bash(git *)", "Bash(*)") → true
 *   isSubsumedBy("Edit", "Edit") → true (same rule)
 *
 * @param narrowRule - The narrower (more specific) rule
 * @param broadRule - The potentially broader rule
 */
export function isSubsumedBy(narrowRule: string, broadRule: string): boolean {
  const { toolName: narrowTool, content: narrowContent } = parsePermissionRule(narrowRule);
  const { toolName: broadTool, content: broadContent } = parsePermissionRule(broadRule);

  if (narrowTool !== broadTool) return false;

  // Bare broad tool matches everything
  if (broadContent === undefined) return true;

  // Both bare — narrowContent is undefined but broadContent is not (checked above)
  if (narrowContent === undefined) return false;

  // Bash rules: check if broad rule's pattern matches narrow rule's content
  if (narrowTool === 'Bash') {
    // A wildcard broad rule subsumes narrow if broad matches all of narrow's content
    const broadParsed = parseBashRuleContent(broadContent);

    if (broadParsed.type === 'exact') {
      // Exact broad only subsumes exact narrow with same content
      const narrowParsed = parseBashRuleContent(narrowContent);
      return narrowParsed.type === 'exact' && narrowParsed.content === broadParsed.content;
    }

    if (broadParsed.type === 'wildcard') {
      // The broad wildcard subsumes narrow if the narrow rule's content can be derived from broad
      // We check by testing a sample: does broad match narrow's literal content?
      const narrowParsed = parseBashRuleContent(narrowContent);
      return matchesParsedBashRule(narrowParsed.content, broadParsed);
    }
  }

  return false;
}

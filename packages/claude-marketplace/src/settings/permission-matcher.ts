/**
 * Permission rule matching — replicates Claude Code's actual permission matching logic.
 *
 * Two distinct systems depending on tool type:
 * - Bash rules: custom regex builder (exact | prefix | wildcard)
 * - Read/Edit/Write/Glob path rules: node-ignore (gitignore spec)
 *
 * Sources: the Bash lane is now built to the PUBLISHED behavior table at
 * <https://code.claude.com/docs/en/permissions> (read 2026-09-06), which is quoted
 * inline at each rule it decides and pinned by the `published table — …` suites.
 * The path lane and the rule-shape parsing still trace to a decompile of Claude
 * Code v2.1.52 (`nA0()`), which nothing here re-confirms.
 *
 * ⚠️ The table is an authority that can only FALSIFY. It says what the product
 * documents, not what the binary does, so a passing suite means "we match the
 * docs", never "we match `nA0()`".
 *
 * @vendor-claim reviewed=2026-09-06 verify=Re-run the matcher against the published behavior table at https://code.claude.com/docs/en/permissions — the `published table` suites in test/permission-matcher.test.ts encode it clause by clause, so re-reading the page and re-running them IS the check. That falsifies cheaply; it cannot CONFIRM equivalence to nA0(), which needs a decompile of a current binary. Bump reviewed= for a table re-read; note in the docstring if only the table was checked.
 *
 * Note the version discrepancy this pin creates: docs/skill-quality-and-compatibility.md
 * establishes plugin-loader semantics from Claude Code 2.1.126, while the matching
 * logic here was read out of 2.1.52. Nothing reconciles the two, and no test can:
 * these are semantics of somebody else's binary, so the suite below can only assert
 * that our replica is self-consistent, never that it still matches the real one.
 * The `reviewed=` date above is the 2.1.52 read, not a re-confirmation against 2.1.126.
 *
 * ⚠️ This block used to say "do not re-investigate — there is no cheaper substitute, no public
 * spec." That was true when written and is false now, and the instruction not to look is why the
 * change went unnoticed for months. Treat a do-not-re-investigate note as an EXPIRING claim.
 * `https://code.claude.com/docs/en/permissions` publishes a worked rule-vs-command match table,
 * names the gitignore spec, enumerates the command separators and the wrapper list, and pins
 * behaviors to Claude Code versions. Running this matcher against it produced seven divergences.
 *
 * ## Of those seven, FOUR are fixed and pinned; three remain
 *
 * ✅ 1. A trailing ` *` now matches the bare command, and only when it is the rule's ONLY
 *       wildcard — see {@link bareCommandFor}.
 * ✅ 2. Compound commands now split on `&&`, `||`, `;`, `|`, `|&`, `&` and newlines, and an allow
 *       rule must match EVERY subcommand — see {@link splitCompound}. This was the false POSITIVE,
 *       the one divergence with a dangerous direction. A dangling `&&`/`||` is unparseable and
 *       approves nothing.
 * ✅ 3. Wrappers are stripped — see {@link stripWrappers}. `command -v` and `nocorrect` are not,
 *       per the table. ⚠️ Which tokens belong to the wrapper is a documented HEURISTIC; read
 *       {@link isWrapperOwnToken} before trusting it on a flag with a non-numeric value.
 * ✅ 5. `xargs` no longer belongs to the `:*` lane alone: both trailing-wildcard spellings resolve
 *       through one path, and `xargs` moved into the shared wrapper strip.
 *
 * ⛔ 4. Leading env-assignment stripping is NOT implemented, and cannot be faithfully: the table
 *       says an allow rule strips *"a leading assignment of certain known-safe environment
 *       variables"* and *"won't match past an assignment of any other variable"* — without
 *       publishing that list. Guessing it would produce false POSITIVES, so nothing is stripped.
 *       `Bash(npm test *)` therefore refuses `NODE_ENV=test npm test`: an under-match, the safe
 *       direction. The deny/ask side (*"matches past any leading assignment"*) is unimplemented
 *       because this module has no allow/deny/ask context — see below.
 * ⛔ 6. `PATH_TOOLS` is over-broad: Claude Code consults path rules for `Edit` and `Read` only,
 *       and warns at startup for the rest (v2.1.210+).
 * ⛔ 7. MCP tool-name globs are unsupported. The table splits them: deny/ask accept a glob in the
 *       tool-name position, while allow accepts one only after a literal `mcp__<server>__` prefix.
 *
 * ## The structural gap this module cannot close alone
 *
 * 🔑 Matching is NOT symmetric between allow and deny/ask, and this module is not told which it is
 * serving. The table: an allow rule needs every subcommand to match, while deny and ask apply when
 * ANY subcommand matches, *"including a command nested inside a subshell, a command substitution,
 * or a control-flow body"*. Everything here implements the ALLOW lane, which under-matches for
 * deny — the unsafe direction for a deny check. A deny lane needs its own entry point that descends
 * into `$(…)` and control-flow bodies; do not reach for {@link splitCompound} to build it.
 *
 * Also reported and not re-measured here: allow-vs-deny depth asymmetry for single-segment relative
 * patterns, and a leading `/` anchoring at the settings source rather than cwd.
 *
 * Remaining work is tracked in issue #207.
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
 * Wrappers stripped before a Bash rule is matched, per the published table:
 * *"The stripped wrappers are `timeout`, `time`, `nice`, `nohup`, and `stdbuf`,
 * plus the shell builtins `command` and `builtin`, and zsh's `noglob`."*
 *
 * `xargs` is handled separately because its stripping is conditional on having
 * no flags. `command -v` and `nocorrect` are deliberately absent: the table
 * names both as forms that are NOT stripped.
 */
const STRIPPED_WRAPPERS = new Set([
  'timeout',
  'time',
  'nice',
  'nohup',
  'stdbuf',
  'command',
  'builtin',
  'noglob',
]);

/**
 * The two-character compound separators, checked before the single-character
 * ones so `&&` is never read as two `&` and `|&` is never read as `|`.
 *
 * *"The recognized command separators are `&&`, `||`, `;`, `|`, `|&`, `&`, and
 * newlines."*
 */
const TWO_CHAR_SEPARATORS = new Set(['&&', '||', '|&']);

/** The single-character compound separators. */
const ONE_CHAR_SEPARATORS = new Set([';', '|', '&', '\n']);

/**
 * The separators after which nothing may follow: *"When `&&` or `||` has nothing
 * after it … Claude Code treats the command as unparseable"*. A trailing `;` is
 * ordinary shell and stays parseable.
 */
const LOGICAL_SEPARATORS = new Set(['&&', '||']);

/**
 * Normalise whitespace in a rule string:
 * - Collapse multiple spaces to single space
 * - Strip leading/trailing whitespace
 */
function normaliseWhitespace(s: string): string {
  return s.trim().replaceAll(/\s+/g, ' ');
}

/**
 * A token that belongs to the WRAPPER rather than to the command it wraps —
 * a flag (`-n`, `--foo`) or an operand-shaped value such as `timeout`'s
 * duration (`30`, `1.5`, `30s`).
 *
 * ⚠️ This is a HEURISTIC and the published table does not specify it. The table
 * says only that each wrapper *"runs its argument as the actual command"*, and
 * gives one worked example (`timeout 30 npm test`). Skipping flag-shaped and
 * duration-shaped tokens covers that example and the ordinary `nice -n 5` form,
 * but a wrapper flag taking a non-numeric value — `timeout -s KILL 30 cmd` —
 * stops the skip early and will not match. That is a known under-match: it
 * refuses a command Claude Code would allow, never the reverse, which is the
 * safe direction for a checker that reports on someone's config.
 */
function isWrapperOwnToken(token: string): boolean {
  // `^\d[\d.]*[a-z]?$` rather than `^\d+(?:\.\d+)?[a-z]?$`: one leading digit
  // then a flat class carries no nested quantifier, so there is nothing for the
  // engine to backtrack over. It also accepts `1.2.3`, which is fine here — the
  // question is only "does this token look like an operand, not a command".
  return token.startsWith('-') || /^\d[\d.]*[a-z]?$/.test(token);
}

/**
 * Strip one leading wrapper, or return the command unchanged when none applies.
 */
function stripOneWrapper(command: string): string {
  const tokens = command.split(' ');
  const head = tokens[0];
  if (head === undefined || tokens.length < 2) return command;

  // The query form `command -v` looks a command UP rather than running one.
  if (head === 'command' && tokens[1] === '-v') return command;

  if (head === 'xargs') {
    // Stripping applies only when `xargs` has no flags.
    return tokens[1]?.startsWith('-') === true ? command : tokens.slice(1).join(' ');
  }

  if (!STRIPPED_WRAPPERS.has(head)) return command;

  let index = 1;
  while (index < tokens.length - 1 && isWrapperOwnToken(tokens[index] as string)) index += 1;
  return tokens.slice(index).join(' ');
}

/**
 * Strip every leading wrapper, so `timeout 30 nice -n 5 npm test` reduces to
 * `npm test`. Iterates because wrappers nest.
 */
function stripWrappers(command: string): string {
  let current = command;
  for (;;) {
    const next = stripOneWrapper(current);
    if (next === current) return current;
    current = next;
  }
}

/**
 * Split a command into the subcommands an allow rule must match INDEPENDENTLY,
 * or `undefined` when the command is unparseable and no allow rule may approve it.
 *
 * *"A rule must match each subcommand independently."* — and *"When `&&` or `||`
 * has nothing after it, such as in `npm test &&`, Claude Code treats the command
 * as unparseable and doesn't split it into subcommands for allow-rule matching."*
 *
 * ⚠️ ALLOW-lane semantics. Deny and ask rules are the mirror image — they apply
 * when ANY subcommand matches, *"including a command nested inside a subshell, a
 * command substitution, or a control-flow body"* — and this function does not
 * serve them: it neither descends into `$(…)` nor into a `for` body. A deny lane
 * built on it would UNDER-match, which is the unsafe direction, so it must not
 * be reused there without handling nesting first.
 */
function splitCompound(command: string): string[] | undefined {
  const { parts, dangling } = scanTopLevel(command.trim());
  if (dangling) return undefined;
  return parts.map((part) => part.trim()).filter((part) => part.length > 0);
}

/** How far into `command` a quoted run starting at `start` extends, past its closer. */
function endOfQuoted(command: string, start: number): number {
  const quote = command[start];
  let index = start + 1;
  while (index < command.length) {
    const char = command[index];
    // Inside single quotes a backslash is literal, per POSIX.
    if (char === '\\' && quote === '"') index += 2;
    else if (char === quote) return index + 1;
    else index += 1;
  }
  return command.length; // Unterminated quote: the rest of the string is quoted.
}

/**
 * The separator at `index`, or `undefined` when the character there is not one.
 */
function separatorAt(command: string, index: number): string | undefined {
  const two = command.slice(index, index + 2);
  if (TWO_CHAR_SEPARATORS.has(two)) return two;
  const one = command[index];
  return one !== undefined && ONE_CHAR_SEPARATORS.has(one) ? one : undefined;
}

/**
 * Split on separators that are genuinely top level — not inside quotes, not
 * inside `(…)` or `$(…)`, and not backslash-escaped.
 *
 * 🚩 A regex split cannot do this, and using one was a defect: `grep -E "a|b"
 * file` split at the `|` INSIDE the quotes, leaving `b" file` as a subcommand
 * that no rule matches, so `Bash(grep *)` stopped permitting an ordinary grep.
 * That is an under-match — the safe direction — but it breaks common commands,
 * and quoted `|`, `&&` and `;` are far too common to wave through.
 *
 * A single linear scan, so there is no backtracking to reason about.
 *
 * @param command - The trimmed command text
 * @returns The top-level parts, and whether a `&&`/`||` was left dangling
 */
function scanTopLevel(command: string): { parts: string[]; dangling: boolean } {
  const parts: string[] = [];
  let current = '';
  let depth = 0;
  let index = 0;
  let lastSeparator: string | undefined;

  while (index < command.length) {
    const char = command[index];
    if (char === '(') depth += 1;
    else if (char === ')' && depth > 0) depth -= 1;

    const separator = depth === 0 ? separatorAt(command, index) : undefined;
    if (separator === undefined) {
      const run = literalRunAt(command, index);
      current += run;
      index += run.length;
      continue;
    }
    parts.push(current);
    current = '';
    lastSeparator = separator;
    index += separator.length;
  }

  parts.push(current);
  const dangling =
    lastSeparator !== undefined &&
    LOGICAL_SEPARATORS.has(lastSeparator) &&
    current.trim().length === 0;
  return { parts, dangling };
}

/**
 * The literal run beginning at `index` — a whole quoted section, a backslash
 * escape pair, or a single ordinary character. Never a separator: the caller
 * has already established that this position is not one.
 */
function literalRunAt(command: string, index: number): string {
  const char = command[index] as string;
  if (char === '"' || char === "'") return command.slice(index, endOfQuoted(command, index));
  if (char === '\\' && index + 1 < command.length) return command.slice(index, index + 2);
  return char;
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
 * The command text a rule permits BARE, or `undefined` when the rule does not
 * permit a bare command.
 *
 * *"A `*` at the end, with a space before it, also matches the bare command.
 * `Bash(ls *)` matches `ls` … That holds only when the trailing `*` is the
 * rule's only wildcard: `Bash(* --help *)` matches `npm --help x` but not
 * `npm --help`."*
 *
 * The `:*` spelling is the same rule — *"an equivalent way to write a trailing
 * wildcard"* — so both spellings resolve here and neither lane gets behaviour
 * the other lacks. That equivalence is why `xargs` handling had to move out of
 * the `:*` branch and into {@link stripWrappers}, which serves every lane.
 */
function bareCommandFor(content: string): string | undefined {
  if (content.endsWith(':*')) return content.slice(0, -2);
  if (!content.endsWith(' *')) return undefined;
  // Only when the trailing star is the rule's ONLY wildcard.
  const withoutTrailing = content.slice(0, -2);
  return withoutTrailing.includes('*') ? undefined : withoutTrailing;
}

/**
 * Check whether a Bash command string matches a parsed Bash rule.
 *
 * ⚠️ This is the RAW shape test, and it is not what a caller asking
 * *"may this command run?"* wants — use {@link matchesBashRule} for that. It
 * deliberately does **none** of the surrounding work: no compound splitting, no
 * wrapper stripping, and no bare-command rule. Handed `safe-cmd && other-cmd`
 * it tests the whole string as one command and will answer `true` for a rule
 * that must not permit it.
 *
 * It stays exported because {@link isSubsumedBy} genuinely needs it: comparing
 * two RULES is not the same question as testing a command, and splitting a
 * rule's content on `&&` or stripping `timeout` out of it would be nonsense.
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
      // Base itself, or base + space + anything. `xargs` is NOT special-cased
      // here any more: it is one of the wrappers {@link stripWrappers} removes
      // before matching, so every lane gets it rather than this one alone.
      const base = parsedRule.content;
      return normCommand === base || normCommand.startsWith(`${base} `);
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

  const subcommands = splitCompound(command);
  // Unparseable (a dangling `&&`/`||`), or nothing to match: no allow rule approves it.
  if (subcommands === undefined || subcommands.length === 0) return false;

  const parsed = parseBashRuleContent(content);
  const bare = bareCommandFor(content);
  return subcommands.every((subcommand) => matchesSubcommand(subcommand, parsed, bare));
}

/**
 * Whether ONE subcommand — wrappers already stripped — satisfies the rule.
 *
 * @param subcommand - A single command, with no compound separators left in it
 * @param parsed - The rule, pre-parsed once for the whole compound
 * @param bare - The command text this rule permits bare, from {@link bareCommandFor}
 */
function matchesSubcommand(
  subcommand: string,
  parsed: ParsedBashRule,
  bare: string | undefined,
): boolean {
  const stripped = normaliseWhitespace(stripWrappers(normaliseWhitespace(subcommand)));
  if (bare !== undefined && stripped === bare) return true;
  return matchesParsedBashRule(stripped, parsed);
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
    const broadParsed = parseBashRuleContent(broadContent);
    const narrowParsed = parseBashRuleContent(narrowContent);

    if (broadParsed.type === 'exact') {
      // Exact broad only subsumes exact narrow with same content
      return narrowParsed.type === 'exact' && narrowParsed.content === broadParsed.content;
    }

    // Wildcard AND prefix. The `prefix` case used to be absent, so a `:*` rule
    // subsumed nothing at all and the conflict analyzer never reported a rule
    // made redundant by one.
    //
    // 🔑 The bare-command test has to be here too, or this function and
    // {@link matchesBashRule} disagree about the same pair: `Bash(ls *)` permits
    // bare `ls`, so it must also SUBSUME `Bash(ls)`. Two answers to one question
    // is how a checker starts contradicting itself.
    const bare = bareCommandFor(broadContent);
    if (bare !== undefined && narrowParsed.content === bare) return true;
    return matchesParsedBashRule(narrowParsed.content, broadParsed);
  }

  return false;
}

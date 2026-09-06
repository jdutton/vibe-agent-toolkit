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
 * ⛔ `reviewed=` is 2026-04-08 and stays there until someone decompiles a current binary. It was
 * briefly bumped to 2026-09-06 on a table re-read — in the same commit that rewrote the instruction
 * forbidding exactly that, so nothing outside the change ever adjudicated the rule. Restored. The
 * 90-day warning this now raises is correct: nobody has confirmed equivalence to `nA0()` since.
 *
 * @vendor-claim reviewed=2026-04-08 verify=Re-read the published behavior table at https://code.claude.com/docs/en/permissions clause by clause against this file. ⛔ Do NOT treat a green `published table` suite as the check: it is a SUBSET, and these published clauses have no assertion behind them at all — redirections vs the `&` separator, tool-name globs, env-assignment stripping, deny/ask ANY-subcommand, nested commands, Edit/Read-only path lanes, `Bash(command:rm *)` being ignored, and `WebFetch(domain:…)`. A reviewer who only re-runs the suite ships every one of those. The table falsifies cheaply and can never CONFIRM equivalence to nA0(), which needs a decompile of a current binary. Bump reviewed= only for a decompile; a table-only re-read is noted in the docstring and leaves the date alone.
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
 *       the one divergence with a dangerous direction. A dangling `&&`/`||`, an unterminated quote
 *       and an unclosed `(` are all unparseable and approve nothing.
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
 * ## 🚨 The structural gap: this module serves the ALLOW lane and its only caller is DENY
 *
 * 🔑 Matching is NOT symmetric between allow and deny/ask. The table: an allow rule needs EVERY
 * subcommand to match, while deny and ask apply when ANY subcommand matches, *"including a command
 * nested inside a subshell, a command substitution, or a control-flow body"*. Everything here
 * implements the ALLOW lane.
 *
 * ⛔ An earlier version of this comment said the module "is not told which lane it is serving."
 * That was never a structural fact — it was a fact nobody looked up. {@link matchesPermissionRule}
 * has exactly ONE production call site, `settings-compat-checker.ts:158`, fed from `:262` with
 * `effectiveSettings.permissions.deny`. The answer is: always deny.
 *
 * 🪤 So allow-lane correctness is, for the only caller, deny-lane UNDER-matching — the unsafe
 * direction. Verified `false` (reported as "no conflict") where Claude Code blocks:
 * `Bash(curl:*)` vs `curl https://x && echo done` (ANY subcommand); `Bash(rm *)` vs
 * `FOO=bar rm -rf tmp/` (deny matches past any leading assignment); `Bash(gitx clean *)` vs
 * `echo "$(gitx clean -f)"` (nested); and `Bash(rm *)` vs `timeout -s KILL 30 rm -rf tmp/`, which
 * {@link stripOneWrapper}'s own false-permit fix turned from `true` to `false`. Row 1 was caught
 * before the compound split was added.
 *
 * 🔑 Two separate, individually-correct allow-lane fixes have now each made the deny lane worse.
 * That is the argument for closing this, not the row count: **every future allow-lane correctness
 * fix will do the same until the lane is a parameter.** All four re-measured on `e5963fed` through
 * {@link matchesPermissionRule}, the entry point the caller actually uses.
 *
 * The fix is a lane parameter plus a `matchesDenyRule` entry point with ANY-subcommand semantics,
 * descent into `$(…)` and control-flow bodies, and unconditional leading-assignment stripping.
 * Until then, do not reach for {@link splitCompound} to build a deny lane.
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

/**
 * Tool names whose path rules Claude Code actually consults:
 * *"Claude Code checks file permissions against `Edit(path)` and `Read(path)`
 * rules only"* (v2.1.210+).
 */
const PATH_TOOLS = new Set(['Read', 'Edit']);

/**
 * Tools whose path rules Claude Code *"accepts … but never consults, and warns
 * at startup"*. A rule like `Write(./secrets/**)` blocks nothing, so reporting
 * it as blocking something is a wrong answer about an adopter's config.
 *
 * 🚩 All four used to live in {@link PATH_TOOLS} and were matched as if they
 * were consulted. `NotebookRead` is not named in the doc's list at all — it was
 * simply assumed in. A bare `Write` still denies the TOOL and is unaffected;
 * only a rule carrying a path falls under this.
 */
const UNCONSULTED_PATH_TOOLS = new Set(['Write', 'Glob', 'NotebookRead', 'NotebookEdit']);

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
 * stops the skip on the flag's own VALUE. See {@link stripOneWrapper} for why
 * that case must refuse to strip rather than strip to the wrong place.
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
 *
 * 🚩 A flag's VALUE can land in the command position, and stripping to it was a
 * FALSE PERMIT: in `timeout -s ls 30 rm -rf /`, `-s` is skipped as a flag, `ls`
 * halts the skip, and `Bash(ls *)` was reported as permitting `ls 30 rm -rf /`.
 * The heuristic cannot know a wrapper flag's arity, so when the skip halts on
 * the token immediately after a flag, the only honest answer is to strip
 * nothing. That refuses `timeout -s KILL 30 npm test` under `Bash(npm test *)`
 * — an under-match, and the direction to keep FOR THE ALLOW LANE.
 *
 * 🪤 It is the WRONG direction for the deny lane, which is the only lane with a
 * caller: `Bash(rm *)` vs `timeout -s KILL 30 rm -rf tmp/` went `true` → `false`
 * with this fix, and Claude Code blocks it. Measured on `e5963fed`. That is not
 * a reason to revert — the false permit this closed is the more severe
 * direction, and a deny under-match is an under-REPORT in a checker rather than
 * a runtime grant — but note the shape: **every allow-lane correctness fix makes
 * the deny lane worse until the lane parameter exists.** See the file header.
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
  // The token the skip halted on may be the VALUE of the flag before it, not a
  // command. Unknowable from here, so strip nothing rather than strip wrong.
  if (tokens[index - 1]?.startsWith('-') === true) return command;
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
 * Unparseable here means a dangling `&&`/`||`, an unterminated quote, or an
 * unclosed `(`. All three refuse, per *"when Claude Code can't fully parse a
 * command, it asks for approval instead."*
 *
 * ⚠️ ALLOW-lane semantics. Deny and ask rules are the mirror image — they apply
 * when ANY subcommand matches, *"including a command nested inside a subshell, a
 * command substitution, or a control-flow body"* — and this function does not
 * serve them: it neither descends into `$(…)` nor into a `for` body. A deny lane
 * built on it would UNDER-match, which is the unsafe direction, so it must not
 * be reused there without handling nesting first.
 */
function splitCompound(command: string): string[] | undefined {
  const parts = scanTopLevel(command.trim());
  if (parts === undefined) return undefined;
  return parts.map((part) => part.trim()).filter((part) => part.length > 0);
}

/**
 * How far into `command` a quoted run starting at `start` extends, past its
 * closer — or `undefined` when the quote is never closed.
 *
 * ⚠️ The `undefined` is load-bearing and must never be softened into "the rest
 * of the string is quoted". That was the original behaviour and it was a FALSE
 * PERMIT: it made every separator after an odd quote invisible, so
 * `Bash(echo *)` approved `echo hi # don't⏎rm -rf /` — the apostrophe being the
 * entire difference between that and a correct refusal. See {@link scanTopLevel}.
 */
function endOfQuoted(command: string, start: number): number | undefined {
  const quote = command[start];
  let index = start + 1;
  while (index < command.length) {
    const char = command[index];
    // Inside single quotes a backslash is literal, per POSIX. Bash's `$'…'`
    // form does honour `\'`, which this does not read, so `echo $'a\'b'` scans
    // as an unterminated quote and is REFUSED. That is a known under-match and
    // it is the direction to keep: honouring the escape without also tracking
    // the `$` prefix would re-open the false permit above.
    if (char === '\\' && quote === '"') index += 2;
    else if (char === quote) return index + 1;
    else index += 1;
  }
  return undefined; // Unterminated quote: the command cannot be fully parsed.
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
 * 🚩 Every way this scan can fail resolves to `undefined`, never to a best
 * guess. *"When Claude Code can't fully parse a command, it asks for approval
 * instead."* An unterminated quote and an unbalanced `(` used to degrade into
 * "assume the rest is quoted" and "stay inside the subshell forever"; both
 * silenced separator detection for the remainder of the command, and both were
 * therefore FALSE PERMITS — `Bash(npm test *)` approved `npm test # (⏎rm -rf /`.
 * A graceful degradation in a permission checker has exactly one safe
 * direction, and it is refusal.
 *
 * @param command - The trimmed command text
 * @returns The top-level parts, or `undefined` when the command is unparseable
 */
function scanTopLevel(command: string): string[] | undefined {
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
      if (run === undefined) return undefined; // Unterminated quote.
      current += run;
      index += run.length;
      continue;
    }
    parts.push(current);
    current = '';
    lastSeparator = separator;
    index += separator.length;
  }

  if (depth !== 0) return undefined; // Unclosed `(` or `$(`.
  const dangling =
    lastSeparator !== undefined &&
    LOGICAL_SEPARATORS.has(lastSeparator) &&
    current.trim().length === 0;
  if (dangling) return undefined;

  parts.push(current);
  return parts;
}

/**
 * The literal run beginning at `index` — a whole quoted section, a backslash
 * escape pair, or a single ordinary character — or `undefined` when a quote
 * opens here and is never closed. Never a separator: the caller has already
 * established that this position is not one.
 */
function literalRunAt(command: string, index: number): string | undefined {
  const char = command[index] as string;
  if (char === '"' || char === "'") {
    const end = endOfQuoted(command, index);
    return end === undefined ? undefined : command.slice(index, end);
  }
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

/** The regex source for one wildcard: anything, including spaces. */
const ANY_RUN = '.*';

/** The rule spelling for a literal `*`. */
const ESCAPED_STAR = String.raw`\*`;

/**
 * The regex source matching `text` literally — every metacharacter escaped,
 * BACKSLASH INCLUDED.
 *
 * 🚩 The escape class this replaced omitted `\`, so a backslash in the rule
 * survived into the compiled regex as the start of an escape sequence. That was
 * a FALSE PERMIT: `Bash(a\b *)` matched `a b`, because `\b` compiled to a word
 * boundary rather than to the two characters the rule author wrote. `\d`, `\s`,
 * `\w` and `\B` all did the same, and any Windows path in a rule compiled to
 * something other than itself.
 */
function escapeRegexLiteral(text: string): string {
  return text.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

/**
 * Compile a wildcard rule's content into an anchored regex.
 *
 * `\*` is a literal star; every other `*` is a wildcard. A RUN of consecutive
 * wildcards collapses to one `.*`, which permits exactly what the run permitted.
 *
 * 🚩 That collapse is not cosmetic. Adjacent `.*` backtrack polynomially, and
 * both inputs here are attacker-reachable files this auditor reads — a
 * `settings.json` permission entry and a `SKILL.md` `allowed-tools` entry.
 * Measured before the collapse, rule `Bash(a**********z)` against `a` + n×`b`:
 * n=20 → 228 ms, n=24 → 314 ms, n=28 → 1087 ms — doubling every ~4 characters,
 * so a 40-character rule takes minutes. One `.*` is linear.
 *
 * ⚠️ A previous commit claimed to have "removed a super-linear pattern" here.
 * It removed the SPLITTER's, and left this one — which it had just built.
 */
function compileWildcardRule(content: string): RegExp {
  const parts: string[] = [];
  let literal = '';
  let index = 0;

  while (index < content.length) {
    if (content.startsWith(ESCAPED_STAR, index)) {
      literal += '*';
      index += ESCAPED_STAR.length;
    } else if (content.charAt(index) === '*') {
      if (literal.length > 0) parts.push(escapeRegexLiteral(literal));
      literal = '';
      if (parts.at(-1) !== ANY_RUN) parts.push(ANY_RUN);
      index += 1;
    } else {
      literal += content.charAt(index);
      index += 1;
    }
  }
  if (literal.length > 0) parts.push(escapeRegexLiteral(literal));

  // eslint-disable-next-line security/detect-non-literal-regexp -- every literal run goes through escapeRegexLiteral; the only unescaped construct in the source is this function's own ANY_RUN, so no rule text reaches the compiler raw
  return new RegExp(`^${parts.join('')}$`);
}

/**
 * Parse a Bash rule content string into a ParsedBashRule for matching.
 */
export function parseBashRuleContent(content: string): ParsedBashRule {
  const normalised = normaliseWhitespace(content);
  const type = classifyBashRule(normalised);

  if (type === 'wildcard') {
    return { type, content: normalised, regex: compileWildcardRule(normalised) };
  }

  if (type === 'prefix') {
    // Strip the ":*" suffix to get the base.
    const base = normalised.slice(0, -2);
    // 🚩 The base is compiled as a WILDCARD pattern, not compared literally.
    // *"The `:*` suffix is an equivalent way to write a trailing wildcard"* — and
    // it was not: a literal comparison left any earlier `*` in the rule as a `*`
    // CHARACTER, so `Bash(gitx * main:*)` matched nothing while the identical
    // `Bash(gitx * main *)` matched. Two spellings the table calls equivalent
    // must not have two matchers.
    return { type, content: base, regex: compileWildcardRule(`${base} *`) };
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
  // Both spellings of a trailing wildcard, stripped the same way.
  //
  // 🚩 The `:*` branch used to return unconditionally, skipping the only-wildcard
  // restriction the ` *` branch applies. That handed `Bash(* --help:*)` a bare
  // permit for `npm --help` — the exact command the table's own worked example
  // says `Bash(* --help *)` must refuse.
  if (!content.endsWith(':*') && !content.endsWith(' *')) return undefined;
  const withoutTrailing = content.slice(0, -2);
  // Only when the trailing star is the rule's ONLY wildcard.
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
 * ⛔ It used to be exported, on the stated grounds that {@link isSubsumedBy}
 * "genuinely needs it" because comparing two RULES is not the same question as
 * testing a command. That reasoning is what let the two disagree: `isSubsumedBy`
 * re-derived the answer here, skipped wrapper stripping and the bare-command
 * rule, and so reported `Bash(npm test *)` redundant under `Bash(npm * *)` —
 * advice that revokes bare `npm test`. It now asks {@link matchesBashRule}, and
 * nothing outside this module needs the raw form, so it is no longer exported.
 *
 * @param command - The actual command to test (e.g. "git push origin main")
 * @param parsedRule - The parsed rule to match against
 */
function matchesParsedBashRule(command: string, parsedRule: ParsedBashRule): boolean {
  const normCommand = normaliseWhitespace(command);

  switch (parsedRule.type) {
    case 'exact':
      return normCommand === parsedRule.content;

    // `:*` compiles to the same regex as the equivalent trailing ` *`, so both
    // spellings answer through one matcher. The bare base is granted by
    // {@link bareCommandFor} — and only when the trailing wildcard is the rule's
    // ONLY one, which is exactly the restriction the literal comparison here
    // used to bypass. `xargs` is not special-cased: it is one of the wrappers
    // {@link stripWrappers} removes, so every lane gets it.
    case 'prefix':
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
  // 🚩 Resolve against `root` explicitly. `safePath.relative(root, filePath)`
  // alone lets Node resolve a RELATIVE filePath against `process.cwd()` rather
  // than against the root this function was handed, so the verdict depended on
  // where the process was launched. The only production caller passes a plugin
  // directory, which is never `process.cwd()` — so the whole path lane of the
  // deny check answered `false` for everything. An absolute filePath is
  // unaffected: `resolve` returns it unchanged.
  const relative = safePath.relative(root, safePath.resolve(root, filePath));

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

  // Accepted by Claude Code, never consulted — so it blocks nothing, including
  // when the path is `*`. Must come BEFORE the `content === '*'` fallthrough.
  if (UNCONSULTED_PATH_TOOLS.has(toolName)) return false;

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

  // Bash rules: ask {@link matchesBashRule} both halves of the question, so
  // there is only ever ONE implementation of "does this rule permit this?".
  // Re-deriving the answer here is what let the two drift apart.
  if (narrowTool === 'Bash') {
    // A rule's extension includes the bare command it permits, and that is the
    // half a broad rule can fail to cover.
    //
    // 🚩 `Bash(npm test *)` was reported redundant under `Bash(npm * *)`, and
    // `settings-conflict-analyzer` turns that into advice to DELETE it — which
    // silently revoked bare `npm test`, because a rule with two wildcards does
    // not permit a bare command. Pinned by the soundness property in the suite:
    // if we advise deleting a rule, no command may lose permission.
    const narrowBare = bareCommandFor(narrowContent);
    if (narrowBare !== undefined && !matchesBashRule(narrowBare, broadRule)) return false;

    // Then the rest of narrow's extension, with its content read as a command.
    // Wrappers are stripped on this path too, so `Bash(builtin cd)` is correctly
    // reported redundant under `Bash(cd *)` — it was not before.
    return matchesBashRule(narrowContent, broadRule);
  }

  return false;
}

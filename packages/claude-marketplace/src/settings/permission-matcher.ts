/**
 * Permission rule matching — replicates Claude Code's actual permission matching logic.
 *
 * Two distinct systems depending on tool type:
 * - Bash rules: custom glob matcher (exact | prefix | wildcard)
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
 * behaviors to Claude Code versions. Running this matcher against it produced seven divergences,
 * and a later pass found an eighth.
 *
 * ## Of those eight, SEVEN are fixed and pinned; one remains
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
 * ✅ 4. Leading env-assignment stripping is implemented, PER LANE — see
 *       {@link stripLeadingAssignment}.
 * ✅ 5. `xargs` no longer belongs to the `:*` lane alone: both trailing-wildcard spellings resolve
 *       through one path, and `xargs` moved into the shared wrapper strip.
 * ✅ 6. `PATH_TOOLS` is `{Read, Edit}`: Claude Code consults path rules for those two only and
 *       warns at startup for the rest (v2.1.210+) — see {@link UNCONSULTED_PATH_TOOLS}.
 * ✅ 7. Tool-name globs are supported, and asymmetrically, as the table splits them: deny/ask
 *       accept a glob anywhere in the tool-name position, while allow accepts one only after a
 *       literal `mcp__<server>__` prefix — see {@link matchesToolName}.
 * ✅ 8. `WebFetch(domain:…)` is matched rather than silently answering `false` — see
 *       {@link matchesStructuredContent}. This one was never on the original list.
 *
 * ⛔ The one still open is not a divergence from the table but a hole IN it: whether the ALLOW lane
 *    descends into `$(…)`, backticks and control-flow bodies is UNDETERMINED. The page's only
 *    nesting sentence is the deny/ask one, so only the deny/ask half is implemented here, and the
 *    allow half is left where it was rather than guessed at in either direction. The assertion that
 *    pins the permissive reading is annotated ⛔ UNSOURCED in the suite. Resolve it against the
 *    product, not against this file.
 *
 * ## 🔑 The lane is a PARAMETER, because matching is not symmetric
 *
 * The table: an allow rule needs EVERY subcommand to match, while deny and ask apply when ANY
 * subcommand matches, *"including a command nested inside a subshell, a command substitution, or a
 * control-flow body"*, and *"a deny or ask rule matches past any leading assignment"* where an
 * allow rule strips only *"certain known-safe environment variables"*. Deny and ask are named
 * together in every clause, so they are ONE behaviour here ({@link isBlockingLane}), never two
 * implementations that could drift.
 *
 * 🚩 This module used to implement the allow lane only, while its sole production call site —
 * `settings-compat-checker.ts`, fed with `effectiveSettings.permissions.deny` — used it entirely
 * for DENY. Allow-lane correctness is, for that caller, deny-lane UNDER-matching: the unsafe
 * direction, because an under-match is silently reported as "no conflict". Two individually-correct
 * allow-lane fixes each made the deny lane worse before the lane became a parameter, which is the
 * argument for the parameter rather than any particular row count.
 *
 * ⛔ {@link matchesPermissionRule} and {@link matchesBashRule} therefore take `lane` as a REQUIRED
 * argument with no default. A default would be the no-op: every existing caller would keep the old
 * behaviour and the defect would survive the fix that was supposed to close it. Callers that want
 * the lane bound use {@link matchesAllowRule} / {@link matchesDenyRule}.
 *
 * The four rows that were `false` — reported as "no conflict" — where Claude Code blocks, and are
 * now `true` through {@link matchesPermissionRule} with `lane: 'deny'`:
 * `Bash(curl:*)` vs `curl https://x && echo done` (ANY subcommand); `Bash(rm *)` vs
 * `FOO=bar rm -rf tmp/` (past any leading assignment); `Bash(gitx clean *)` vs
 * `echo "$(gitx clean -f)"` (nested); and `Bash(rm *)` vs `timeout -s KILL 30 rm -rf tmp/`, where
 * the deny lane takes ANY reading the wrapper heuristic admits ({@link stripOneWrapperReadings})
 * while the allow lane keeps its single conservative one.
 *
 * 🚩 The allow lane is not WEAKENED by any of this — but it is not unchanged either, and this block
 * used to claim it was: *"where the two lanes differ, the allow side is byte-for-byte the behaviour
 * the false-permit fixes left it with"*. That was a corpus-limited claim, and a 270,855-pair
 * differential of the pre-lane matcher against {@link matchesAllowRule} falsified it. 1,219 pairs
 * diverge. 776 are old=`false`→new=`true`: 736 of those are the intended `NODE_ENV` strip, and
 * ⚠️ FORTY are not. The other 443 are old=`true`→new=`false` — the compound-split and unparseable
 * refusals, every one in the safe direction.
 *
 * 🔑 The real boundary, in place of "unchanged": the allow lane takes a wrapper strip whenever the
 * heuristic admits exactly ONE reading, and {@link wrapperCommandStarts} yields one reading — not
 * two — when the resumed reading would run off the end of the token list. So `Bash(test *)` now
 * matches `timeout 30 -rf test`, `nice -n 5 -rf test` and `command -rf test`, where the old code
 * returned the command unchanged. That is correct and stays: the branch is reachable only when the
 * ambiguous token is LAST, and there the alternative reading is *"the flag ate it and no command
 * runs at all"* — a permit cannot be wrong about a command that does not exist. The false permit F5
 * closed has the other shape and is untouched: `timeout -s ls 30 rm -rf /` still yields two
 * readings, and the allow lane still takes neither. Pinned by *"strips when the ambiguous token is
 * LAST, and refuses when it is not"* in the suite.
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

/**
 * Which permission bucket a rule came from. Claude Code evaluates deny → ask →
 * allow, and matching is NOT symmetric between them, so no function here may
 * answer "does this rule match?" without being told which lane is asking.
 */
export type PermissionLane = 'allow' | 'deny' | 'ask';

/**
 * Whether the lane is one of the two the table always names together.
 *
 * Every published clause that distinguishes lanes says *"a deny or ask rule"* —
 * never one without the other — so they share one implementation rather than
 * two that could drift apart.
 */
function isBlockingLane(lane: PermissionLane): boolean {
  return lane !== 'allow';
}

/** Classification of a Bash permission rule */
export type BashRuleType = 'exact' | 'prefix' | 'wildcard';

/** Parsed Bash rule */
export interface ParsedBashRule {
  type: BashRuleType;
  /** Normalised rule content (after whitespace normalisation) */
  content: string;
  /** Compiled glob for matching (wildcard and prefix types only) */
  pattern?: WildcardPattern | undefined;
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
 * The shell keywords that introduce a control-flow BODY rather than a command.
 *
 * The compound scan already splits `if x; then y; fi` at its `;`, which leaves
 * `then y` — a segment no rule matches, because `then` is not part of the
 * command. Dropping a leading keyword is what makes *"a command nested inside …
 * a control-flow body"* reachable for the deny lane. Allow never sees this: the
 * table says nothing about the allow lane and nesting.
 */
const CONTROL_FLOW_KEYWORDS = new Set([
  'if',
  'then',
  'elif',
  'else',
  'fi',
  'while',
  'until',
  'for',
  'do',
  'done',
  'case',
  'esac',
  '{',
  '}',
  '!',
]);

/**
 * The shape of a leading shell variable assignment. Anchored, one quantifier,
 * so there is nothing to backtrack over.
 */
const ASSIGNMENT_TOKEN = /^[A-Za-z_]\w*=/;

/**
 * The known-safe environment variables an ALLOW rule strips past.
 *
 * ⚠️ This is a COVERAGE gap, not an implementability one, and the distinction
 * matters because the module used to claim the latter and therefore implement
 * nothing. The table says an allow rule *"strips a leading assignment of certain
 * known-safe environment variables"* and *"won't match past an assignment of any
 * other variable"* — and it publishes exactly ONE member of that set by name,
 * `NODE_ENV`, in its own worked example. Stripping precisely the published
 * member closes the documented case with zero added false-positive risk; what
 * cannot be enumerated is the REMAINDER, and a missing member is an under-match,
 * the safe direction for an allow rule. The deny/ask side has no such problem:
 * *"a deny or ask rule matches past any leading assignment"* is unconditional.
 */
const ALLOW_STRIPPABLE_ASSIGNMENTS = new Set(['NODE_ENV']);

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
 * stops the skip on the flag's own VALUE. See {@link stripOneWrapperReadings}
 * for the two readings that produces and how each lane resolves them.
 */
function isWrapperOwnToken(token: string): boolean {
  // `^\d[\d.]*[a-z]?$` rather than `^\d+(?:\.\d+)?[a-z]?$`: one leading digit
  // then a flat class carries no nested quantifier, so there is nothing for the
  // engine to backtrack over. It also accepts `1.2.3`, which is fine here — the
  // question is only "does this token look like an operand, not a command".
  return token.startsWith('-') || /^\d[\d.]*[a-z]?$/.test(token);
}

/**
 * Where the wrapper's own tokens end and the wrapped command begins — one index
 * when the heuristic is certain, TWO when it is not.
 *
 * 🚩 A flag's VALUE can land in the command position, and stripping to it was a
 * FALSE PERMIT: in `timeout -s ls 30 rm -rf /`, `-s` is skipped as a flag, `ls`
 * halts the skip, and `Bash(ls *)` was reported as permitting `ls 30 rm -rf /`.
 * The heuristic cannot know a wrapper flag's arity, so when the skip halts on
 * the token immediately after a flag there are two admissible readings: that
 * token is the command, or it is the flag's value and the skip resumes past it.
 */
function wrapperCommandStarts(tokens: string[]): number[] {
  let index = 1;
  while (index < tokens.length - 1 && isWrapperOwnToken(tokens[index] as string)) index += 1;
  if (tokens[index - 1]?.startsWith('-') !== true) return [index];

  let resumed = index + 1;
  while (resumed < tokens.length - 1 && isWrapperOwnToken(tokens[resumed] as string)) resumed += 1;
  return resumed < tokens.length ? [index, resumed] : [index];
}

/**
 * Every reading of ONE leading wrapper strip, or an empty array when no wrapper
 * applies. More than one entry means the heuristic is UNCERTAIN.
 *
 * The lanes resolve the uncertainty in opposite directions, and both are right:
 * - ALLOW takes no reading at all ({@link stripOneWrapper}), because stripping
 *   to the wrong place is a false permit. That refuses `timeout -s KILL 30 npm
 *   test` under `Bash(npm test *)` — an under-match, the safe direction here.
 * - DENY/ASK take EVERY reading, because a missed match is an under-REPORT: the
 *   checker says "no conflict" about a command Claude Code blocks. `Bash(rm *)`
 *   vs `timeout -s KILL 30 rm -rf tmp/` is the worked case.
 */
function stripOneWrapperReadings(command: string): string[] {
  const tokens = command.split(' ');
  const head = tokens[0];
  if (head === undefined || tokens.length < 2) return [];

  // The query form `command -v` looks a command UP rather than running one.
  if (head === 'command' && tokens[1] === '-v') return [];

  if (head === 'xargs') {
    // Stripping applies only when `xargs` has no flags.
    return tokens[1]?.startsWith('-') === true ? [] : [tokens.slice(1).join(' ')];
  }

  if (!STRIPPED_WRAPPERS.has(head)) return [];

  return wrapperCommandStarts(tokens).map((start) => tokens.slice(start).join(' '));
}

/**
 * Strip one leading wrapper for the ALLOW lane, or return the command unchanged
 * when no wrapper applies or when the heuristic admits more than one reading.
 */
function stripOneWrapper(command: string): string {
  const readings = stripOneWrapperReadings(command);
  return readings.length === 1 ? (readings[0] as string) : command;
}

/**
 * Strip every leading wrapper, so `timeout 30 nice -n 5 npm test` reduces to
 * `npm test`. Iterates because wrappers nest. ALLOW lane only — the deny lane
 * explores every reading rather than following one chain.
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
 * Strip ONE leading `NAME=value` assignment, per the lane's published rule.
 *
 * *"A deny or ask rule matches past any leading assignment"*, unconditionally.
 * An allow rule strips only the known-safe names — see
 * {@link ALLOW_STRIPPABLE_ASSIGNMENTS} for why that set has one member and why
 * that is a coverage gap rather than a reason to strip nothing.
 */
function stripLeadingAssignment(command: string, lane: PermissionLane): string {
  const spaceIndex = command.indexOf(' ');
  if (spaceIndex === -1) return command;

  const head = command.slice(0, spaceIndex);
  if (!ASSIGNMENT_TOKEN.test(head)) return command;
  if (!isBlockingLane(lane) && !ALLOW_STRIPPABLE_ASSIGNMENTS.has(head.slice(0, head.indexOf('=')))) {
    return command;
  }
  return command.slice(spaceIndex + 1);
}

/**
 * Drop a leading control-flow keyword, so the body of an `if`/`for`/`while` is
 * reachable as a command. See {@link CONTROL_FLOW_KEYWORDS}.
 */
function stripLeadingControlKeyword(command: string): string {
  const spaceIndex = command.indexOf(' ');
  if (spaceIndex === -1) return command;
  return CONTROL_FLOW_KEYWORDS.has(command.slice(0, spaceIndex))
    ? command.slice(spaceIndex + 1)
    : command;
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
 * ⚠️ The split itself is lane-neutral, but what a lane DOES with it is not, and
 * the difference is the whole of {@link denySegments}: the deny lane needs the
 * interiors of `$(…)`, `(…)` and backticks as well, and must not go silent on an
 * unparseable command. Refusal is the safe direction for allow and the unsafe
 * one for a checker reporting conflicts, so the two lanes must never share the
 * refusal path.
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
 * What an enclosing region keeps in place of a region emitted on its own — an
 * empty group, so the enclosing text stays PARSEABLE and no invented word
 * appears where a command could be read.
 */
const NESTED_REGION_PLACEHOLDER = '()';

/** Accumulator for {@link nestedRegions}. */
interface NestedScan {
  readonly found: string[];
  /**
   * The text of each currently-open region, outermost first. Index 0 is the
   * text outside every region, which the caller already has as `command` and
   * which is therefore never emitted.
   */
  readonly open: string[];
  inBacktick: boolean;
}

/** Append literal text to the innermost open region. */
function appendToRegion(scan: NestedScan, text: string): void {
  scan.open[scan.open.length - 1] += text;
}

/**
 * Close the innermost open region, emitting it, and leave a
 * {@link NESTED_REGION_PLACEHOLDER} in the enclosing one.
 *
 * 🚩 The placeholder is what makes the scan LINEAR. Every enclosing region used
 * to be re-emitted whole and then re-split, so `'('×k + 'echo x' + ')'×k` cost
 * O(k²): measured on the shipped module, k=25,000 took 4,487 ms and 4× the
 * length cost ~11× the time — from the same attacker-reachable input as the
 * wildcard blowup. A region that has already been emitted on its own does not
 * need to appear inside its parent as well.
 */
function closeRegion(scan: NestedScan): void {
  if (scan.open.length === 1) return; // A closer with nothing open.
  scan.found.push(scan.open.pop() as string);
  appendToRegion(scan, NESTED_REGION_PLACEHOLDER);
}

/**
 * Record the grouping character `char`, opening or closing a region — or report
 * that it is not a grouping character at all.
 */
function recordGrouping(char: string, scan: NestedScan): boolean {
  if (char === '`') {
    if (scan.inBacktick) closeRegion(scan);
    else scan.open.push('');
    scan.inBacktick = !scan.inBacktick;
    return true;
  }
  if (char === '(') {
    scan.open.push('');
    return true;
  }
  if (char === ')') {
    closeRegion(scan);
    return true;
  }
  return false;
}

/**
 * How far past `index` a literal run extends when the character there opens
 * one, `index` itself when it does not, or `undefined` for an unterminated
 * single quote — at which point the scan can learn nothing further.
 */
function skipQuoting(command: string, index: number, inDouble: boolean): number | undefined {
  const char = command[index];
  if (char === '\\') return index + 2;
  if (char === "'" && !inDouble) return endOfQuoted(command, index);
  return index;
}

/**
 * The interior of every subshell `(…)`, command substitution `$(…)` and
 * backtick run in `command`, at any depth.
 *
 * This is what makes *"a command nested inside a subshell, a command
 * substitution, or a control-flow body"* reachable for the deny/ask lane. It
 * deliberately scans INSIDE double quotes — `echo "$(gitx clean -f)"` runs the
 * substitution, and {@link scanTopLevel} consumes the whole double-quoted run as
 * one literal, so nothing else would ever see it. Single-quoted text is skipped:
 * there is no substitution there, so matching inside it would report a conflict
 * over a string literal.
 *
 * ⚠️ Deny/ask only. The table's ONLY nesting sentence is the deny/ask one; it
 * never says what the allow lane does, and inferring the permissive half of that
 * asymmetry from the ANY-vs-EVERY half is the mistake this module already made
 * once. The allow lane is unchanged and its behaviour stays annotated
 * ⛔ UNSOURCED in the suite.
 *
 * A region carries a {@link NESTED_REGION_PLACEHOLDER} where each of its own
 * nested regions sat, because those are emitted separately — see
 * {@link closeRegion} for why that, and not a whole re-emission, is the shape
 * this has to take.
 */
function nestedRegions(command: string): string[] {
  const scan: NestedScan = { found: [], open: [''], inBacktick: false };
  let inDouble = false;
  let index = 0;

  while (index < command.length) {
    const char = command[index] as string;
    if (char === '"') {
      inDouble = !inDouble;
      appendToRegion(scan, char);
      index += 1;
      continue;
    }
    const skipped = skipQuoting(command, index, inDouble);
    if (skipped === undefined) break; // Unterminated quote: nothing more to learn.
    if (skipped > index) {
      appendToRegion(scan, command.slice(index, skipped));
      index = skipped;
      continue;
    }
    if (!recordGrouping(char, scan)) appendToRegion(scan, char);
    index += 1;
  }

  return scan.found;
}

/**
 * Split on every separator LEXICALLY — blind to quoting, escaping and nesting.
 *
 * ⛔ Only for text {@link scanTopLevel} has already refused. On a parseable
 * command this is the defect that split `grep -E "a|b" file` at the quoted `|`;
 * on an UNPARSEABLE one there is no quote state to respect, because being unable
 * to establish that state is what made it unparseable.
 */
function splitIgnoringQuoting(region: string): string[] {
  const parts: string[] = [];
  let current = '';
  let index = 0;

  while (index < region.length) {
    const separator = separatorAt(region, index);
    if (separator === undefined) {
      current += region[index];
      index += 1;
      continue;
    }
    parts.push(current);
    current = '';
    index += separator.length;
  }
  parts.push(current);

  return parts.map((part) => part.trim()).filter((part) => part.length > 0);
}

/**
 * The command texts to test a deny/ask rule against when a region cannot be
 * parsed: the raw whole string, plus every lexically separated part of it.
 *
 * 🚩 The whole string ALONE was the defect. It is the right fallback direction —
 * an allow rule must refuse a command it cannot parse, because approving it is a
 * false permit, while a deny rule that refuses reports "no conflict" about a
 * command Claude Code blocks, which is an under-REPORT — but requiring the rule
 * to match the ENTIRE raw command almost never fires for the class the fallback
 * exists for. The denied command in an unparseable compound is not at the front:
 * `Bash(rm *)` answered `false` for `echo hi # don't⏎rm -rf /` (this module's own
 * worked false-permit example), for `npm test # (⏎rm -rf /`, and for
 * `echo "unclosed⏎rm -rf /`. Only `rm -rf tmp &&`, where the denied program
 * leads, was ever caught.
 *
 * What makes these unparseable — an odd quote, an unbalanced `(` — is exactly
 * what hid the separator from {@link scanTopLevel}, so the recovery is to take
 * the separators back lexically rather than to give up on splitting.
 *
 * ⚠️ Deliberately a lexical SPLIT rather than every whitespace-delimited suffix
 * of the raw string. Both reach the same commands here, but the suffix set is
 * quadratic in the command length and this lane already carries one super-linear
 * defect too many; the split is linear, and its parts are command-shaped rather
 * than arbitrary token tails.
 */
function unparseableSegments(region: string): string[] {
  return [...new Set([region.trim(), ...splitIgnoringQuoting(region)])];
}

/**
 * Every command text a deny or ask rule is tested against: the top-level
 * subcommands, plus those of every nested region, plus — for a region that
 * cannot be parsed at all — {@link unparseableSegments}.
 */
function denySegments(command: string): string[] {
  const segments: string[] = [];
  for (const region of [command, ...nestedRegions(command)]) {
    const parts = splitCompound(region);
    if (parts === undefined || parts.length === 0) segments.push(...unparseableSegments(region));
    else segments.push(...parts);
  }
  return segments;
}

/**
 * The index just past the `)` at `closeIndex` when it terminates a `case` ARM's
 * pattern, or `-1` when it does not. `openIndex` is the `(` it closes, or `-1`
 * when it closes nothing.
 *
 * A `)` that closes nothing is the bare `pattern)` spelling and always
 * terminates an arm. Otherwise the group has to look like an arm's own
 * parentheses rather than a subshell or a command substitution:
 *
 * - A `$(` is a command substitution — {@link nestedRegions} already reaches
 *   inside it, and reading its `)` as an arm terminator would turn
 *   `echo $(foo) rm` into a reading of `rm`, reporting a conflict over an `echo`
 *   whose second ARGUMENT happens to be the word `rm`.
 * - A group containing whitespace is a subshell, `(gitx clean -f)`, which
 *   {@link nestedRegions} also already reaches.
 *
 * What is left — `(x)`, `(*.txt)` — is the POSIX spelling of an arm pattern.
 */
function caseArmBodyStartAt(command: string, openIndex: number, closeIndex: number): number {
  const body = closeIndex + 1;
  if (openIndex === -1) return body; // `pattern)` — a closer with nothing open.
  if (command[openIndex - 1] === '$') return -1;
  return /\s/.test(command.slice(openIndex + 1, closeIndex)) ? -1 : body;
}

/**
 * The index just past the `)` that introduces a `case` arm's body, or `-1` when
 * the command does not begin with an arm pattern.
 *
 * 🚩 Nesting used to be implemented ONLY as {@link stripLeadingControlKeyword} —
 * "drop a leading keyword from a segment". A `case` arm is introduced by a
 * pattern and a `)`, never by a keyword, so it was the one body form that
 * construction structurally could not reach: `Bash(rm *)` answered `false` for
 * `case x in x) rm -rf tmp;; esac` while every other body form (`if/then`,
 * `while/do`, `for/do`, `until/do`, `{ …; }`, `$(…)`, backticks, `(…)`, `<(…)`)
 * already matched. The published clause names *"a control-flow body"* without
 * excepting `case`.
 *
 * Both POSIX spellings are recognised — a bare `pattern)`, which is a `)` that
 * closes nothing, and the balanced `(pattern)` — and quoted text is skipped, so
 * a `)` inside a string is never an arm.
 *
 * A function definition's body reaches the lane through the same reduction, since
 * `foo()` is a whitespace-free group: `foo() { rm -rf /; }` reduces here to
 * `{ rm -rf /`, and then through {@link stripLeadingControlKeyword} to the
 * command. That is the same direction the published clause asks for, and it is
 * pinned in the suite rather than left to be rediscovered as an accident.
 */
function caseArmBodyStart(command: string): number {
  let index = 0;
  let inDouble = false;
  let openIndex = -1;

  while (index < command.length) {
    const skipped = skipQuoting(command, index, inDouble);
    if (skipped === undefined) return -1; // Unterminated quote: nothing to learn.
    if (skipped > index) {
      index = skipped;
      continue;
    }
    const at = index;
    index += 1;

    const char = command[at];
    if (char === '"') inDouble = !inDouble;
    else if (inDouble) continue; // A `(` or `)` inside a string is not an arm.
    else if (char === '(') openIndex = at;
    else if (char === ')') return caseArmBodyStartAt(command, openIndex, at);
  }

  return -1;
}

/**
 * Drop a leading `case` arm pattern, so the arm's BODY is reachable as a
 * command. See {@link caseArmBodyStart}.
 */
function stripCaseArmPattern(command: string): string {
  const start = caseArmBodyStart(command);
  return start === -1 ? command : command.slice(start).trim();
}

/**
 * Every reading of one deny/ask segment: the segment itself and the closure of
 * every reduction the lane admits — control-flow keyword, `case` arm pattern,
 * leading assignment, and each wrapper strip the heuristic considers possible.
 *
 * Every reduction strictly shortens the string, and repeats are dropped, so the
 * worklist terminates.
 */
function denyReadings(segment: string): string[] {
  const seen = new Set<string>();
  const queue = [normaliseWhitespace(segment)];

  while (queue.length > 0) {
    const current = queue.pop() as string;
    if (current.length === 0 || seen.has(current)) continue;
    seen.add(current);
    queue.push(
      stripLeadingControlKeyword(current),
      stripCaseArmPattern(current),
      stripLeadingAssignment(current, 'deny'),
      ...stripOneWrapperReadings(current),
    );
  }

  return [...seen];
}

/**
 * The single reading the ALLOW lane takes of one subcommand: known-safe
 * assignments and unambiguous wrappers stripped, to a fixed point.
 */
function reduceForAllow(subcommand: string): string {
  let current = normaliseWhitespace(subcommand);
  for (;;) {
    const next = normaliseWhitespace(stripWrappers(stripLeadingAssignment(current, 'allow')));
    if (next === current) return current;
    current = next;
  }
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

/** The rule spelling for a literal `*`. */
const ESCAPED_STAR = String.raw`\*`;

/**
 * A `*`-glob rule compiled for matching: the literal runs BETWEEN its
 * wildcards, in order. `n` wildcards produce `n + 1` segments, so a rule with no
 * wildcard is a single segment and the pattern is anchored at both ends.
 *
 * ⛔ Deliberately NOT a `RegExp`. A glob whose wildcards are separated by
 * literals compiles to `^a.*b.*b.*…z$`, and that backtracks EXPONENTIALLY —
 * measured on the shipped module at 26,273 ms for a 24-character rule against a
 * 61-character command, ~9× per added `b*`. The same module was polynomial on an
 * ordinary-looking rule: `Bash(npm * --registry * --registry * --registry *
 * publish)` cost 10,455 ms at a 4,171-character command. Both inputs are
 * attacker-reachable files this auditor reads — a `settings.json` permission
 * entry and a plugin `SKILL.md` `allowed-tools:` entry — and `vat audit` reaches
 * them through `checkSettingsCompatibility`, so the blowup hangs CI.
 *
 * 🚩 The previous fix collapsed a RUN of adjacent stars to one `.*` and asserted
 * the compiled SOURCE to prove it. That assertion was true and the safety
 * property was false: `a*b*z` has no run to collapse. A shape assertion is not a
 * cost claim — see the cost suite, which asserts a RATIO between two input
 * sizes. ⛔ An atomic group (`(?=(X))\1`) is not the fix either: this repo has
 * measured that it satisfies the linter while remaining quadratic.
 */
export interface WildcardPattern {
  /** The literal runs between wildcards, in order. Never empty. */
  readonly segments: readonly string[];
}

/**
 * Compile a `*`-glob rule's content into a {@link WildcardPattern}.
 *
 * `\*` is a literal star; every other `*` is a wildcard. A RUN of consecutive
 * wildcards opens no extra segment, because it permits exactly what one permits.
 *
 * Nothing here is escaped, because nothing is handed to a regex compiler: the
 * segments are matched as literal text. That also closes, structurally, the
 * FALSE PERMIT this used to carry when the escape class omitted `\` — `Bash(a\b
 * *)` matched `a b`, because `\b` compiled to a word boundary rather than to the
 * two characters the rule author wrote.
 */
function compileWildcardPattern(content: string): WildcardPattern {
  const segments: string[] = [];
  let literal = '';
  let index = 0;
  let afterWildcard = false;

  while (index < content.length) {
    if (content.startsWith(ESCAPED_STAR, index)) {
      literal += '*';
      index += ESCAPED_STAR.length;
      afterWildcard = false;
    } else if (content.charAt(index) === '*') {
      if (!afterWildcard) {
        segments.push(literal);
        literal = '';
        afterWildcard = true;
      }
      index += 1;
    } else {
      literal += content.charAt(index);
      index += 1;
      afterWildcard = false;
    }
  }
  segments.push(literal);

  return { segments };
}

/**
 * Whether `text` matches `pattern`, in O(n·m) with no backtracking.
 *
 * The standard two-pointer greedy scan for a `*`-only glob: the first segment
 * must be a prefix and the last a suffix, and each middle segment is taken at
 * its EARLIEST occurrence at or after the position the previous one ended. That
 * greedy choice is optimal — matching a middle segment later can only leave less
 * room for the ones after it — so one forward pass decides the question that a
 * regex engine explores by backtracking.
 *
 * The `limit` is what stops the prefix and suffix from overlapping: `a*a`
 * requires two characters, and `a*ab*b` requires four.
 */
function matchesWildcardPattern(pattern: WildcardPattern, text: string): boolean {
  const { segments } = pattern;
  const first = segments[0] as string;
  const last = segments.at(-1) as string;

  // No wildcard at all: the pattern is one literal segment.
  if (segments.length === 1) return text === first;

  if (!text.startsWith(first) || !text.endsWith(last)) return false;

  let position = first.length;
  const limit = text.length - last.length;
  if (limit < position) return false;

  for (let index = 1; index < segments.length - 1; index += 1) {
    const segment = segments[index] as string;
    const found = text.indexOf(segment, position);
    if (found === -1 || found + segment.length > limit) return false;
    position = found + segment.length;
  }

  return true;
}

/**
 * Parse a Bash rule content string into a ParsedBashRule for matching.
 */
export function parseBashRuleContent(content: string): ParsedBashRule {
  const normalised = normaliseWhitespace(content);
  const type = classifyBashRule(normalised);

  if (type === 'wildcard') {
    return { type, content: normalised, pattern: compileWildcardPattern(normalised) };
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
    return { type, content: base, pattern: compileWildcardPattern(`${base} *`) };
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

    // `:*` compiles to the same glob as the equivalent trailing ` *`, so both
    // spellings answer through one matcher. The bare base is granted by
    // {@link bareCommandFor} — and only when the trailing wildcard is the rule's
    // ONLY one, which is exactly the restriction the literal comparison here
    // used to bypass. `xargs` is not special-cased: it is one of the wrappers
    // {@link stripWrappers} removes, so every lane gets it.
    case 'prefix':
    case 'wildcard':
      return (
        parsedRule.pattern !== undefined &&
        matchesWildcardPattern(parsedRule.pattern, normCommand)
      );

    default:
      return false;
  }
}

/**
 * Whether ONE reading of a command — every reduction its lane admits already
 * applied — satisfies the rule.
 *
 * @param reading - A single command, with no compound separators left in it
 * @param parsed - The rule, pre-parsed once for the whole compound
 * @param bare - The command text this rule permits bare, from {@link bareCommandFor}
 */
function matchesReading(
  reading: string,
  parsed: ParsedBashRule,
  bare: string | undefined,
): boolean {
  const normalised = normaliseWhitespace(reading);
  if (bare !== undefined && normalised === bare) return true;
  return matchesParsedBashRule(normalised, parsed);
}

/**
 * Whether a tool-name glob the ALLOW lane will accept: the literal text before
 * the first `*` must be a complete `mcp__<server>__` prefix. `mcp__srv__*`
 * qualifies; `mcp__*` and a bare `*` do not.
 */
const MCP_ALLOW_GLOB_PREFIX = /^mcp__[^*]+__$/;

/**
 * Whether a rule's tool-name position covers `toolName`.
 *
 * Exact names are case-sensitive and compared as such. A glob is accepted
 * ASYMMETRICALLY, which is the point: deny and ask accept one anywhere in the
 * tool-name position — an org that denies `"*"` and allow-lists back is blocking
 * everything, and reporting that as blocking nothing is a wrong answer about its
 * config — while an allow rule accepts one only after a literal
 * `mcp__<server>__` prefix, so `"*"` can never be read as a blanket permit.
 */
function matchesToolName(ruleTool: string, toolName: string, lane: PermissionLane): boolean {
  if (ruleTool === toolName) return true;

  const star = ruleTool.indexOf('*');
  if (star === -1) return false;
  if (!isBlockingLane(lane) && !MCP_ALLOW_GLOB_PREFIX.test(ruleTool.slice(0, star))) return false;

  return matchesWildcardPattern(compileWildcardPattern(ruleTool), toolName);
}

/**
 * Match a rule whose content is a structured selector rather than a command or
 * a path — `WebFetch(domain:example.com)`.
 *
 * 🚩 This lane answered `false` for everything, so a deny rule blocking all
 * fetches was reported as blocking nothing. The tool input carries the same
 * `domain:…` shape the rule does, so the content is matched against it whole,
 * with `*` as a wildcard. Lane-neutral: the table publishes no allow/deny
 * asymmetry for it.
 */
function matchesStructuredContent(toolInput: string, content: string): boolean {
  return matchesWildcardPattern(compileWildcardPattern(content), normaliseWhitespace(toolInput));
}

/**
 * Check whether a Bash command matches a full Bash permission rule string.
 * Rule format: "Bash(npm run *)" or "Bash(git commit)" or bare "Bash"
 *
 * A bare "Bash" (no parens) matches all Bash calls.
 *
 * ⛔ `lane` is REQUIRED and has no default — see the file header. Allow needs
 * EVERY subcommand to match; deny and ask match when ANY reading of any segment
 * does, including nested ones.
 *
 * @param command - The actual command
 * @param rule - Full rule string e.g. "Bash(npm run *)"
 * @param lane - Which permission bucket the rule came from
 */
export function matchesBashRule(command: string, rule: string, lane: PermissionLane): boolean {
  const { toolName, content } = parsePermissionRule(rule);

  if (!matchesToolName(toolName, 'Bash', lane)) return false;

  // Bare "Bash" — matches all calls
  if (content === undefined || content === '*') return true;

  const parsed = parseBashRuleContent(content);
  const bare = bareCommandFor(content);

  if (isBlockingLane(lane)) {
    return denySegments(command).some((segment) =>
      denyReadings(segment).some((reading) => matchesReading(reading, parsed, bare)),
    );
  }

  const subcommands = splitCompound(command);
  // Unparseable (a dangling `&&`/`||`), or nothing to match: no allow rule approves it.
  if (subcommands === undefined || subcommands.length === 0) return false;

  return subcommands.every((subcommand) =>
    matchesReading(reduceForAllow(subcommand), parsed, bare),
  );
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
 * Check whether a tool call is matched by a permission rule.
 *
 * Handles Bash rules (glob-based), path-tool rules (gitignore-based) and
 * `WebFetch(domain:…)` selectors. A bare tool name (e.g. "Edit") matches all
 * uses of that tool.
 *
 * ⛔ `lane` is REQUIRED and deliberately has no default. A default would be the
 * no-op: every existing caller would keep the old, allow-lane behaviour, and
 * this module's whole defect was that its only caller wanted the deny lane. Use
 * {@link matchesAllowRule} / {@link matchesDenyRule} to bind it.
 *
 * @param toolName - The tool being called (e.g. "Bash", "Edit")
 * @param toolInput - For Bash: the command string. For path tools: the file path.
 * @param rule - Full permission rule string
 * @param lane - Which permission bucket the rule came from
 * @param cwd - Current working directory (for path-tool matching)
 */
export function matchesPermissionRule(
  toolName: string,
  toolInput: string,
  rule: string,
  lane: PermissionLane,
  cwd: string = process.cwd()
): boolean {
  const { toolName: ruleTool, content } = parsePermissionRule(rule);

  // Tool names are case-sensitive; a glob is accepted per lane.
  if (!matchesToolName(ruleTool, toolName, lane)) return false;

  // Bare tool name — matches all calls to this tool
  if (content === undefined) return true;

  if (toolName === 'Bash') {
    return matchesBashRule(toolInput, rule, lane);
  }

  if (toolName === 'WebFetch') {
    return matchesStructuredContent(toolInput, content);
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
 * {@link matchesPermissionRule} with the ALLOW lane bound: EVERY subcommand must
 * match, only known-safe assignments are stripped, and a tool-name glob is
 * honoured only after a literal `mcp__<server>__` prefix.
 */
export function matchesAllowRule(
  toolName: string,
  toolInput: string,
  rule: string,
  cwd?: string
): boolean {
  return matchesPermissionRule(toolName, toolInput, rule, 'allow', cwd);
}

/**
 * {@link matchesPermissionRule} with the DENY lane bound — the same behaviour
 * `ask` gets. ANY subcommand matching is enough, nested commands are reached,
 * any leading assignment is stripped past, every wrapper reading is tried, and
 * an unparseable command falls back to a whole-string match rather than going
 * silent.
 */
export function matchesDenyRule(
  toolName: string,
  toolInput: string,
  rule: string,
  cwd?: string
): boolean {
  return matchesPermissionRule(toolName, toolInput, rule, 'deny', cwd);
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
 * ⚠️ This asks the ALLOW-lane question in every lane, and that is deliberate.
 * Subsumption exists to answer *"does the broad rule permit everything the
 * narrow one does?"*, and `settings-conflict-analyzer` turns a `true` into
 * advice to DELETE the narrow rule. The deny lane's deliberate over-matching
 * would manufacture subsumptions that do not hold and advise deleting rules that
 * still carry weight, so the narrower extension is the sound one to compare.
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
    if (narrowBare !== undefined && !matchesBashRule(narrowBare, broadRule, 'allow')) return false;

    // Then the rest of narrow's extension, with its content read as a command.
    // Wrappers are stripped on this path too, so `Bash(builtin cd)` is correctly
    // reported redundant under `Bash(cd *)` — it was not before.
    return matchesBashRule(narrowContent, broadRule, 'allow');
  }

  return false;
}

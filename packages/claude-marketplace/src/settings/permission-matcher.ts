/**
 * Permission rule matching — replicates Claude Code's actual permission matching logic.
 *
 * Two distinct systems depending on tool type:
 * - Bash rules: custom glob matcher (exact | prefix | wildcard)
 * - Read/Edit path rules: gitignore-style patterns, matched by the linear scanner in `path-pattern.ts`
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

import { homedir } from 'node:os';

import { safePath } from '@vibe-agent-toolkit/utils';

import { compilePathPattern, matchesPathPattern } from './path-pattern.js';

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
 * How a rule's CONTENT is read for a given tool — the one taxonomy behind both
 * {@link matchesPermissionRule} (which content matcher decides a concrete tool
 * input) and {@link ruleConstrainsTool} (whether the rule restricts the tool at
 * all).
 *
 * 🚩 Those two questions used to have two implementations, and they
 * contradicted each other. `settings-compat-checker` answered the second one
 * itself with `rule.startsWith(`${toolName}(`)`, so `Write(./secrets/**)` was
 * reported as blocking a skill that declares a bare `Write` while this module's
 * own ruling — and its answer for `Write(./out/x)` — says that rule blocks
 * nothing. One deny rule gave two answers for one tool, decided by nothing but
 * how the SKILL.md spelled it. A second taxonomy is what let that happen, so
 * there is one.
 */
type ContentLane = 'bash' | 'webfetch' | 'path' | 'unconsulted' | 'opaque';

/**
 * Which {@link ContentLane} reads a rule's content for `toolName`.
 *
 * `opaque` is everything else — MCP tools and any tool this module has no
 * content matcher for. Their content is not interpreted, so only a `*` covers
 * anything.
 */
function contentLaneFor(toolName: string): ContentLane {
  if (toolName === 'Bash') return 'bash';
  if (toolName === 'WebFetch') return 'webfetch';
  if (PATH_TOOLS.has(toolName)) return 'path';
  if (UNCONSULTED_PATH_TOOLS.has(toolName)) return 'unconsulted';
  return 'opaque';
}

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
 * Whether the `&` at `index` belongs to a REDIRECTION operator rather than to
 * the separator of the same character.
 *
 * 🚩 `&` was read as a top-level separator with no redirection awareness, so
 * `2>&1` split into `… 2>` and `1`, and the allow lane's every-subcommand
 * requirement then failed on the subcommand `1`. `Bash(ls:*)` stopped
 * permitting `ls -la > /dev/null 2>&1` and `Bash(npm run build:*)` stopped
 * permitting `npm run build 2>&1` — the same class as the `grep -E "a|b"`
 * quoting defect, an under-match, and the single most common shell idiom there
 * is. The file's own `@vendor-claim` names *"redirections vs the `&`
 * separator"* as a published clause with no assertion behind it; there is one
 * now.
 *
 * Adjacency is the whole test, and it is what keeps a genuine separator a
 * separator. `>&` covers `2>&1`, `1>&2`, `>&2` and `2>&-`; `&>` covers `&>file`
 * and `&>>file`. A background `&` with a space after it (`npm test & rm -rf /`)
 * and one glued to the next command (`npm test &rm -rf /`) are untouched, and
 * `&&` never reaches here because {@link TWO_CHAR_SEPARATORS} is checked first.
 */
function isRedirectionAmpersand(command: string, index: number): boolean {
  return command[index - 1] === '>' || command[index + 1] === '>';
}

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
 * The separator at `index`, or `undefined` when the character there is not one —
 * including when it is an `&` that belongs to a redirection operator, per
 * {@link isRedirectionAmpersand}.
 */
function separatorAt(command: string, index: number): string | undefined {
  const two = command.slice(index, index + 2);
  if (TWO_CHAR_SEPARATORS.has(two)) return two;
  const one = command[index];
  if (one === undefined || !ONE_CHAR_SEPARATORS.has(one)) return undefined;
  return one === '&' && isRedirectionAmpersand(command, index) ? undefined : one;
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
 * How much region text one command may yield, as a multiple of its own length.
 *
 * ⚠️ NOT a schema or format number — nothing stored is judged valid or invalid
 * by it. It is a work bound, and it exists because full correctness here is
 * provably incompatible with a linear one: see {@link closeRegion}.
 *
 * 8 is the nesting depth at which a command stops having every one of its
 * regions materialised in full. Real commands nest one to three deep — the
 * deepest shape in this module's own suite, `echo "$(sh -c "rm $(x)")"`, is
 * two — so the factor is never reached by a command anybody wrote on purpose.
 */
const NESTED_REGION_TEXT_BUDGET_FACTOR = 8;

/** Accumulator for {@link nestedRegions}. */
interface NestedScan {
  readonly found: string[];
  /**
   * Where each currently-open region's INTERIOR begins, outermost first. Text
   * outside every region is not a region: the caller already has it as
   * `command`, so nothing sits at the bottom of this stack.
   */
  readonly open: number[];
  /** How many more characters of region text this command may still yield. */
  budget: number;
  /**
   * Set once a region has been dropped for want of budget. The scan's own
   * answer to *"is what I am handing back the whole picture?"* — see
   * {@link closeRegion} for why a `false` here is not safe to act on.
   */
  truncated: boolean;
  inBacktick: boolean;
}

/**
 * Close the innermost open region, emitting the command's own text for it —
 * children and all.
 *
 * 🚩 Children and all is the point, and the shape this replaces got it exactly
 * backwards. A parent used to carry a two-character `()` placeholder wherever
 * one of its own children sat, justified as *"a region that has already been
 * emitted on its own does not need to appear inside its parent as well."* That
 * sentence is FALSE for every rule whose literal SPANS a child: the parent of
 * `(rm -rf $(pwd))` came out as `rm -rf $()`, so `Bash(rm -rf $(pwd))` answered
 * `false` for a command that is literally itself. 10 of 10 hand-built shapes
 * regressed that way on BOTH deny and ask, and a 1,118,566-pair differential
 * found 29 more. The direction is UNDER-REPORT — `vat audit` reporting no
 * conflict about a command Claude Code blocks — which is the same class the
 * unparseable-command fallback below exists to close.
 *
 * 🚩 The placeholder's other stated virtue — *"no invented word appears where a
 * command could be read"* — was false too, and in the opposite direction: `()`
 * is a whitespace-free group, so {@link caseArmBodyStartAt} read it as a `case`
 * ARM PATTERN and `()rm` reduced to a reading of `rm`. A 500,000-pair
 * differential against this implementation found 11 deny/ask answers that flip
 * to `false`, and every one of them lost only segments carrying that invented
 * `()`. Those were conflicts reported over a pattern the command never had.
 *
 * ⚠️ So the bound is a BUDGET now, not a placeholder, because the two cannot
 * both be had. The correct region set is inherently Θ(length × depth):
 * `'('×k + 'rm -rf /' + ')'×k` has k regions whose lengths sum to ~k², and no
 * representation of "every region's own text" escapes that — the placeholder
 * bought its linearity by not answering the question. The budget caps the TOTAL
 * emitted characters at {@link NESTED_REGION_TEXT_BUDGET_FACTOR} × the command's
 * length, which keeps the whole scan linear, and it is spent INNERMOST-FIRST
 * because regions close from the inside out.
 *
 * 🚩 That spend order used to be defended here as harmless — *"an adversarially
 * deep nest keeps the inner regions, where a command can actually sit, and drops
 * the outer ones, which at that depth are that same command wrapped in
 * parentheses"*. FALSE, and it was the budget's whole safety argument. An outer
 * region's OWN TEXT is a place a command sits with no child around it:
 * `x $( '('×23 + ')'×23 ; rm -rf / )` is 64 characters, and `Bash(rm *)`
 * answered `false` for it while answering `true` at 21 levels. The regions the
 * budget dropped were exactly the ones holding the payload. The guard that
 * existed placed its command at the INNERMOST point — the one position an
 * innermost-first spend always preserves — so it could not see this.
 *
 * ⛔ So a truncated scan is REPORTED rather than silently returned, and
 * {@link matchesBashRule} FAILS CLOSED on it: past the budget the lane cannot
 * say what the command contains, and for a blocking lane "cannot say" has to
 * read as "matches". The cost is real and is pinned in the suite — an innocent
 * 3,000-deep nest is reported as conflicting with every Bash deny rule — and it
 * is the direction that is safe to be wrong in. Nothing anybody wrote on purpose
 * reaches it: real commands nest one to three deep, and this module's own
 * deepest worked shape, `echo "$(sh -c "rm $(x)")"`, is two.
 *
 * Measured on Node 24 against `Bash(rm *)` and `'('×k + 'echo x' + ')'×k`, with
 * the budget: k=48,000 in 8.47 ms and ~1.9× per 2× input across k=1,500…48,000.
 * WITHOUT it, on the same machine and the same code: ~3.75× per 2× input, and
 * k=6,000 alone costs 374.89 ms. The suite pins the ratio, not those numbers.
 */
function closeRegion(scan: NestedScan, command: string, end: number): void {
  const start = scan.open.pop();
  if (start === undefined) return; // A closer with nothing open.
  const length = end - start;
  if (length > scan.budget) {
    // Budget spent. The caller must not read the remaining regions as the whole
    // command — see above for the under-report that reading cost.
    scan.truncated = true;
    return;
  }
  scan.budget -= length;
  scan.found.push(command.slice(start, end));
}

/**
 * Record the grouping character at `index`, opening or closing a region — or
 * report that it is not a grouping character at all.
 */
function recordGrouping(char: string, scan: NestedScan, command: string, index: number): boolean {
  if (char === '`') {
    if (scan.inBacktick) closeRegion(scan, command, index);
    else scan.open.push(index + 1);
    scan.inBacktick = !scan.inBacktick;
    return true;
  }
  if (char === '(') {
    scan.open.push(index + 1);
    return true;
  }
  if (char === ')') {
    closeRegion(scan, command, index);
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
 * Each region is the command's OWN text between its delimiters, its nested
 * regions included verbatim, so a rule literal that crosses a child's boundary
 * still matches. That is not free — see {@link closeRegion} for the budget that
 * pays for it and for what an adversarially deep nest gives up.
 *
 * ⛔ `truncated` is not a diagnostic. A `true` means regions were DROPPED, and
 * the drop is innermost-first-preserving, so what comes back is a nest's inner
 * text with its outer text — where a command also sits — missing. Every blocking
 * caller must treat it as "unanalysable" and match, never as "nothing found".
 */
function nestedRegions(command: string): { regions: string[]; truncated: boolean } {
  const scan: NestedScan = {
    found: [],
    open: [],
    budget: command.length * NESTED_REGION_TEXT_BUDGET_FACTOR,
    truncated: false,
    inBacktick: false,
  };
  let inDouble = false;
  let index = 0;

  while (index < command.length) {
    const char = command[index] as string;
    if (char === '"') {
      inDouble = !inDouble;
      index += 1;
      continue;
    }
    const skipped = skipQuoting(command, index, inDouble);
    if (skipped === undefined) break; // Unterminated quote: nothing more to learn.
    if (skipped > index) {
      index = skipped;
      continue;
    }
    recordGrouping(char, scan, command, index);
    index += 1;
  }

  return { regions: scan.found, truncated: scan.truncated };
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
 *
 * ⛔ `truncated` rides along rather than being dropped here, and a caller that
 * ignores it is reading a PARTIAL segment list as a complete one. That is the
 * defect {@link closeRegion} documents: the budget's spend order drops the outer
 * regions, and a command sitting in an outer region's own text vanishes with
 * them.
 */
function denySegments(command: string): { segments: string[]; truncated: boolean } {
  const segments: string[] = [];
  const { regions, truncated } = nestedRegions(command);
  for (const region of [command, ...regions]) {
    const parts = splitCompound(region);
    if (parts === undefined || parts.length === 0) segments.push(...unparseableSegments(region));
    else segments.push(...parts);
  }
  return { segments, truncated };
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
 * How much reading text one deny/ask segment may yield, as a multiple of its
 * own length. A work bound in the same sense as
 * {@link NESTED_REGION_TEXT_BUDGET_FACTOR}, and NOT a schema or format number.
 *
 * A real chain — `sudo timeout 30 nice -n 5 rm -rf /`, `FOO=1 BAR=2 cmd`, one
 * `case` arm — yields a handful of readings, each a little shorter than the
 * last, so their text sums to a few times the segment. Past ~14 strippable
 * prefixes the sum crosses 8×, and nothing written on purpose has fourteen.
 */
const DENY_READING_TEXT_BUDGET_FACTOR = 8;

/**
 * Every reading of one deny/ask segment: the segment itself and the closure of
 * every reduction the lane admits — control-flow keyword, `case` arm pattern,
 * leading assignment, and each wrapper strip the heuristic considers possible.
 *
 * Every reduction strictly shortens the string, and repeats are dropped, so the
 * worklist terminates.
 *
 * 🚩 Terminates, but not linearly: each reduction drops one prefix and keeps
 * the rest as a NEW string, so a chain of `k` strippable prefixes yields `k`
 * readings whose lengths sum to ~k²/2, each then matched from the front.
 * Measured on the shipped module against `Bash(rm *)`: `(x) )×1,000 echo z`
 * 27.5 ms, ×4,000 430.5 ms, ×16,000 6,458 ms (~15× per 4×), and
 * `(timeout -s KILL 30 )×800 echo hi` 194.6 ms — a 48 KB `allowed-tools:` entry
 * cost about a minute. The correct reading SET is inherently that size, so as
 * with {@link closeRegion} the bound is a budget on the emitted text, and a
 * segment that exhausts it is reported `truncated` for {@link matchesBashRule}
 * to FAIL CLOSED on — for a blocking lane, "I could not read every reading" has
 * to mean "it matches".
 */
function denyReadings(segment: string): { readings: string[]; truncated: boolean } {
  const seen = new Set<string>();
  const start = normaliseWhitespace(segment);
  const queue = [start];
  let budget = start.length * DENY_READING_TEXT_BUDGET_FACTOR;

  while (queue.length > 0) {
    const current = queue.pop() as string;
    if (current.length === 0 || seen.has(current)) continue;
    if (current.length > budget) return { readings: [...seen], truncated: true };
    budget -= current.length;
    seen.add(current);
    queue.push(
      stripLeadingControlKeyword(current),
      stripCaseArmPattern(current),
      stripLeadingAssignment(current, 'deny'),
      ...stripOneWrapperReadings(current),
    );
  }

  return { readings: [...seen], truncated: false };
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
 * ⚠️ This closed the class for the BASH lane only. The path lane reached the
 * same backtracking through node-ignore's compiled regex, and
 * {@link ruleConstrainsDeclaration} hands a plugin-authored `Read(…)` across as
 * a pattern — measured at 11.1 s for a 21-character declaration against a
 * 44-character rule. It has its own linear scanner now, in `path-pattern.ts`.
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
    const { segments, truncated } = denySegments(command);
    // ⛔ FAIL CLOSED. A truncated scan is a nest the region budget could not
    // materialise in full, and the regions it drops are the OUTER ones — where a
    // command sits just as readily as at the bottom. Reading the remainder as
    // the whole command is what answered `false` for
    // `x $( '('×23 + ')'×23 ; rm -rf / )`. For a blocking lane, "I could not
    // analyse this" has to read as "it matches"; see {@link closeRegion} for the
    // over-report this buys and why nothing written on purpose reaches it.
    if (truncated) return true;
    // The same, one layer down: a segment whose READINGS outran their budget
    // is a chain of wrappers or arms the lane could not strip to the end, and
    // the command may sit past the point it stopped. See {@link denyReadings}.
    return segments.some((segment) => {
      const { readings, truncated: readingsTruncated } = denyReadings(segment);
      return readingsTruncated || readings.some((reading) => matchesReading(reading, parsed, bare));
    });
  }

  const subcommands = splitCompound(command);
  // Unparseable (a dangling `&&`/`||`), or nothing to match: no allow rule approves it.
  if (subcommands === undefined || subcommands.length === 0) return false;

  return subcommands.every((subcommand) =>
    matchesReading(reduceForAllow(subcommand), parsed, bare),
  );
}

/**
 * A path as a permission rule SPELLS it, split into the directory it is
 * relative to and the remainder — the prefix table the published permissions
 * page gives for `Read(…)`/`Edit(…)`:
 *
 * - `//path` → absolute, from the filesystem root (strip one `/`)
 * - `~/path` → relative to the home directory
 * - `/path`  → relative to the project root (cwd); the leading `/` stays, and
 *              anchors the pattern there
 * - `./path` and `path` → relative to cwd
 *
 * ⛔ The ONE table for both sides of a match. It used to be applied to the
 * pattern side only, and the other side — a witness path drawn from a rule, or
 * a declaration read as an input — went to `resolve` verbatim, so `~/.ssh/**`
 * became a literal `~` directory under the root and `Read(~/.ssh/**)` did not
 * contain ITSELF. See {@link pathSpellingToFilePath}.
 */
function splitPathSpelling(spelling: string, cwd: string): { root: string; rest: string } {
  if (spelling.startsWith('//')) return { root: '/', rest: spelling.slice(1) };
  if (spelling.startsWith('~/')) return { root: homedir(), rest: spelling.slice(2) };
  if (spelling.startsWith('./')) return { root: cwd, rest: spelling.slice(2) };
  return { root: cwd, rest: spelling };
}

/**
 * The absolute filesystem path a rule-spelled path denotes, for handing to
 * {@link matchesPathRule} as its `filePath`. `join` rather than `resolve`, so a
 * project-root `/path` lands under cwd instead of at the filesystem root.
 */
function pathSpellingToFilePath(spelling: string, cwd: string): string {
  const { root, rest } = splitPathSpelling(normaliseWhitespace(spelling), cwd);
  return safePath.join(root, rest);
}

/**
 * Check whether a file path matches a Read/Edit permission rule, under the
 * gitignore-style semantics of `path-pattern.ts` and the prefix table of
 * {@link splitPathSpelling}.
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
  const { root, rest: pattern } = splitPathSpelling(normaliseWhitespace(ruleContent), cwd);

  // 🚩 Resolve against `root` explicitly. `safePath.relative(root, filePath)`
  // alone lets Node resolve a RELATIVE filePath against `process.cwd()` rather
  // than against the root this function was handed, so the verdict depended on
  // where the process was launched. The only production caller passes a plugin
  // directory, which is never `process.cwd()` — so the whole path lane of the
  // deny check answered `false` for everything. An absolute filePath is
  // unaffected: `resolve` returns it unchanged.
  const relative = safePath.relative(root, safePath.resolve(root, filePath));

  // A path that goes "up" (..) is outside the root, so no pattern under it applies.
  if (relative.startsWith('..')) return false;

  // 🚩 An empty relative path THREW in the matcher this replaced (`path must
  // not be empty`), and `settings-compat-checker` reaches this with an empty
  // tool input whenever a SKILL.md declares a bare `Read`/`Edit` against an org
  // path rule. `vat audit` died with an uncaught TypeError on that plugin rather
  // than reporting anything about it. An empty path is not a path, and a rule
  // cannot match a file that was never named, so the answer is `false`.
  if (relative.length === 0) return false;

  return matchesPathPattern(compilePathPattern(pattern), relative);
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

  switch (contentLaneFor(toolName)) {
    case 'bash':
      return matchesBashRule(toolInput, rule, lane);
    case 'webfetch':
      return matchesStructuredContent(toolInput, content);
    case 'path':
      return matchesPathRule(toolInput, content, cwd);
    // Accepted by Claude Code, never consulted — so it blocks nothing,
    // including when the path is `*`.
    case 'unconsulted':
      return false;
    // MCP tools and others: the content is not interpreted, so only a `*`
    // covers this call. A bare rule was already answered above.
    case 'opaque':
      return content === '*';
  }
}

/**
 * Whether `rule` restricts `toolName` AT ALL — the question to ask about a tool
 * declared without a specific input, where {@link matchesPermissionRule} needs
 * one concrete input to answer.
 *
 * A SKILL.md `allowed-tools:` entry spelled bare (`Write`) or wildcarded
 * (`Write(*)`) declares the tool UNRESTRICTED, so the conflict it can have with
 * a permission rule is not "does this rule match that input" — there is no
 * input — but "does this rule constrain the tool the skill wants unrestricted".
 *
 * ⛔ The answer comes from {@link contentLaneFor}, the same taxonomy
 * {@link matchesPermissionRule} dispatches on, so the two can never disagree
 * about a tool. Answering it any other way — a string prefix test on the rule,
 * for one — is what made the checker contradict this module's own ruling that a
 * `Write`/`Glob`/`NotebookRead`/`NotebookEdit` path rule blocks nothing.
 *
 * ⛔ `lane` is REQUIRED here for the same reason it is everywhere else in this
 * module: the tool-name glob a rule may carry is accepted asymmetrically.
 *
 * @param toolName - The tool the caller is asking about
 * @param rule - Full permission rule string
 * @param lane - Which permission bucket the rule came from
 */
export function ruleConstrainsTool(
  toolName: string,
  rule: string,
  lane: PermissionLane
): boolean {
  const { toolName: ruleTool, content } = parsePermissionRule(rule);

  if (!matchesToolName(ruleTool, toolName, lane)) return false;

  // A bare rule names the tool and nothing else: it covers every use of it.
  if (content === undefined) return true;

  switch (contentLaneFor(toolName)) {
    case 'unconsulted':
      return false;
    case 'opaque':
      return content === '*';
    // Bash, WebFetch and the two consulted path tools: the content is read, so
    // a rule carrying any restricts what the tool may do.
    case 'bash':
    case 'webfetch':
    case 'path':
      return true;
  }
}

/**
 * Tool inputs drawn from a rule's OWN extension, to ask another rule about.
 *
 * The content text is one — `git push:*` read as a command, `./secrets/**` read
 * as a path — and for Bash the {@link bareCommandFor} command is a second. That
 * second one is what makes a `:*` or trailing-` *` rule intersect ITSELF: the
 * text `git push:*` is not matched by the pattern `git push *` that the
 * identical rule compiles to, while the bare `git push` is.
 *
 * ⚠️ A heuristic witness SET, not the extension. Two patterns can overlap on a
 * string neither of these is — see {@link ruleConstrainsDeclaration} for the
 * residue that leaves.
 */
function ruleWitnesses(toolName: string, content: string): string[] {
  if (contentLaneFor(toolName) !== 'bash') return [content];
  const bare = bareCommandFor(content);
  return bare === undefined || bare === content ? [content] : [content, bare];
}

/**
 * Whether `rule` constrains anything a SKILL.md `allowed-tools:` DECLARATION
 * asks for — the question `settings-compat-checker` actually has, for every
 * spelling a declaration can take.
 *
 * A declaration is not a tool call. It is a rule-shaped PATTERN over the calls
 * the skill intends to make, and the conflict question is whether its extension
 * and the rule's extension intersect. {@link matchesPermissionRule} answers the
 * narrower question — *"does this rule cover this one concrete input?"* — and
 * {@link ruleConstrainsTool} answers the widest one, for a declaration that
 * names no input at all.
 *
 * 🚩 Between those two lay every spelling people actually write, and they were
 * being handed to the concrete matcher as if the pattern text were a literal
 * command or a literal filename. `Bash(git:*)` was tested as a command called
 * `git:*`. Measured: bare `Bash` vs deny `Bash(git push:*)` reported a conflict,
 * and `Bash(git:*)` vs the SAME rule reported none — even though the second
 * declaration is a NARROWING of the first that still contains `git push`. So did
 * `Bash(git push:*)` against itself. One deny rule, two answers, decided by how
 * much of its own scope the skill bothered to spell out, and the direction is
 * UNDER-report: silently telling an adopter "no conflict" about a tool their org
 * policy blocks.
 *
 * ⚠️ The previous repair of that same contradiction fixed one spelling — bare
 * `Write` versus `Write(./out/**)` — rather than the mechanism, which is why the
 * `:*` and `./**` forms were still broken afterwards. So the shape here is
 * per-LANE and spelling-blind: the taxonomy decides the tool, then containment
 * is asked in BOTH directions.
 *
 * 1. Tool names first, through {@link matchesToolName} in BOTH directions, so a
 *    rule for another tool can never be read as a pattern over this one, and a
 *    declaration that is itself a tool-name glob (`mcp__srv__*`) is reached by
 *    a rule naming one of its members.
 * 2. A declaration naming no input (bare, or `(*)`) is UNRESTRICTED, so the
 *    question is {@link ruleConstrainsTool}'s.
 * 3. Otherwise ask whether the RULE covers the declaration, and then whether the
 *    DECLARATION covers a {@link ruleWitnesses witness} drawn from the rule.
 *    Either containment means some call the skill intends is one the rule
 *    catches. On the path lane both inputs are rule-SPELLED paths, and each is
 *    expanded through the same `~/`, `//`, `/`, `./` table the pattern side
 *    reads ({@link splitPathSpelling}) before it is handed across — 🚩 they
 *    were not, so `Read(~/.ssh/**)` did not contain itself, or its narrowing
 *    `Read(~/.ssh/id_rsa)`, while `Read(./**)` over-reported against it by
 *    matching a literal `~` directory.
 *
 * The second direction is asked in the ALLOW lane whatever `lane` is, for
 * {@link isSubsumedBy}'s reason: the question there is *"does the declaration
 * PERMIT this?"*, and the deny lane's deliberate over-matching would manufacture
 * intersections that do not hold.
 *
 * ⛔ {@link isSubsumedBy} is NOT the primitive for the second direction, though
 * it looks like it. It asks whether the whole of one extension lies inside the
 * other and conjoins both halves of that, so a Bash rule does not even subsume
 * ITSELF: `Bash(git push:*)` fails its own second half, because the content text
 * `git push:*` is not a command the pattern `git push *` matches. Deliberate
 * there — it advises DELETING a rule, so it must never over-claim — and wrong
 * here, where one witness is enough.
 *
 * ⚠️ Containment is not intersection, and this returns `false` for the pairs
 * that overlap without either side containing the other — `Bash(npm *)` against
 * deny `Bash(* --help *)` share `npm --help x` and are reported as no conflict.
 * Deciding that needs a real glob-intersection over both patterns; what is here
 * closes the containment cases, which is every spelling the review measured, and
 * the residue is named rather than left to be rediscovered.
 *
 * @param declaration - The `allowed-tools:` entry, e.g. `Bash(git:*)` or `Read`
 * @param rule - Full permission rule string
 * @param lane - Which permission bucket the rule came from
 * @param cwd - Base directory for path-tool matching
 */
export function ruleConstrainsDeclaration(
  declaration: string,
  rule: string,
  lane: PermissionLane,
  cwd?: string
): boolean {
  const { toolName: declaredTool, content: declared } = parsePermissionRule(declaration);
  const { toolName: ruleTool, content: ruleContent } = parsePermissionRule(rule);

  // Tool names, in BOTH directions. A declaration may itself be the glob the
  // allow lane accepts — `mcp__srv__*` — and a rule naming one of its members
  // is a rule-inside-declaration containment, the same relation the content
  // step handles both ways. 🚩 Asked one way only, `mcp__srv__*` against a deny
  // rule for `mcp__srv__tool` was refused here before content was consulted:
  // the deny blocks a tool the declaration claims, and the answer was "no
  // conflict". When the declaration's glob covers the rule's tool, the rule's
  // concrete name is the tool the content lanes are asked about.
  const ruleCoversTool = matchesToolName(ruleTool, declaredTool, lane);
  if (!ruleCoversTool && !matchesToolName(declaredTool, ruleTool, 'allow')) return false;
  const toolName = ruleCoversTool ? declaredTool : ruleTool;

  // No input named: the declaration is the whole tool, unrestricted.
  if (declared === undefined || declared === '*') return ruleConstrainsTool(toolName, rule, lane);

  // A bare rule names the tool and nothing else, so it covers every use of it.
  if (ruleContent === undefined) return true;

  // The path lane's inputs are rule-SPELLED paths, so each is expanded through
  // the same prefix table the pattern side reads before it is handed across as
  // a file path — see {@link splitPathSpelling}.
  const asInput = (spelling: string): string =>
    contentLaneFor(toolName) === 'path' ? pathSpellingToFilePath(spelling, cwd ?? process.cwd()) : spelling;

  // Does the rule cover the declaration, read as an input…
  if (matchesPermissionRule(toolName, asInput(declared), rule, lane, cwd)) return true;
  // …or does the declaration cover something the rule names?
  return ruleWitnesses(toolName, ruleContent).some((witness) =>
    matchesPermissionRule(toolName, asInput(witness), declaration, 'allow', cwd),
  );
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

/**
 * MCP_TOOL_NAME_UNQUALIFIED — a skill document tells an agent to call an MCP
 * tool by its bare name, in a document that elsewhere spells that same tool
 * fully-qualified.
 *
 * Anthropic's skill-authoring guidance: "Without the server prefix, Claude may
 * fail to locate the tool, especially when multiple MCP servers are available."
 * VAT's own `vat skill review` checklist has carried this as a `[A]` manual item
 * marked "Not enforced by any validation code; a shift-left candidate awaiting
 * corpus evidence per docs/validation-rule-design.md, since a bare identifier in
 * prose is only a defect when the skill actually drives MCP." The reservation is
 * exactly right, and it is what shapes the detector below.
 *
 * ## The document supplies its own vocabulary
 *
 * A bare snake_case identifier is not evidence of anything — `page_size`,
 * `next_page_token` and `whiteboard_id` are all over these documents. What makes
 * an identifier an MCP *tool name* is that the SAME document also writes it
 * fully-qualified, in one of the two spellings a reader will meet:
 *
 * - `mcp__<server>__<tool>` — the Claude Code form, also how `allowed-tools`
 *   frontmatter names them.
 * - `ServerName:tool_name` — the API form Anthropic's guidance prescribes.
 *
 * So the detector never guesses. It reads the qualified names the document
 * already contains, and then reports the places that document names one of those
 * same tools bare. A document that does not drive MCP has an empty vocabulary and
 * cannot produce a finding — which dissolves the checklist's reservation rather
 * than arguing with it.
 *
 * ## Prose supplies the vocabulary; frontmatter does not
 *
 * Leading YAML frontmatter is stripped here, in the detector, before anything is
 * read from it. An `allowed-tools:` list of `mcp__…` names is a manifest, not the
 * document contradicting itself, so it must not seed the vocabulary — and a bare
 * name in the body below it is then simply a document that never qualified the
 * tool at all.
 *
 * Enforcing that HERE rather than at each call site is deliberate, and it is the
 * only place it has ever held. ⛔ An earlier version of this paragraph said the
 * SKILL.md lane in `packaging-validator.ts` "happened to pass a
 * frontmatter-stripped slice" while the bundled-`.md` lane passed whole files.
 * It does not and never did: `parseFileCached(...).content` is the raw source
 * verbatim — that file says so itself, 190 lines above the call — so BOTH lanes
 * fed frontmatter to the detector until this stripping landed.
 *
 * ## The uppercase rule in the API form, and why it is load-bearing
 *
 * The server half must be spelled the way Anthropic's own examples spell one —
 * uppercase FIRST, no underscore (`GitHub:create_issue`,
 * `BigQuery:bigquery_schema`). Without that rule the
 * pattern also matches two things that are emphatically not MCP tools:
 *
 * - **Node builtin specifiers** — `node:child_process` yields a "tool" named
 *   `child_process`, and VAT's own `packages/utils/README.md` then reports a
 *   finding on a table of exported function names.
 * - **OAuth scope strings** — `whiteboard:read:list_whiteboards` and
 *   `cloud_recording:read:list_user_recordings`, both live in a partner-built
 *   plugin in the install corpus.
 *
 * Neither was visible on the two adopter corpora; both were visible on the
 * authoring project, which is precisely the population check
 * `docs/validation-rule-design.md` requires and the reason it requires it.
 *
 * ## Measured fire rate, re-measured 2026-09-07
 *
 * Population = documents that spell at least one MCP tool fully-qualified.
 *
 * | Corpus | docs | population | firing | occurrences |
 * |---|---|---|---|---|
 * | VAT itself (`packages/**\/*.md`, dist + node_modules excluded) | 206 | 3 | **0** | 0 |
 * | installed skills (`SKILL.md` under `~/.claude/plugins`, `~/.claude/skills`) | 678 | 28 | 7 | 11 |
 *
 * ⛔ **Every number this table used to carry was taken by the camelCase-blind
 * matcher, so re-taking them was not optional.** A corpus measured by a matcher
 * that cannot see a whole family of names has already excluded that family from
 * its own population count, and "zero false positives" over such a corpus is a
 * statement about the blindness as much as about the rule. Both rows above were
 * re-run with the fixed detector, driving the exported functions directly, over
 * a corpus re-enumerated on the day.
 *
 * What moved, A/B on the same files with HEAD's module and this one:
 *
 * - **Authoring project: population 2 → 3.** One document newly enters the
 *   population, because it spells two camelCase tools (`generateHaiku`,
 *   `generateName`) that the old matcher could not see at all. Firing stays 0.
 * - **Installed skills: nothing moved** — 28 / 7 / 11 before and after,
 *   character for character, with no vocabulary entry gained or lost. The
 *   installed corpus is snake_case throughout, which is Anthropic's own
 *   convention and therefore exactly the population least able to expose this
 *   defect. Its silence is not evidence the defect was small.
 * - The corpus itself grew 677 → 678 `SKILL.md` between the two measurement
 *   dates; the delta above is A/B on the SAME 678 files, so it is a property of
 *   the detector rather than of the corpus.
 *
 * All 11 occurrences were read: every one names a tool bare that the same
 * document qualifies in its own prose. Zero false positives.
 *
 * The SHIPPED command was re-run on the same corpus rather than trusted to
 * agree with the probe — `vat audit --user`, 852 skills scanned, reproducing
 * the installed-skills row occurrence for occurrence and line for line (plus
 * the 4 linked-file occurrences `docs/validation-codes.md` records, which the
 * probe above does not traverse).
 *
 * The frontmatter-including detector, run over the same 678 documents, reports
 * 19 occurrences from the same 7 documents. The extra 8 are four copies of one
 * skill naming `create_repository` and `create_branch` bare, whose only
 * qualified spelling is its `allowed-tools:` frontmatter.
 *
 * ⛔ Those 8 WERE shipped. This paragraph used to claim the SKILL.md lane had
 * "always passed a frontmatter-stripped slice" and that the 19 therefore
 * described the probe rather than the product. `parseFileCached(...).content` is
 * the raw file, frontmatter and all, so the shipped lane emitted every one of
 * them. The 19 → 11 delta is a real behaviour change this detector made, not a
 * correction to a probe.
 *
 * `warning`, not `error`: with a single MCP server mounted the bare name
 * usually resolves, so the skill is degraded rather than broken.
 */

import { CODE_REGISTRY, type ValidationIssue } from '@vibe-agent-toolkit/schema';

/**
 * `mcp__<server>__<tool>` — the Claude Code spelling.
 *
 * The server segment is non-greedy, so the FIRST `__` after it closes the server
 * half and everything to its right is the tool. `mcp__plugin_github_github__get_me`
 * therefore yields `get_me`, and `mcp__zapier__gmail__send_email` yields
 * `gmail__send_email` — the tool half a document that writes that name bare will
 * write.
 *
 * ⚠️ This comment used to say the LAST `__` was the separator, and to credit the
 * non-greedy quantifier for it. Non-greedy stops at the FIRST. FIRST is also the
 * behaviour to want: Claude Code joins server segments with SINGLE underscores
 * (`plugin_<plugin>_<server>`), so the first `__` after `mcp__` closes the server
 * half — checked against a live session's whole mounted-tool roster, 200-plus
 * names, not one of which carries `__` inside its server half.
 * Nothing caught the false claim because no fixture could: the one that pinned
 * this line was `mcp__plugin_github_github__get_me`, whose server half has only
 * single underscores, so its first and last `__` are the same character.
 *
 * Both halves admit `-`. `\w` does not, and excluding it made two whole
 * families invisible:
 *
 * - **Hyphenated SERVER names matched nothing at all.** Claude Code mounts
 *   plugin servers as `plugin_<plugin>_<server>` and hyphenated plugin names are
 *   the norm (`mcp__plugin_microsoft-docs_microsoft-learn__microsoft_docs_search`,
 *   `mcp__claude-in-chrome__browser_batch`). A document driving MCP solely
 *   through such a server had an empty vocabulary and could produce no finding,
 *   true ones included.
 * - **Hyphenated TOOL names truncated at the hyphen**, and `\b` was satisfied
 *   there, so `mcp__plugin_context7_context7__resolve-library-id` put `resolve`
 *   into the vocabulary. Every later code span spelling that ordinary English
 *   word — or `query`, from `query-docs` — became a finding.
 *
 * ⛔ **The tool capture must NOT end on `\b`, and camelCase is why.** It used to,
 * and the consequence was not truncation — it was total invisibility. `\b`
 * asserts a word/non-word boundary; when the character after the captured run is
 * an UPPERCASE letter, both sides are word characters and the assertion fails.
 * The engine then backtracks the lowercase class one character at a time, and
 * every interior position is word|word too, so the whole match is abandoned:
 *
 * ```
 * mcp__linear__createIssue  →  []   (not ["create"] — nothing at all)
 * mcp__x__get_userInfo      →  []
 * ```
 *
 * camelCase tool names are the ordinary case for MCP servers written in
 * TypeScript, so a document driving such a server had an EMPTY vocabulary and
 * could report nothing — the exact defect this detector exists to catch, in the
 * exact documents most likely to have it. The hyphen family survived only
 * because `-` is a non-word character, which is why a fixture existed for
 * `foo-Bar` and none for `fooBar`.
 *
 * The fix is `(?![\w-])` — "not followed by a name character" — with the capture
 * class widened to admit uppercase so the whole camelCase name is taken. A
 * lookahead cannot be satisfied by giving back characters the way `\b` was, so
 * there is no silent-abandonment mode left.
 */
const CLAUDE_CODE_QUALIFIED = /\bmcp__[\w-]+?__([a-z][A-Za-z0-9_-]*)(?![\w-])/gu;

/**
 * `ServerName:tool_name` — the API spelling. Deliberately shapeless: two flat
 * classes either side of a literal `:`, with every *judgement* about the halves
 * made in code by {@link SERVER_IS_NAMED} and {@link isMultiSegmentToolName}.
 *
 * The natural spelling encodes both judgements inline —
 * `(?=[A-Za-z0-9-]*[A-Z])[A-Za-z][A-Za-z0-9-]*:([a-z][a-z0-9_]*_[a-z0-9_]+)` —
 * and `sonarjs/super-linear-regex` rejects it for backtracking: `[A-Za-z]`
 * overlaps the `[\w-]*` behind it, and `[a-z0-9_]*_` is ambiguous about which
 * `_` is the literal one. The flat form removes both, which is why it passes.
 *
 * ⚠️ **The rewrite bought nothing at runtime, and the comment here used to claim
 * otherwise.** Measured on 20k → 80k character inputs (a 4x input, so linear
 * predicts ~4x and quadratic ~16x):
 *
 * | Spelling | one colonless token | hyphenated run |
 * |---|---|---|
 * | this flat form | 0.05 → 0.22 ms (**4.0x**) | 0.06 → 0.21 ms (**3.3x**) |
 * | the natural form sonarjs rejects | 0.06 → 0.24 ms (**3.9x**) | 0.05 → 0.14 ms (**2.9x**) |
 * | flat form, lookbehind removed | 154 → **2595 ms** (**16.8x**) | 211 → **2879 ms** (**13.6x**) |
 *
 * So the linter was wrong about the natural form — it was already linear — and
 * the flat spelling is a readability-and-linter change, not a fix. What actually
 * decides the complexity is the `(?<![\w-])` **lookbehind**, and it is the one
 * piece here that must not be touched: without it the engine restarts the scan at
 * EVERY character of a long token that has no colon, and 80 KB of prose costs 2.6
 * seconds. Same mechanism, and the same measured shape, as the lookbehind on
 * `INLINE_LINK_REGEX` in `post-build-checks.ts`.
 *
 * A test holds the catastrophic case out rather than this comment, because a
 * regex can be rewritten into a shape a checker likes while staying quadratic —
 * and, as the table shows, flagged while already being linear. Neither direction
 * is observable from the linter's verdict. That test asserts a fixed budget on
 * one input size, not a growth ratio: the two columns above are four orders of
 * magnitude apart, so an absolute gate separates them, whereas a ratio needs a
 * denominator too small to measure honestly on a fast machine.
 *
 * ⛔ The tool capture ends on `(?![\w-])`, not `\b`, and for the same reason
 * {@link CLAUDE_CODE_QUALIFIED} does: `([a-z0-9_]+)\b` matched `GitHub:createIssue`
 * NOT AT ALL — not as `create`, not at all — because `\b` fails between `e` and
 * `I`, and every position the engine backtracks to is word|word as well. The
 * capture also opens with `[a-z]` rather than `[a-z0-9_]`, which changes no
 * outcome ({@link isMultiSegmentToolName} already demanded a lowercase first
 * character) and lets the regex say what it means.
 */
const API_QUALIFIED = /(?<![\w-])([\w-]+):([a-z]\w*)(?![\w-])/gu;

/**
 * A server half is an MCP server name only if it is spelled the way Anthropic's
 * own examples spell one: it STARTS with an uppercase letter and carries no
 * underscore — `GitHub:`, `BigQuery:`. This one predicate is what excludes
 * `node:child_process` and `whiteboard:read:list_whiteboards`; see the module
 * docstring for where each was measured.
 *
 * ⚠️ It used to be `/[A-Z]/` — an uppercase letter ANYWHERE — and a reviewer
 * flagged that as too loose. Tightening to the documented shape was measured
 * cost-free: over 884 documents (206 authoring-project `.md` + 678 installed
 * `SKILL.md`) the loose rule accepted exactly three distinct server halves —
 * `GitHub`, `BigQuery` and the literal `ServerName` of the guidance's own
 * template — and the strict rule accepts all three. It rejects nothing that was
 * ever observed.
 *
 * ⛔ Be honest about what it does NOT buy. The reviewer's own example,
 * `Note:this_is_fine`, satisfies BOTH halves of the strict rule and still seeds
 * the vocabulary. This is a narrowing toward the documented spelling, not a fix
 * for that class — no cheap predicate separates a prose `Word:token` from a
 * genuine `Server:tool`, and the reviewer could construct no realistic markdown
 * instance because the pattern admits no whitespace after the colon, which rules
 * out prose, YAML and JSON alike.
 */
const SERVER_IS_NAMED = /^[A-Z][A-Za-z0-9-]*$/u;

/** A lowercase letter opens every MCP tool name. */
const TOOL_STARTS_LOWERCASE = /^[a-z]/u;

/**
 * A camelCase hump — a lowercase-or-digit immediately followed by an uppercase
 * letter. `addCaseLinks`, `createIssue` and `get_userInfo` all carry one; `find`
 * and `resolve` do not. See {@link isMultiSegmentToolName} for why that matters.
 */
const TOOL_HAS_CASE_HUMP = /[a-z0-9][A-Z]/u;

/**
 * Separators the greedy tool capture can end on — when the character after the
 * name is neither a word character nor a hyphen, so `` `mcp__x__do_thing_` ``
 * captures `do_thing_`.
 *
 * ⚠️ This used to say "when the name is followed by an uppercase letter
 * (`mcp__x__foo-Bar` captures `foo-`)". That was true only while the capture
 * ended on `\b` and excluded uppercase, which is the same defect that made every
 * camelCase tool name invisible; see {@link CLAUDE_CODE_QUALIFIED}. That name
 * now captures whole, as `foo-Bar`.
 */
const TOOL_SEPARATORS = new Set(['-', '_']);

/**
 * The capture without those trailing separators.
 *
 * Still reachable after the camelCase fix, on a different shape: a trailing
 * separator followed by a non-name character, as in `` `mcp__x__do_thing_` ``.
 *
 * Trimmed in code, twice over. Requiring a non-separator last character inside
 * {@link CLAUDE_CODE_QUALIFIED} costs a nested quantifier for a case handled here
 * in one pass; and the obvious `.replace(/[-_]+$/u, '')` is itself super-linear —
 * `sonarjs/super-linear-regex` rejects it, correctly, because a long run of
 * separators makes every position a candidate start. A backwards walk has
 * nothing to backtrack.
 */
function withoutTrailingSeparators(tool: string): string {
  let end = tool.length;
  while (end > 0 && TOOL_SEPARATORS.has(tool[end - 1] ?? '')) end--;
  return tool.slice(0, end);
}

/**
 * A tool half opens with a lowercase letter and is MULTI-SEGMENT — it carries an
 * underscore, a hyphen, or a camelCase hump.
 *
 * ⚠️ **The hump is not decoration; without it the camelCase fix buys nothing.**
 * `addCaseLinks` and `createIssue` contain neither `_` nor `-`, so a gate written
 * as "contains a separator" refuses every camelCase tool name — the vocabulary
 * stays empty and the regex fix is inert. The predicate the gate is really
 * asking is *"is this a NAME rather than an ordinary English word?"*, and a case
 * boundary answers it exactly as well as a separator does: `find` is a word,
 * `addCaseLinks` is a name. That the two families are spelled differently is a
 * fact about the server's implementation language, not about ambiguity.
 *
 * Applied to BOTH spellings; see {@link qualifiedNamesIn}. Gating only the API
 * form let the `mcp__` form contribute ONE-WORD names to the vocabulary, so
 * `mcp__claude-in-chrome__find` seeded `find` and every later code span spelling
 * that ordinary English word became a finding. Same family as the uppercase-server
 * rule, and not closed by the hyphen fix: that one stopped a name being TRUNCATED
 * at its hyphen, this one stops a name that is one word to begin with.
 *
 * ⚠️ The separator set is `_` OR `-`, not `_` alone. Requiring an underscore
 * would drop `resolve-library-id` and `query-docs` — real, kebab-spelled MCP
 * tools whose whole capture the hyphen fix exists to preserve. What earns a place
 * in the vocabulary is being multi-word, because that is what makes a bare
 * occurrence unambiguous; `find` is a word, `resolve-library-id` is a name. The
 * API lane's capture holds no hyphen, so widening the predicate to admit one
 * leaves that lane exactly as it was.
 *
 * Written as a predicate rather than the obvious `^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$`
 * because that spelling nests a quantifier inside a quantifier, which
 * `security/detect-unsafe-regex` flags as a ReDoS shape. The captures this runs
 * on are already character-class-constrained, so the only things left to decide
 * are the first character and the presence of a separator — and `String.includes`
 * decides that in linear time with nothing to backtrack.
 */
function isMultiSegmentToolName(tool: string): boolean {
  if (!TOOL_STARTS_LOWERCASE.test(tool)) return false;
  return tool.includes('_') || tool.includes('-') || TOOL_HAS_CASE_HUMP.test(tool);
}

/** Inline code spans. Newline-free so a runaway backtick cannot swallow a paragraph. */
const CODE_SPAN = /`([^`\n]+)`/g;

/** The fence that opens and closes YAML frontmatter. */
const FRONTMATTER_FENCE = '---';

/**
 * Index one past the closing frontmatter fence, or 0 when `lines` opens no
 * frontmatter. An unterminated opening fence is not frontmatter: a document
 * whose first line happens to be a horizontal rule keeps all of its body.
 */
function frontmatterEnd(lines: readonly string[]): number {
  if (lines[0]?.trim() !== FRONTMATTER_FENCE) return 0;
  for (let index = 1; index < lines.length; index++) {
    if (lines[index]?.trim() === FRONTMATTER_FENCE) return index + 1;
  }
  return 0;
}

/**
 * `content` split into lines, with any leading YAML frontmatter blanked rather
 * than removed — every reported `line` stays the line the author will open the
 * file to, which dropping the lines outright would silently shift.
 */
function scannableLines(content: string): string[] {
  const lines = content.split('\n');
  const end = frontmatterEnd(lines);
  for (let index = 0; index < end; index++) lines[index] = '';
  return lines;
}

/** Every MCP tool name `text` spells fully-qualified, in either spelling. */
function qualifiedNamesIn(text: string): Set<string> {
  const vocabulary = new Set<string>();
  for (const match of text.matchAll(CLAUDE_CODE_QUALIFIED)) {
    const tool = withoutTrailingSeparators(match[1] ?? '');
    // The SAME multi-segment gate the API lane applies, and for the same reason.
    // It used to sit on one lane only: `API_QUALIFIED` demanded an underscore
    // while `mcp__…` demanded nothing, so `mcp__claude-in-chrome__find` seeded
    // the vocabulary with `find` and every later code span spelling that ordinary
    // word became a finding. Structurally the same class as the hyphen bug
    // (`resolve-library-id` → `resolve`), which the hyphen fix does not close —
    // that one truncated a name, this one admits a name that is one word to begin
    // with. The cost is that a genuinely single-word MCP tool spelled bare goes
    // unreported, which is the safe direction for a warning whose whole argument
    // is precision.
    if (tool !== '' && isMultiSegmentToolName(tool)) vocabulary.add(tool);
  }
  for (const match of text.matchAll(API_QUALIFIED)) {
    const [, server, tool] = match;
    if (server === undefined || tool === undefined) continue;
    if (!SERVER_IS_NAMED.test(server) || !isMultiSegmentToolName(tool)) continue;
    vocabulary.add(tool);
  }
  return vocabulary;
}

/**
 * Every MCP tool name `content` spells fully-qualified in its body, in either
 * spelling. Frontmatter supplies nothing; see the module docstring.
 *
 * Exported for tests: this set IS the detector's premise, and pinning it directly
 * is cheaper and clearer than inferring it from emitted issues.
 */
export function qualifiedMcpToolNames(content: string): Set<string> {
  return qualifiedNamesIn(scannableLines(content).join('\n'));
}

/**
 * Emit one `MCP_TOOL_NAME_UNQUALIFIED` per (line, bare tool name).
 *
 * Per instance rather than per document, each carrying the bare tool name as
 * `link`, because `applyAllowFilter` matches an allow glob against `location` OR
 * `link`. That is what lets an adopter waive one identifier:
 *
 * ```yaml
 * validation:
 *   allow:
 *     MCP_TOOL_NAME_UNQUALIFIED:
 *       - paths: ["get_me"]
 *         reason: "Named bare in the availability-probe step on purpose; the
 *                  qualified form is three lines above."
 * ```
 *
 * …while a different bare tool name in the same document still fires. Waiver
 * granularity is the emitter's decision, not the allow machinery's.
 *
 * Only inline code spans count. An agent copies what is in a code span; the same
 * word in running prose is discussion of the tool rather than an instruction to
 * call it. This is a design choice, not a measured one — the corpus numbers in
 * the module docstring were all taken with the code-span rule already applied, so
 * nothing here says what admitting prose would have cost.
 *
 * @param content Raw markdown of one skill document, frontmatter and all.
 * @param docLocation Project-relative path of that document, for the anchor.
 */
export function collectUnqualifiedMcpToolIssues(
  content: string,
  docLocation: string,
  issues: ValidationIssue[],
): void {
  const lines = scannableLines(content);
  const vocabulary = qualifiedNamesIn(lines.join('\n'));
  if (vocabulary.size === 0) return;

  const registryEntry = CODE_REGISTRY.MCP_TOOL_NAME_UNQUALIFIED;

  for (const [index, line] of lines.entries()) {
    const seenOnLine = new Set<string>();
    // Computed only once a span has already hit the vocabulary, so an ordinary
    // line pays nothing for the exemption below.
    let qualifiedOnLine: Set<string> | undefined;

    for (const match of line.matchAll(CODE_SPAN)) {
      const inner = (match[1] ?? '').trim();
      if (!vocabulary.has(inner) || seenOnLine.has(inner)) continue;

      // A line that spells THIS tool fully-qualified is the definition the
      // vocabulary was built from — a "`get_me` — that is `GitHub:get_me`"
      // gloss, or a row of a bare-to-qualified mapping table. Reporting it
      // would flag the very thing this code asks authors to write.
      //
      // Per MATCH, not per line: a line that qualifies tool A while naming
      // tool B bare is exactly the defect this check exists to report, and a
      // per-line skip dropped it without a trace.
      qualifiedOnLine ??= qualifiedNamesIn(line);
      if (qualifiedOnLine.has(inner)) continue;

      seenOnLine.add(inner);
      issues.push({
        severity: registryEntry.defaultSeverity,
        code: 'MCP_TOOL_NAME_UNQUALIFIED',
        message:
          `MCP tool "${inner}" is named without its server prefix; this document ` +
          `spells it fully-qualified elsewhere`,
        location: docLocation,
        line: index + 1,
        // The tool name, so one identifier can be waived without silencing the
        // document. Never the location: a tool name is not a file to open.
        link: inner,
        fix: registryEntry.fix,
        reference: registryEntry.reference,
      });
    }
  }
}

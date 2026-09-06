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
 * Enforcing that HERE rather than at each call site is deliberate: it used to
 * hold only because the SKILL.md lane in `packaging-validator.ts` happened to
 * pass a frontmatter-stripped slice, while the same file's bundled-`.md` lane
 * passed whole files straight off disk. One lane obeyed the invariant its own
 * comment asserted and the other did not.
 *
 * ## The uppercase rule in the API form, and why it is load-bearing
 *
 * The server half must carry an uppercase letter (`GitHub:create_issue`,
 * `BigQuery:bigquery_schema` — Anthropic's own examples). Without that rule the
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
 * ## Measured fire rate, 2026-09-06
 *
 * Population = documents that spell at least one MCP tool fully-qualified.
 *
 * | Corpus | docs | population | firing | occurrences |
 * |---|---|---|---|---|
 * | VAT itself (`packages/**\/*.md`, dist + node_modules excluded) | 206 | 2 | **0** | 0 |
 * | installed skills (`SKILL.md` under `~/.claude/plugins`, `~/.claude/skills`) | 677 | 28 | 7 | 11 |
 *
 * Re-measured with THIS detector after the hyphen, per-match and frontmatter
 * fixes. The previous table's two adopter rows are gone rather than restated:
 * they were taken with the previous regexes, and neither corpus is reachable
 * from this worktree to re-run.
 *
 * All 11 occurrences were read: every one names a tool bare that the same
 * document qualifies in its own prose. Zero false positives.
 *
 * The pre-fix detector, run over the SAME 677 documents, reported 19
 * occurrences from the same 7 documents. The extra 8 were four copies of one
 * skill naming `create_repository` and `create_branch` bare, whose only
 * qualified spelling is its `allowed-tools:` frontmatter — so those 8 were
 * never emitted by the shipped SKILL.md lane, which has always passed a
 * frontmatter-stripped slice. The old number described the probe, not the
 * product; this one describes both lanes, because both now strip.
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
 */
const CLAUDE_CODE_QUALIFIED = /\bmcp__[\w-]+?__([a-z][a-z0-9_-]*)\b/gu;

/**
 * `ServerName:tool_name` — the API spelling. Deliberately shapeless: two flat
 * classes either side of a literal `:`, with every *judgement* about the halves
 * made in code by {@link SERVER_IS_NAMED} and {@link isSnakeCaseToolName}.
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
 */
const API_QUALIFIED = /(?<![\w-])([\w-]+):([a-z0-9_]+)\b/gu;

/**
 * A server half is an MCP server name only if it carries an uppercase letter —
 * `GitHub:`, `BigQuery:`, per Anthropic's own examples. This one predicate is
 * what excludes `node:child_process` and `whiteboard:read:list_whiteboards`; see
 * the module docstring for where each was measured.
 */
const SERVER_IS_NAMED = /[A-Z]/u;

/** A lowercase letter opens every MCP tool name. */
const TOOL_STARTS_LOWERCASE = /^[a-z]/u;

/**
 * Separators the greedy tool capture can end on when the name is followed by an
 * uppercase letter (`mcp__x__foo-Bar` captures `foo-`).
 */
const TOOL_SEPARATORS = new Set(['-', '_']);

/**
 * The capture without those trailing separators.
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
 * A tool half is snake_case: it opens with a lowercase letter and carries at
 * least one underscore.
 *
 * Written as a predicate rather than the obvious `^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$`
 * because that spelling nests a quantifier inside a quantifier, which
 * `security/detect-unsafe-regex` flags as a ReDoS shape. The capture this runs on
 * is already `[a-z0-9_]+`, so the only two things left to decide are the first
 * character and the presence of an underscore — and `String.includes` decides the
 * second in linear time with nothing to backtrack.
 */
function isSnakeCaseToolName(tool: string): boolean {
  return TOOL_STARTS_LOWERCASE.test(tool) && tool.includes('_');
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
    if (tool !== '') vocabulary.add(tool);
  }
  for (const match of text.matchAll(API_QUALIFIED)) {
    const [, server, tool] = match;
    if (server === undefined || tool === undefined) continue;
    if (!SERVER_IS_NAMED.test(server) || !isSnakeCaseToolName(tool)) continue;
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

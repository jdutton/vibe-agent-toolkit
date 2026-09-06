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
 * | VAT itself (`packages/**\/*.md`, dist excluded) | 206 | 2 | **0** | 0 |
 * | adopter A (`SKILL.md`, dist excluded) | 107 | 1 | 1 | 3 |
 * | adopter B (`SKILL.md`) | 21 | 0 | 0 | 0 |
 * | 632-skill install corpus | 632 | 19 | 7 | 19 |
 *
 * Zero false positives across the 8 firing documents. Two of them are skills in
 * a first-party marketplace plugin, so this is not a house style being
 * legislated. These are the SHIPPED detector's numbers, re-run through this
 * module rather than through the throwaway probe that first found them — the
 * probe de-duplicated per document and reported 18 occurrences where this code,
 * de-duplicating per LINE, reports 19. Per line is the intended granularity: two
 * bare uses of one tool are two places to fix, each with its own line number. `warning`, not `error`: with a single MCP server mounted the bare
 * name usually resolves, so the skill is degraded rather than broken.
 */

import { CODE_REGISTRY, type ValidationIssue } from '@vibe-agent-toolkit/schema';

/**
 * `mcp__<server>__<tool>` — the Claude Code spelling. The server segment is
 * non-greedy so the LAST `__` separates server from tool, which is what makes
 * `mcp__plugin_github_github__get_me` yield `get_me` and not `github__get_me`.
 */
const CLAUDE_CODE_QUALIFIED = /\bmcp__\w+?__([a-z][a-z0-9_]*)\b/gu;

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
 * The growth is pinned by a test rather than by this comment, because a regex can
 * be rewritten into a shape a checker likes while staying quadratic — and, as the
 * table shows, flagged while already being linear. Neither direction is
 * observable from the linter's verdict.
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

/**
 * Every MCP tool name `content` spells fully-qualified, in either spelling.
 *
 * Exported for tests: this set IS the detector's premise, and pinning it directly
 * is cheaper and clearer than inferring it from emitted issues.
 */
export function qualifiedMcpToolNames(content: string): Set<string> {
  const vocabulary = new Set<string>();
  for (const match of content.matchAll(CLAUDE_CODE_QUALIFIED)) {
    if (match[1] !== undefined) vocabulary.add(match[1]);
  }
  for (const match of content.matchAll(API_QUALIFIED)) {
    const [, server, tool] = match;
    if (server === undefined || tool === undefined) continue;
    if (!SERVER_IS_NAMED.test(server) || !isSnakeCaseToolName(tool)) continue;
    vocabulary.add(tool);
  }
  return vocabulary;
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
 * @param content Raw markdown of one skill document.
 * @param docLocation Project-relative path of that document, for the anchor.
 */
export function collectUnqualifiedMcpToolIssues(
  content: string,
  docLocation: string,
  issues: ValidationIssue[],
): void {
  const vocabulary = qualifiedMcpToolNames(content);
  if (vocabulary.size === 0) return;

  const registryEntry = CODE_REGISTRY.MCP_TOOL_NAME_UNQUALIFIED;
  const lines = content.split('\n');

  for (const [index, line] of lines.entries()) {
    // A line that already carries the qualified spelling is the definition the
    // vocabulary was built from, not a bare use of it. Reporting it would flag
    // the very thing this code asks authors to write.
    if (line.includes('mcp__')) continue;

    const seenOnLine = new Set<string>();
    for (const match of line.matchAll(CODE_SPAN)) {
      const inner = (match[1] ?? '').trim();
      if (!vocabulary.has(inner) || seenOnLine.has(inner)) continue;
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

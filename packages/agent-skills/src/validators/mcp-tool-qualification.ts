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
 * ## Measured fire rate (re-measured after the camelCase fix below)
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
 *
 * ## Text half and judgement half
 *
 * The text half (frontmatter blanking, the vocabulary from both qualified
 * spellings, the per-line exemption, one record per line and bare name) is the
 * skill-text core's `mcpUnqualified` family in `@vibe-agent-toolkit/resources`,
 * computed once per document and stored with its blob. This module builds the
 * issue from each record, every run.
 */

import type { SkillTextFacts } from '@vibe-agent-toolkit/resources';
import { CODE_REGISTRY, type ValidationIssue } from '@vibe-agent-toolkit/schema';

import { recordsOf } from './skill-text-records.js';

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
 * @param facts - The skill-text record of one skill document, frontmatter and all
 * @param docLocation - Project-relative path of that document, for the anchor
 * @param issues - Where the issues are appended
 */
export function collectUnqualifiedMcpToolIssues(
  facts: SkillTextFacts,
  docLocation: string,
  issues: ValidationIssue[],
): void {
  const registryEntry = CODE_REGISTRY.MCP_TOOL_NAME_UNQUALIFIED;
  for (const { line, matchText: tool } of recordsOf(facts, 'mcpUnqualified')) {
    issues.push({
      severity: registryEntry.defaultSeverity,
      code: 'MCP_TOOL_NAME_UNQUALIFIED',
      message:
        `MCP tool "${tool}" is named without its server prefix; this document ` +
        `spells it fully-qualified elsewhere`,
      location: docLocation,
      line,
      // The tool name, so one identifier can be waived without silencing the
      // document. Never the location: a tool name is not a file to open.
      link: tool,
      fix: registryEntry.fix,
      reference: registryEntry.reference,
    });
  }
}

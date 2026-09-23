/**
 * **The built-in check set** — the assertions `vat resources check` runs whether
 * or not a project declares any of its own.
 *
 * 🔑 **A built-in is a TypeScript predicate over {@link BuiltinCheckInput} — it
 * is never SQL**, so a default-on rule cannot make the query engine mandatory
 * for everyone who inherits it. ⛔ The `sqlTwin` each check carries is
 * documentation an adopter copies, and must not become a runtime alternative.
 * A built-in's findings carry an ORDINARY registry code, never `CUSTOM:<name>`.
 *
 * All three, with the grounds they were decided on: `docs/architecture/cli.md`,
 * "`vat resources check [path]`".
 *
 * Three checks ship, all over `.claude/rules/` files, and each later one exists
 * because the earlier ones are structurally blind to its case:
 *
 * 1. {@link CLAUDE_RULE_GLOB_INERT_CHECK} — a `paths:` glob that matches nothing.
 * 2. {@link CLAUDE_RULE_FRONTMATTER_INVALID_CHECK} — frontmatter VAT could not
 *    read `paths:` out of, so the rule's globs never reached
 *    `claude_rule_patterns` and the first check had nothing to look at.
 * 3. {@link CLAUDE_RULE_LINK_UNCHECKED_CHECK} — a rules file or directory that
 *    is ITSELF a SYMLINK. VAT realizes no link path, so such a rule has no
 *    realization, no blob and no pattern row: both checks above pass on it.
 *    ⛔ "Itself": a link at a HIGHER ancestor hides a rules tree the same way
 *    and is out of reach — see {@link rulesLinkKind}.
 */

import { createRegistryIssue, type IssueCode, type ValidationIssue } from '@vibe-agent-toolkit/schema';

import type { BlobRow } from '../schemas/projection-blobs.js';
import type { ClaudeRulePatternRow } from '../schemas/projection-claude-rules.js';
import type {
  RealizationConditionRow,
  ResourceRealizationRow,
  ResourceTagRow,
} from '../schemas/projection-resources.js';

import { RULES_FILE_TAG } from './agentic-tags.js';
import { nestedRuleParent } from './claude-context-rules.js';
import {
  DECLINED_SYMLINK_CODES,
  EXTENT_SYMLINK_TARGET_OUTSIDE_ROOT,
  isDeclinedSymlinkCode,
} from './contributors/filesystem-extent.js';
import { findingLocation } from './finding-location.js';

/**
 * The projection slice the built-in set reads.
 *
 * ⚠️ Deliberately the COLUMNS rather than `Pick<Projection, …>` of whole rows. A
 * `Projection` satisfies it structurally, so the command passes one unchanged;
 * a test supplies two fields instead of the seventeen a realization row carries,
 * which is what keeps these cases about the predicate rather than about a
 * fixture builder.
 */
export interface BuiltinCheckInput {
  readonly claudeRulePatterns: readonly ClaudeRulePatternRow[];
  readonly resourceRealizations: readonly Pick<ResourceRealizationRow, 'resourceId' | 'path' | 'contentKey'>[];
  /** Which identities are rules files — the `rules-file` tag the path classifier emits. */
  readonly resourceTags: readonly Pick<ResourceTagRow, 'resourceId' | 'tag'>[];
  /** Whether each keyed blob's frontmatter parsed. */
  readonly blobs: readonly Pick<BlobRow, 'contentKey' | 'frontmatterError'>[];
  /**
   * What the extents could not realize — the only table that holds the links
   * they declined.
   *
   * ⛔ REQUIRED, like every other member. A rules file reached through a symlink
   * has no realization row, no blob row and no pattern row, so it is invisible
   * to the two checks above by construction; an optional field here would have
   * compiled for every caller that omitted it and left the third check silently
   * inert — the *"optional seam whose omission is the failure"* shape. A
   * `Projection` satisfies it unchanged.
   */
  readonly realizationConditions: readonly Pick<RealizationConditionRow, 'code' | 'path'>[];
}

/** One default-on assertion over the projection's row model. */
export interface BuiltinCheck {
  /** The operator's handle: what `--check <name>` takes, and what `checks[]` publishes. */
  readonly name: string;
  /** What it asserts, in one line — the built-in's answer to a declared check's `description`. */
  readonly description: string;
  /**
   * The registry code every finding carries. The help renders the code and its
   * default severity from this, so the two are never transcribed apart.
   */
  readonly code: IssueCode;
  /**
   * The SQL that selects the same rows, for an adopter to copy into
   * `resources.checks` and adapt. Documentation, never executed here.
   */
  readonly sqlTwin: string;
  /**
   * Select the violations and report them.
   *
   * @param input - The rows this check reads
   * @returns One finding per violation, in row order
   */
  readonly run: (input: BuiltinCheckInput) => readonly ValidationIssue[];
}

/** A built-in bound to the projection it will run over — all the runner needs. */
export interface BoundBuiltinCheck {
  readonly name: string;
  /** @returns One finding per violation */
  readonly run: () => readonly ValidationIssue[];
}

/** What {@link CLAUDE_RULE_GLOB_INERT_CHECK} emits. */
const GLOB_INERT_CODE = 'CLAUDE_RULE_GLOB_INERT' satisfies IssueCode;

/** What {@link CLAUDE_RULE_FRONTMATTER_INVALID_CHECK} emits. */
const FRONTMATTER_INVALID_CODE = 'CLAUDE_RULE_FRONTMATTER_INVALID' satisfies IssueCode;

/** The status that means *evaluated, and it matched nothing*. The only defect of the four. */
const INERT = 'inert';

/**
 * Where each identity is realized, for anchoring a finding to a file.
 *
 * FIRST realization wins, and ties are impossible in the direction that matters:
 * `resourceId` is `hash(rootId, canonicalPath at first observation)`, so every
 * realization of one identity carries the same path. A rules file is re-realized
 * under every import closure that reaches it, which is why the map is built once
 * rather than searched per pattern.
 *
 * @param realizations - The projection's realization rows
 * @returns resourceId → root-relative path
 */
function pathByResourceId(
  realizations: BuiltinCheckInput['resourceRealizations'],
): ReadonlyMap<string, string> {
  const paths = new Map<string, string>();
  for (const row of realizations) {
    if (!paths.has(row.resourceId)) paths.set(row.resourceId, row.path);
  }
  return paths;
}

/** How a finding names a rules file that has no realization row to anchor it. */
const UNLOCATED_RULES_FILE = 'the rules file that declares it';

/**
 * What one dead glob says to its author.
 *
 * The pattern is quoted VERBATIM and never normalised: VAT reports the glob and
 * never rewrites it, so the text here is what the author can grep for in the
 * file the finding names.
 *
 * @param row - The inert pattern
 * @param where - The rules file, or a description of it when its path is unknown
 * @returns The message
 */
function inertMessage(row: ClaudeRulePatternRow, where: string): string {
  // ⛔ "that VAT can see", not "in this tree". The corpus declines every path
  // git ignores, and the harness reads the filesystem — so for a glob scoped to
  // `dist/**` the unqualified claim was false, and the fix text below would have
  // had the author delete a glob that fires.
  return `The paths: glob "${row.pattern}" (pattern ${row.ordinal + 1} of ${where}) matches no file VAT`
    + ' can see in this tree (tracked, or untracked and not gitignored), so no such file can load the'
    + ' rule it scopes.';
}

/**
 * Every `paths:` glob that matches nothing.
 *
 * ## ⭐ `unevaluated` and `gitignored` are not violations, and that is the whole design
 *
 * Of the four statuses only `inert` is a defect. `matched` is the healthy case;
 * `unevaluated` means the matcher was NEVER RUN for THAT ONE PATTERN — the
 * vendor's 1,000-pattern / 4 MiB budget is spent per pattern as the list is
 * walked, so the entry that exhausts it is used unexpanded by the harness and
 * skipped here while its live neighbours are evaluated and reported normally —
 * so reporting it would report VAT's own declined work as the
 * adopter's typo, and no edit to the rules file would fix it. `gitignored`
 * means the glob's territory is ignored, so VAT never saw the files the harness
 * reads there, and deleting the glob would break a rule that fires. Widening this to
 * `status !== 'matched'` is the *guard that returns the reassuring value* drift
 * class arriving from the other side: refused read as present.
 *
 * @param input - The rows
 * @returns One finding per inert pattern, in row order
 */
function runClaudeRuleGlobInert(input: BuiltinCheckInput): readonly ValidationIssue[] {
  const paths = pathByResourceId(input.resourceRealizations);
  const issues: ValidationIssue[] = [];

  for (const row of input.claudeRulePatterns) {
    if (row.status !== INERT) continue;
    // 🪤 A LEFT join. A pattern whose rules file has no realization row still
    // produces a finding, without an anchor — dropping it would make the finding
    // count silently disagree with the table and nothing would say so.
    const location = findingLocation(paths.get(row.resourceId));
    issues.push(createRegistryIssue(GLOB_INERT_CODE,inertMessage(row, location ?? UNLOCATED_RULES_FILE), {
      // Spread rather than assigned: under `exactOptionalPropertyTypes` an
      // absent key and one holding `undefined` are different values, and
      // `location` is refined to a project-relative POSIX path or nothing. There
      // is no third state to put a placeholder in.
      ...(location === undefined ? {} : { location }),
      // The frontmatter key, not a slot in it. `paths:` is a sequence OR a
      // comma-separated scalar, so there is no index to name for the scalar form
      // — `ordinal` is the dense pattern index, which the message already spells
      // out in words. `line` would be a second lie: the row model carries none.
      field: 'paths',
    }));
  }

  return issues;
}

/** The dead-`paths:`-glob check. Exported by name so a test can drive one check. */
export const CLAUDE_RULE_GLOB_INERT_CHECK: BuiltinCheck = {
  name: 'claude-rule-glob-inert',
  description: 'Every paths: glob in .claude/rules/ matches at least one file in the tree',
  code: GLOB_INERT_CODE,
  // A correlated subquery, not a join: a rules file is realized once per extent
  // that reaches it, and a join would repeat every finding per realization.
  sqlTwin:
    'SELECT p.pattern, p.ordinal,\n'
    + '       (SELECT r.path FROM resource_realizations r\n'
    + '         WHERE r.resourceId = p.resourceId LIMIT 1) AS path\n'
    + '  FROM claude_rule_patterns p\n'
    + " WHERE p.status = 'inert'",
  run: runClaudeRuleGlobInert,
};

/**
 * What one unreadable rules file says to its author.
 *
 * ⚠️ "Unreadable", not "unparseable" — the column carries two reasons and the
 * sentence has to hold both. A YAML syntax error is the first. The second is a
 * block that PARSES and is not a mapping (`---\n- a\n- b\n---`), which
 * `blob-facts.ts` gives its own reason: "does not parse (valid YAML …)" would
 * have contradicted itself.
 *
 * The parser's reason is kept to its FIRST line: a YAML error can carry a code
 * frame, which repeats the file's content and says nothing the first line does
 * not. The reason is about content, never about a path.
 *
 * "As if it had no `paths:`" is a different load for the two locations a rules
 * file can live in: a project-root rule loads at launch, a nested one only when
 * Claude reads files under its directory — the same split `ruleScopeFor` draws.
 *
 * @param where - The rules file, or a description of it when its path is unknown
 * @param path - The rules file's root-relative path, for its scope
 * @param reason - The parser's message
 * @returns The message
 */
function frontmatterInvalidMessage(where: string, path: string, reason: string): string {
  const firstLine = reason.split('\n', 1)[0] ?? reason;
  const under = nestedRuleParent(path);
  const load = under === null
    ? 'loaded at launch'
    : `loaded on demand, when Claude reads files under '${under}'`;
  // A YAML error's first line ends in `:` introducing the code frame it dropped.
  const said = firstLine.trim().replace(/:$/, '');
  return `VAT could not read the YAML frontmatter of ${where} (${said}), so it read no paths:`
    + ` from it: the rule is counted as if it had no paths: (${load}), and claude_rule_patterns`
    + ' holds no row for any glob it declares, so claude-rule-glob-inert cannot see them. What Claude Code'
    + ' does with a rules file whose frontmatter it cannot read is not documented.';
}

/**
 * Every rules file whose frontmatter failed to parse — once per file.
 *
 * ## Why this is its own check and not a widening of the inert one
 *
 * An unparseable `paths:` list produces NO pattern rows, so the inert-glob check
 * has nothing to read and passes: an empty table and a clean rules tree are the
 * same answer there. This check reads the blob's own verdict instead, so the
 * defect the first check is structurally blind to is reported by the second.
 *
 * One finding per IDENTITY: a rules file is realized once per extent that reaches
 * it, and every realization carries the same path and content key. A realization
 * with no content key was never read, so it has no verdict to report.
 *
 * @param input - The rows
 * @returns One finding per rules file whose frontmatter did not parse, in realization order
 */
function runClaudeRuleFrontmatterInvalid(input: BuiltinCheckInput): readonly ValidationIssue[] {
  const rulesFiles = new Set(
    input.resourceTags.filter((row) => row.tag === RULES_FILE_TAG).map((row) => row.resourceId),
  );
  const errorByKey = new Map<string, string>();
  for (const blob of input.blobs) {
    if (blob.frontmatterError !== null) errorByKey.set(blob.contentKey, blob.frontmatterError);
  }

  const reported = new Set<string>();
  const issues: ValidationIssue[] = [];
  for (const row of input.resourceRealizations) {
    if (!rulesFiles.has(row.resourceId) || reported.has(row.resourceId) || row.contentKey === null) continue;
    const reason = errorByKey.get(row.contentKey);
    if (reason === undefined) continue;
    reported.add(row.resourceId);
    const location = findingLocation(row.path);
    issues.push(createRegistryIssue(
      FRONTMATTER_INVALID_CODE,
      frontmatterInvalidMessage(location ?? UNLOCATED_RULES_FILE_ITSELF, row.path, reason),
      { ...(location === undefined ? {} : { location }), field: 'frontmatter' },
    ));
  }
  return issues;
}

/** How the frontmatter finding names a rules file whose path cannot be used as a location. */
const UNLOCATED_RULES_FILE_ITSELF = 'a rules file';

/** The unparseable-frontmatter check. Exported by name so a test can drive one check. */
export const CLAUDE_RULE_FRONTMATTER_INVALID_CHECK: BuiltinCheck = {
  name: 'claude-rule-frontmatter-invalid',
  description: 'Every .claude/rules/ file has YAML frontmatter that parses, so its paths: globs are evaluated',
  code: FRONTMATTER_INVALID_CODE,
  // DISTINCT, not a join per realization: every realization of one identity
  // carries the same path and content key, so DISTINCT collapses the fan-out.
  sqlTwin:
    'SELECT DISTINCT r.path, b.frontmatterError\n'
    + '  FROM resource_realizations r\n'
    + '  JOIN blobs b ON b.contentKey = r.contentKey\n'
    + ' WHERE b.frontmatterError IS NOT NULL\n'
    + "   AND r.resourceId IN (SELECT t.resourceId FROM resource_tags t WHERE t.tag = 'rules-file')",
  run: runClaudeRuleFrontmatterInvalid,
};

/** What {@link CLAUDE_RULE_LINK_UNCHECKED_CHECK} emits. */
const LINK_UNCHECKED_CODE = 'CLAUDE_RULE_LINK_UNCHECKED' satisfies IssueCode;

/** The two path segments that make a directory a Claude rules directory. */
const RULES_DIRECTORY_SEGMENTS = ['.claude', 'rules'] as const;

/**
 * Is this path a rules FILE, something else at or under a rules directory, or
 * neither?
 *
 * `null` for every other path: `CLAUDE.md -> AGENTS.md` is the commonest link
 * in the corpus and is no business of a rules check.
 *
 * ⭐ A link at `.claude` ITSELF counts. `sub/.claude -> ../.claude` carries a
 * whole rules directory with it, and the link's own path never contains the
 * `rules` segment — so a `.claude`/`rules` pair search alone read the commonest
 * shape of the defect as "not a rules link" and said nothing.
 *
 * ## ⛔ AT a rules path, never ABOVE one — the class is narrowed, not closed
 *
 * A link at any HIGHER ancestor hides a rules tree just as completely:
 * `sub -> ../shared`, where the target holds `sub/.claude/rules/*.md`, returns
 * `null` here and is reported by nothing. That is stated rather than fixed,
 * because nothing available can decide it. The condition row is at `sub`; VAT
 * follows no link, so it never reads what the target holds; and the row carries
 * no column saying so. The only predicate that would catch it is *"every
 * declined link is a possible hidden rule set"*, which reports `CLAUDE.md ->
 * AGENTS.md` and every vendored tree in the corpus — the loudest available way
 * to be wrong. So the check's `description`, this predicate and
 * `docs/validation-codes.md` all claim the narrow thing; closing the wider class
 * needs a column saying what a declined link's target holds.
 *
 * ## Case-SENSITIVE, and the twin has to be too
 *
 * `.CLAUDE` is not `.claude` to the rest of this lane — `agentic-tags.ts`
 * compares the segments byte for byte — so it is not one here. SQLite's `LIKE`
 * is ASCII-case-insensitive by default, which is why {@link
 * CLAUDE_RULE_LINK_UNCHECKED_CHECK}'s twin is written with `GLOB`: as `LIKE` it
 * selected `.CLAUDE/rules/a.md`, `.Claude/Rules/a.md`, `.claude/RULES/a.md` and
 * `X/.CLAUDE`, none of which this predicate reports, and disagreed with itself
 * besides (two `=` arms case-sensitive, four `LIKE` arms not).
 *
 * `.MD` is the one place case is folded, and it decides only how the finding is
 * PHRASED — both arms are reported either way. For a link VAT never opens,
 * calling `linked.MD` a directory is the worse guess: on a case-insensitive host
 * it is exactly the file the harness opens for `*.md`.
 *
 * @param path - A root-relative, forward-slashed path
 * @returns `'file'` for a markdown file under a rules directory, `'tree'` for a
 *   `.claude` directory, a rules directory, or any non-markdown path under one,
 *   `null` otherwise
 */
function rulesLinkKind(path: string): 'file' | 'tree' | null {
  // eslint-disable-next-line local/no-hardcoded-path-split -- `realization_conditions.path` is root-relative and forward-slashed by `relativize()` before any consumer sees it, which is the precondition that rule enforces
  const segments = path.split('/');
  if (segments.at(-1) === RULES_DIRECTORY_SEGMENTS[0]) return 'tree';
  const at = segments.findIndex((segment, index) =>
    segment === RULES_DIRECTORY_SEGMENTS[0] && segments[index + 1] === RULES_DIRECTORY_SEGMENTS[1]);
  if (at === -1) return null;
  const isTheDirectory = segments.length === at + RULES_DIRECTORY_SEGMENTS.length;
  return !isTheDirectory && path.toLowerCase().endsWith('.md') ? 'file' : 'tree';
}

/**
 * What Claude Code does with this link, and what the author should do about it.
 *
 * ## ⛔ The two arms are different defects, and the CODE decides which
 *
 * Read from the shipped 2.1.280 binary
 * (`docs/external/claude-code-rules-paths-behaviour.md`, "Symlinked rules"): a
 * rules file or rules directory reached through a link whose target resolves
 * OUTSIDE the directory the session started in is skipped — the directory arm
 * returns `[]`, the file arm `continue`s — and one whose target stays inside is
 * loaded normally. In-root, a rule governs the session and nothing checked it,
 * and the remedy is to stop linking so VAT can see it. Out-of-root, the rule set
 * the author believes governs the session is in force NOWHERE, and VAT's blind
 * spot is the lesser problem beside that.
 *
 * ⚠️ This check is a pure predicate over rows and resolves no link itself. It
 * reads the verdict from {@link EXTENT_SYMLINK_TARGET_OUTSIDE_ROOT} — the
 * condition row's own code, set where the target was resolved — and never from
 * the row's prose, which would be the *"a contract carried in text"* drift
 * class. For one release both arms shared one sentence for exactly that reason.
 *
 * ⚠️ The in-root arm still hedges on ONE point, because the two directories are
 * not the same question: the harness compares against the directory the session
 * started in and VAT against the project root, so a session started in a
 * subdirectory can skip a link VAT calls in-root. The out-of-root arm carries no
 * such hedge — outside the project root is outside every directory beneath it.
 *
 * @param code - The declined link's `realization_conditions.code`
 * @returns The sentences that follow the blind-checks clause
 */
function linkPositionClause(code: string): string {
  if (code === EXTENT_SYMLINK_TARGET_OUTSIDE_ROOT) {
    return ' Its target resolves outside the project root, so Claude Code does not load it either:'
      + ' a rules file or directory reached through such a link is skipped, and the rule set you'
      + ' meant to pull in is in force nowhere. Copy or vendor those rules into the repository —'
      + ' sharing one rule set across repositories by symlink does not work. The'
      + ' EXTENT_SYMLINK_TARGET_OUTSIDE_ROOT row at this path records the position without naming'
      + ' the target.';
  }
  return ' Its target is inside the project root, so Claude Code loads the rule through the link:'
    + ' it is in force and unchecked. Replace the link with the file itself, or with an @ import of'
    + ' the shared file from a rules file that is not a link, to make VAT check its globs and'
    + ' frontmatter. (Claude Code compares against the directory the session started in rather than'
    + ' the project root, so a session started in a subdirectory can skip this link too.) The'
    + ' EXTENT_SYMLINK_NOT_REALIZED row at this path names the target.';
}

/**
 * What one linked rule says to its author.
 *
 * @param path - The link's root-relative path
 * @param kind - Whether the link is one rules file or a directory of them
 * @param code - The declined link's `realization_conditions.code`
 * @returns The message
 */
function linkUncheckedMessage(path: string, kind: 'file' | 'tree', code: string): string {
  const subject = kind === 'file'
    ? `The rules file '${path}' is a symbolic link`
    : `'${path}' is a symbolic link at or under a directory Claude Code loads rules from, so every`
      + ' rules file it reaches through the link is in the same position';
  return `${subject}. VAT realizes no link path, so there is no claude_rule_patterns row for`
    + ' any paths: glob it declares and no blobs row at that path for its frontmatter:'
    + ` claude-rule-glob-inert and claude-rule-frontmatter-invalid are both blind to it.${linkPositionClause(code)}`;
}

/**
 * Every declined link that hides a rules file.
 *
 * ## Why this reads condition rows rather than realizations
 *
 * There is nothing else to read. VAT realizes no symbolic link's own path
 * (*"A SYMLINK IS NOT A MEMBER"*, `crawl-source.ts`) and that policy stands, so
 * a linked rules file has no realization row, no blob and no pattern row — it is
 * absent from every table the other two built-ins query, and both PASS on it.
 * The declined-link row the extent records is the only trace, and at `info` with
 * a message about link targets it says nothing about rules.
 *
 * ⛔ BOTH declined-link codes, read through {@link DECLINED_SYMLINK_CODES}. The
 * out-of-root arm is the one whose rule never loads at all, so a filter that
 * kept only `EXTENT_SYMLINK_NOT_REALIZED` would stay silent about the worse
 * defect of the two.
 *
 * One finding per PATH: an extent records the link it met, so a link met by the
 * walk and by git is two rows carrying one path, exactly as one rules file is
 * realized once per extent that reaches it.
 *
 * @param input - The rows
 * @returns One finding per linked rules path, in row order
 */
function runClaudeRuleLinkUnchecked(input: BuiltinCheckInput): readonly ValidationIssue[] {
  const reported = new Set<string>();
  const issues: ValidationIssue[] = [];
  for (const row of input.realizationConditions) {
    if (!isDeclinedSymlinkCode(row.code) || reported.has(row.path)) continue;
    const kind = rulesLinkKind(row.path);
    if (kind === null) continue;
    reported.add(row.path);
    const location = findingLocation(row.path);
    issues.push(createRegistryIssue(
      LINK_UNCHECKED_CODE,
      linkUncheckedMessage(row.path, kind, row.code),
      location === undefined ? {} : { location },
    ));
  }
  return issues;
}

/** The declined-link codes as a SQL `IN` list, derived from the one constant. */
const DECLINED_SYMLINK_CODES_SQL = DECLINED_SYMLINK_CODES.map((code) => `'${code}'`).join(', ');

/** The linked-rules check. Exported by name so a test can drive one check. */
export const CLAUDE_RULE_LINK_UNCHECKED_CHECK: BuiltinCheck = {
  name: 'claude-rule-link-unchecked',
  description:
    'No .claude directory, .claude/rules/ directory or file under one is ITSELF a symbolic link,'
    + ' which VAT realizes at no path and cannot check',
  code: LINK_UNCHECKED_CODE,
  // DISTINCT, because one link is recorded by every extent that met it. The
  // `.claude/rules` test is written as four arms rather than one: the directory
  // can be the root's own or a nested one, and it can be the link itself or an
  // ancestor of it.
  //
  // ⛔ GLOB, never LIKE. SQLite's LIKE is ASCII-case-insensitive by default and
  // GLOB is not, and the predicate compares segments byte for byte — so as LIKE
  // this twin selected four case variants (`.CLAUDE/rules/a.md`,
  // `.Claude/Rules/a.md`, `.claude/RULES/a.md`, `X/.CLAUDE`) the check does not
  // report, and disagreed with ITSELF besides: the two `=` arms were
  // case-sensitive and the four `LIKE` arms were not, so the same tree answered
  // differently depending on which arm caught it. A twin is documentation an
  // adopter copies into `resources.checks`; one that selects rows the built-in
  // does not is a rule that changes meaning on being copied.
  //
  // ⛔ BOTH declined-link codes, rendered from `DECLINED_SYMLINK_CODES` rather
  // than typed out: a twin naming one of them would silently drop every
  // out-of-root link — the arm whose rule Claude Code does not load at all.
  sqlTwin:
    'SELECT DISTINCT c.path\n'
    + '  FROM realization_conditions c\n'
    + ` WHERE c.code IN (${DECLINED_SYMLINK_CODES_SQL})\n`
    + "   AND (c.path = '.claude' OR c.path GLOB '*/.claude'\n"
    + "        OR c.path = '.claude/rules' OR c.path GLOB '*/.claude/rules'\n"
    + "        OR c.path GLOB '.claude/rules/*' OR c.path GLOB '*/.claude/rules/*')",
  run: runClaudeRuleLinkUnchecked,
};

/**
 * The DEFAULT check set, in the order it runs.
 *
 * 🔑 **It is a constant in the pipeline, never a default in the config object.**
 * An absent `vibe-agent-toolkit.config.yaml` parses to `undefined`, so a default
 * folded into the parsed config would vanish for exactly the projects the
 * category exists for — *"'default-on error' is meaningless as a category if
 * being default-on requires a config file to say so."* The command reads this
 * list and merges the project's declared checks onto it.
 */
export const BUILTIN_CHECKS: readonly BuiltinCheck[] = [
  CLAUDE_RULE_GLOB_INERT_CHECK,
  CLAUDE_RULE_FRONTMATTER_INVALID_CHECK,
  CLAUDE_RULE_LINK_UNCHECKED_CHECK,
];

/** Every built-in's name, for a `--check` guard and for an operator-facing list. */
export const BUILTIN_CHECK_NAMES: readonly string[] = BUILTIN_CHECKS.map((check) => check.name);

/**
 * Bind the default set to one projection.
 *
 * Here rather than in the CLI so the command keeps knowing nothing about the row
 * model: it receives named thunks, runs them, and prices them exactly as it
 * prices a statement.
 *
 * @param input - The rows every built-in will read
 * @returns One bound check per built-in, in {@link BUILTIN_CHECKS} order
 */
export function bindBuiltinChecks(input: BuiltinCheckInput): readonly BoundBuiltinCheck[] {
  return BUILTIN_CHECKS.map((check) => ({ name: check.name, run: () => check.run(input) }));
}

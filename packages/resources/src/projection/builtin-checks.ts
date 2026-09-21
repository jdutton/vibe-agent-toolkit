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
 */

import { createRegistryIssue, type ValidationIssue } from '@vibe-agent-toolkit/schema';

import type { ClaudeRulePatternRow } from '../schemas/projection-claude-rules.js';
import type { ResourceRealizationRow } from '../schemas/projection-resources.js';

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
  readonly resourceRealizations: readonly Pick<ResourceRealizationRow, 'resourceId' | 'path'>[];
}

/** One default-on assertion over the projection's row model. */
export interface BuiltinCheck {
  /** The operator's handle: what `--check <name>` takes, and what `checks[]` publishes. */
  readonly name: string;
  /** What it asserts, in one line — the built-in's answer to a declared check's `description`. */
  readonly description: string;
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

/**
 * What one dead glob says to its author.
 *
 * The pattern is quoted VERBATIM and never normalised: VAT reports the glob and
 * never rewrites it, so the text here is what the author can grep for in the
 * file the finding names.
 *
 * @param row - The inert pattern
 * @param file - The rules file, when it is known
 * @returns The message
 */
function inertMessage(row: ClaudeRulePatternRow, file: string | undefined): string {
  const where = file ?? 'the rules file that declares it';
  // ⛔ "that VAT can see", not "in this tree". The corpus declines every path
  // git ignores, and the harness reads the filesystem — so for a glob scoped to
  // `dist/**` the unqualified claim was false, and the fix text below would have
  // had the author delete a glob that fires.
  return `The paths: glob "${row.pattern}" (entry ${row.ordinal} of ${where}) matches no file VAT`
    + ' can see in this tree (tracked, or untracked and not gitignored), so no such file can load the'
    + ' rule it scopes.';
}

/**
 * Every `paths:` glob that matches nothing.
 *
 * ## ⭐ `unevaluated` and `gitignored` are not violations, and that is the whole design
 *
 * Of the four statuses only `inert` is a defect. `matched` is the healthy case;
 * `unevaluated` means the matcher was NEVER RUN — a rule whose `paths:` list
 * blows the vendor's shared expansion budget is used unexpanded by the harness
 * and skipped here — so reporting it would report VAT's own declined work as the
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
    issues.push(createRegistryIssue('CLAUDE_RULE_GLOB_INERT', inertMessage(row, location), {
      // Spread rather than assigned: under `exactOptionalPropertyTypes` an
      // absent key and one holding `undefined` are different values, and
      // `location` is refined to a project-relative POSIX path or nothing. There
      // is no third state to put a placeholder in.
      ...(location === undefined ? {} : { location }),
      // The glob's slot in its own `paths:` list. `line` would be the lie: the
      // ordinal is an index into a YAML sequence, not a line number, and the row
      // model carries no line.
      field: `paths[${row.ordinal}]`,
    }));
  }

  return issues;
}

/** The dead-`paths:`-glob check. Exported by name so a test can drive one check. */
export const CLAUDE_RULE_GLOB_INERT_CHECK: BuiltinCheck = {
  name: 'claude-rule-glob-inert',
  description: 'Every paths: glob in .claude/rules/ matches at least one file in the tree',
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
 * The DEFAULT check set, in the order it runs.
 *
 * 🔑 **It is a constant in the pipeline, never a default in the config object.**
 * An absent `vibe-agent-toolkit.config.yaml` parses to `undefined`, so a default
 * folded into the parsed config would vanish for exactly the projects the
 * category exists for — *"'default-on error' is meaningless as a category if
 * being default-on requires a config file to say so."* The command reads this
 * list and merges the project's declared checks onto it.
 */
export const BUILTIN_CHECKS: readonly BuiltinCheck[] = [CLAUDE_RULE_GLOB_INERT_CHECK];

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

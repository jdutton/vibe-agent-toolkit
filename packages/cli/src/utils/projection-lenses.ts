/**
 * Which lenses a run evaluates, and when it does NOT — the selection that keeps
 * the derived relations affordable.
 *
 * 🚨 **The selector over-selects on purpose: a FALSE NEGATIVE is a wrong
 * answer.** A lens skipped when its relation is named answers from an empty
 * table, which is indistinguishable from a healthy tree. The cost that forced
 * the selection, the three rules that keep it fail-safe, and why the registry
 * lives in the CLI rather than in a population are in
 * `docs/architecture/zones.md` §2, "A lens is evaluated only when a statement
 * names one of its relations".
 */

import { DERIVED_TABLES, type DerivedTableName, type PopulationCache, type Projection } from '@vibe-agent-toolkit/resources';

import { evaluateClaudeContextLens } from './claude-context-lens.js';
import { evaluateAuthoredLenses } from './edge-lens-evaluation.js';
import type { Logger } from './logger.js';

/**
 * The rows one lens evaluation produced, keyed by `DERIVED_TABLES`' own keys.
 *
 * Structurally `projection-sqlite`'s `DerivedRows`, spelled here so every lens
 * states its output in terms of the RELATION REGISTRY rather than of a storage
 * backend. `writeDerived` accepts it unchanged.
 */
export type LensRows = {
  readonly [Name in DerivedTableName]?: readonly Record<string, unknown>[];
};

/** Everything a lens may read while evaluating. */
export interface LensEvaluationInput {
  /** The resources-lane projection the run already populated. */
  readonly projection: Projection;
  /** Absolute corpus root, for a lens that must populate a lane of its own. */
  readonly root: string;
  /** Where a lens's own blob-stage refusals go — stderr. */
  readonly logger: Logger;
  /** The run's projection store, so a lens's own population can hit it. */
  readonly cache: PopulationCache | undefined;
}

/** One lens: the relations it owns, and how to produce their rows. */
export interface ProjectionLens {
  /** How the lens names itself in `lensesEvaluated` and in a refusal. */
  readonly name: string;
  /**
   * Every relation this lens produces, by registry key.
   *
   * ⛔ Disjoint from every other lens's. Two lenses claiming one relation would
   * make "was it evaluated" unanswerable, and the second `writeDerived` would
   * CLEAR the first's rows — `writeDerived` replaces a relation's contents.
   */
  readonly relations: readonly DerivedTableName[];
  /**
   * Produce the rows.
   *
   * @param input - The projection, the root, and the run's oracles
   * @returns Every relation this lens owns — all of them, every time, because
   *   omitting one leaves its previous contents in place
   */
  readonly evaluate: (input: LensEvaluationInput) => Promise<LensRows> | LensRows;
}

/** The authored-link lens: `lens_contexts`, `edges`, `edge_resolutions`. */
export const AUTHORED_LINK_LENS: ProjectionLens = {
  name: 'authored-link',
  relations: ['lensContexts', 'edges', 'edgeResolutions'],
  evaluate: ({ projection }) => evaluateAuthoredLenses(projection),
};

/** The always-loaded context lens: `claude_context_chains`, `claude_context_loads`. */
export const CLAUDE_CONTEXT_LENS: ProjectionLens = {
  name: 'claude-context',
  relations: ['claudeContextChains', 'claudeContextLoads'],
  evaluate: ({ root, logger, cache }) => evaluateClaudeContextLens({ root, logger, cache }),
};

/** Every lens the query lane can evaluate, in evaluation order. */
export const PROJECTION_LENSES: readonly ProjectionLens[] = [
  AUTHORED_LINK_LENS,
  CLAUDE_CONTEXT_LENS,
];

/**
 * The SQL names of a lens's relations. Read off `DERIVED_TABLES` rather than
 * restated: the SQL name and the registry key are deliberately different
 * vocabularies (`edgeResolutions` is spelled `edge_resolutions`), so a second
 * copy here would be a rename waiting to be missed.
 *
 * @param lens - The lens
 * @returns Its relations as SQL spells them
 */
export function lensRelationNames(lens: ProjectionLens): readonly string[] {
  return lens.relations.map((name) => DERIVED_TABLES[name].name);
}

/**
 * The lenses a run has to evaluate, given the statements it declared.
 *
 * @param statements - Every statement the run may ask, or `undefined` when the
 *   caller cannot enumerate them. ⛔ `undefined` selects EVERY lens — see the
 *   header on why the fail-safe direction is not negotiable
 * @returns The lenses to evaluate, in {@link PROJECTION_LENSES} order
 */
export function lensesNamedBy(statements: readonly string[] | undefined): readonly ProjectionLens[] {
  if (statements === undefined) return PROJECTION_LENSES;
  const readable = statements.map((sql) => wordsIn(withoutCommentsAndLiterals(sql)));
  return PROJECTION_LENSES.filter((lens) =>
    lensRelationNames(lens).some((relation) =>
      readable.some((words) => namesRelation(words, relation))));
}

/**
 * The relations a statement reaches for that none of `evaluated` produced.
 *
 * 🔑 The guard that turns this selection into an optimisation rather than a
 * silent narrowing. A statement naming `edges` on a run where the authored-link
 * lens was not evaluated must FAIL, not return zero rows: an empty relation and
 * a tree with no links are the same result set.
 *
 * @param sql - The statement about to run
 * @param evaluated - The lenses this run evaluated
 * @returns The relation names it names that nothing filled, in registry order
 */
export function unevaluatedRelationsNamed(
  sql: string,
  evaluated: readonly ProjectionLens[],
): readonly string[] {
  const words = wordsIn(withoutCommentsAndLiterals(sql));
  const filled = new Set(evaluated.flatMap((lens) => lensRelationNames(lens)));
  return PROJECTION_LENSES
    .flatMap((lens) => lensRelationNames(lens))
    .filter((relation) => !filled.has(relation) && namesRelation(words, relation));
}

/**
 * Evaluate one lens and hand back its rows — a one-line indirection so the lane
 * has a single `await` per lens and no lens has to decide whether it is async.
 *
 * @param lens - The lens
 * @param input - What it may read
 * @returns Its rows
 */
export async function evaluateLens(
  lens: ProjectionLens,
  input: LensEvaluationInput,
): Promise<LensRows> {
  return lens.evaluate(input);
}

/**
 * Blank out the parts of a statement that cannot name a table: line comments,
 * block comments and single-quoted string literals. Quoted IDENTIFIERS
 * (`"edges"`, `[edges]`, backticked) are deliberately left alone — those ARE
 * table references, spelled differently. Replaced with spaces rather than
 * removed, so a block comment between `FROM` and `edges` cannot let the two run
 * together.
 *
 * @param sql - The statement
 * @returns The statement with every non-code span blanked
 */
function withoutCommentsAndLiterals(sql: string): string {
  return sql.replaceAll(NON_CODE_SPANS, (span) => ' '.repeat(span.length));
}

/**
 * Line comments, block comments and single-quoted literals, in one alternation.
 *
 * ⚠️ Ordered so a comment marker inside a literal loses to the literal and a
 * quote inside a comment loses to the comment — one pass with this ordering is
 * what makes the two mutually exclusive. `''` is SQL's escaped quote and is
 * matched by the repetition, so `'it''s'` is consumed whole.
 */
const NON_CODE_SPANS = /--[^\n]*|\/\*[\s\S]*?\*\/|'(?:[^']|'')*'/g;

/**
 * Every whole word in a statement, lowercased.
 *
 * Relation names are `[a-z_]` only and `_` is a word character, so membership in
 * this set answers exactly what a `\b`-anchored search would: `my_edges`
 * tokenizes whole and never answers for `edges`. One pass per statement, rather
 * than one pattern per relation, and no `RegExp` built from a variable.
 *
 * @param sql - The statement, already stripped of comments and literals
 * @returns Its identifier-character runs, lowercased
 */
function wordsIn(sql: string): ReadonlySet<string> {
  return new Set((sql.match(IDENTIFIER_RUNS) ?? []).map((word) => word.toLowerCase()));
}

/** Runs of identifier characters — SQL's word boundaries, the `\b` equivalent. */
const IDENTIFIER_RUNS = /[a-z0-9_]+/gi;

/**
 * Does a statement's word set name this relation?
 *
 * Case-folds the relation as well as the words: a registry name spelled with an
 * uppercase letter would otherwise miss every statement silently.
 *
 * @param words - The statement's words, from {@link wordsIn}
 * @param relation - The relation's SQL name
 * @returns True when the statement could be reading that relation
 */
function namesRelation(words: ReadonlySet<string>, relation: string): boolean {
  return words.has(relation.toLowerCase());
}

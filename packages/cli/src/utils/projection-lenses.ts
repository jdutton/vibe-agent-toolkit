/**
 * Which lenses a run evaluates, and when it does NOT — the selection that keeps
 * the derived relations affordable.
 *
 * 🚨 **The selector over-selects on purpose: a FALSE NEGATIVE fails a run that
 * had an answer.** A lens skipped when its relation is named leaves that
 * relation ABSENT from the run's database, so the statement is refused with
 * `no such table` — loud rather than wrong, because the refusal is SQLite's and
 * does not depend on this scan. The cost that forced the selection, the rules
 * that keep it fail-safe, and why the registry lives in the CLI rather than in a
 * population are in
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
 * Evaluate one lens and hand back its rows, refusing any that are not exactly
 * the relations it declares.
 *
 * `LensRows` makes every relation optional, so a lens that forgot one compiles —
 * and `writeDerived` would leave that relation empty, a table that reads as a
 * healthy tree. Checked here because this is the one place every lens passes.
 *
 * @param lens - The lens
 * @param input - What it may read
 * @returns Its rows
 * @throws Error When the rows omit a declared relation or carry an undeclared one
 */
export async function evaluateLens(
  lens: ProjectionLens,
  input: LensEvaluationInput,
): Promise<LensRows> {
  const rows = await lens.evaluate(input);
  const declared: readonly string[] = lens.relations;
  const missing = declared.filter((name) => !Object.hasOwn(rows, name));
  const undeclared = Object.keys(rows).filter((name) => !declared.includes(name));
  if (missing.length > 0 || undeclared.length > 0) {
    throw new Error(
      `Lens "${lens.name}" must produce exactly [${declared.join(', ')}];`
      + ` missing [${missing.join(', ')}], undeclared [${undeclared.join(', ')}]`,
    );
  }
  return rows;
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
  let out = '';
  let index = 0;
  while (index < sql.length) {
    const end = spanEnd(sql, index);
    if (end === undefined) {
      out += sql.charAt(index);
      index += 1;
      continue;
    }
    const span = sql.slice(index, end);
    out += QUOTED_IDENTIFIER_CLOSERS.has(span.charAt(0)) ? span : ' '.repeat(span.length);
    index = end;
  }
  return out;
}

/** The characters that open a quoted identifier, and the one that closes each. */
const QUOTED_IDENTIFIER_CLOSERS: ReadonlyMap<string, string> = new Map([['"', '"'], ['[', ']'], ['`', '`']]);

/** Every quoted span's opener and closer: the identifiers, plus `'` for a literal. */
const QUOTE_CLOSERS: ReadonlyMap<string, string> = new Map([...QUOTED_IDENTIFIER_CLOSERS, ["'", "'"]]);

/**
 * Where a span starting at `start` ends: a line comment, a block comment, a
 * single-quoted literal — or a quoted IDENTIFIER, consumed only so it can be
 * handed back unblanked.
 *
 * ⛔ Quoted identifiers MUST be consumed by this same scan even though their
 * contents stay code, and the reason is the whole of this function. SQLite gives
 * `'`, `--` and `/*` no meaning inside `"…"`, `[…]` or `` `…` ``. A scanner that
 * skips those spans lets a character inside one open a literal or a comment that
 * SQLite never opened, desynchronises, and blanks a span of REAL SQL — taking the
 * relation name with it. The statement then reads an EMPTY relation and answers 0
 * instead of being refused, which for a declared check is a silent exit 0: a gate
 * that cannot fail.
 *
 * Scanning left to right is what keeps the spans mutually exclusive: a comment
 * marker inside a literal is never looked at, nor a quote inside a comment.
 *
 * @param sql - The statement
 * @param start - Where to look
 * @returns The index just past the span, or undefined when none opens here
 */
function spanEnd(sql: string, start: number): number | undefined {
  const pair = sql.slice(start, start + 2);
  if (pair === '--') {
    const newline = sql.indexOf('\n', start);
    return newline === -1 ? sql.length : newline;
  }
  if (pair === '/*') {
    const close = sql.indexOf('*/', start + 2);
    return close === -1 ? undefined : close + 2;
  }
  const closer = QUOTE_CLOSERS.get(sql.charAt(start));
  return closer === undefined ? undefined : quotedEnd(sql, start, closer);
}

/**
 * Where a quoted span ends. A doubled closer (`''`, `""`, two backticks) is an
 * escaped one; `[…]` has no escape. Left unterminated, the span ends at the last
 * doubled closer instead — what the single pattern this replaced did by
 * backtracking.
 *
 * @param sql - The statement
 * @param start - The opening quote
 * @param closer - The character that closes it
 * @returns The index just past the span, or undefined when it never closes
 */
function quotedEnd(sql: string, start: number, closer: string): number | undefined {
  let fallback: number | undefined;
  let from = start + 1;
  for (;;) {
    const close = sql.indexOf(closer, from);
    if (close === -1) return fallback;
    if (closer === ']' || sql.charAt(close + 1) !== closer) return close + 1;
    fallback = close + 1;
    from = close + 2;
  }
}

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

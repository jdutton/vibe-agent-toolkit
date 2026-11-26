/**
 * Which lenses a run evaluates, and when it does NOT — the selection that keeps
 * the derived relations affordable.
 *
 * 🚨 **The selector over-selects on purpose: a FALSE NEGATIVE fails a run that
 * had an answer.** A relation the scan misses — a projection table not hydrated,
 * or a lens skipped — is ABSENT from the run's database, so the statement is
 * refused with `no such table` — loud rather than wrong, because the refusal is
 * SQLite's and does not depend on this scan. The cost that forced the selection, the rules
 * that keep it fail-safe, and why the registry lives in the CLI rather than in a
 * population are in
 * `docs/architecture/zones.md` §2, "A lens is evaluated only when a statement
 * names one of its relations".
 */

import {
  dataDemandOf,
  DERIVED_TABLES,
  queryableRelationNames,
  relationsNamedBy,
  rootlessPathRelations,
  storedRelationSpecs,
  type DataDemand,
  type DerivedTableName,
  type PopulationCache,
  type PopulationOutcome,
  type PopulationRun,
  type LensRefusalCode,
  type QueryProjection,
} from '@vibe-agent-toolkit/resources';

import { evaluateChangedFilesLens } from './changed-files-lens.js';
import { evaluateClaudeContextLens } from './claude-context-lens.js';
import { evaluateAuthoredLenses } from './edge-lens-evaluation.js';
import type { LensPopulation } from './lens-population.js';
import type { Logger } from './logger.js';

/**
 * The rows one lens evaluation produced, keyed by `DERIVED_TABLES`' own keys.
 *
 * Structurally what `RunDatabase.writeDerived` takes, spelled here so every
 * lens states its output in terms of the RELATION REGISTRY rather than of a
 * storage backend. `writeDerived` accepts it unchanged.
 */
export type LensRows = {
  readonly [Name in DerivedTableName]?: readonly Record<string, unknown>[];
};

/**
 * What one lens evaluation produced: its rows, and where its OWN population came
 * from — `null` for a lens that populated nothing (it read the run's projection).
 * Required, so a lens that populates cannot leave its provenance unstated.
 */
export interface LensEvaluation {
  readonly rows: LensRows;
  readonly population: PopulationOutcome['population'] | null;
}

/**
 * A lens that could not answer, and why. 🚨 Its relations stay ABSENT, never
 * empty: written as `[]`, a check over them could never fail.
 */
export interface LensRefusal {
  readonly refused: string;
  /** Whose fault, as the refusal a statement reading the relation is published under. */
  readonly refusal: LensRefusalCode;
}

/** What evaluating one lens produced: its rows, or why it has none. */
export type LensOutcome = LensEvaluation | LensRefusal;

/**
 * A run's {@link LensPopulation} from each evaluated lens's own population.
 *
 * @param populations - Each evaluated lens's `population`, in evaluation order
 * @returns The run's lens provenance
 */
export function lensPopulationOf(populations: readonly LensEvaluation['population'][]): LensPopulation {
  const populated = populations.filter((population) => population !== null);
  if (populated.length === 0) return 'none';
  return populated.every((population) => population === 'store') ? 'store' : 'derived';
}

/** Everything a lens may read while evaluating. */
export interface LensEvaluationInput {
  /** The resources-lane projection the run already populated: AST references only (`QueryProjection`). */
  readonly projection: QueryProjection;
  /** Absolute corpus root, for a lens that must populate a lane of its own. */
  readonly root: string;
  /** The run's `--base` ref, or undefined. Only the changed-files lens reads it. */
  readonly base: string | undefined;
  /** The run's projection store, so a lens's own population can hit it. */
  readonly cache: PopulationCache | undefined;
  /** The run's population run, so a lens's own population reads and parses through the run's. */
  readonly populationRun: PopulationRun;
  /** Where a lens that populates reports its own population's refused content. */
  readonly logger: Logger;
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
   *   omitting one leaves its previous contents in place — and where its own
   *   population came from; or a {@link LensRefusal} when it cannot answer
   */
  readonly evaluate: (input: LensEvaluationInput) => Promise<LensOutcome> | LensOutcome;
}

/** The authored-link lens: `lens_contexts`, `edges`, `edge_resolutions`. */
export const AUTHORED_LINK_LENS: ProjectionLens = {
  name: 'authored-link',
  relations: ['lensContexts', 'edges', 'edgeResolutions'],
  evaluate: ({ projection }) => ({ rows: evaluateAuthoredLenses(projection), population: null }),
};

/** The always-loaded context lens: `claude_context_chains`, `claude_context_loads`. */
export const CLAUDE_CONTEXT_LENS: ProjectionLens = {
  name: 'claude-context',
  relations: ['claudeContextChains', 'claudeContextLoads'],
  evaluate: ({ root, populationRun, cache, logger }) => evaluateClaudeContextLens({ root, run: populationRun, cache, logger }),
};

/** What changed under the root since the run's `--base`: `changed_files`. Refuses without a base. */
export const CHANGED_FILES_LENS: ProjectionLens = {
  name: 'changed-files',
  relations: ['changedFiles'],
  evaluate: ({ root, base }) => evaluateChangedFilesLens(root, base),
};

/** Every lens the query lane can evaluate, in evaluation order. */
export const PROJECTION_LENSES: readonly ProjectionLens[] = [
  AUTHORED_LINK_LENS,
  CLAUDE_CONTEXT_LENS,
  CHANGED_FILES_LENS,
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

/** Every stored relation (projection and row-set tables), by SQL name, in registry order: what hydration fills. */
const BASE_RELATIONS: readonly string[] = storedRelationSpecs().map((spec) => spec.name);

/** Why a relation is withheld in a run holding more than one root. */
const ROOTLESS_REASON = 'it has a root-relative path column and no `root` column, and this run holds more than one root,'
  + ' so a row could not say which root its path is under';

/**
 * What one run hydrates and evaluates, decided from the statements it declared — and what it
 * withholds.
 */
export interface HydrationPlan {
  /** The stored relations to hydrate, by SQL name, in registry order. Lens and data relations add none. */
  readonly relations: readonly string[];
  /** The lenses to evaluate, in {@link PROJECTION_LENSES} order. */
  readonly lenses: readonly ProjectionLens[];
  /** The relations the statements name that this run will not hold, by SQL name, each with why. */
  readonly withheld: ReadonlyMap<string, string>;
  /**
   * What the statements demand of the `data` instance, or `undefined` when they name none of its
   * relations: then the data stage does not run, and the run reads nothing of the row-set tier.
   */
  readonly data: DataDemand | undefined;
}

/**
 * Plan one run's run database from the statements it declared.
 *
 * - **Relations**: the projection tables some statement names, by the scan the SQL gate also reads
 *   (`relationsNamedBy`, from `resources`), so a statement can read only a relation it names
 *   itself — never one hydrated because another statement named it. A lens relation adds none: no lens reads the run database —
 *   each reads the in-memory projection, its own lane or git — and a statement joining a lens
 *   relation to a table names both.
 * - **Lenses**: those owning a relation some statement names.
 * - **Data**: the `data` instance's demand, when some statement names a row-set table or a derived
 *   `data__*` relation (`dataDemandOf`). The named row-set tables hydrate like any stored relation.
 * - **Withheld**, in a run holding more than one root: every named relation with a root-relative
 *   path column and no `root` column (`rootlessPathRelations`), and every relation of a lens that
 *   owns one, since that lens is not evaluated. ⚠️ Transitional, until relations carry `root`.
 *
 * The scan over-selects on purpose (see the header); a relation it misses is ABSENT from the run
 * database, so the statement is refused by SQLite rather than answered from an empty table.
 *
 * @param input - The run
 * @param input.statements - Every statement the run may ask
 * @param input.roots - The run's root rows
 * @returns The plan
 */
export function planHydration(input: { readonly statements: readonly string[]; readonly roots: readonly unknown[] }): HydrationPlan {
  const named = namedRelations(input.statements);
  const rootless: ReadonlySet<string> = input.roots.length > 1 ? new Set(rootlessPathRelations()) : new Set();
  const withheld = new Map<string, string>();
  for (const name of named) {
    if (rootless.has(name)) withheld.set(name, ROOTLESS_REASON);
  }
  const lenses = PROJECTION_LENSES.filter((lens) => {
    const owned = lensRelationNames(lens);
    if (!owned.some((name) => named.has(name))) return false;
    const blocking = owned.find((name) => rootless.has(name));
    if (blocking === undefined) return true;
    for (const name of owned) {
      if (named.has(name) && !withheld.has(name)) {
        withheld.set(name, `its lens is not evaluated, because it also produces ${blocking}, which is withheld: ${ROOTLESS_REASON}`);
      }
    }
    return false;
  });
  return {
    relations: BASE_RELATIONS.filter((name) => named.has(name) && !withheld.has(name)),
    lenses,
    withheld,
    data: dataDemandOf(named),
  };
}

/**
 * Every queryable relation some statement names, by the scan the SQL gate also reads.
 *
 * @param statements - The statements
 * @returns The relations they name, by SQL name
 */
function namedRelations(statements: readonly string[]): ReadonlySet<string> {
  return new Set(statements.flatMap((sql) => relationsNamedBy(sql, queryableRelationNames())));
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
 * @returns Its rows and its own population's provenance, or its refusal
 * @throws Error When the rows omit a declared relation or carry an undeclared one
 */
export async function evaluateLens(
  lens: ProjectionLens,
  input: LensEvaluationInput,
): Promise<LensOutcome> {
  const evaluation = await lens.evaluate(input);
  if ('refused' in evaluation) return evaluation;
  const { rows } = evaluation;
  const declared: readonly string[] = lens.relations;
  const missing = declared.filter((name) => !Object.hasOwn(rows, name));
  const undeclared = Object.keys(rows).filter((name) => !declared.includes(name));
  if (missing.length > 0 || undeclared.length > 0) {
    throw new Error(
      `Lens "${lens.name}" must produce exactly [${declared.join(', ')}];`
      + ` missing [${missing.join(', ')}], undeclared [${undeclared.join(', ')}]`,
    );
  }
  return evaluation;
}

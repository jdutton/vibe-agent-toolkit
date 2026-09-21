/**
 * The instruction chain as RELATIONS — what Claude Code loads at each working
 * location, in a shape an adopter can select from.
 *
 * ⛔ **`claude_context_chains` and `claude_context_loads` are DERIVED, not
 * materialised**: nothing populates them, they are `whatLoadsAt` run once per
 * instruction chain over a projection that already exists.
 *
 * 🚨 **An unrealized representative produces NO rows**, rather than a chain with
 * an empty load list — an empty list is an answer, and conflating it with "VAT
 * never looked" is the confident-zero failure this lane refuses everywhere else.
 *
 * No threshold and no verdict live here or anywhere in VAT: the rows are the
 * facts, and what counts as too much is the adopter's `resources.checks` to say.
 * Why the rows are keyed per CHAIN rather than per location, and the join
 * fan-out a statement over them must avoid: `docs/architecture/zones.md` §2,
 * "The two claude-context relations, and the rules they carry".
 */

import type {
  ClaudeContextAdmissionKind,
  ClaudeContextChainRow,
  ClaudeContextLoadRow,
} from '../schemas/projection-claude-context.js';

import { account, type AccountedRow } from './claude-context-accounting.js';
import { admissionLoadsAtLaunch, launchCharge } from './claude-context-launch-charge.js';
import type { Admission } from './claude-context-query.js';
import { whatLoadsAt } from './claude-context-query.js';
import { claudeMdIdentities, contextRegions } from './claude-context-regions.js';
import type { Projection } from './projection.js';

/**
 * One instruction chain: the locations that pay it, and what it loads.
 *
 * The intermediate `claudeContextRelations` flattens into the two relations SQL
 * sees.
 *
 * ⚠️ `loads` is the REPRESENTATIVE's answer. Its always-loaded rows hold for
 * every location in the chain — that is the collapse `claude-context-regions.ts`
 * owns — but its on-demand rows do not: a path-scoped rule is admitted to a
 * directory query only when a file under THAT directory matches, so a
 * region-mate's on-demand set can differ. The `chain-on-demand-is-representative`
 * stated limit says so wherever these rows are published.
 */
interface ContextChain {
  /** The chain's id — {@link ClaudeContextChainRow.chainId}. */
  readonly chainId: string;
  /** The instructed directory whose chain this is. `''` is the corpus root. */
  readonly representative: string;
  /** Every working location that inherits it, including the representative. */
  readonly locations: readonly string[];
  /**
   * The chain's loaded rows, or `null` when the representative is a path this
   * projection never realized.
   *
   * ⛔ `null`, never `[]`. See the module header: an empty list is an answer and
   * this is the absence of one.
   */
  readonly loads: readonly ClaudeContextLoadRow[] | null;
}

/** The two relations, keyed by `DERIVED_TABLES`' own keys. */
export interface ClaudeContextRelations {
  readonly claudeContextChains: readonly ClaudeContextChainRow[];
  readonly claudeContextLoads: readonly ClaudeContextLoadRow[];
}

/** The prefix a chain id carries, so an id is recognisable in a result set. */
const CHAIN_ID_PREFIX = 'chain-';

/**
 * The chain id for one representative.
 *
 * Derived from the representative rather than minted, for the same reason
 * `authoredLensId` is: the same tree produces the same id on every run, so a
 * `WHERE chainId = …` is writable by hand and a diff across runs shows real
 * movement. ⛔ It is NOT a digest, and a reader is not expected to parse it —
 * `claude_context_chains.representative` carries the representative as a column
 * precisely so nobody has to strip this prefix (the corpus root's representative
 * is `''`, which no prefix strip recovers legibly).
 *
 * @param representative - The instructed directory whose chain this is
 * @returns The chain's id
 */
export function contextChainId(representative: string): string {
  return `${CHAIN_ID_PREFIX}${representative}`;
}

/**
 * Every instruction chain in a tree, with what each loads.
 *
 * ⚠️ Issues exactly ONE `whatLoadsAt` per chain — the collapse
 * `claude-context-regions.ts` computes — not one per working location. On the
 * adopter tree that is 9 queries instead of 589.
 *
 * @param projection - A populated projection from `buildClaudeContextPopulation`
 * @returns One entry per distinct chain, in `contextRegions` order
 */
function contextChains(projection: Projection): readonly ContextChain[] {
  const claudeMdIds = claudeMdIdentities(projection);

  return contextRegions(projection).map((region) => {
    const chainId = contextChainId(region.representative);
    const answer = whatLoadsAt(projection, region.representative);
    return {
      chainId,
      representative: region.representative,
      locations: region.locations,
      loads:
        answer.kind === 'answer'
          ? account(answer, claudeMdIds).rows.map((row) => loadRow(chainId, row))
          : null,
    };
  });
}

/**
 * Flatten a tree's chains into the two derived relations.
 *
 * @param projection - A populated projection from `buildClaudeContextPopulation`
 * @returns The rows, ready for `writeDerived`
 */
export function claudeContextRelations(projection: Projection): ClaudeContextRelations {
  const chains: ClaudeContextChainRow[] = [];
  const loads: ClaudeContextLoadRow[] = [];

  for (const chain of contextChains(projection)) {
    // ⛔ Both relations skip an unknown chain, together. Emitting the chain rows
    // without the loads would publish a chain that appears to load nothing.
    if (chain.loads === null) continue;
    for (const directory of chain.locations) {
      chains.push({ chainId: chain.chainId, directory, representative: chain.representative });
    }
    loads.push(...chain.loads);
  }

  return { claudeContextChains: chains, claudeContextLoads: loads };
}

/**
 * One accounted row as a `claude_context_loads` row.
 *
 * @param chainId - The chain this row is loaded for
 * @param row - The accounted row
 * @returns The relation row
 */
function loadRow(chainId: string, row: AccountedRow): ClaudeContextLoadRow {
  const deciding = decidingAdmission(row.admissions);
  return {
    chainId,
    resourceId: row.resourceId,
    path: row.path,
    loadClass: row.loadClass,
    admissionKind: (deciding?.kind satisfies ClaudeContextAdmissionKind | undefined) ?? null,
    pattern: deciding === undefined ? null : admissionPattern(deciding),
    depth: deciding?.kind === 'import' ? deciding.depth : null,
    admissionCount: row.admissions.length,
    sizeCliff: row.sizeCliff,
    launchCharge: launchCharge(row),
    tokens: row.tokens,
    bytes: row.bytes,
  };
}

/**
 * The admission whose kind the row is reported under.
 *
 * 🔑 The first admission that CAN load at launch, falling back to the first of
 * any kind. A row carries several — a rules file that is also an ancestry member
 * is ordinary — and one row per admission would make every `SUM(tokens)`
 * double-count exactly the diamond `whatLoadsAt` dedupes by identity to avoid.
 * Preferring a launch-time kind is what keeps `admissionKind` consistent with
 * the `launchCharge` stored beside it: a charged row never names a path-scoped
 * rule. ⚠️ Among several `import` admissions the first is shown, which may name
 * an on-demand closure root while an always-loaded one is what charged the row;
 * `admissionCount` says there were more.
 *
 * @param admissions - Every admission the row carries
 * @returns The deciding admission, or undefined when the row carries none
 */
function decidingAdmission(admissions: readonly Admission[]): Admission | undefined {
  return admissions.find(admissionLoadsAtLaunch) ?? admissions[0];
}

/**
 * The deciding admission's distinguishing string.
 *
 * Exhaustive over the {@link Admission} union by construction — a kind added
 * later fails to compile here rather than silently storing `null`, which is the
 * difference between "this kind has no selector" and "nobody taught this
 * function about it". `ClaudeContextLoadRowSchema` carries the table of what
 * each kind puts here.
 *
 * @param admission - The deciding admission
 * @returns Its selector, or null for a kind that has none
 */
function admissionPattern(admission: Admission): string | null {
  switch (admission.kind) {
    case 'ancestry': {
      return admission.dir;
    }
    case 'root-rule': {
      return null;
    }
    case 'nested-rule': {
      return admission.under;
    }
    case 'glob-rule':
    case 'glob-rule-covers-dir':
    case 'glob-rule-may-fire': {
      return admission.pattern;
    }
    case 'import': {
      return admission.rootPath;
    }
  }
}

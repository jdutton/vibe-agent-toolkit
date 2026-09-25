/**
 * What a harness can REACH in a projection — the only blobs whose harness
 * facts are ever derived.
 *
 * The facts (`harness_blob_facts`, `harness_blob_imports`) cost a markdown lex
 * per blob, and nearly every blob in a real tree is a source file no loader
 * ever opens. So they are derived lazily, for the reachable set only, by the
 * harness pass (`harness-pass.ts`), which asks this module for the
 * {@link harnessFrontier} — the reached blobs that have no facts yet — until
 * there is none.
 *
 * ## Reach is a SUPERSET of every strict reader's demand
 *
 * Every reader outside the closure fixpoint reads a reached blob's facts
 * STRICTLY (`requireFacts`/`requireImports` throw `HarnessFactsAbsentError`),
 * so reach must cover everything any of them could ask about. Two lanes:
 *
 * 1. **The loader** — every realized path the profile calls an entry point
 *    (`isEntryPoint`, itself a case-insensitive superset), followed through
 *    its own derived imports for `maxImportDepth` hops, breadth-first by
 *    least hop count (a superset of any depth-first load order). It applies
 *    the loader's own gates: a path that is not `isTextPath` is not read, and a
 *    file that injects 0 bytes has none of its imports followed. ⛔ The size
 *    cliff is NOT a gate here: the loader stats an oversize file, and the
 *    launch walk's `prunedBehind` reads its facts and follows its imports to
 *    report what the cliff cost — strictly.
 * 2. **Declared harness-dialect extents** — every `zone_provenance` row whose
 *    `parameterSet` is an extent declaration with `referenceDialect ===
 *    profile.dialect` (the ONE field the dialect travels in — never the
 *    contributor id's prefix, which a user-declared extent does not carry).
 *    Its closure is followed from `closureFrom` to its own declared `maxDepth`
 *    with none of the loader's gates (the closure primitive follows every
 *    realized target, text or not), and every realized member is covered
 *    outright. Following the declaration here, not only the members the
 *    fixpoint has admitted so far, is what lets the fixpoint settle in a pass
 *    or two instead of one iteration per hop.
 *
 * A key with no `blobs` row is never in the frontier: it has no content to
 * have facts OF, and every strict reader already reads it as having none.
 *
 * ## One corpus root
 *
 * Imports resolve against `roots[0]`, the invariant every reader of these
 * tables already relies on (`merge.ts` is the sole `addRoot` caller and adds
 * exactly one); `resolveReferencePath` is the same resolver the closure
 * primitive uses, so reach cannot disagree with it about where an import lands.
 */

import { compareCodeUnits, safePath } from '@vibe-agent-toolkit/utils';

import { type ExtentDeclaration, ExtentDeclarationSchema } from '../../schemas/project-config.js';
import type { BlobRow } from '../../schemas/projection-blobs.js';
import type { ResourceRealizationRow, RootRow } from '../../schemas/projection-resources.js';
import type { ZoneProvenanceRow } from '../../schemas/projection-zones.js';
import { resolveReferencePath } from '../reference-resolution.js';

import { harnessFactsIndex, type HarnessFactsIndex, type HarnessFactsView } from './facts-index.js';
import type { HarnessProfile } from './profile.js';

/** The tables reach reads — satisfied by a `ProjectionBase` and by a built `Projection`. */
export interface HarnessReachView extends HarnessFactsView {
  /** `roots[0]` is the corpus root imports resolve against. */
  readonly roots: readonly RootRow[];
  readonly resourceRealizations: readonly ResourceRealizationRow[];
  /** Which extents are declared in a harness's dialect, and their declarations. */
  readonly zoneProvenance: readonly ZoneProvenanceRow[];
  /** Which content keys have content at all. */
  readonly blobs: readonly BlobRow[];
}

/** One blob the harness reaches whose facts are not derived yet. */
export interface HarnessFrontierEntry {
  readonly contentKey: string;
  /** A root-relative path the blob is realized at — the least in code-unit order among those reached. */
  readonly path: string;
  /** The corpus root's id. */
  readonly rootId: string;
  /** `path` joined to the corpus root — where a reader finds the bytes. */
  readonly absolutePath: string;
}

/** Everything one frontier computation reads, indexed once. */
interface ReachContext {
  readonly profile: HarnessProfile;
  readonly root: RootRow;
  /** Root-relative path → its first non-directory realization. */
  readonly files: ReadonlyMap<string, ResourceRealizationRow>;
  /** Every content key with a `blobs` row. */
  readonly content: ReadonlySet<string>;
  readonly facts: HarnessFactsIndex;
  /** Content key → the least path it was reached at, for the keys with no facts. */
  readonly frontier: Map<string, string>;
}

/** Where a walk starts, and how many hops it may still take from there (`Infinity` for none). */
interface Seed {
  readonly path: string;
  readonly budget: number;
}

/**
 * Keyed blobs the harness can reach whose facts are not derived yet, in
 * content-key order, one entry per key. See the module header for what
 * "reach" is.
 *
 * @param view - The projection (or builder base) so far
 * @param profile - The harness whose reach, and whose facts, to read
 * @returns The frontier; empty when every reached blob is derived
 * @throws When the view realizes paths but carries no root, or carries more
 *   than one — the one-root invariant `merge.ts` guarantees; answering
 *   "nothing reached", or resolving against the wrong root, would be silent
 */
export function harnessFrontier(view: HarnessReachView, profile: HarnessProfile): readonly HarnessFrontierEntry[] {
  const root = view.roots[0];
  if (root === undefined) {
    if (view.resourceRealizations.length === 0) return [];
    throw new Error('harnessFrontier received a projection with realizations and no root; imports resolve against it.');
  }
  // Refused rather than resolved against the first: a realization carries no
  // root of its own, so the others' imports would resolve against a root they
  // are not under, and the facts they need would go silently underived.
  if (view.roots.length > 1) {
    throw new Error(
      `harnessFrontier received a projection with ${view.roots.length} roots; imports resolve against exactly one`
      + ' (`merge.ts` is the sole `addRoot` caller and adds one).',
    );
  }
  const context: ReachContext = {
    profile,
    root,
    files: filesByPath(view.resourceRealizations),
    content: new Set(view.blobs.map((row) => row.contentKey)),
    facts: harnessFactsIndex(view, profile.id),
    frontier: new Map(),
  };
  walk(context, loaderSeeds(context), true);
  walk(context, declaredSeeds(view, context), false);
  return [...context.frontier]
    .sort(([left], [right]) => compareCodeUnits(left, right))
    .map(([contentKey, path]) => ({
      contentKey,
      path,
      rootId: root.id,
      absolutePath: safePath.join(root.path, path),
    }));
}

/**
 * Root-relative path → its first non-directory realization, in base order —
 * the tie-break the closure primitive and the launch walk both apply.
 *
 * @param realizations - Every realization
 * @returns The file index
 */
function filesByPath(realizations: readonly ResourceRealizationRow[]): ReadonlyMap<string, ResourceRealizationRow> {
  const files = new Map<string, ResourceRealizationRow>();
  for (const row of realizations) {
    if (!row.isDirectory && !files.has(row.path)) files.set(row.path, row);
  }
  return files;
}

/**
 * Every realized entry point, with the full import budget.
 *
 * @param context - The frontier computation
 * @returns The loader lane's seeds
 */
function loaderSeeds(context: ReachContext): Seed[] {
  const seeds: Seed[] = [];
  for (const path of context.files.keys()) {
    if (context.profile.isEntryPoint(path)) seeds.push({ path, budget: context.profile.maxImportDepth });
  }
  return seeds;
}

/** Each provenance row's parsed declaration — see {@link declarationOf}. */
const declarationMemo = new WeakMap<ZoneProvenanceRow, ExtentDeclaration | null>();

/**
 * A provenance row's parsed extent declaration, or null when its
 * `parameterSet` is not one — parsed once per ROW, not once per frontier call.
 *
 * The harness pass asks for the frontier every fixpoint iteration, and each
 * call would otherwise re-run the Zod parse over every `zone_provenance` row. Keyed on
 * the row object rather than the array: the provenance table REPLACES a
 * contributor's row in place as its fixpoint re-runs, so an array-plus-length
 * key would serve a replaced row's stale parse, while a new row object is
 * simply a cache miss.
 *
 * @param row - A `zone_provenance` row
 * @returns Its extent declaration, or null
 */
function declarationOf(row: ZoneProvenanceRow): ExtentDeclaration | null {
  const cached = declarationMemo.get(row);
  if (cached !== undefined) return cached;
  const parsed = ExtentDeclarationSchema.safeParse(row.parameterSet);
  const declaration = parsed.success ? parsed.data : null;
  declarationMemo.set(row, declaration);
  return declaration;
}

/**
 * Every declared closure in the profile's dialect — its root with the
 * declared depth budget, and each realized member with none.
 *
 * @param view - The projection so far
 * @param context - The frontier computation
 * @returns The declared lane's seeds
 */
function declaredSeeds(view: HarnessReachView, context: ReachContext): Seed[] {
  const seeds: Seed[] = [];
  const extents = new Set<string>();
  for (const row of view.zoneProvenance) {
    const declaration = declarationOf(row);
    if (declaration?.referenceDialect !== context.profile.dialect) continue;
    extents.add(row.contextId);
    const { closureFrom, maxDepth } = declaration;
    seeds.push({ path: closureFrom, budget: maxDepth === 'full' ? Number.POSITIVE_INFINITY : maxDepth });
  }
  if (extents.size === 0) return seeds;
  for (const row of view.resourceRealizations) {
    if (extents.has(row.extentId)) seeds.push({ path: row.path, budget: 0 });
  }
  return seeds;
}

/**
 * Breadth-first from every seed, keeping the LARGEST budget a path has been
 * reached with — a path reached again with more hops left is walked again,
 * because what lies behind it may now be in budget. Terminates: a path is
 * re-walked only on a strictly larger budget, and no budget exceeds the
 * largest seed's.
 *
 * @param context - The frontier computation, whose `frontier` this fills
 * @param seeds - Where to start
 * @param loader - Apply the loader's gates (text path, zero injection) — true
 *   for the entry-point lane, false for a declared closure
 */
function walk(context: ReachContext, seeds: readonly Seed[], loader: boolean): void {
  const best = new Map<string, number>();
  const queue: Seed[] = [];
  const offer = (path: string, budget: number): void => {
    const known = best.get(path);
    if (known !== undefined && known >= budget) return;
    best.set(path, budget);
    queue.push({ path, budget });
  };
  for (const seed of seeds) offer(seed.path, seed.budget);
  // Iterated rather than `shift()`ed — an array iterator re-reads the length,
  // so entries `offer` appends mid-loop are visited, and a shift is O(n).
  for (const hop of queue) {
    // A stale entry: the path was offered again with more budget, and that entry walks it.
    if (best.get(hop.path) !== hop.budget) continue;
    for (const target of importTargets(context, hop, loader)) offer(target, hop.budget - 1);
  }
}

/**
 * The paths one reached file's imports lead to — or none, recording the file
 * as frontier when its blob has no facts yet.
 *
 * @param context - The frontier computation
 * @param hop - The reached path and its remaining budget
 * @param loader - Apply the loader's gates
 * @returns Root-relative import targets inside the root; realized or not
 */
function importTargets(context: ReachContext, hop: Seed, loader: boolean): string[] {
  const contentKey = context.files.get(hop.path)?.contentKey;
  if (contentKey === undefined || contentKey === null) return [];
  if (loader && !context.profile.isTextPath(hop.path)) return [];
  if (!context.content.has(contentKey)) return [];
  const facts = context.facts.factsOf(contentKey);
  if (facts === undefined) {
    noteFrontier(context, contentKey, hop.path);
    return [];
  }
  if (hop.budget <= 0 || (loader && facts.injectedBytes === 0)) return [];
  const targets: string[] = [];
  for (const entry of context.facts.requireImports(contentKey, hop.path)) {
    const resolved = resolveReferencePath(context.profile.dialect, entry.target, hop.path, context.root.path);
    if (resolved.kind === 'inside-root') targets.push(resolved.path);
  }
  return targets;
}

/**
 * Record a reached blob with no facts, at the least path it was reached at.
 *
 * @param context - The frontier computation
 * @param contentKey - The blob
 * @param path - Where it was reached
 */
function noteFrontier(context: ReachContext, contentKey: string, path: string): void {
  const known = context.frontier.get(contentKey);
  if (known === undefined || compareCodeUnits(path, known) < 0) context.frontier.set(contentKey, path);
}

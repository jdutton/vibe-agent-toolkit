/**
 * The **closure** extent contributor (zones.md §7.3) — the declarative closure
 * primitive, and the only `closure`-stratum contributor VAT ships.
 *
 * A closure extent is *everything reachable from one root document* by following
 * declared reference forms, bounded by a depth and narrowed by globs. That is
 * what a skill bundle is, and it is already spelled once in privileged code:
 * `SkillPackagingConfigSchema`'s `linkFollowDepth` and
 * `excludeReferencesFromBundle` are this primitive in disguise. Generalizing it
 * is what makes §7.3's adequacy test satisfiable — *a built-in extent must be
 * expressible the way a config-declared one would be* — without adding a plugin
 * API, because an {@link ExtentDeclaration} is inert data, never code.
 *
 * ## Identity comes from the constructor; extent SHAPE comes from `parameters`
 *
 * This split is load-bearing, not stylistic.
 *
 * `ContributorRegistry` keys on `id` and partitions by `kind` and `stratum`
 * *before* any `contribute` call happens, so those three cannot come from a
 * runtime argument. They are the constructor's whole job.
 *
 * Everything that shapes the extent — `closureFrom`, `follow`, `maxDepth`,
 * `refusals` — arrives through {@link ClosureExtentContributor.contribute}'s
 * `parameters`, because §7.4 requires `zone_provenance.parameterSet` to be *"the
 * parameters this contributor ran under, verbatim"*. The merge driver resolves
 * one binding per contributor and writes that same binding both into
 * `contribute` and into the provenance row, deliberately, so the two cannot
 * diverge. A declaration hidden in a constructor would leave a provenance row
 * recording `null` while something invisible to it shaped the extent — a
 * provenance row that under-describes its own extent, which is exactly the
 * failure the digest exists to prevent.
 *
 * ## Edges come from the base projection, never from a fresh parse
 *
 * `blob_references` is keyed by **blob**, so the walk goes resource →
 * realization → `contentKey` → reference rows, and resolves each `rawRef`
 * relative to that realization's path. Re-parsing would be a second opinion
 * nothing reconciles, and would make a closure extent's membership depend on
 * whether the file changed since the base was populated.
 *
 * Consequently this contributor performs **no filesystem I/O of its own**: it is
 * a pure function of the base plus the declaration. The one exception is
 * lexical — {@link resolveLocalHref}'s root-absolute branch canonicalizes
 * through `realpath` to decide containment. That is VAT's single href resolver
 * (root `CLAUDE.md`), and writing a parallel path-only one here is precisely the
 * mistake that once bundled a de-linked file.
 *
 * ## Three decisions that look like gaps
 *
 * - **An unresolvable `rawRef` is a condition row, not a member and not an
 *   error.** Broken links exist, and a reference to a file no contributor
 *   enumerated is a fact about the corpus. Counting it as a member would invent
 *   one; dropping it silently would lose the only signal. It becomes a
 *   {@link CLOSURE_REFERENCE_UNRESOLVED} row anchored to the *referring* path,
 *   because that is the file an author can open.
 * - **A reference that LEAVES the root is a different row from one that
 *   resolves to nothing**, and telling them apart needs no oracle — only the
 *   root, which is already in hand. Both are "no realization holds this", and
 *   collapsing them made the useful half unreadable: a path inside the root that
 *   nothing realizes is a defect an author can fix, while a path outside it is a
 *   file the population was never defined over. See
 *   {@link CLOSURE_REFERENCE_OUTSIDE_ROOT}, including the one fact that row
 *   cannot carry.
 * - **A reference back to `closureFrom` is silently skipped.** The root is a
 *   member by declaration, admitted before any traversal, so a self-link has
 *   nothing left to decide: refusing it would contradict the admission, and
 *   holding it at the hop boundary would offer to admit a file that is already
 *   in. This is the one place the primitive records nothing about a resolved,
 *   in-root target, and it is `walk-link-graph.ts`'s own `skipped` verdict.
 * - **References inside a fence or a code span are never followed**, and that is
 *   not configurable. Anthropic documents that `@` import parsing skips code
 *   spans and fenced blocks; a path inside a fence is sample text, not a link.
 *   An AST-derived row is never in either context by construction, so this
 *   filter only ever bites lexer-derived forms — which is exactly where sample
 *   text lives.
 * - **An explicitly named path is admitted even when a refusal rule catches
 *   it.** An explicit declaration outranks a net: `closureFrom` and every entry
 *   in `admitPaths` name the file, whereas a glob, a basename set and a kind set
 *   never did. The same rule decides the `files:` escape hatch in
 *   `walk-link-graph.ts` (`refusesAgentInstructionFile`), which is why
 *   `admitPaths` is matched by exact string equality rather than by prefix — the
 *   explicit-vs-glob distinction is the whole content of the rule.
 * - **A refusal is a condition row carrying the matched rule's LABEL**, not a
 *   silent drop. The label is opaque here — the declaration supplies the
 *   vocabulary, this module only reports it — which is what lets a caller
 *   reproduce a domain cascade's reasons (`navigation-file`,
 *   `directory-target`, …) without the primitive knowing any of them. The row
 *   also carries the refusal's PROVENANCE (which reference, at which line, with
 *   which href, against a target that did or did not exist, by which rule), so a
 *   consumer can raise the issue the shipped walker raises rather than only
 *   knowing that something was turned away — see {@link refusedCondition}.
 * - **`maxDepth` bounds MEMBERSHIP, never enumeration.** A member sitting at the
 *   bound still has its references resolved and judged; what the budget denies
 *   is the hop. Each such reference becomes a
 *   {@link CLOSURE_DEPTH_EXCEEDED} row carrying the same provenance a refusal
 *   does. Stopping the enumeration instead was cheaper and quieter, and quieter
 *   was the defect: two implementations that agree on membership but differ in
 *   what they SAY at the boundary look identical to every membership test, so
 *   the gap surfaces only once someone compares the reports — at which point the
 *   temptation is to teach the comparison to tolerate the silence rather than to
 *   close it.
 */

import { isAbsoluteAnyPlatform } from '@vibe-agent-toolkit/utils';
import picomatch from 'picomatch';

import {
  CRAWL_CLOSURE_CONTRIBUTE_ID,
  CRAWL_CLOSURE_RESOLVE_ID,
  CRAWL_PASS_INSIDE,
  crawlTimingStart,
  recordCrawlPass,
} from '../../crawl-timing.js';
import {
  ExtentDeclarationSchema,
  type ExtentDeclaration,
  type ExtentRefusalRule,
} from '../../schemas/project-config.js';
import type { BlobReferenceRow } from '../../schemas/projection-blobs.js';
import { CONDITION_WITHOUT_REFERENCE } from '../../schemas/projection-resources.js';
import type {
  RealizationConditionRow,
  ResourceExtentRow,
  ResourceRealizationRow,
  ResourceRow,
} from '../../schemas/projection-resources.js';
import type { JsonValue } from '../../schemas/projection-shared.js';
import type { ResolutionContextRow } from '../../schemas/projection-zones.js';
import { resolveLocalHref } from '../../utils.js';
import type { ContributorStratum, ExtentContribution, ExtentContributor } from '../contributor.js';
import type { ProjectionBase } from '../projection.js';
import { relativize } from '../realizations.js';

import { extentContextId } from './context-id.js';

/** Every closure contributor's id begins here, so one prefix scan identifies them. */
export const CLOSURE_CONTRIBUTOR_ID_PREFIX = 'closure:';

/**
 * A followed reference resolved to a path no realization in the base occupies,
 * **and that path is inside the root**.
 *
 * The containment half is what {@link CLOSURE_REFERENCE_OUTSIDE_ROOT} split off,
 * and it is what makes this code readable: a path inside the root that nothing
 * realizes is a claim about the CORPUS — a broken link, or a file some crawl
 * exclusion skipped — and an author can act on it. That reading was unavailable
 * while the same code also covered every reference pointing at a perfectly
 * healthy file in a sibling directory of the project.
 */
export const CLOSURE_REFERENCE_UNRESOLVED = 'CLOSURE_REFERENCE_UNRESOLVED';

/**
 * A followed reference that resolved to a path **outside the corpus root**.
 *
 * The counterpart of `walk-link-graph.ts`'s `outside-project`, and it needs no
 * oracle: `relativize` already states every path against the root, and a path
 * the root does not contain comes back `..`-prefixed. The closure has always
 * *known* this — it simply said `CLOSURE_REFERENCE_UNRESOLVED` instead, which is
 * true (nothing realizes it) and useless (nothing ever could; the population is
 * defined by the root).
 *
 * ⚠️ **`targetExists` is null here and always will be**, which is the one place
 * this row is weaker than the walker's. The walker `stat`s the escaping path and
 * answers; a projection populated from one root observes nothing outside it, and
 * this contributor does no filesystem I/O. So the two arms are comparable on
 * WHICH paths escaped and not on whether they are there.
 *
 * The row names the target the way `relativize` spells it — `../…` — which is
 * the only spelling available and the same one the walker's absolute path
 * reduces to against the same root. `realization_conditions.path` is documented
 * as root-relative, and a `..` prefix is that: relative to the root, and stating
 * plainly that the target is not under it.
 */
export const CLOSURE_REFERENCE_OUTSIDE_ROOT = 'CLOSURE_REFERENCE_OUTSIDE_ROOT';

/** The declared `closureFrom` names a path the base never realized. */
export const CLOSURE_ROOT_ABSENT = 'CLOSURE_ROOT_ABSENT';

/**
 * A followed reference out of a member sitting AT `maxDepth`: resolved, not
 * refused, and admitted by nothing because the hop budget is spent.
 *
 * The counterpart of `walk-link-graph.ts`'s `depth-exceeded`, and it exists for
 * the same reason that one does — the bound is a fact about the DECLARATION, not
 * about the file, so a reader who widens `maxDepth` by one wants to know what
 * would arrive. Before this row the boundary was the primitive's one silent
 * verdict: a refusal at depth 1 was reported, a refusal-by-budget at depth 1 was
 * indistinguishable from a reference that was never authored.
 */
export const CLOSURE_DEPTH_EXCEEDED = 'CLOSURE_DEPTH_EXCEEDED';

/** Where the walk currently is: a root-relative path and its hop count from the root. */
type Hop = readonly [path: string, depth: number];

/** Everything one traversal needs, gathered once from the base. */
interface WalkContext {
  readonly base: ProjectionBase;
  readonly declaration: ExtentDeclaration;
  readonly extentId: string;
  /** Root-relative path → the realizations the base holds for it, in base order. */
  readonly byPath: ReadonlyMap<string, readonly ResourceRealizationRow[]>;
  /** `blobs.contentKey` → its reference rows, in ordinal order. */
  readonly byBlob: ReadonlyMap<string, readonly BlobReferenceRow[]>;
  /**
   * The FIRST `refusals` rule that catches this candidate, or `undefined` when
   * the declaration admits it.
   *
   * The **rule**, not merely its label, and not a boolean. A boolean cannot say
   * why; a bare label can say why but nothing more, and the refusal row is
   * expected to grow provenance (which reference, at which line, matching which
   * declared rule). Returning the declared rule object means every field a
   * future `ExtentRefusalRuleSchema` gains is available at the refusal site
   * without rethreading anything — the extension is additive by construction.
   * It also costs no allocation: this is the object the declaration already
   * holds.
   *
   * Takes the candidate's **realization row**, not its path, because three of
   * the four matchers need a column the path does not carry: `basenames` reads
   * `basenameLower` (already folded by `realizations.ts`, with the same
   * `toLowerCase()` the declaration side uses), `kinds` reads `resources.kind`
   * via `resourceId`, and `flags` reads the row's own boolean columns
   * (`gitignored`, `exists`, …). Passing the row rather than a widening tuple of
   * columns keeps the one refusal point one argument wide, and every column it
   * reads is one the projection already computed — which is what makes a
   * `gitignored` refusal a COLUMN MATCH rather than an oracle the closure would
   * have had to consult, and so keeps the "no filesystem I/O of its own" claim
   * in this module's docstring true.
   */
  readonly refusalOf: (candidate: ResourceRealizationRow) => ExtentRefusalRule | undefined;
}

/**
 * One closure-defined extent, parameterised entirely by config data.
 *
 * Registered once per declaration in `ProjectConfig.extents`; the declaration
 * itself travels through `PopulateOptions.parameters`, keyed by {@link id}.
 */
export class ClosureExtentContributor implements ExtentContributor {
  readonly id: string;

  readonly kind: string;

  readonly stratum: ContributorStratum = 'closure';

  /** The extent name — the within-root discriminator of this extent's context id. */
  readonly #name: string;

  /**
   * @param name - The extent name, as declared in `ProjectConfig.extents`. It is
   *   both this contributor's id suffix and the extent's within-root
   *   discriminator, so two declarations under one root can never collide
   * @param kind - The `resolution_contexts.kind` this extent has. Fixed at
   *   construction because `ContributorRegistry.forKind` partitions on it before
   *   `contribute` runs; the declaration must agree with it
   */
  constructor(name: string, kind: string) {
    this.#name = name;
    this.id = `${CLOSURE_CONTRIBUTOR_ID_PREFIX}${name}`;
    this.kind = kind;
  }

  /**
   * Walk the reference graph from the declared root and return the extent.
   *
   * @param base - Everything merged so far: the realizations that decide what a
   *   reference can resolve to, and the `blob_references` rows that are the edges
   * @param parameters - An {@link ExtentDeclarationSchema}-shaped declaration.
   *   Not optional and not defaulted: an extent with no `closureFrom` has no root
   *   to close over
   * @returns The extent's context, members, realizations and conditions
   * @throws When `parameters` is not a valid declaration, or names a `kind` other
   *   than the one this contributor is registered under
   */
  async contribute(base: ProjectionBase, parameters: JsonValue): Promise<ExtentContribution> {
    // Bracketed from the inside, under a synthetic id shared by every declared
    // extent — see `crawl-timing.ts`. The merge driver already records this
    // invocation per extent and per fixpoint pass; what only an inner bracket can
    // say is how much of that is this body and how much is the merge, the digest
    // and the provenance rows the driver wraps around it.
    const startedAt = crawlTimingStart();
    try {
      return this.#contribute(base, parameters);
    } finally {
      recordCrawlPass(CRAWL_CLOSURE_CONTRIBUTE_ID, 'closure', CRAWL_PASS_INSIDE, startedAt);
    }
  }

  /**
   * The traversal itself, with no timing concern in it.
   *
   * Split out so the bracket in {@link ClosureExtentContributor.contribute} is a
   * `try`/`finally` around ONE call rather than a pair of statements around a
   * body with several exits — a bracket that has to be repeated at every `return`
   * is one a later edit silently drops.
   *
   * @param base - Everything merged so far
   * @param parameters - An {@link ExtentDeclarationSchema}-shaped declaration
   * @returns The extent's context, members, realizations and conditions
   */
  #contribute(base: ProjectionBase, parameters: JsonValue): ExtentContribution {
    const declaration = ExtentDeclarationSchema.parse(parameters);
    if (declaration.kind !== this.kind) {
      throw new Error(
        `Closure extent "${this.#name}" is registered under kind "${this.kind}" but its declaration names kind "${declaration.kind}".`
        + ' ContributorRegistry.forKind partitions on the registered kind, so a disagreement would return this contributor for a kind it does not populate.',
      );
    }

    const extentId = extentContextId(this.kind, base.identities.rootId, this.#name);
    const context: ResolutionContextRow = {
      contextId: extentId,
      species: 'extent',
      kind: this.kind,
      rootId: base.identities.rootId,
      extentContextId: null,
      role: null,
    };

    const walk = walkClosure({
      base,
      declaration,
      extentId,
      byPath: indexRealizationsByPath(base),
      byBlob: referencesByBlobFor(base),
      refusalOf: refusalMatcher(declaration, base),
    });

    return { contexts: [context], ...walk };
  }
}

/**
 * Breadth-first traversal from `closureFrom`, bounded by depth and excludes.
 *
 * Two independent guards stop it, and they are deliberately not interchangeable:
 * the **visited set** terminates cycles (a cycle at `maxDepth: 'full'` has no
 * depth to exceed), and the **depth cap** bounds an acyclic chain (a chain has
 * nothing to revisit). A fixture that could not tell them apart would leave one
 * of them unfalsifiable.
 *
 * @param walk - The traversal's inputs, indexed once
 * @returns Every table except `contexts`, which the caller owns
 */
function walkClosure(walk: WalkContext): Omit<ExtentContribution, 'contexts'> {
  const resources: ResourceRow[] = [];
  const realizations: ResourceRealizationRow[] = [];
  const memberships: ResourceExtentRow[] = [];
  const conditions: RealizationConditionRow[] = [];

  const rootPath = walk.declaration.closureFrom;
  if (!walk.byPath.has(rootPath)) {
    // Empty, but never *unexplained* empty: the condition says which declared
    // path the base never realized, so this extent cannot be read as a complete
    // one. Reported rather than thrown, because one typo in one declaration must
    // not abort a whole population.
    conditions.push(rootAbsentCondition(walk.extentId, rootPath));
    return { resources, realizations, memberships, tags: [], conditions };
  }

  const visited = new Set<string>([rootPath]);
  const queue: Hop[] = [[rootPath, 0]];

  while (queue.length > 0) {
    const hop = queue.shift();
    if (hop === undefined) break;
    const [path, depth] = hop;

    const rows = walk.byPath.get(path) ?? [];
    // The FIRST realization in base order wins. A closure extent does not
    // re-observe the path — it inherits the columns of the first extent that
    // did — so this is a stated tie-break rather than whichever extent happened
    // to be registered last.
    const first = rows[0];
    if (first !== undefined) {
      resources.push(memberResource(first.resourceId, walk));
      realizations.push({ ...first, extentId: walk.extentId });
      memberships.push({ resourceId: first.resourceId, extentId: walk.extentId });
    }

    // ⚠️ NO depth guard here, deliberately. A member at `maxDepth` still has its
    // references ENUMERATED and EVALUATED — the hop budget decides what is
    // ADMITTED, never what is looked at. That split is `walk-link-graph.ts`'s
    // own: `processLink` runs `checkExclusions` before `processRegistryResource`
    // reaches the depth check, so the walker records an exclusion for a link out
    // of a member at the frontier and simply declines to bundle its target.
    // Guarding here instead made the closure SILENT at the boundary — same
    // membership, fewer facts — and a comparison against the walker had to
    // tolerate the missing rows rather than the code closing the gap. The
    // budget now lives at the single point that turns a candidate into a hop
    // ({@link hopFor}), which is the only place it can bound membership without
    // also bounding what gets reported.
    for (const next of outboundHops(path, rows, depth, walk, conditions)) {
      if (visited.has(next[0])) continue;
      visited.add(next[0]);
      queue.push(next);
    }
  }

  return { resources, realizations, memberships, tags: [], conditions };
}

/**
 * The hops reachable from one member, in reference order.
 *
 * Edges are the union over the member's distinct blobs: a resource realized in
 * two extents normally has one content key, and taking only one realization's
 * references would make the answer depend on registration order.
 *
 * @param path - The referring member's root-relative path
 * @param rows - Every realization the base holds for that path
 * @param depth - The referring member's hop count
 * @param walk - The traversal's indexed inputs
 * @param conditions - Collector for references that resolve to nothing
 * @returns Candidate hops, already filtered by `follow`, code context and excludes
 */
function outboundHops(
  path: string,
  rows: readonly ResourceRealizationRow[],
  depth: number,
  walk: WalkContext,
  conditions: RealizationConditionRow[],
): Hop[] {
  const hops: Hop[] = [];
  const seenBlobs = new Set<string>();

  for (const row of rows) {
    if (row.contentKey === null || seenBlobs.has(row.contentKey)) continue;
    seenBlobs.add(row.contentKey);
    for (const reference of walk.byBlob.get(row.contentKey) ?? []) {
      const hop = hopFor(reference, path, depth, row.resourceId, walk, conditions);
      if (hop !== undefined) hops.push(hop);
    }
  }

  return hops;
}

/**
 * The hop one reference contributes, if any.
 *
 * Extracted from {@link outboundHops} to stay under the cognitive-complexity
 * ceiling: the two loops and the four filters together exceed it.
 *
 * @param reference - One `blob_references` row
 * @param path - The referring member's root-relative path
 * @param depth - The referring member's hop count
 * @param resourceId - The referring member's identity, for a condition row
 * @param walk - The traversal's indexed inputs
 * @param conditions - Collector for references that resolve to nothing
 * @returns The hop, or undefined when this reference is not an edge of this extent
 */
function hopFor(
  reference: BlobReferenceRow,
  path: string,
  depth: number,
  resourceId: string,
  walk: WalkContext,
  conditions: RealizationConditionRow[],
): Hop | undefined {
  if (!shouldFollow(reference, walk.declaration)) return undefined;
  // A non-local reference is not a broken local one. `walkLinkGraph` filters on
  // `isLocalFileLink` *before* resolving; this traversal's edges come from
  // `blob_references`, which records the raw token and not the link type, so the
  // scheme check has to happen here. Without it every external URL in the corpus
  // resolves against the referring directory, finds nothing, and lands in the
  // condition table as an unresolved *local* reference — a false claim about the
  // document, and one that would fire on essentially every real skill.
  if (isNonLocalRef(reference.rawRef)) return undefined;

  const resolution = resolveReference(reference.rawRef, path, walk);
  if (resolution.kind === 'outside-root') {
    conditions.push(outsideRootCondition(walk.extentId, resolution.path, path, reference));
    return undefined;
  }
  if (resolution.kind === 'unrealized') {
    conditions.push(unresolvedCondition(walk.extentId, path, resourceId, reference));
    return undefined;
  }
  const target = resolution.row;
  // A reference back to this extent's OWN root is a self-link, and the only
  // honest report is silence. `closureFrom` is admitted before any traversal and
  // outranks every rule — this module's docstring says so, and until this line
  // that was true only because nothing ever asked: the root was seeded into the
  // queue, so no rule ran against it, while a reference REACHING it went through
  // the cascade like any other candidate. A rule naming the root's own basename
  // therefore refused the extent's root, and a root reached from a member at
  // `maxDepth` was reported as held back by a budget it was never subject to.
  // Both rows say something false about a file that is already a member.
  //
  // Checked BEFORE the cascade and before the budget, which is the same
  // precedence `admitPaths` gets and the same one `walk-link-graph.ts` gives its
  // own self-link (`classifyExclusion` answers `skipped`, recording nothing, and
  // never reaches the depth check in `processRegistryResource`).
  if (target.path === walk.declaration.closureFrom) return undefined;
  // A refused target is neither admitted nor walked through: it is not a
  // member, so its own references are not this extent's edges. That pruning is
  // the whole reason a refusal is worth expressing — refusing one navigation hub
  // drops everything reachable only through it.
  //
  // Unlike the three `return undefined`s above, this one is RECORDED. The three
  // are not omissions: a reference whose form the declaration does not follow, a
  // non-local URL, and (already condition-bearing) an unresolvable ref are all
  // facts about the REFERENCE. A refusal is a fact about a real file that this
  // projection realizes and that the declaration decided against, which is the
  // one of the four an author can act on.
  //
  // 📌 Refusal PROVENANCE threads through exactly here, and every fact
  // `LinkResolution` carries is in scope at this line: the referring path is
  // `path`, the link's line is `reference.line`, the href as authored is
  // `reference.rawRef`, whether the target exists is `target.exists`, and which
  // rule matched is the rule object `refusalOf` returns — including the opaque
  // `payload` a caller hangs on it. The fifth was never a threading problem: it
  // was a DECLARATION problem, and it closed when the skill translation stopped
  // flattening every `excludeReferencesFromBundle` rule into one refusal rule and
  // started emitting one rule apiece, in the same order `excludeMatchers.find`
  // scans them.
  const refusal = walk.refusalOf(target);
  if (refusal !== undefined) {
    conditions.push(refusedCondition(walk.extentId, target, refusal, path, reference));
    return undefined;
  }
  // The depth bound is checked LAST, and after the refusal — the order is
  // `classifyExclusion`-before-`processRegistryResource`, which is the order
  // `walk-link-graph.ts` checks them in. It matters because both can apply to
  // one reference and only one reason gets reported: a navigation file linked
  // from a member at `maxDepth` is a `navigation-file` refusal on both arms, not
  // a depth verdict wearing the wrong label.
  if (!canDescend(depth, walk.declaration.maxDepth)) {
    conditions.push(depthExceededCondition(walk.extentId, target, path, reference));
    return undefined;
  }
  return [target.path, depth + 1];
}

/**
 * Does the declaration follow this reference?
 *
 * An `if` chain rather than a `switch`: `switch-exhaustiveness-check` would
 * require naming every `ReferenceSyntacticForm` member here, which is the
 * declaration's job, not this function's.
 *
 * @param reference - One `blob_references` row
 * @param declaration - The extent declaration
 * @returns True when the form is declared and the reference is not sample text
 */
function shouldFollow(reference: BlobReferenceRow, declaration: ExtentDeclaration): boolean {
  if (reference.inFence || reference.inCodeSpan) return false;
  return declaration.follow.includes(reference.syntacticForm);
}

/**
 * A scheme-bearing or protocol-relative reference, matched on the raw token.
 *
 * `//host/path` is protocol-relative and equally not a local file. A bare
 * `mailto:`, `https:` or any other scheme is caught by the scheme production of
 * RFC 3986 — a letter followed by letters, digits, `+`, `-` or `.`, then `:`.
 * A Windows drive letter (`C:\…`) also matches, and excluding it is correct
 * here: an absolute drive path is not a corpus-relative reference either.
 */
const NON_LOCAL_REF = /^(?:\/\/|[a-z][\w+.-]*:)/iu;

/**
 * Is this reference something other than a path into the corpus?
 *
 * @param rawRef - The reference exactly as authored
 * @returns True when the token names an external or non-filesystem target
 */
function isNonLocalRef(rawRef: string): boolean {
  return NON_LOCAL_REF.test(rawRef);
}

/**
 * What one `rawRef` resolved to — three outcomes the closure must keep apart,
 * because each is a different report.
 *
 * `unrealized` and `outside-root` were one case until the latter was split out:
 * both are "no realization holds this", but only the first is a fact an author
 * can act on. See {@link CLOSURE_REFERENCE_OUTSIDE_ROOT}.
 */
type ReferenceResolution =
  /** A path the base realizes — the only outcome that can become a member. */
  | { readonly kind: 'realized'; readonly row: ResourceRealizationRow }
  /** A path outside the root, carried as `relativize` spells it (`../…`). */
  | { readonly kind: 'outside-root'; readonly path: string }
  /** Inside the root, and no realization holds it — or the href named no file. */
  | { readonly kind: 'unrealized' };

/**
 * Resolve one `rawRef` to a realization the base already holds.
 *
 * Resolution is relative to the **referring** file, so the referring path is
 * required rather than convenient. A target the base never realized resolves to
 * one of the two non-member outcomes — the closure is defined over what other
 * contributors found, and minting an identity for an unenumerated path would let
 * a broken link invent a member.
 *
 * The ROW is returned rather than the path because the refusal matchers need
 * columns the path does not carry (`basenameLower`, and `resourceId` for the
 * kind lookup). The **first** realization in base order is the one returned,
 * which is the same tie-break {@link walkClosure} applies when it admits a
 * member — stated once here so the two cannot pick different rows.
 *
 * ## Containment is decided on the RELATIVIZED path, not by a second resolver
 *
 * The escape test is `relativize`'s own output — the string this function was
 * already computing to key `byPath` — because that is the one spelling the whole
 * projection states paths in. Re-deriving containment from the absolute paths
 * would be a parallel implementation of a rule `resolveLocalHref` and
 * `relativize` already settle between them, which is exactly the split that once
 * bundled a de-linked file.
 *
 * ⚠️ `resolveLocalHref`'s own `absolute_escapes_root` verdict is deliberately
 * NOT reported as `outside-root`: that branch returns the href and no path, so
 * naming a target would mean resolving the href a second time, here, against a
 * rule this module does not own. It stays `unrealized`, which is what it was.
 *
 * @param rawRef - The reference exactly as authored
 * @param fromPath - Root-relative path of the file holding the reference
 * @param walk - The traversal's indexed inputs
 * @returns Which of the three outcomes this reference has
 */
function resolveReference(
  rawRef: string,
  fromPath: string,
  walk: WalkContext,
): ReferenceResolution {
  // The one genuinely hot bracket in this module, and the reason it is here: the
  // module docstring claims this contributor "performs no filesystem I/O of its
  // own" with ONE stated exception — `resolveLocalHref`'s root-absolute branch
  // canonicalizes through `realpath`. A claim like that is exactly the kind that
  // stops being true silently, and it is unfalsifiable while the step it
  // describes is unmeasured.
  const startedAt = crawlTimingStart();
  try {
    const { root } = walk.base;
    const resolution = resolveLocalHref(rawRef, joinRoot(root, fromPath), root);
    if (resolution.kind !== 'resolved') return { kind: 'unrealized' };
    const relative = relativize(resolution.resolvedPath, root);
    if (escapesRoot(relative)) return { kind: 'outside-root', path: relative };
    const row = walk.byPath.get(relative)?.[0];
    return row === undefined ? { kind: 'unrealized' } : { kind: 'realized', row };
  } finally {
    recordCrawlPass(CRAWL_CLOSURE_RESOLVE_ID, 'closure', CRAWL_PASS_INSIDE, startedAt);
  }
}

/**
 * Does a path stated against the root fall OUTSIDE it?
 *
 * Two spellings, because `safePath.relative` has two ways of saying "not under
 * this root": a `..`-prefixed relative path in the ordinary case, and an
 * ABSOLUTE path when no relative route exists at all — which on Windows is what
 * a different drive letter produces. Testing only the first would silently admit
 * `D:/elsewhere/doc.md` as though it were a root-relative member, on the one
 * platform where nobody would see it fail.
 *
 * `..` alone is the root's own parent directory and is outside by the same rule;
 * it is spelled separately because it carries no trailing separator to match.
 *
 * The parameter is named `normalized…` for the same reason `isUnderRoot`'s are
 * in `utils.ts`: the name states the precondition this function does not check,
 * and it is what discharges `local/no-path-startswith`. `relativize` is the only
 * producer of this argument and it forward-slashes on the way out.
 *
 * @param normalizedRelative - A forward-slashed path already stated against the
 *   root by `relativize`
 * @returns True when the root does not contain it
 */
function escapesRoot(normalizedRelative: string): boolean {
  return normalizedRelative === '..'
    || normalizedRelative.startsWith('../')
    || isAbsoluteAnyPlatform(normalizedRelative);
}

/**
 * The absolute path of a root-relative member.
 *
 * Deliberately string concatenation rather than `safePath.join`: the row's
 * `path` column is already forward-slashed and normalized, and `join` would
 * re-derive a platform separator that `resolveLocalHref` immediately undoes.
 *
 * @param root - The absolute corpus root
 * @param path - A root-relative, forward-slashed path
 * @returns The absolute, forward-slashed path
 */
function joinRoot(root: string, path: string): string {
  return `${root}/${path}`;
}

/**
 * Is a member at `depth` allowed to contribute further hops?
 *
 * @param depth - The member's hop count from the root
 * @param maxDepth - Declared bound, or `'full'` for none
 * @returns True when a hop to `depth + 1` is within the bound
 */
function canDescend(depth: number, maxDepth: ExtentDeclaration['maxDepth']): boolean {
  return maxDepth === 'full' || depth < maxDepth;
}

/**
 * Compile one refusal rule's globs.
 *
 * `dot: true`, because adopter paths traverse dotfile segments (`.claude/`)
 * and without it a refusal rule silently never matches them.
 *
 * @param patterns - Declared globs, possibly empty
 * @returns A matcher over root-relative paths — never matching when nothing was declared
 */
function excludeMatcher(patterns: readonly string[]): (path: string) => boolean {
  if (patterns.length === 0) return () => false;
  return picomatch([...patterns], { dot: true });
}

/** One `refusals` entry with its three matchers compiled, paired with the rule. */
interface CompiledRefusal {
  /**
   * The declared rule, carried through verbatim so the refusal can name it.
   *
   * The whole rule rather than just `label`: see {@link WalkContext.refusalOf}
   * for why the refusal verdict is the rule object.
   */
  readonly rule: ExtentRefusalRule;
  /** True when this rule catches the candidate — its three matchers OR'd. */
  readonly matches: (candidate: ResourceRealizationRow) => boolean;
}

/**
 * The boolean columns of `resource_realizations` an
 * {@link ExtentRefusalRule.flags} entry may name, and how each is read.
 *
 * A **closed table**, unlike `kinds`' open `resources.kind` vocabulary, and the
 * asymmetry is the point: a kind VAT has not minted yet is a value that may
 * legitimately appear later, whereas a realization row has a fixed shape and a
 * column name it does not carry is a rule that can never fire. Naming the
 * columns here is what lets {@link compileFlags} reject such a name loudly
 * instead of compiling a matcher that silently refuses nothing —
 * [[eslint-linter-probe-dead-config]]: a probe matching no config returns a
 * confident zero.
 *
 * `symlinkResolves` is deliberately absent: it is `boolean | null`, and a
 * two-valued matcher cannot say which of the two falsy answers it meant.
 */
const REALIZATION_FLAG_COLUMNS: Readonly<Record<string, (row: ResourceRealizationRow) => boolean>> = {
  exists: (row) => row.exists,
  isDirectory: (row) => row.isDirectory,
  gitignored: (row) => row.gitignored,
  isSymlink: (row) => row.isSymlink,
};

/** One compiled `flags` entry: how to read the column, and the value that refuses. */
type CompiledFlag = readonly [read: (row: ResourceRealizationRow) => boolean, refusesWhen: boolean];

/**
 * Compile one rule's `flags` record into readers, rejecting an unknown column.
 *
 * Compiled once per `contribute` — the analogue of {@link excludeMatcher}'s
 * precompiled globs, and of `kindByResourceIdFor`'s once-per-run index. There is
 * no lazy index to build here, because a flag is a column the projection already
 * computed and carries on the row itself; the laziness that matters is simply
 * that a rule declaring no flags compiles to an empty list and costs nothing per
 * candidate.
 *
 * @param flags - One rule's declared column → refusing-value record
 * @returns One reader per named column, in declaration order
 * @throws When a name is not a boolean column of `resource_realizations`
 */
function compileFlags(flags: ExtentRefusalRule['flags']): CompiledFlag[] {
  return Object.entries(flags).map(([column, refusesWhen]) => {
    const read = Object.hasOwn(REALIZATION_FLAG_COLUMNS, column)
      ? REALIZATION_FLAG_COLUMNS[column]
      : undefined;
    if (read === undefined) {
      throw new Error(
        `Refusal rule flag "${column}" is not a boolean column of resource_realizations.`
        + ` Known columns: ${Object.keys(REALIZATION_FLAG_COLUMNS).join(', ')}.`
        + ' A rule keyed on a column that does not exist could never refuse anything, so it is rejected'
        + ' rather than compiled into a matcher that silently admits everything.',
      );
    }
    return [read, refusesWhen] as const;
  });
}

/**
 * Compile one refusal rule's four matchers into a single predicate.
 *
 * The four are OR'd and therefore **unordered within a rule** — that is sound
 * here, and only here, for the reason the old flat design claimed globally: they
 * yield the same verdict *with the same label*, so no answer depends on which
 * one fired. A caller that needs two matchers told apart writes two rules, which
 * is exactly what {@link refusalMatcher}'s cascade is for.
 *
 * ## `flags` is the one matcher that is AND inside and OR outside
 *
 * A `flags` record is CONJUNCTIVE across its own entries and contributes one
 * OR'd term to the rule. That is not an inconsistency, it is the only shape that
 * can express a GUARDED column rule, and the shipped cascade this primitive
 * shadows has one: `walk-link-graph.ts`'s gitignore branch refuses on
 * `gitignored ∧ exists`, having declined for a path that is not there because
 * neither ignore oracle can be trusted about a path it cannot see. Read
 * disjunctively, `{ gitignored: true, exists: true }` would refuse every
 * existing file in the corpus.
 *
 * An EMPTY record never matches, for the same reason an empty `patterns` list
 * never matches: `[].every(...)` is `true`, so without the guard every rule
 * carrying the schema default would refuse the whole corpus.
 *
 * ## Case folding is `toLowerCase()`, never `toLocaleLowerCase()`
 *
 * The same rule, for the same reason, as `basenameMatcher` in
 * `packages/agent-skills/src/validators/validation-rules.ts`: the Turkish
 * dotless-i rule would fold `INDEX.md` to something `index.md` does not match on
 * a `tr-TR` host. The candidate side of the comparison is already folded —
 * `resource_realizations.basenameLower` is `basename.toLowerCase()`
 * (`realizations.ts`) — so only the declaration side is folded here, and the two
 * halves must stay on the same function or the matcher silently stops matching.
 *
 * @param rule - One declared refusal rule
 * @param kindById - The base's entity-kind index, or undefined when NO rule in
 *   the whole declaration names a kind and the index was never built
 * @returns The rule and its compiled predicate
 */
function compileRefusal(
  rule: ExtentRefusalRule,
  kindById: ReadonlyMap<string, string> | undefined,
): CompiledRefusal {
  const byGlob = excludeMatcher(rule.patterns);
  const basenames = new Set(rule.basenames.map((name) => name.toLowerCase()));
  const kinds = new Set(rule.kinds);
  const flags = compileFlags(rule.flags);

  return {
    rule,
    matches: (candidate: ResourceRealizationRow): boolean => {
      if (byGlob(candidate.path)) return true;
      if (basenames.has(candidate.basenameLower)) return true;
      if (flags.length > 0 && flags.every(([read, refusesWhen]) => read(candidate) === refusesWhen)) {
        return true;
      }
      if (kinds.size === 0) return false;
      const kind = kindById?.get(candidate.resourceId);
      return kind !== undefined && kinds.has(kind);
    },
  };
}

/**
 * The declaration's single refusal point — the ordered `refusals` cascade, plus
 * the `admitPaths` override that outranks all of it.
 *
 * Compiled **once per `contribute`**, the way {@link excludeMatcher} precompiles
 * its globs. Building the sets per candidate would rebuild the same sets once
 * per followed reference in the corpus, which is the shape of cost this module
 * already paid for once (see {@link referencesByBlobMemo}).
 *
 * ## `admitPaths` wins, and is checked before the cascade runs
 *
 * An explicit declaration outranks a net, exactly as `closureFrom` does: a glob,
 * a basename set and a kind set never named the file they caught. Exact string
 * equality against the root-relative, forward-slashed path — never a prefix or a
 * glob test, because the explicit-vs-glob distinction IS the rule. Checked
 * first, so an admitted path can never report a refusal label either.
 *
 * ## ⚠️ Among the rules the order IS the behaviour
 *
 * This loop is a **cascade**, not a short-circuit over interchangeable
 * predicates. Each rule carries a distinct label, so a candidate matching two
 * rules is attributed to the EARLIER one and reordering the array repicks the
 * reported reason — the same property `walk-link-graph.ts`'s `classifyExclusion`
 * documents ("the order IS the behaviour"), and the reason this function returns
 * a label instead of a boolean. This comment used to say the opposite, and it
 * was true while a refusal carried no payload; a labelled refusal is what made
 * it false. `'reports the FIRST matching refusal rule'` in
 * `projection-closure-extent.test.ts` is the assertion that keeps it false.
 *
 * @param declaration - The extent declaration
 * @param base - The projection built so far, for the `resources.kind` lookup
 * @returns The first matching rule for a refused candidate, else undefined
 */
function refusalMatcher(
  declaration: ExtentDeclaration,
  base: ProjectionBase,
): (candidate: ResourceRealizationRow) => ExtentRefusalRule | undefined {
  const admitted = new Set(declaration.admitPaths);
  // Built only when SOME rule names a kind, so a declaration that never asks
  // does not pay for a whole-corpus index — the laziness the flat `excludeKinds`
  // design had, preserved across the reshape.
  const kindById = declaration.refusals.some((rule) => rule.kinds.length > 0)
    ? kindByResourceIdFor(base)
    : undefined;
  const compiled = declaration.refusals.map((rule) => compileRefusal(rule, kindById));

  return (candidate: ResourceRealizationRow): ExtentRefusalRule | undefined => {
    if (admitted.has(candidate.path)) return undefined;
    for (const entry of compiled) {
      if (entry.matches(candidate)) return entry.rule;
    }
    return undefined;
  };
}

/**
 * Per-run memo of the `resourceId` → `resources.kind` index.
 *
 * Same premise and same guard as {@link referencesByBlobMemo}, for the same
 * reason: a closure contributor is registered once per extent (61 of them on
 * this repo, × 2 fixpoint passes), and rebuilding a whole-corpus index inside
 * each one is the per-item-cost-proportional-to-the-corpus shape that measured
 * as 98% of a run last time it went unnoticed. Keyed on row count as well as
 * identity so an index cannot outlive its own premise — a closure contributor
 * only ever re-selects entities the base stratum already enumerated, so the
 * count is stable across the stratum, and if that ever stops being true the
 * index is rebuilt rather than silently serving a stale kind.
 */
const kindByResourceIdMemo = new WeakMap<
  ProjectionBase,
  { readonly rowCount: number; readonly index: ReadonlyMap<string, string> }
>();

/**
 * The base's entity-kind index, built once per run rather than once per call.
 *
 * First row per `resourceId` wins, matching `ProjectionBuilder`'s own key race —
 * `resources` holds one row per identity, so this is a stated tie-break rather
 * than a situation that arises.
 *
 * @param base - The projection built so far
 * @returns `resources.resourceId` → its `kind`
 */
function kindByResourceIdFor(base: ProjectionBase): ReadonlyMap<string, string> {
  const cached = kindByResourceIdMemo.get(base);
  if (cached?.rowCount === base.resources.length) {
    return cached.index;
  }
  const index = new Map<string, string>();
  for (const row of base.resources) {
    if (!index.has(row.resourceId)) index.set(row.resourceId, row.kind);
  }
  kindByResourceIdMemo.set(base, { rowCount: base.resources.length, index });
  return index;
}

/**
 * The `resources` row for one member.
 *
 * `observed`/`fromEnumeration` are both true, and that is a true statement about
 * every row this contributor emits: it never *discovers* an entity, it selects
 * among entities some other contributor already enumerated. (In a real
 * population the base's own row wins the key race anyway — `ProjectionBuilder`
 * keeps the first row per `resourceId`.)
 *
 * `origin` carries the extent **kind**, matching how the filesystem and git
 * contributors spell theirs, so a query over `origin` sees one vocabulary.
 *
 * @param resourceId - The member's identity
 * @param walk - The traversal's inputs, for the declared kind
 * @returns The resources row
 */
function memberResource(resourceId: string, walk: WalkContext): ResourceRow {
  return {
    resourceId,
    kind: 'file',
    origin: walk.declaration.kind,
    observed: true,
    fromEnumeration: true,
    vatId: null,
  };
}

/**
 * The reference that provoked a condition, in the columns
 * `realization_conditions` carries it in.
 *
 * One helper for both reference-borne codes, because the four facts are read
 * off the same two objects in both and a second spelling is a second place for
 * the mapping to drift. `targetExists` is NOT here: it is the one fact the two
 * codes answer differently — a refusal observed the target, an unresolved
 * reference never found one — so each caller states it.
 *
 * @param fromPath - Root-relative path of the file holding the reference
 * @param reference - The reference row
 * @returns The three reference columns
 */
function referenceProvenance(
  fromPath: string,
  reference: BlobReferenceRow,
): Pick<RealizationConditionRow, 'sourcePath' | 'sourceLine' | 'sourceRef'> {
  return { sourcePath: fromPath, sourceLine: reference.line, sourceRef: reference.rawRef };
}

/**
 * The condition recording a reference that resolved to nothing.
 *
 * Anchored to the **referring** path: the target does not exist as far as this
 * projection is concerned, so a row naming it would name a file nobody can open.
 * `sourcePath` therefore repeats `path` here, and that repetition is the point —
 * the column always means "the referring file", so one reading serves both
 * anchorings.
 *
 * `targetExists` is **null**, not false. Nothing observed the target: "no
 * realization in this projection holds this path" is a statement about the
 * projection's population, and this contributor does no filesystem I/O, so
 * `false` would be a claim about the disk that nothing here checked.
 *
 * @param extentId - The closure extent
 * @param fromPath - Root-relative path of the file holding the reference
 * @param resourceId - The referring identity
 * @param reference - The reference row that did not resolve
 * @returns The condition row
 */
function unresolvedCondition(
  extentId: string,
  fromPath: string,
  resourceId: string,
  reference: BlobReferenceRow,
): RealizationConditionRow {
  return {
    extentId,
    path: fromPath,
    code: CLOSURE_REFERENCE_UNRESOLVED,
    severity: 'info',
    message: `Reference "${reference.rawRef}" at line ${reference.line} resolves to no realization in this projection,`
      + ' so the closure could not admit it as a member',
    resourceId,
    ...referenceProvenance(fromPath, reference),
    targetExists: null,
    matchedPattern: null,
    matchedPayload: null,
  };
}

/**
 * The condition recording a reference that resolved OUT of the corpus root.
 *
 * Anchored to the **target**, unlike {@link unresolvedCondition} and for that
 * function's own reason read the other way round: an escaping reference names a
 * real place a reader can go and look, it is merely one this population does not
 * cover. That anchoring is also what makes the row comparable with
 * `walk-link-graph.ts`'s `outside-project` row, which names the same file.
 *
 * `resourceId` is **null**: the population never minted an identity for a path
 * outside its own root, and minting one here would let a reference create a
 * resource — the same rule {@link unresolvedCondition} follows and for the same
 * reason. `targetExists` is null for the reason
 * {@link CLOSURE_REFERENCE_OUTSIDE_ROOT} states: nothing observed it, and this
 * contributor does no filesystem I/O.
 *
 * @param extentId - The closure extent
 * @param targetPath - The escaping target, as `relativize` spells it against the root
 * @param fromPath - Root-relative path of the file holding the reference
 * @param reference - The reference that pointed out of the root
 * @returns The condition row
 */
function outsideRootCondition(
  extentId: string,
  targetPath: string,
  fromPath: string,
  reference: BlobReferenceRow,
): RealizationConditionRow {
  return {
    extentId,
    path: targetPath,
    code: CLOSURE_REFERENCE_OUTSIDE_ROOT,
    severity: 'info',
    message: `Reference "${reference.rawRef}" at line ${reference.line} resolves outside this projection's root,`
      + ' so no contributor could ever realize it and the closure cannot admit it as a member',
    resourceId: null,
    ...referenceProvenance(fromPath, reference),
    targetExists: null,
    matchedPattern: null,
    matchedPayload: null,
  };
}

/**
 * The condition recording a candidate a `refusals` rule turned away.
 *
 * Anchored to the **refused target**, not to the referring file — the opposite
 * of {@link unresolvedCondition}, and for that function's own reason read the
 * other way round: an unresolved reference names a path nothing realizes, while
 * a refused candidate is a real file this projection holds a realization for, so
 * the row can name the file the decision was about.
 *
 * `code` is the matched rule's label **verbatim**. The primitive contributes no
 * vocabulary of its own here: `realization_conditions.code` is an open
 * vocabulary, and inventing a `CLOSURE_REFUSED_*` wrapper around the label would
 * make a caller's cascade reasons unreadable without also knowing this module's
 * prefix.
 *
 * Emitted **once per refused reference**, not once per refused path, matching
 * both {@link unresolvedCondition} and `walkLinkGraph`'s own
 * `excludedReferences` — a target linked from three documents was refused three
 * times. The rows are identical, and `ProjectionBuilder`'s condition table keys
 * on `(extentId, path, code, resourceId)`, so a population records one.
 *
 * ## The refusal's PROVENANCE, which is the rest of what `LinkResolution` carries
 *
 * `code` answers *why*; these five columns answer *where from* and *by which
 * rule*, which is what a consumer needs to raise the issue `walker-to-issues.ts`
 * raises (`sourcePath`/`sourceLine`/`linkHref`/`targetExists`) and the finding
 * `packaging-validator.ts` renders (`matchedRule.patterns[0]`).
 *
 * - **`sourcePath` / `sourceLine` / `sourceRef`** come from the reference this
 *   refusal was reached through, so the row names a file and a line an author
 *   can open — never the refused target, which is where an author would find
 *   nothing to change.
 * - **`targetExists`** is `target.exists`, a COLUMN of the realization row and
 *   not a probe. That is what keeps the module docstring's "no filesystem I/O of
 *   its own" true while still answering the question the walker answers with a
 *   `stat`.
 * - **`matchedPattern`** is the matched rule's FIRST declared glob, read exactly
 *   the way `packaging-validator.ts:1182` reads `matchedRule.patterns[0]` — the
 *   rule's identifying pattern, not necessarily the glob that fired. A rule
 *   refusing by basename, kind or flag declares no patterns and reports null.
 * - **`matchedPayload`** is the rule's opaque payload, verbatim. The primitive
 *   contributes no vocabulary here either: it neither reads nor validates it,
 *   exactly as it neither reads nor validates `label`.
 *
 * ⚠️ One row per refused REFERENCE is emitted, but `ProjectionBuilder` keys the
 * condition table on `(extentId, path, code, resourceId)` — so a target refused
 * through three references records ONE row, carrying the FIRST reference's
 * provenance. The witness is a witness, not the list; `blob_references` is where
 * the list lives.
 *
 * @param extentId - The closure extent
 * @param target - The refused candidate's realization row
 * @param rule - The refusal rule that matched, first-match-wins
 * @param fromPath - Root-relative path of the file whose reference reached it
 * @param reference - The reference this refusal was reached through
 * @returns The condition row
 */
function refusedCondition(
  extentId: string,
  target: ResourceRealizationRow,
  rule: ExtentRefusalRule,
  fromPath: string,
  reference: BlobReferenceRow,
): RealizationConditionRow {
  return {
    extentId,
    path: target.path,
    code: rule.label,
    severity: 'info',
    message: `Refused by the "${rule.label}" rule of this extent's refusal cascade,`
      + ' so it is neither a member nor a path the closure traverses through',
    resourceId: target.resourceId,
    ...referenceProvenance(fromPath, reference),
    targetExists: target.exists,
    matchedPattern: rule.patterns[0] ?? null,
    matchedPayload: rule.payload,
  };
}

/**
 * The condition recording a reference the hop budget — not a rule — turned away.
 *
 * Anchored to the **target**, like {@link refusedCondition} and unlike
 * {@link unresolvedCondition}, and for that function's stated reason: the target
 * is a real file this projection realizes, so the row can name the file the
 * decision was about. It carries the same provenance a refusal does, because a
 * consumer asking "what would arrive if I widened `maxDepth`" needs the same
 * five answers as one asking "what did a rule turn away" — which reference, at
 * which line, written how, against a target that did or did not exist.
 *
 * `matchedPattern` and `matchedPayload` are null and always will be: no rule
 * matched. That is a **discriminating** null rather than an absent one — it is
 * how a reader tells a budget verdict from a rule verdict without reading
 * `code`, and it is exactly what the walker's own row says (`makeExclusion`
 * attaches `matchedRule` only for `pattern-matched`).
 *
 * ⚠️ Emitted once per REFERENCE, like every other closure condition, and
 * `ProjectionBuilder` keys the condition table on
 * `(extentId, path, code, resourceId)` — so a target held back at the boundary
 * through three references records one row carrying the first reference's
 * provenance.
 *
 * A path can never carry both this code and a refusal label: {@link refusalOf}
 * is a function of the candidate ROW, and {@link resolveReference} always
 * returns the same first realization for a path, so a refused path is refused
 * from every referrer and never reaches this branch.
 *
 * @param extentId - The closure extent
 * @param target - The realization the reference resolved to
 * @param fromPath - Root-relative path of the file holding the reference
 * @param reference - The reference this boundary was reached through
 * @returns The condition row
 */
function depthExceededCondition(
  extentId: string,
  target: ResourceRealizationRow,
  fromPath: string,
  reference: BlobReferenceRow,
): RealizationConditionRow {
  return {
    extentId,
    path: target.path,
    code: CLOSURE_DEPTH_EXCEEDED,
    severity: 'info',
    message: 'Reachable, refused by no rule, and beyond this extent\'s maxDepth,'
      + ' so it is reported rather than admitted — widening the bound would make it a member',
    resourceId: target.resourceId,
    ...referenceProvenance(fromPath, reference),
    targetExists: target.exists,
    matchedPattern: null,
    matchedPayload: null,
  };
}

/**
 * The condition recording a `closureFrom` the base never realized.
 *
 * The one closure condition with **no reference behind it** — the root arrives
 * from the declaration, not from a link — so it spreads
 * {@link CONDITION_WITHOUT_REFERENCE} rather than naming a source it does not
 * have.
 *
 * @param extentId - The closure extent
 * @param rootPath - The declared root path
 * @returns The condition row
 */
function rootAbsentCondition(extentId: string, rootPath: string): RealizationConditionRow {
  return {
    extentId,
    path: rootPath,
    code: CLOSURE_ROOT_ABSENT,
    severity: 'error',
    message: `closureFrom "${rootPath}" is not realized anywhere in this projection,`
      + ' so this extent is empty for a declared reason rather than an observed one',
    resourceId: null,
    ...CONDITION_WITHOUT_REFERENCE,
  };
}

/**
 * Index the base's realizations by root-relative path, preserving base order.
 *
 * @param base - The projection built so far
 * @returns Path → its realization rows
 */
function indexRealizationsByPath(base: ProjectionBase): ReadonlyMap<string, readonly ResourceRealizationRow[]> {
  const byPath = new Map<string, ResourceRealizationRow[]>();
  for (const row of base.resourceRealizations) {
    const rows = byPath.get(row.path);
    if (rows === undefined) {
      byPath.set(row.path, [row]);
    } else {
      rows.push(row);
    }
  }
  return byPath;
}

/**
 * Per-run memo of {@link indexReferencesByBlob}, keyed on the base view.
 *
 * The index this caches is **invariant across the whole closure stratum**, and
 * that is a property of the driver rather than a hopeful assumption:
 * `populate` runs `populateBlobs` exactly once, between the strata, and a
 * closure contributor only ever re-realizes a path the base already realized —
 * so no new `blob_references` row can appear after the stratum starts
 * (`merge.ts`, "Between the strata, and exactly once").
 *
 * Rebuilding it per call was measured at **98% of a whole-corpus run**: 61
 * closure contributors × 2 passes = 122 full scans of 44k reference rows, each
 * with a per-blob sort, where one scan would do. `ProjectionBuilder.base()`
 * memoizes its view, so every contributor in every pass is handed the *same*
 * object and one entry serves the run.
 *
 * Keyed on row count as well as identity so the memo cannot outlive its own
 * premise: if a future change ever does append a reference row mid-stratum, the
 * count moves and the index is rebuilt rather than silently serving a stale
 * answer. That is the difference between a cache and a bug.
 */
const referencesByBlobMemo = new WeakMap<
  ProjectionBase,
  { readonly rowCount: number; readonly index: ReadonlyMap<string, readonly BlobReferenceRow[]> }
>();

/**
 * The base's reference index, built once per run rather than once per call.
 *
 * @param base - The projection built so far
 * @returns `contentKey` → its reference rows, ordinal-ordered
 */
function referencesByBlobFor(base: ProjectionBase): ReadonlyMap<string, readonly BlobReferenceRow[]> {
  const cached = referencesByBlobMemo.get(base);
  if (cached?.rowCount === base.blobReferences.length) {
    return cached.index;
  }
  const index = indexReferencesByBlob(base);
  referencesByBlobMemo.set(base, { rowCount: base.blobReferences.length, index });
  return index;
}

/**
 * Index the base's reference candidates by blob, in ordinal order.
 *
 * Sorted rather than trusted: `ordinal` is the documented order of a blob's
 * references, and the table's insertion order is whatever the parse layer
 * happened to add rows in.
 *
 * @param base - The projection built so far
 * @returns `contentKey` → its reference rows, ordinal-ordered
 */
function indexReferencesByBlob(base: ProjectionBase): ReadonlyMap<string, readonly BlobReferenceRow[]> {
  const byBlob = new Map<string, BlobReferenceRow[]>();
  for (const row of base.blobReferences) {
    const rows = byBlob.get(row.blob);
    if (rows === undefined) {
      byBlob.set(row.blob, [row]);
    } else {
      rows.push(row);
    }
  }
  for (const rows of byBlob.values()) {
    rows.sort((left, right) => left.ordinal - right.ordinal);
  }
  return byBlob;
}

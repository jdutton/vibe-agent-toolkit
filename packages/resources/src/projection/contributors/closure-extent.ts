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
 * `exclude` — arrives through {@link ClosureExtentContributor.contribute}'s
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
 * - **References inside a fence or a code span are never followed**, and that is
 *   not configurable. Anthropic documents that `@` import parsing skips code
 *   spans and fenced blocks; a path inside a fence is sample text, not a link.
 *   An AST-derived row is never in either context by construction, so this
 *   filter only ever bites lexer-derived forms — which is exactly where sample
 *   text lives.
 * - **The root is admitted even when an `exclude` glob matches it.** An explicit
 *   declaration outranks a net: `closureFrom` names the file, a glob never did.
 *   The same rule decides the `files:` escape hatch in `walk-link-graph.ts`.
 */

import picomatch from 'picomatch';

import { ExtentDeclarationSchema, type ExtentDeclaration } from '../../schemas/project-config.js';
import type { BlobReferenceRow } from '../../schemas/projection-blobs.js';
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

/** A followed reference resolved to a path no realization in the base occupies. */
export const CLOSURE_REFERENCE_UNRESOLVED = 'CLOSURE_REFERENCE_UNRESOLVED';

/** The declared `closureFrom` names a path the base never realized. */
export const CLOSURE_ROOT_ABSENT = 'CLOSURE_ROOT_ABSENT';

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
  /** True when a candidate member's path is excluded by declaration. */
  readonly isExcluded: (path: string) => boolean;
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
      byBlob: indexReferencesByBlob(base),
      isExcluded: excludeMatcher(declaration.exclude),
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

    if (!canDescend(depth, walk.declaration.maxDepth)) continue;
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

  const target = resolveReference(reference.rawRef, path, walk);
  if (target === undefined) {
    conditions.push(unresolvedCondition(walk.extentId, path, resourceId, reference));
    return undefined;
  }
  // An excluded target is neither admitted nor walked through: it is not a
  // member, so its own references are not this extent's edges.
  if (walk.isExcluded(target)) return undefined;
  return [target, depth + 1];
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
 * Resolve one `rawRef` to a root-relative path the base already realizes.
 *
 * Resolution is relative to the **referring** file, so the referring path is
 * required rather than convenient. A target the base never realized resolves to
 * `undefined` — the closure is defined over what other contributors found, and
 * minting an identity for an unenumerated path would let a broken link invent a
 * member.
 *
 * @param rawRef - The reference exactly as authored
 * @param fromPath - Root-relative path of the file holding the reference
 * @param walk - The traversal's indexed inputs
 * @returns The target's root-relative path, or undefined when nothing realizes it
 */
function resolveReference(rawRef: string, fromPath: string, walk: WalkContext): string | undefined {
  const { root } = walk.base;
  const resolution = resolveLocalHref(rawRef, joinRoot(root, fromPath), root);
  if (resolution.kind !== 'resolved') return undefined;
  const candidate = relativize(resolution.resolvedPath, root);
  return walk.byPath.has(candidate) ? candidate : undefined;
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
 * Compile the declaration's exclude globs.
 *
 * `dot: true`, because adopter paths traverse dotfile segments (`.claude/`)
 * and without it an exclude rule silently never matches them.
 *
 * @param patterns - Declared globs, possibly empty
 * @returns A matcher over root-relative paths — never matching when nothing was declared
 */
function excludeMatcher(patterns: readonly string[]): (path: string) => boolean {
  if (patterns.length === 0) return () => false;
  return picomatch([...patterns], { dot: true });
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
 * The condition recording a reference that resolved to nothing.
 *
 * Anchored to the **referring** path: the target does not exist as far as this
 * projection is concerned, so a row naming it would name a file nobody can open.
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
  };
}

/**
 * The condition recording a `closureFrom` the base never realized.
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

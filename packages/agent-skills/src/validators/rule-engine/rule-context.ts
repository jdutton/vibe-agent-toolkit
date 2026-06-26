/**
 * RuleContext — the intent-aware input to the skill-resource verdict engine.
 *
 * Issue #129 (slice 3). VAT decided "is this skill resource OK?" across three
 * diverged code paths (built / live-audit / wild-fallback), none of which
 * encoded the *intent* behind a file's inclusion. This module replaces the
 * per-path `excludeReason` mechanism with a description of the resource (or the
 * reference edge) that the path's extraction front-end derives once; the pure
 * {@link evaluate} engine then reasons from that description to a single code.
 *
 * The verdict functions in `verdicts.ts` NEVER touch the filesystem — every
 * fact they need is a field here. The two extraction front-ends
 * (`extract-from-walker.ts` for the live path, the built path) are the only
 * places that do I/O, and they are responsible for producing field-faithful
 * contexts (proven by the extraction integration tests).
 */

/**
 * The role stamped on each copy edge at the call site (skill packaging vs.
 * marketplace plugin bundling). A **closed enum**, deliberately NOT a field on
 * the shared `SkillFileEntrySchema` (which is `.strict()` and reused by the
 * marketplace plugin entry) — intent attaches to the inclusion edge, not to the
 * author's `{source, dest}` config.
 *
 * - `skill-bundled` — copied as part of a skill bundle; skill expectations
 *   (self-containment, reachable-from-SKILL.md) apply.
 * - `plugin-artifact` — copied as a plugin-level artifact (e.g. a compiled CLI
 *   outside any skill); skill expectations do NOT apply.
 *
 * Phase 2 (future) refines `skill-bundled` into `skill-doc` / `skill-executable`
 * / `skill-asset`; not in scope here.
 */
export type FileCopyRole = 'skill-bundled' | 'plugin-artifact';

/** The validation layer that owns the contract supplying intent. */
export type RuleScope = 'base-resource' | 'skill' | 'plugin';

/**
 * Coarse classification of *what kind of thing* a resource is. `directory` is
 * the post-`stat` realization of #126's source-level `local_directory` link
 * shape; `nav` is a navigation file (README.md, index.md, …) excluded from
 * bundles.
 */
export type FileKind =
  | 'doc'
  | 'executable'
  | 'asset'
  | 'data'
  | 'schema'
  | 'nav'
  | 'directory'
  | 'unknown';

/** How a resource is referenced from the skill graph. */
export type ReferencedHow = 'link' | 'mention' | 'none';

/**
 * Which path produced this context. The engine erases *duplicated* logic, not
 * the *legitimate* source-vs-built distinction: a missing link target at source
 * is `LINK_MISSING_TARGET` (author error), but a missing link target in the
 * built output is `PACKAGED_BROKEN_LINK` (a link-rewriter bug). Likewise an
 * unreferenced built file is `PACKAGED_UNREFERENCED_FILE`. This is the one
 * discriminator added beyond the issue's RuleContext sketch, recorded here per
 * the issue's instruction to "resolve aliasing via a new discriminating field."
 */
export type RulePhase = 'source' | 'built';

/**
 * Whether this context describes a **reference edge** (a link from one file to
 * another) or a **file** (an inclusion candidate evaluated for orphan-ness).
 * Edge codes (LINK_*) and file codes (PACKAGED_UNREFERENCED_FILE) never apply
 * to the same subject, so this cleanly partitions the rule set and keeps the
 * aliasing detector meaningful.
 */
export type RuleSubject = 'edge' | 'file';

/**
 * Intent-aware description of a skill resource or reference edge.
 *
 * Fields above the divider are the issue's RuleContext sketch verbatim. Fields
 * below are minimal, documented additions required to drive *existing* codes
 * without aliasing (each maps 1:1 to a real, extractable property — none is a
 * pre-computed "reason").
 */
export interface RuleContext {
  // --- issue #129 RuleContext sketch ---------------------------------------
  scope: RuleScope;
  fileKind: FileKind;
  reachableFromSkillMd: boolean;
  referencedHow: ReferencedHow;
  copyRole?: FileCopyRole | undefined;
  inFilesConfig: boolean;
  existsAtSource: boolean;
  looksBuildProduced: boolean;
  insideSkillDir: boolean;

  // --- documented additions (disambiguation only) --------------------------
  /** source vs built path — see {@link RulePhase}. */
  phase: RulePhase;
  /** reference edge vs inclusion-candidate file — see {@link RuleSubject}. */
  subject: RuleSubject;
  /** Edge target resolves outside the project root boundary. */
  outsideProject: boolean;
  /** Edge target is gitignored (only meaningful when it exists on disk). */
  gitignored: boolean;
  /**
   * The edge is a **typed single-file slot** (e.g. a packaging `files:` source
   * entry) — a directory target is an error here, whereas a navigational edge
   * accepts a directory. #126's "typed single-file slot" ≡ this flag.
   */
  typedSingleFileSlot: boolean;
  /** Edge targets another skill's SKILL.md (duplicate-definition risk). */
  crossSkillDefinition: boolean;
  /** Edge was dropped because it lay beyond the configured linkFollowDepth. */
  droppedByDepth: boolean;
  /** Edge target was excluded by an excludeReferencesFromBundle pattern. */
  patternExcluded: boolean;
}

/**
 * Build a RuleContext with sensible defaults, overriding only the fields a
 * scenario cares about. Keeps the scenario table to one-line deltas and keeps
 * every extraction front-end honest about which fields it must set.
 */
export function makeRuleContext(overrides: Partial<RuleContext> = {}): RuleContext {
  return {
    scope: 'skill',
    fileKind: 'unknown',
    reachableFromSkillMd: false,
    referencedHow: 'none',
    copyRole: undefined,
    inFilesConfig: false,
    existsAtSource: true,
    looksBuildProduced: false,
    insideSkillDir: true,
    phase: 'source',
    subject: 'edge',
    outsideProject: false,
    gitignored: false,
    typedSingleFileSlot: false,
    crossSkillDefinition: false,
    droppedByDepth: false,
    patternExcluded: false,
    ...overrides,
  };
}

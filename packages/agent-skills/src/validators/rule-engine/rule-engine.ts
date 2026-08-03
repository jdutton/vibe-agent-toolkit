/**
 * The skill-resource verdict engine (issue #129, slice 3).
 *
 * `evaluate(ctx)` is a **pure** function: it takes an intent-aware
 * {@link RuleContext} and returns at most one validation code (or `null` when
 * the resource/edge is fine). It never touches the filesystem — all I/O lives
 * in the per-path extraction front-ends. `materializeIssue(code, …)` is the
 * single place that turns a code into a {@link ValidationIssue}, sourcing
 * `description` / `fix` / `reference` / `defaultSeverity` from
 * `CODE_REGISTRY` so docs, runtime, and tests cannot drift (the runtime
 * `message` is the registry `description` plus per-issue detail).
 *
 * Determinism + non-aliasing are enforced by the scenario harness: every
 * constructed context maps to exactly one expected code, and no two distinct
 * intents may share a context signature while expecting different codes.
 */

import { CODE_REGISTRY, type IssueCode, type ValidationIssue } from '@vibe-agent-toolkit/agent-schema';

import type { FileKind, RuleContext } from './rule-context.js';

/**
 * File kinds the walker refuses to bundle outright, and the code each reports.
 * Both are "this file cannot travel", differing only in why: a navigation file
 * is content at the wrong granularity, an agent-instruction file is guidance
 * about the repository it lives in. Kept as a table so the two stay adjacent
 * and adding a third kind does not deepen `evaluateEdge`.
 */
const EXCLUDED_FILE_KIND_CODES: Partial<Record<FileKind, IssueCode>> = {
  nav: 'LINK_TO_NAVIGATION_FILE',
  'agent-instruction': 'LINK_TO_AGENT_INSTRUCTION_FILE',
};

/**
 * Decide the code for a **reference edge** (`subject: 'edge'`). Ordered: the
 * first matching intent wins. Returns `null` for edges that are valid (a
 * navigational directory link, a pattern-excluded reference, a normally-bundled
 * link).
 */
function evaluateEdge(ctx: RuleContext): IssueCode | null {
  // A target outside the project boundary is the strongest signal — it can
  // never be bundled regardless of anything else about the edge.
  if (ctx.outsideProject) return 'LINK_OUTSIDE_PROJECT';

  // Directory targets: an error ONLY for a typed single-file slot (the contract
  // demanded a file). A navigational directory link is a valid target (#126).
  if (ctx.fileKind === 'directory') {
    return ctx.typedSingleFileSlot ? 'LINK_TARGETS_DIRECTORY' : null;
  }

  // Linking another skill's SKILL.md duplicates skill definitions on bundle.
  if (ctx.crossSkillDefinition) return 'LINK_TO_SKILL_DEFINITION';

  // A declared-but-not-yet-materialized files: artifact is deferred, not broken.
  // (The extraction front-end only sets inFilesConfig+!existsAtSource for genuine
  // deferrals; an existing files: target falls through to the leak/normal paths.)
  if (!ctx.existsAtSource && ctx.inFilesConfig) return 'LINK_DEFERRED_ARTIFACT';

  // An existing gitignored target risks leaking ignored data into the bundle.
  if (ctx.gitignored && ctx.existsAtSource) return 'LINK_TO_GITIGNORED_FILE';

  // A link to a file kind the walker excludes from the bundle outright.
  const excludedKindCode = EXCLUDED_FILE_KIND_CODES[ctx.fileKind];
  if (excludedKindCode) return excludedKindCode;

  // Excluded by an author-configured pattern — intentional, not an issue.
  if (ctx.patternExcluded) return null;

  // Beyond the configured linkFollowDepth.
  if (ctx.droppedByDepth) return 'LINK_DROPPED_BY_DEPTH';

  // A missing target: an author error at source, a link-rewriter bug in built
  // output (the legitimate source-vs-built distinction the engine preserves).
  if (!ctx.existsAtSource) {
    return ctx.phase === 'built' ? 'PACKAGED_BROKEN_LINK' : 'LINK_MISSING_TARGET';
  }

  // Resolves to an existing in-bundle file — fine.
  return null;
}

/**
 * Decide the code for an **inclusion-candidate file** (`subject: 'file'`),
 * i.e. orphan detection. Returns `null` for files that are referenced,
 * declared, or exempt.
 */
function evaluateFile(ctx: RuleContext): IssueCode | null {
  // Plugin artifacts are exempt from skill self-containment expectations
  // (issue #129 AC4): never apply skill orphan rules to a plugin-level copy.
  if (ctx.copyRole === 'plugin-artifact') return null;

  // Referenced (by link or documented mention) or explicitly declared in
  // files: config — not an orphan.
  if (ctx.reachableFromSkillMd || ctx.referencedHow !== 'none' || ctx.inFilesConfig) {
    return null;
  }

  // An unreferenced file in the built output is dead weight.
  if (ctx.phase === 'built') return 'PACKAGED_UNREFERENCED_FILE';

  // Source-phase orphan detection (live audit/build parity, AC2) is wired by
  // the live extraction front-end; the code choice by fileKind is owned there
  // so it can respect the evidence-gated severity posture. The engine returns
  // null at source for now rather than reusing the built-output error code.
  return null;
}

/**
 * Evaluate a single intent-aware context to at most one validation code.
 *
 * @returns the code that fires, or `null` when the resource/edge is acceptable.
 */
export function evaluate(ctx: RuleContext): IssueCode | null {
  return ctx.subject === 'edge' ? evaluateEdge(ctx) : evaluateFile(ctx);
}

/**
 * Options for {@link materializeIssue}.
 *
 * `location` / `line` / `field` / `link` are the four independent anchors of
 * {@link ValidationIssue} and are passed through verbatim — see the anchor
 * contract on that type. In particular `location` is ALWAYS the
 * project-relative path of the file to open; a link target belongs in `link`.
 */
export interface MaterializeOpts {
  /** Project-relative POSIX path of the file the issue is in. */
  location?: string | undefined;
  /** 1-based line within `location`. */
  line?: number | undefined;
  /** Dotted document-internal pointer, e.g. `frontmatter.description`. */
  field?: string | undefined;
  /** A link href/target the issue concerns — never the file to open. */
  link?: string | undefined;
  /**
   * Per-issue detail appended to the registry `description` to form the runtime
   * `message` (e.g. the link href). The registry `description` stays the stable,
   * doc-asserted headline; `message` is treated as dynamic.
   */
  detail?: string | undefined;
  /**
   * Full runtime `message` override. Use when a code needs a bespoke message
   * that isn't `description (detail)` — severity/fix/reference still come from
   * the registry. Takes precedence over {@link MaterializeOpts.detail}.
   */
  message?: string | undefined;
}

/**
 * Build a {@link ValidationIssue} for a code, sourcing severity / description /
 * fix / reference from {@link CODE_REGISTRY}. The single construction site for
 * skill-resource issues — eliminates the duplicated `{severity, code, message,
 * fix, reference}` literals that previously lived in walker-to-issues,
 * deferredAssetsToIssues, and post-build-checks.
 */
export function materializeIssue(code: IssueCode, opts: MaterializeOpts = {}): ValidationIssue {
  const e = CODE_REGISTRY[code];
  const message = opts.message
    ?? (opts.detail === undefined ? e.description : `${e.description} (${opts.detail})`);
  const issue: ValidationIssue = {
    severity: e.defaultSeverity,
    code,
    message,
    fix: e.fix,
    reference: e.reference,
  };
  if (opts.location !== undefined) {
    issue.location = opts.location;
  }
  if (opts.line !== undefined) {
    issue.line = opts.line;
  }
  if (opts.field !== undefined) {
    issue.field = opts.field;
  }
  if (opts.link !== undefined) {
    issue.link = opts.link;
  }
  return issue;
}

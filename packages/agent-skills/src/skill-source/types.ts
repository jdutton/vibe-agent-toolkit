/**
 * Typed "skill source" descriptors and the unified resolution result.
 *
 * A SkillSource declares HOW to obtain a skill/plugin directory; resolveSkillSource
 * (resolve-skill-source.ts) materializes it to a local staged directory and returns
 * a stable identity used by reconciliation (spec §11b).
 *
 * Names here are a pinned cross-plan interface — do not rename.
 */

/** Discriminated union of every way VAT can obtain a skill/plugin directory. */
export type SkillSource =
  /** A member of THIS monorepo, built via the build graph. */
  | { workspace: string }
  /** A bare npm specifier, e.g. "@scope/pkg@1.2.3". Version-pinned, content-hashed. */
  | { npm: string }
  /** A git URL (cloneUrl#ref:subpath) OR an arbitrary .zip. Fetched, sha256-verified. */
  | { url: string; sha256?: string }
  /** A local directory. Content-hashed. */
  | { path: string }
  /** A committed pinned copy (e.g. skill-creator). Copied; manifest-hashed. */
  | { vendored: true };

/** Result of resolving a SkillSource: a staged directory + a reconciliation identity. */
export interface ResolvedSkillSource {
  /** Forward-slash absolute path to the staged skill/plugin directory. */
  stagedDir: string;
  /**
   * Stable identity for reconciliation (spec §11b):
   *   workspace -> build-input hash
   *   npm       -> version + staged-tree content hash
   *   url       -> url + sha256
   *   path      -> path content hash
   *   vendored  -> vendored manifest hash
   */
  identity: string;
}

/** Resolution context shared by every source kind. */
export interface ResolveSkillSourceContext {
  /** Absolute path to the repo/project root (anchor for workspace builds + npm/path resolution). */
  repoRoot: string;
  /** Absolute staging root the resolved dir is copied into (created 0700 if absent). */
  stagingRoot: string;
  /** Per-user content-addressed fetch cache root for external npm/url items. */
  fetchCacheDir: string;
  /** When true, force re-download / re-resolve of cached external items (verify still runs). */
  refresh?: boolean;
  /** Absolute path to the committed vendored skill-creator dir (used by the vendored kind). */
  vendoredDir?: string;
}

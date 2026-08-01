import { findProjectRoot } from '@vibe-agent-toolkit/utils';

/**
 * The anchor base for a validation run: the ONE root every emitted
 * `ValidationIssue.location` in that run is expressed relative to.
 *
 * This is deliberately NOT the same thing as a validation-policy project root.
 * The project root decides what counts as "outside the project", where
 * config-relative paths resolve from, and what a registry crawl covers. The
 * anchor base only answers "relative to what is this location written?".
 *
 * Conflating them is what broke `vat audit`: audit spans many
 * `vibe-agent-toolkit.config.yaml` roots in one run, each resource anchored its
 * findings at its own nearest-ancestor config, and the resulting document mixed
 * coordinate systems — two distinct `plugin.json` files carried a byte-identical
 * `location`, so anything grouping or de-duplicating by `location` merged them.
 */
export interface AnchorRootOptions {
  /**
   * Root every emitted `location` is relative to. A caller that scans more than
   * one project in a single run MUST pass its invocation scan root. Omitted, it
   * falls back to the resource's own discovered project root, which is correct
   * exactly when the run covers a single project.
   */
  locationRoot?: string;
}

/**
 * Resolve the anchor base: the caller's explicit run root if given, else the
 * resource's own project boundary (config root -> git root -> the directory
 * itself).
 *
 * @param explicit - Caller-supplied run root, if any.
 * @param fallbackDir - Directory to discover a project root from when no run
 *   root was supplied. Also the last-resort base, so the return is never null.
 */
export function resolveAnchorRoot(explicit: string | undefined, fallbackDir: string): string {
  return explicit ?? findProjectRoot(fallbackDir) ?? fallbackDir;
}

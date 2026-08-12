/**
 * Verdict computation helpers for the CLI.
 *
 * The agent-skills package emits CAPABILITY_* observations from compat
 * detectors. The marketplace package owns the verdict engine that combines
 * those observations with declared targets to produce COMPAT_TARGET_*
 * verdicts. The CLI sits above both packages and is the natural home for
 * stitching them together for the validate / build / audit commands.
 *
 * Verdict computation does not live in agent-skills (which would otherwise
 * have to depend on marketplace, reversing the existing dependency arrow)
 * nor in marketplace (which knows nothing about config-level packaging
 * options).
 */

import {
  type Observation,
  type PackagingValidationResult,
} from '@vibe-agent-toolkit/agent-skills';
import {
  computeVerdicts,
  resolveEffectiveTargets,
  type Target,
  type Verdict,
} from '@vibe-agent-toolkit/claude-marketplace';
import { CODE_REGISTRY, type ValidationIssue } from '@vibe-agent-toolkit/schema';
import { issueLocation } from '@vibe-agent-toolkit/utils';

/**
 * Convert a verdict into a ValidationIssue using CODE_REGISTRY for severity,
 * fix and reference. Pure function — no I/O.
 */
export function verdictToIssue(verdict: Verdict, location: string): ValidationIssue {
  const entry = CODE_REGISTRY[verdict.code];
  return {
    severity: entry.defaultSeverity,
    code: verdict.code,
    message: verdict.summary,
    location,
    fix: entry.fix,
    reference: entry.reference,
  };
}

/**
 * Compute compat verdicts for a skill given config-level targets.
 *
 * For validate / build / audit this is the layer that has visibility:
 * config-level targets only. Plugin-level and marketplace-level targets
 * are surfaced by the analyzer (`vat audit --compat`) which has its own
 * walk over plugin / marketplace manifests.
 *
 * Takes the skill's path plus the anchor root and re-bases internally rather
 * than accepting a pre-rendered `location`. That is deliberate: when this took
 * a caller-supplied location string, each of the four call sites got its own
 * chance to answer "relative to what?" and three answered "absolute" — one
 * `vat skill review --yaml` document ended up carrying two coordinate systems,
 * and `vat skills validate` leaked a full home-directory path. Owning the
 * re-base here makes that unrepresentable at every call site at once.
 */
export function computeConfigVerdicts(
  observations: readonly Observation[],
  configTargets: ReadonlyArray<Target> | undefined,
  skillSourcePath: string,
  locationRoot: string,
): ValidationIssue[] {
  if (observations.length === 0) {
    return [];
  }

  const effectiveTargets = resolveEffectiveTargets({
    configTargets: configTargets === undefined ? undefined : [...configTargets],
    pluginTargets: undefined,
    marketplaceTargets: undefined,
  });

  const verdicts = computeVerdicts({
    observations: [...observations],
    targets: effectiveTargets,
  });

  const location = issueLocation(skillSourcePath, locationRoot);
  return verdicts.map(v => verdictToIssue(v, location));
}

/**
 * Mutate a PackagingValidationResult in place to include compat verdicts
 * derived from the result's observations and the configured targets.
 *
 * Verdict issues land in `allErrors`, which is the sole container for every
 * emitted issue regardless of severity — callers derive the active partition
 * with `activeErrorsOf` / `activeWarningsOf` rather than reading a second
 * pre-filtered copy. Verdicts are not allow-filterable.
 */
export function applyConfigVerdicts(
  result: PackagingValidationResult,
  configTargets: ReadonlyArray<Target> | undefined,
  skillSourcePath: string,
  locationRoot: string,
): void {
  const verdictIssues = computeConfigVerdicts(
    result.observations,
    configTargets,
    skillSourcePath,
    locationRoot,
  );
  if (verdictIssues.length === 0) {
    return;
  }
  result.allErrors.push(...verdictIssues);
  if (result.allErrors.some(issue => issue.severity === 'error')) {
    result.status = 'error';
  }
}


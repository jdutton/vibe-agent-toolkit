/**
 * The ONE construction site for an `EvidenceRecord`.
 *
 * Every evidence producer — the skill-level compat detectors and the
 * plugin-level marketplace scanners alike — routes through {@link buildEvidence}
 * so that an evidence `location` can only ever be a root-relative POSIX path.
 * Two independent copies of this helper previously existed, each taking a
 * pre-formed `filePath` and trusting it: one was handed absolute skill paths and
 * leaked the developer's home directory into audit output, the other was handed
 * plugin-relative paths and silently anchored them at a base the document never
 * stated. Making the root a REQUIRED parameter and relativizing in here makes
 * both shapes unrepresentable.
 */

import { issueLocation, safePath } from '@vibe-agent-toolkit/utils';

import { assertPatternRegistered, getPatternDefinition } from './pattern-registry.js';
import type { EvidenceRecord } from './types.js';

const SNIPPET_MAX = 120;

/** Truncate a matched fragment to a display-safe length. */
function snippet(s: string): string {
  const trimmed = s.trim();
  return trimmed.length <= SNIPPET_MAX ? trimmed : `${trimmed.slice(0, SNIPPET_MAX - 1)}…`;
}

/**
 * Anchor a file path at `locationRoot`, the way {@link buildEvidence} anchors
 * `location.file`.
 *
 * Exported for the one legitimate second use: a producer whose `matchText` names
 * the file it found, which must be spelled identically to the location rather
 * than leaking an absolute path into the rendered message. Do NOT reach for this
 * to hand `buildEvidence` a pre-relativized path — pass the root and let it
 * anchor.
 */
export function anchorEvidencePath(filePath: string, locationRoot: string): string {
  // resolve() first so an already-relative filePath round-trips unchanged and an
  // absolute one is re-based, rather than each caller guessing which it holds.
  return issueLocation(safePath.resolve(locationRoot, filePath), locationRoot);
}

/**
 * Build one evidence record, anchoring its `location.file` at `locationRoot`.
 *
 * @param patternId - Registered pattern ID; asserted against PATTERN_REGISTRY.
 * @param filePath - The file the pattern was seen in. Absolute, or already
 *   relative to `locationRoot` — both resolve to the same anchored location.
 * @param locationRoot - The ONE base this run states. Required: "relative to
 *   what?" has no safe default (see `issueLocation`).
 * @param matchText - What the detector saw; truncated for display.
 * @param line - 1-based line number, when the producer knows it.
 */
export function buildEvidence(
  patternId: string,
  filePath: string,
  locationRoot: string,
  matchText: string,
  line?: number,
): EvidenceRecord {
  assertPatternRegistered(patternId);
  const def = getPatternDefinition(patternId);
  const file = anchorEvidencePath(filePath, locationRoot);
  return {
    source: 'code',
    patternId,
    location: line === undefined ? { file } : { file, line },
    matchText: snippet(matchText),
    confidence: def?.confidence ?? 'medium',
  };
}

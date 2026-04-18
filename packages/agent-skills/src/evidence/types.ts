/**
 * Evidence substrate types.
 *
 * Evidence is a neutral, pattern-level observation produced by a parser:
 * "pattern X fired at location Y with match text Z." Evidence has no opinion
 * about whether the match is good or bad — that is the job of the derivation
 * layer, which rolls evidence into domain-specific observations.
 */

/** Where the evidence came from. */
export type EvidenceSource = 'code' | 'ai';

/** Inherent false-positive risk of the pattern. */
export type EvidenceConfidence = 'high' | 'medium' | 'low';

export interface EvidenceLocation {
  file: string;
  line?: number;
  col?: number;
}

export interface EvidenceRecord {
  source: EvidenceSource;
  /** Stable ID registered in PATTERN_REGISTRY. */
  patternId: string;
  location: EvidenceLocation;
  /** What the detector saw — short snippet, truncated for display. */
  matchText: string;
  confidence: EvidenceConfidence;
  /** AI-source: short "why"; code-source: rarely used. */
  rationale?: string;
}

export interface PatternDefinition {
  patternId: string;
  source: EvidenceSource;
  /** Human-readable description of what the pattern detects. */
  description: string;
  confidence: EvidenceConfidence;
}

/**
 * An observation is a derived capability-level claim about a skill or plugin,
 * referencing the evidence records that support it.
 */
export interface Observation {
  /** Validation code (e.g. 'CAPABILITY_LOCAL_SHELL'). */
  code: string;
  /** Human-readable claim. */
  summary: string;
  /** Payload specific to the observation code. */
  payload?: Record<string, unknown>;
  /** patternId[] of evidence records that support this observation. */
  supportingEvidence: string[];
}

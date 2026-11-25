export type {
  EvidenceRecord,
  EvidenceSource,
  EvidenceConfidence,
  EvidenceLocation,
  PatternDefinition,
  Observation,
} from './types.js';
export {
  PATTERN_REGISTRY,
  getPatternDefinition,
  assertPatternRegistered,
} from './pattern-registry.js';
export { anchorEvidencePath, buildEvidence } from './build-evidence.js';
export {
  deriveObservationsFromEvidence,
  type DeriveObservationsOptions,
  type DerivationSubject,
} from './derive-observations.js';
export {
  detectInterpreter,
  extractMcpCommandFromMatchText,
} from './interpreter-detection.js';

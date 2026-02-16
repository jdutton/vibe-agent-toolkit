/**
 * @vibe-agent-toolkit/claude-marketplace
 * Claude plugin marketplace tools: compatibility analysis, provenance tracking, enterprise config
 */

export type {
  CompatibilityEvidence,
  CompatibilityResult,
  EvidenceSource,
  Target,
  Verdict,
} from './types.js';

export { ALL_TARGETS } from './types.js';

export { analyzeCompatibility } from './compatibility-analyzer.js';

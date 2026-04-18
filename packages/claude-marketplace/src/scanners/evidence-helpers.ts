/**
 * Shared helpers for marketplace scanner evidence emission.
 */

import {
  assertPatternRegistered,
  getPatternDefinition,
  type EvidenceRecord,
} from '@vibe-agent-toolkit/agent-skills';

const SNIPPET_MAX = 120;

export function snippet(s: string): string {
  const trimmed = s.trim();
  return trimmed.length <= SNIPPET_MAX ? trimmed : `${trimmed.slice(0, SNIPPET_MAX - 1)}…`;
}

export function buildEvidence(
  patternId: string,
  filePath: string,
  matchText: string,
  line?: number,
): EvidenceRecord {
  assertPatternRegistered(patternId);
  const def = getPatternDefinition(patternId);
  return {
    source: 'code',
    patternId,
    location: line === undefined ? { file: filePath } : { file: filePath, line },
    matchText: snippet(matchText),
    confidence: def?.confidence ?? 'medium',
  };
}

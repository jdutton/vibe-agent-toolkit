/**
 * Roll plugin-level evidence records up into capability observations.
 *
 * Shares the derivation logic with agent-skills; plugins include more
 * shell-related patterns (hooks, script files) than SKILL.md alone.
 */

import {
  deriveObservationsFromEvidence,
  type EvidenceRecord,
  type Observation,
} from '@vibe-agent-toolkit/agent-skills';

const PLUGIN_LOCAL_SHELL_PATTERN_IDS: ReadonlySet<string> = new Set([
  'FENCED_SHELL_BLOCK',
  'ALLOWED_TOOLS_LOCAL_SHELL',
  'PROSE_LOCAL_SHELL_TOOL_REFERENCE',
  'HOOK_COMMAND_INVOKES_BINARY',
  'SCRIPT_FILE_PYTHON',
  'SCRIPT_FILE_SHELL',
  'SCRIPT_FILE_NODE',
]);

export function deriveScannerObservations(evidence: readonly EvidenceRecord[]): Observation[] {
  return deriveObservationsFromEvidence(evidence, {
    localShellPatternIds: PLUGIN_LOCAL_SHELL_PATTERN_IDS,
    subject: 'plugin',
  });
}

/**
 * Code-block scanner for marketplace plugin analysis.
 *
 * Delegates to the agent-skills compat detectors so that markdown content
 * inside plugins is analysed with the same rules used for standalone
 * skill validation. This emits FENCED_SHELL_BLOCK and EXTERNAL_CLI_*
 * evidence (browser-auth detection lives in scanBrowserAuthEvidence).
 */

import { runCompatDetectors, type EvidenceRecord } from '@vibe-agent-toolkit/agent-skills';

const SHELL_AND_BROWSER_PATTERN_PREFIXES = ['FENCED_SHELL_BLOCK', 'EXTERNAL_CLI_', 'BROWSER_AUTH_'];

function isCodeBlockEvidence(record: EvidenceRecord): boolean {
  return SHELL_AND_BROWSER_PATTERN_PREFIXES.some(prefix => record.patternId.startsWith(prefix));
}

/**
 * Scan markdown content for fenced shell blocks and the external-CLI /
 * browser-auth invocations they may contain. Returns an EvidenceRecord
 * for each detected pattern.
 */
export function scanCodeBlocks(content: string, filePath: string): EvidenceRecord[] {
  const { evidence } = runCompatDetectors(content, filePath);
  // Filter to evidence types this scanner is responsible for: shell-block /
  // external-CLI / browser-auth. Frontmatter-scoped evidence is emitted by
  // scanFrontmatter.
  return evidence.filter(isCodeBlockEvidence);
}

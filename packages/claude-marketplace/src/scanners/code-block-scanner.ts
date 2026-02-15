import type { CompatibilityEvidence } from '../types.js';

import { COMMAND_RULES } from './command-classifier.js';

const EXECUTABLE_LANGUAGES = new Set(['bash', 'sh', 'shell', 'zsh', '']);

/** Regex to extract fenced code blocks: ```lang\ncontent\n``` */
const CODE_BLOCK_RE = /^```(\w*)\n([\s\S]*?)^```/gm;

/**
 * Scan markdown content for fenced code blocks containing command invocations.
 * Only scans blocks with executable languages (bash, sh, shell, zsh, unlabeled).
 */
export function scanCodeBlocks(content: string, filePath: string): CompatibilityEvidence[] {
  const evidence: CompatibilityEvidence[] = [];

  for (const match of content.matchAll(CODE_BLOCK_RE)) {
    const language = match[1] ?? '';
    const blockContent = match[2] ?? '';
    const blockStartOffset = match.index ?? 0;
    const blockLine = content.slice(0, blockStartOffset).split('\n').length;

    if (!EXECUTABLE_LANGUAGES.has(language)) continue;

    for (const rule of COMMAND_RULES) {
      if (rule.pattern.test(blockContent)) {
        evidence.push({
          source: 'code-block',
          file: filePath,
          line: blockLine,
          signal: rule.signal,
          detail: `Found "${rule.signal}" command in ${language || 'unlabeled'} code block`,
          impact: { ...rule.impact },
        });
      }
    }
  }

  return evidence;
}

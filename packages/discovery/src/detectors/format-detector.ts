import * as path from 'node:path';

import type { DetectedFormat } from '../types.js';

/**
 * Detect file format based on filename
 *
 * Detection rules:
 * - Exact match "SKILL.md" → claude-skill
 * - Exact match "agent.yaml" or "agent.yml" → vat-agent
 * - Extension ".md" → markdown
 * - Everything else → unknown
 *
 * @param filePath - Path to file (can be relative or absolute)
 * @returns Detected format
 */
export function detectFormat(filePath: string): DetectedFormat {
  const basename = path.basename(filePath);

  // Exact matches (case-sensitive)
  if (basename === 'SKILL.md') {
    return 'claude-skill';
  }

  if (basename === 'agent.yaml' || basename === 'agent.yml') {
    return 'vat-agent';
  }

  // Extension-based detection (case-insensitive)
  if (basename.toLowerCase().endsWith('.md')) {
    return 'markdown';
  }

  return 'unknown';
}

/**
 * Help loader - reads verbose help from markdown files
 * Markdown docs are the source of truth for CLI help
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Load verbose help from markdown files in packages/cli/docs/
 *
 * @param section - Optional section name (e.g., 'resources'). If not provided, loads index.md
 * @returns Markdown content as string
 */
export function loadVerboseHelp(section?: string): string {
  // Get package root (packages/cli/)
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const packageRoot = join(__dirname, '../..');

  // Determine which markdown file to load
  const filename = section ? `${section}.md` : 'index.md';
  const helpPath = join(packageRoot, 'docs', filename);

  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path is constructed from known safe components
    const content = readFileSync(helpPath, 'utf-8');
    return content;
  } catch (error) {
    // Fallback if markdown file not found
    const errorMessage = error instanceof Error ? error.message : String(error);
    return `# Help Documentation Not Found

Error loading help from ${helpPath}

${errorMessage}

Please report this issue at: https://github.com/jdutton/vibe-agent-toolkit/issues
`;
  }
}

import yaml from 'yaml';

export interface FrontmatterSuccess {
  success: true;
  frontmatter: Record<string, unknown>;
  body: string;
}

export interface FrontmatterError {
  success: false;
  error: string;
}

export type FrontmatterResult = FrontmatterSuccess | FrontmatterError;

/**
 * Parse YAML frontmatter from SKILL.md content
 *
 * Expected format:
 * ```
 * ---
 * name: skill-name
 * description: Description here
 * ---
 * Body content...
 * ```
 *
 * @param content - Full SKILL.md content
 * @returns Parsed frontmatter and body, or error
 */
export function parseFrontmatter(content: string): FrontmatterResult {
  // Normalize line endings
  const normalized = content.replaceAll('\r\n', '\n');

  // Check for opening delimiter at start
  if (!normalized.startsWith('---\n')) {
    return {
      success: false,
      error: 'No frontmatter found - must start at beginning with "---" delimiter',
    };
  }

  // Find closing delimiter
  const closingIndex = normalized.indexOf('\n---\n', 4);
  const closingIndexAlt = normalized.indexOf('\n---', 4);

  if (closingIndex === -1 && closingIndexAlt === -1) {
    return {
      success: false,
      error: 'No closing delimiter found',
    };
  }

  // Extract YAML content (between delimiters)
  const actualClosingIndex = closingIndex === -1 ? closingIndexAlt : closingIndex;
  const yamlContent = normalized.slice(4, actualClosingIndex);

  // Extract body (after closing delimiter)
  const bodyStartIndex = actualClosingIndex + 4; // Skip "\n---"
  const body = bodyStartIndex < normalized.length
    ? normalized.slice(bodyStartIndex + 1) // Skip newline after ---
    : '';

  // Parse YAML
  try {
    const frontmatter = yaml.parse(yamlContent) as Record<string, unknown>;

    return {
      success: true,
      frontmatter,
      body,
    };
  } catch (error) {
    return {
      success: false,
      error: `Failed to parse YAML frontmatter: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

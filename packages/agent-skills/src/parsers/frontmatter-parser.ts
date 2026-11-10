import yaml from 'yaml';

export interface FrontmatterSuccess {
  success: true;
  frontmatter: Record<string, unknown>;
  body: string;
}

export interface FrontmatterError {
  success: false;
  error: string;
  /**
   * What the YAML parser threw, or `undefined` for a refusal this parser made
   * itself (no delimiter, not a mapping). Carried so a caller can classify the
   * throw — a stack overflow on deeply nested YAML is a parse LIMIT, not missing
   * frontmatter — without reading `error`'s text.
   */
  cause: unknown;
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
      cause: undefined,
    };
  }

  // Find closing delimiter
  const closingIndex = normalized.indexOf('\n---\n', 4);
  const closingIndexAlt = normalized.indexOf('\n---', 4);

  if (closingIndex === -1 && closingIndexAlt === -1) {
    return {
      success: false,
      error: 'No closing delimiter found',
      cause: undefined,
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
  let parsed: unknown;
  try {
    parsed = yaml.parse(yamlContent);
  } catch (error) {
    return {
      success: false,
      error: `Failed to parse YAML frontmatter: ${error instanceof Error ? error.message : String(error)}`,
      cause: error,
    };
  }

  // A block that parsed but is not a mapping is refused HERE, once. `yaml.parse`
  // answers `null` for an empty document or `~`, a string for a bare scalar, an
  // array for a sequence — and the success arm promises `Record<string,
  // unknown>`, so every reader dereferenced it. `validateSkill` died with
  // `Cannot read properties of null (reading 'name')` and took the whole
  // `vat audit` run with it, while two other readers had grown their own `null`
  // guards: three consumers of one seam, three answers for one file. The
  // refusal names what was found, because "no frontmatter" over a file that
  // plainly has a `---` block sends the author to the wrong fix.
  if (parsed === null || parsed === undefined || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      success: false,
      error: `Frontmatter is not a YAML mapping: the block between the "---" delimiters is ${describeNonMapping(parsed)}`,
      cause: undefined,
    };
  }

  return {
    success: true,
    frontmatter: parsed as Record<string, unknown>,
    body,
  };
}

/** The shape a non-mapping frontmatter block turned out to be, for the refusal message. */
function describeNonMapping(parsed: unknown): string {
  if (parsed === null || parsed === undefined) return 'empty';
  if (Array.isArray(parsed)) return 'a sequence, not key: value fields';
  return `a scalar (${JSON.stringify(parsed)}), not key: value fields`;
}

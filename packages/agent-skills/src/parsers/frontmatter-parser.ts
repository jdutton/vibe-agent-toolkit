import { isPlainMapping } from '@vibe-agent-toolkit/resources';
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

/** The refusal for a block that declares nothing. */
const EMPTY_BLOCK: FrontmatterError = {
      success: false,
      error: 'Frontmatter is empty: the block between the "---" delimiters declares no fields',
      cause: undefined,
    };

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

  // A block that declares NOTHING — empty, whitespace, comment-only, `~`, `null`
  // — is the rule `parseFrontmatterSource` (the crawl lane's decode) applies:
  // "no value" by the document's own word, NOT a non-mapping, and no keys. A
  // skill without frontmatter fields is not a skill, so it is refused — saying
  // it is empty, never that it is not a mapping — and the packaging lane, which
  // reads the crawl lane's absent `frontmatter`, refuses the same bytes.
  if (yamlContent.trim() === '') return EMPTY_BLOCK;

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

  if (parsed === null || parsed === undefined) return EMPTY_BLOCK;

  // A block that parsed but is not a PLAIN mapping is refused HERE, once, by
  // the rule every lane reads (`isPlainMapping`): a string for a bare scalar,
  // an array for a sequence, and the `Set` / `Map` / `Date` / `Uint8Array` of a
  // `!!set` / `!!omap` / `!!timestamp` / `!!binary` root. The success arm
  // promises `Record<string, unknown>`, so a typed root admitted here handed
  // every reader an object with no keys to read, while the crawl lane called the
  // same block "not a mapping". The refusal names what was found, because "no
  // frontmatter" over a file that plainly has a `---` block sends the author to
  // the wrong fix.
  if (!isPlainMapping(parsed)) {
    return {
      success: false,
      error: `Frontmatter is not a YAML mapping: the block between the "---" delimiters is ${describeNonMapping(parsed)}`,
      cause: undefined,
    };
  }

  return { success: true, frontmatter: parsed, body };
}

/** The shape a non-mapping frontmatter block turned out to be, for the refusal message. */
function describeNonMapping(parsed: unknown): string {
  if (Array.isArray(parsed)) return 'a sequence, not key: value fields';
  if (typeof parsed === 'object' && parsed !== null) {
    return `a typed value (${parsed.constructor.name}), not key: value fields`;
  }
  return `a scalar (${JSON.stringify(parsed)}), not key: value fields`;
}

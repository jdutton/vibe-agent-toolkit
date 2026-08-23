/**
 * Frontmatter YAML decoding, kept apart from the markdown parser.
 *
 * This function is the one piece of parsing a cache HIT still performs
 * (`parse-cache.ts` rehydrates `frontmatter` from the stored YAML source rather
 * than storing the parsed object). It lives in its own module because importing
 * it from `link-parser.js` dragged the entire remark stack with it — measured at
 * ~730ms of module load on Windows, on top of `yaml`'s own ~78ms — so a fully
 * warm scan, in which nothing is ever parsed, still paid to load a markdown
 * parser it never called.
 *
 * `link-parser.js` imports it and `parseMarkdownContent` still calls it, so cold
 * and warm continue to run the same code — the property the docstring below
 * exists to protect.
 */

import * as yaml from 'yaml';

/**
 * What a frontmatter block's YAML source means — the single implementation of
 * that decision.
 *
 * ## Why this is exported
 *
 * A parse cache stores {@link ParseResult.frontmatterSource} (the source is
 * JSON-safe; the parsed object is not) and must rebuild `frontmatter` /
 * `frontmatterError` on a hit. If it re-implemented the decision below it would
 * become a second implementation free to drift from this one — the same class
 * of defect as any parallel resolver. It calls this instead, so cold and warm
 * run *the same code*.
 *
 * The two properties that second caller depends on, and which must not be
 * broken: it is **pure** (no state, no I/O, no AST) and **total** (never
 * throws, for any string — a YAML failure comes back as `frontmatterError`).
 *
 * ## Acceptance rules (behaviour-preserving — do not "improve" these)
 *
 * - Empty or whitespace-only source → `{}`. No frontmatter, no error.
 * - Parses to a non-null, non-array object → `{ frontmatter }`.
 * - Parses to anything else (a bare scalar, `null`, a sequence) → `{}`. The
 *   value is silently ignored, exactly as it always has been.
 * - Throws → `{ frontmatterError }`.
 *
 * Keys are spread conditionally, so the result never carries an
 * undefined-valued key (see {@link cleanupEmptyChildren} for why that matters).
 *
 * @param source - A frontmatter block's YAML body, delimiters excluded
 * @returns The frontmatter object, the error message, or neither
 */
export function parseFrontmatterSource(source: string): {
  frontmatter?: Record<string, unknown>;
  frontmatterError?: string;
} {
  if (source.trim() === '') {
    // Empty frontmatter block
    return {};
  }

  try {
    const parsed: unknown = yaml.parse(source);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return { frontmatter: parsed as Record<string, unknown> };
    }
    return {};
  } catch (error) {
    // Capture YAML parsing error for validation reporting
    return { frontmatterError: error instanceof Error ? error.message : String(error) };
  }
}

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
  const decoded = decodeFrontmatter(source);
  switch (decoded.kind) {
    case 'mapping': {
      return { frontmatter: decoded.value };
    }
    case 'error': {
      return { frontmatterError: decoded.message };
    }
    // Behaviour-preserving: every other value is silently ignored.
    case 'blank':
    case 'null':
    case NON_MAPPING: {
      return {};
    }
  }
}

/**
 * Whether a frontmatter block is valid YAML that decodes to a sequence or a
 * scalar — the ONE statement of that rule, read by the projection's
 * `blob_conditions` and by the OKF judges alike.
 *
 * ## Why it is not a key on {@link parseFrontmatterSource}'s result
 *
 * That result is spread into every `ParseResult` (cold, cache hit, worker
 * pool), and its "no undefined-valued key, nothing beyond these two" shape is
 * pinned; a third key would change what every parse carries to serve two
 * readers on a rare path. Both come from {@link decodeFrontmatter}, so they
 * cannot disagree about where "not a mapping" begins.
 *
 * A block that declares NOTHING — `~`, `null`, comment-only — is not flagged: it
 * is "no value" by the document's own word. Blank, a mapping and invalid YAML
 * are not flagged either; the last is `frontmatterError`'s. Total, like the parse.
 *
 * @param source - A frontmatter block's YAML body, or `undefined` for no block
 * @returns True for a sequence or a scalar
 */
export function frontmatterIsNonMapping(source: string | undefined): boolean {
  return source !== undefined && decodeFrontmatter(source).kind === NON_MAPPING;
}

/** A sequence or a scalar: valid YAML that is not a mapping and not null. */
const NON_MAPPING = 'non-mapping';

/** What a frontmatter source decodes to — every case the two readers above tell apart. */
type FrontmatterDecode =
  | { readonly kind: 'blank' }
  | { readonly kind: 'mapping'; readonly value: Record<string, unknown> }
  | { readonly kind: 'null' }
  | { readonly kind: typeof NON_MAPPING }
  | { readonly kind: 'error'; readonly message: string };

/**
 * Decode a frontmatter source once — pure and total.
 *
 * @param source - A frontmatter block's YAML body, delimiters excluded
 * @returns The decode's kind, with the mapping or the error message
 */
function decodeFrontmatter(source: string): FrontmatterDecode {
  if (source.trim() === '') return { kind: 'blank' };
  let parsed: unknown;
  try {
    parsed = yaml.parse(source);
  } catch (error) {
    // Captured for validation reporting, never thrown: the parse cache calls
    // this on a stored string and must never see it throw.
    return { kind: 'error', message: error instanceof Error ? error.message : String(error) };
  }
  if (parsed === null) return { kind: 'null' };
  if (typeof parsed === 'object' && !Array.isArray(parsed)) {
    return { kind: 'mapping', value: parsed as Record<string, unknown> };
  }
  return { kind: NON_MAPPING };
}

/**
 * Frontmatter YAML decoding: the one place a frontmatter block's YAML is
 * decoded, run by the markdown parser inside a parse worker.
 *
 * ## Why only the worker runs it
 *
 * `yaml`'s composer recurses once per nesting level, so a deep block overflows
 * the stack of whatever thread decodes it: on the main thread a 1,000-level
 * `a: [[[…]]]` already does. A decode on the parent would therefore be an
 * unbounded parse beside the bounded one (ADR I8), and its outcome would hang
 * on the thread's stack, not on the bytes. So the worker decodes, under its
 * `stackMb`, and sends the mapping back encoded (`frontmatter-codec.ts`); the
 * parent and a parse-cache hit rebuild it from that encoding and never call
 * this module. Neither `parse-cache.ts` nor `parse-pool.ts` imports it.
 */

import * as yaml from 'yaml';

import { isPlainMapping } from './frontmatter-codec.js';
import { isStackOverflow } from './parse-limits.js';

/**
 * What a frontmatter block's YAML source means — the single implementation of
 * that decision.
 *
 * ## Acceptance rules (behaviour-preserving — do not "improve" these)
 *
 * - Empty, whitespace-only, or decoding to YAML `null` (`~`, `null`,
 *   comment-only) → `{}`. The block declares nothing; no error.
 * - Parses to a PLAIN mapping (prototype `Object.prototype` or `null`,
 *   {@link isPlainMapping}) → `{ frontmatter }`.
 * - Parses to anything else — a sequence, a scalar, or a non-plain object such
 *   as the `Set` of a `!!set` root, the `Map` of `!!omap`, the `Date` of
 *   `!!timestamp` or the `Buffer` of `!!binary` → `{ frontmatterNotAMapping: true }`:
 *   no keys can be read from it, and the projection's `blob_conditions` and the
 *   OKF judges say so. A non-plain root admitted as `frontmatter` would reach a
 *   parent that cannot rebuild it (the codec's decode accepts only a mapping
 *   root) and every consumer that reads keys off it. Carried on the result because only the decoded VALUE
 *   tells it from a block that declares nothing, and the parent never decodes.
 * - Invalid YAML → `{ frontmatterError }`: a function of the bytes.
 * - A stack overflow, bare or wrapped by `yaml` → **thrown**. It is a `stackMb`
 *   breach, a function of the thread's stack and never of the bytes, so it must
 *   not become a `frontmatterError` a cache would store (ADR I6). The worker
 *   reports it as the breach.
 *
 * Keys are spread conditionally, so the result never carries an
 * undefined-valued key.
 *
 * @param source - A frontmatter block's YAML body, delimiters excluded
 * @returns The frontmatter object, the error message, the non-mapping flag, or none of them
 * @throws The stack overflow, when decoding the block overflowed this thread's stack
 */
export function parseFrontmatterSource(source: string): {
  frontmatter?: Record<string, unknown>;
  frontmatterError?: string;
  frontmatterNotAMapping?: true;
} {
  if (source.trim() === '') return {};
  let parsed: unknown;
  try {
    parsed = yaml.parse(source);
  } catch (error) {
    if (isStackOverflow(error)) throw error;
    return { frontmatterError: error instanceof Error ? error.message : String(error) };
  }
  if (parsed === null) return {};
  if (isPlainMapping(parsed)) return { frontmatter: parsed };
  return { frontmatterNotAMapping: true };
}

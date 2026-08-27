/**
 * The one definition of the markdown processor VAT parses with.
 *
 * Three call sites need the SAME plugin list and would otherwise each spell it
 * out: the parser itself (`link-parser.ts`), the tokenize/tree-build split probe
 * (`parse-tokenize-probe.ts`), and any benchmark measuring a rival parser
 * against this one. A rival benchmarked against a processor missing a plugin is
 * a rival that was handed less work to do, and the resulting ratio is wrong in
 * the direction that flatters the challenger.
 *
 * ⚠️ Do not memoise the returned processor. `parseMarkdownContent` builds a new
 * one per document on purpose and times that construction as its own pass —
 * `remark-processor`, ~0.004 ms/doc, which is what makes "the processor is not
 * the cost" a measured statement rather than an assumption.
 */

import remarkFrontmatter from 'remark-frontmatter';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';

/**
 * The plugin chain, composed once so its type can be inferred.
 *
 * Spelled apart from the exported function only because `remark-frontmatter`'s
 * overloads make the composed type a union TypeScript will not let an explicit
 * annotation collapse. Inference gets it right; a hand-written annotation
 * either loses information or needs a cast.
 *
 * @returns The composed processor
 */
function composeMarkdownProcessor() {
  return unified().use(remarkParse).use(remarkGfm).use(remarkFrontmatter);
}

/**
 * Compose the markdown processor.
 *
 * `remark-gfm` is load-bearing rather than decorative: its autolink literals
 * produce real `link` nodes, so dropping it changes VAT's link inventory and
 * not merely its timings.
 *
 * @returns An unfrozen processor; `parse()` freezes it on first use
 */
export function createMarkdownProcessor(): ReturnType<typeof composeMarkdownProcessor> {
  return composeMarkdownProcessor();
}

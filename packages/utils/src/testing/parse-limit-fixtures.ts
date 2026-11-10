/**
 * Fixture documents that breach ONE parse limit and no other, whatever heap
 * the process runs under.
 */

import { randomUUID } from 'node:crypto';

/** Rows over the default `outputRows` limit (16,384) by a clear margin. */
const OVER_OUTPUT_ROWS = 20_000;

/**
 * A markdown document over the default parse `outputRows` limit (16,384), and
 * far under every other limit — the heap included.
 *
 * The rows are a frontmatter sequence of 20,000 integers (~130 KB, under 100 ms
 * to parse). Body links would breach the same limit only by building a parse
 * tree whose live heap peaks at 300 to 400 MiB (measured, 20,000 links, Node
 * 26): over the 256 MiB heap limit the pool applies under a process-wide
 * `--max-old-space-size=512`, as CI runs, so that fixture was refused at
 * `heapMb` instead — on one host and not another.
 *
 * The leading nonce makes the bytes new to the shared parse cache: an
 * in-process parse of identical content elsewhere stores unbounded facts under
 * the same content key, and a later crawl serves that entry as an admission.
 *
 * @param target - The file the body's one link points at
 * @returns The document
 */
export function overOutputRowsMarkdown(target: string): string {
  const items = Array.from({ length: OVER_OUTPUT_ROWS }, (_, index) => String(index)).join(', ');
  return `---\nnonce: ${randomUUID()}\nitems: [${items}]\n---\n\n# Reference\n\n[l](./${target})\n`;
}

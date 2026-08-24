/**
 * Pure link classification and size estimation — no markdown parser behind it.
 *
 * These three helpers are needed by callers that never parse a document:
 * `types.ts` re-exports `classifyLink`, `blob-sections.ts` calls
 * `estimateTokens`, and `frontmatter-link-validator.ts` classifies hrefs it read
 * from YAML. While they lived in `link-parser.ts` every one of those importers
 * pulled the whole remark stack with them — ~500-730ms of module load on
 * Windows — which is what made `parse-cache.ts`'s deferral of the parsers buy
 * nothing: `types.js` had already loaded it.
 *
 * Keep this module dependency-free apart from the `LinkType` TYPE (erased at
 * runtime, so it creates no cycle with `types.ts`). Anything needing an AST
 * belongs in `link-parser.ts`.
 */

import type { LinkType } from './types.js';

/**
 * VAT's token estimate for a span of text: one token per four characters.
 *
 * A deliberately crude, tokenizer-free approximation — no model's vocabulary is
 * consulted, so the number is comparable across documents rather than accurate
 * for any one model. It exists as a function because more than one caller needs
 * it: {@link parseMarkdownContent} reports it per document as
 * `estimatedTokenCount`, and `blobSectionsFor` reports it per section. Restating
 * `Math.ceil(text.length / 4)` at each site is how an estimator drifts.
 *
 * The input is a **decoded** string, so this counts UTF-16 code units, not bytes
 * on disk — the same unit `ContentMeasures` (`proseCodeUnits` /
 * `codeBlockCodeUnits`) reports in. The one size column that is not code units
 * is `blob_sections.bytes`, which is a real UTF-8 byte count and says so.
 *
 * @param text - Decoded text to estimate
 * @returns Estimated token count, rounded up
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Classify a link based on its href shape.
 *
 * Public so frontmatter-link validation can reuse identical URI classification
 * logic (markdown links and frontmatter URI-reference values share one
 * classifier).
 *
 * @param href - The href attribute from the link
 * @returns Classified link type
 *
 * @example
 * ```typescript
 * classifyLink('https://example.com') // 'external'
 * classifyLink('mailto:user@example.com') // 'email'
 * classifyLink('#heading') // 'anchor'
 * classifyLink('./file.md') // 'local_file'
 * classifyLink('./file.md#anchor') // 'local_file'
 * classifyLink('docs/') // 'local_directory'
 * classifyLink('./docs/') // 'local_directory'
 * classifyLink('../docs/') // 'local_directory'
 * classifyLink('/docs/') // 'local_directory'
 * classifyLink('https://x.com/docs/') // 'external' (not a local ref)
 * classifyLink('//cdn.example.com/x.js') // 'external' (protocol-relative)
 * ```
 */
export function classifyLink(href: string): LinkType {
  // B4: `//`-prefixed is grouped with `http(s)://` rather than getting its own
  // `if`, and that is not just a style choice — a `//`-prefixed href is a
  // network-path reference (RFC 3986 §4.2): same scheme as the referring
  // document, different AUTHORITY (`cdn.example.com`), not a root-relative
  // path on this document's own host. It carries no `:`, so it used to fall
  // through every protocol check and land on `href.startsWith('/')` far
  // below — true for `//...` as much as for `/...` — and come back
  // `local_file`: a link this package would then try to resolve and validate
  // against the local filesystem, which is usually "silently never checked"
  // rather than "checked and wrong", since a resolver handed a bogus local
  // path typically reports it broken or skips it, neither of which is the
  // truth about an external URL. Must be tested BEFORE the later
  // `startsWith('/')` branch, which is why it sits at the top with the other
  // protocol checks — it IS a protocol check, just one whose protocol is
  // implicit rather than spelled out.
  if (href.startsWith('http://') || href.startsWith('https://') || href.startsWith('//')) {
    return 'external';
  }
  if (href.startsWith('mailto:')) {
    return 'email';
  }
  if (href.startsWith('#')) {
    return 'anchor';
  }
  // Self-contained inline resources: a data: URI embeds its payload and a blob:
  // URL references an in-memory object. Neither has a target to fetch or an
  // anchor to resolve, so they are valid-but-nothing-to-validate (skipped), not
  // "unknown". Common in HTML (inline SVG/PNG/GIF logos).
  if (href.startsWith('data:') || href.startsWith('blob:')) {
    return 'embedded';
  }
  // Any remaining href containing ':' is a protocol-like pattern we don't recognise
  // (e.g., javascript:, tel:, ftp:) — classify as unknown rather than local file
  if (href.includes(':')) {
    return 'unknown';
  }
  // Local directory: path component (before any # or ?) ends in '/'.
  // Must come after all protocol guards so external URLs are never reclassified.
  const pathPart = href.split(/[#?]/u)[0] ?? href;
  if (pathPart.endsWith('/')) {
    return 'local_directory';
  }
  // Links with anchors are still local file links
  if (href.includes('#')) {
    return 'local_file';
  }
  // .md files are always local files
  if (href.endsWith('.md')) {
    return 'local_file';
  }
  // Paths that look like file paths (start with ./ or ../ or /) or have no extension
  if (href.startsWith('./') || href.startsWith('../') || href.startsWith('/')) {
    return 'local_file';
  }
  // Paths without extensions (no dot or last dot is before a slash)
  const lastSlash = href.lastIndexOf('/');
  const lastDot = href.lastIndexOf('.');
  if (lastDot === -1 || lastDot < lastSlash) {
    return 'local_file';
  }
  // Bare relative paths with file extensions (e.g., "files/doc.pdf")
  // If it contains a slash but doesn't look like a protocol (no "://"), it's a file path
  if (lastSlash >= 0 && !href.includes('://')) {
    return 'local_file';
  }
  // URL-decode and check if it looks like a relative file path
  // (e.g., "My%20Document.pdf" decodes to "My Document.pdf")
  try {
    const decoded = decodeURIComponent(href);
    if (decoded !== href) {
      return 'local_file';
    }
  } catch {
    // Invalid percent encoding — leave as unknown
  }
  // Bare filenames with extensions (e.g., "config.schema.json", "image.png")
  if (href.includes('.')) {
    return 'local_file';
  }
  return 'unknown';
}

/**
 * Returns true for link types that represent local filesystem targets — both
 * regular files and directories. Other packages (e.g. agent-skills walker)
 * import this predicate as the single source of truth for "should we treat
 * this link like a file link during validation/traversal?"
 *
 * @param type - The classified link type
 * @returns `true` for `'local_file'` and `'local_directory'`
 */
export function isLocalFileLink(type: LinkType): boolean {
  return type === 'local_file' || type === 'local_directory';
}

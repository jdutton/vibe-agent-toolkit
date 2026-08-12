/**
 * Markdown link parser and shared resource-parsing types.
 *
 * Parses markdown files to extract:
 * - Links (regular, reference-style, autolinks)
 * - Headings (with GitHub-style slugs and nested tree structure)
 * - File size and token estimates
 *
 * Uses unified/remark for robust markdown parsing with GFM support.
 *
 * Also defines the format-neutral `ParseResult` contract shared with the HTML
 * parser (`html-link-parser.ts`). The `HtmlParseError` shape is Zod-sourced
 * from `schemas/resource-metadata.ts` (single source of truth).
 */

import { readFile, stat } from 'node:fs/promises';

import GithubSlugger from 'github-slugger';
import type { Definition, Heading, Html, Link, LinkReference, Root, Yaml } from 'mdast';
import { toString as mdastToString } from 'mdast-util-to-string';
import remarkFrontmatter from 'remark-frontmatter';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';
import { visit } from 'unist-util-visit';
import * as yaml from 'yaml';

import { findLexicalReferences, type LexicalReference } from './reference-lexer.js';
import type { HtmlParseError } from './schemas/resource-metadata.js';
import type { HeadingNode, LinkType, ResourceLink, UnresolvedReference } from './types.js';
import { findUnresolvedReferences } from './unresolved-references.js';

/**
 * Result of parsing a resource file (markdown or HTML).
 */
export interface ParseResult {
  links: ResourceLink[];
  headings: HeadingNode[];
  frontmatter?: Record<string, unknown>;
  frontmatterError?: string;
  /**
   * The frontmatter block's YAML **source**, delimiters excluded, exactly as
   * the mdast `yaml` node carried it.
   *
   * Absent (key omitted) when the document has no frontmatter block at all;
   * present-and-empty (`''`) for a block whose body is empty — so "empty block"
   * stays distinguishable from "no block", which is a distinction neither
   * {@link frontmatter} nor {@link frontmatterError} can make (an empty block
   * leaves both absent, exactly as no block does).
   *
   * ## Why the source is carried next to the parsed object
   *
   * {@link frontmatter} cannot survive a JSON round trip, so nothing that
   * stores a `ParseResult` as JSON — a disk-backed parse cache, chiefly — can
   * reconstruct it from that field. Measured: `yaml` decodes `.inf` to
   * `Infinity`, `.nan` to `NaN` and `!!binary` to a `Buffer`; `JSON.stringify`
   * then maps the first two to `null` and mangles the third into an envelope
   * object, and a cyclic YAML anchor makes it throw outright — meaning such a
   * document could not be stored at all.
   *
   * Storing the source and re-running {@link parseFrontmatterSource} on a hit
   * is lossless **by construction**, because it is literally the same
   * computation the cold path runs. That is the only reason this field exists;
   * it is not a convenience copy.
   *
   * HTML documents leave it undefined, exactly as they leave
   * {@link frontmatter} undefined.
   */
  frontmatterSource?: string;
  content: string;
  sizeBytes: number;
  estimatedTokenCount: number;
  /**
   * Fragment targets declared as `id`/`name` attributes. HTML documents index
   * every element's; markdown indexes those in raw-HTML nodes (lowercased, to
   * match markdown's case-folded fragment policy) and omits the key entirely
   * when a document declares none.
   */
  anchors?: string[];
  /** HTML well-formedness diagnostics. Markdown leaves this undefined. */
  parseErrors?: HtmlParseError[];
  /**
   * Full (`[text][label]`) and collapsed (`[label][]`) reference-style link
   * occurrences whose label has no matching `[label]: url` definition. HTML
   * leaves this undefined; markdown always populates it (possibly empty).
   */
  unresolvedReferences?: UnresolvedReference[];
  /**
   * Reference candidates the markdown AST cannot produce: `@`-prefixed tokens,
   * variable-anchored paths, and bounded path-shaped bare tokens. See
   * `reference-lexer.ts` for what qualifies and what is excluded.
   *
   * The key is **omitted** when a document has none, matching {@link anchors}:
   * no own property of a `ParseResult` is ever valued `undefined`, which is
   * what makes the cache's JSON round trip exact under `toStrictEqual`. HTML
   * documents leave it undefined.
   */
  lexicalReferences?: LexicalReference[];
}

/**
 * Parse a markdown file and extract all links, headings, and metadata.
 *
 * Reads the bytes, then delegates every parsing decision to
 * {@link parseMarkdownContent}. The only thing decided here is the byte size
 * attributed to the document: `stat().size`, the real size on disk.
 *
 * @param filePath - Absolute path to the markdown file
 * @returns Parsed markdown data including links, headings, size, and token estimate
 * @throws Error if file cannot be read or parsed
 *
 * @example
 * ```typescript
 * const result = await parseMarkdown('/path/to/document.md');
 * console.log(`Found ${result.links.length} links`);
 * console.log(`Document has ${result.headings.length} top-level headings`);
 * ```
 */
export async function parseMarkdown(filePath: string): Promise<ParseResult> {
  // Read file content and stats
  const [content, stats] = await Promise.all([
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- filePath is user-provided path parameter
    readFile(filePath, 'utf-8'),
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- filePath is user-provided path parameter
    stat(filePath),
  ]);

  return parseMarkdownContent(content, stats.size);
}

/**
 * Parse markdown **source** — the content-addressable half of
 * {@link parseMarkdown}.
 *
 * This is a pure function of its two arguments: no filesystem access, no path,
 * no ambient state. That is what makes it cacheable by content, and it is what
 * a history replay needs — a historical blob read out of git is not on disk
 * under any path, so anything that insists on a `filePath` cannot parse it.
 * {@link parseMarkdown} is now just "read the bytes, then call this".
 *
 * ## Why `sizeBytes` is a parameter and NOT derived from `content`
 *
 * `content` is a **decoded** string; `sizeBytes` is a count of **bytes on
 * disk**. Those are not recoverable from one another:
 *
 * - `content.length` is UTF-16 code units — wrong for anything non-ASCII.
 * - `Buffer.byteLength(content, 'utf-8')` is the byte length of a *re-encoded*
 *   string, which diverges from the file's real size whenever the source bytes
 *   were not already well-formed UTF-8 (invalid sequences decode to U+FFFD and
 *   re-encode to three bytes each, so the round trip does not preserve length)
 *   — and it silently ignores a UTF-8 BOM the decoder stripped.
 *
 * The value reaches packaged-output accounting elsewhere in the toolkit, so it
 * must stay the caller's decision rather than a guess made here.
 * {@link parseMarkdown} passes `stat().size`, exactly as it always has; a
 * caller replaying a git blob passes that blob's byte length.
 *
 * @param content - Decoded markdown source
 * @param sizeBytes - Byte size the caller attributes to this content
 * @returns Parsed markdown data including links, headings, size, and token estimate
 *
 * @example
 * ```typescript
 * const result = parseMarkdownContent('# Title\n', 8);
 * console.log(`Found ${result.links.length} links`);
 * ```
 */
export function parseMarkdownContent(content: string, sizeBytes: number): ParseResult {
  const estimatedTokenCount = Math.ceil(content.length / 4);

  // Parse markdown with unified/remark
  const processor = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkFrontmatter);

  const tree = processor.parse(content) as Root;

  // Links, headings, raw-HTML anchors and frontmatter, from ONE tree walk
  const { links, headings, anchors, frontmatter, frontmatterError, frontmatterSource } =
    collectAstFacts(tree);

  // Detect dangling reference-style links (full/collapsed forms with no
  // matching definition) — see findUnresolvedReferences for why this is a
  // raw-source scan rather than an AST visit.
  const unresolvedReferences = findUnresolvedReferences(content, tree);

  // Reference candidates remark parses as plain text — `@`-prefixed tokens,
  // variable-anchored paths, path-shaped bare tokens. Also a raw-source scan,
  // and for the same structural reason.
  const lexicalReferences = findLexicalReferences(content, tree);

  // With exactOptionalPropertyTypes: true, we must conditionally include the property
  // rather than assigning undefined to it
  return {
    links,
    headings,
    unresolvedReferences,
    ...(lexicalReferences.length > 0 && { lexicalReferences }),
    ...(anchors.length > 0 && { anchors }),
    ...(frontmatter !== undefined && { frontmatter }),
    ...(frontmatterError !== undefined && { frontmatterError }),
    ...(frontmatterSource !== undefined && { frontmatterSource }),
    content,
    sizeBytes,
    estimatedTokenCount,
  };
}

/**
 * Everything a single walk of the markdown AST yields.
 *
 * `anchors` is always an array here (possibly empty); `parseMarkdownContent`
 * is what decides to omit the key entirely when a document declares none, so
 * the "absent, not empty" distinction lives at exactly one place.
 */
interface MarkdownAstFacts {
  links: ResourceLink[];
  headings: HeadingNode[];
  anchors: string[];
  frontmatter?: Record<string, unknown>;
  frontmatterError?: string;
  frontmatterSource?: string;
}

/**
 * Mutable state threaded through the single AST walk.
 *
 * The three link buckets exist because `links` is ordered **by node kind, not
 * by document position** — all `link`s, then all `linkReference`s, then all
 * `definition`s — a contract the parse-fact goldens pin by ordinal. A single
 * walk sees the three kinds interleaved, so it buckets them and concatenates
 * in kind order afterwards. Within a bucket, walk order IS document order.
 */
interface AstWalkState {
  /**
   * `[ref]: url` targets. Complete only once the walk finishes.
   *
   * FIXED (was a known defect): a duplicated `[ref]: url` label used to keep
   * the LAST definition, but CommonMark resolves a reference to the FIRST
   * one. For
   *
   *     A [ref][dup].
   *     [dup]: ./first.md
   *     [dup]: ./last.md
   *
   * every renderer links `[ref][dup]` to `./first.md`, so a LAST-wins map
   * made VAT check a target the reader never visits. Fixed by making this
   * write first-write-wins: `case 'definition'` only calls
   * `definitions.set(id, url)` when `!definitions.has(id)`, so the first
   * occurrence of a label sticks and later re-declarations of the same label
   * are ignored for resolution purposes (each still gets its own
   * `definitionLinks` entry — see below). Kept as documentation of the
   * CommonMark first-wins contract this map must uphold: a future refactor
   * that reintroduces an unconditional `.set()` here would silently regress
   * to last-wins.
   */
  definitions: Map<string, string>;
  /** `[text](href)` and autolinks. */
  inlineLinks: ResourceLink[];
  /** Deferred: resolving these needs the *completed* `definitions` map. */
  linkReferenceNodes: LinkReference[];
  /** `[ref]: url` definitions, as links in their own right. */
  definitionLinks: ResourceLink[];
  flatHeadings: HeadingNode[];
  /** Stateful: dedupes slugs in document order, exactly as GitHub does. */
  slugger: GithubSlugger;
  anchors: Set<string>;
  frontmatter?: Record<string, unknown>;
  frontmatterError?: string;
  frontmatterSource?: string;
}

/**
 * Node kinds {@link collectAstFacts} reacts to.
 *
 * Passed to `visit` as its test so the walk is still ONE traversal while the
 * visitor's parameter narrows to exactly these kinds — which is what lets
 * {@link collectNode}'s switch be exhaustive (and therefore lets the compiler
 * enforce that adding a kind here adds a case there).
 */
const COLLECTED_NODE_TYPES = [
  'link',
  'linkReference',
  'definition',
  'heading',
  'html',
  'yaml',
] as const;

/**
 * Walk the markdown AST **once** and extract every fact `parseMarkdown` needs.
 *
 * Replaces seven separate `visit()` passes (definitions, links, link
 * references, definitions again, raw HTML, headings, frontmatter) with a
 * single traversal dispatching on `node.type`. Each pass was a full tree walk,
 * so the tree was walked seven times per document to produce facts that are
 * all available from one; parsing dominates every resource-reading command in
 * the toolkit, and this is the cold path CI always pays.
 *
 * Output is byte-identical to the seven-pass version by construction: a
 * filtered `visit` yields nodes of its type in the same relative order an
 * unfiltered one does, so bucketing by kind and concatenating reproduces the
 * previous ordering exactly (see {@link AstWalkState}).
 *
 * @param tree - Markdown AST from unified/remark
 * @returns Links, heading tree, raw-HTML anchors and frontmatter
 */
function collectAstFacts(tree: Root): MarkdownAstFacts {
  const state: AstWalkState = {
    definitions: new Map<string, string>(),
    inlineLinks: [],
    linkReferenceNodes: [],
    definitionLinks: [],
    flatHeadings: [],
    slugger: new GithubSlugger(),
    anchors: new Set<string>(),
  };

  visit(tree, [...COLLECTED_NODE_TYPES], (node) => {
    collectNode(state, node);
  });

  return {
    links: [...state.inlineLinks, ...resolveLinkReferences(state), ...state.definitionLinks],
    headings: buildHeadingTree(state.flatHeadings),
    anchors: [...state.anchors],
    ...(state.frontmatter !== undefined && { frontmatter: state.frontmatter }),
    ...(state.frontmatterError !== undefined && { frontmatterError: state.frontmatterError }),
    ...(state.frontmatterSource !== undefined && { frontmatterSource: state.frontmatterSource }),
  };
}

/**
 * Record whatever one AST node contributes. Node kinds with nothing to
 * contribute (paragraphs, text, lists, tables, …) fall through untouched.
 */
function collectNode(
  state: AstWalkState,
  node: Definition | Heading | Html | Link | LinkReference | Yaml,
): void {
  switch (node.type) {
    case 'link': {
      state.inlineLinks.push(toResourceLink(node, extractLinkText(node), node.url, 'link'));
      break;
    }
    case 'linkReference': {
      state.linkReferenceNodes.push(node);
      break;
    }
    case 'definition': {
      if (!state.definitions.has(node.identifier)) {
        state.definitions.set(node.identifier, node.url);
      }
      state.definitionLinks.push(toResourceLink(node, node.identifier, node.url, 'definition'));
      break;
    }
    case 'heading': {
      state.flatHeadings.push(toFlatHeading(state.slugger, node));
      break;
    }
    case 'html': {
      collectHtmlAnchors(state.anchors, node);
      break;
    }
    case 'yaml': {
      collectFrontmatter(state, node);
      break;
    }
  }
}

/**
 * Build a `ResourceLink` from any of the three link-bearing node kinds.
 *
 * `text` and `href` are passed in because each kind derives them differently
 * (a `definition`'s text is its identifier and a `linkReference`'s href comes
 * from the definitions map, not the node), while position and classification
 * are shared.
 *
 * `line` is spread conditionally so the key is ABSENT rather than
 * undefined-valued when a node carries no position. See
 * {@link cleanupEmptyChildren} for why that distinction is load-bearing. This
 * particular guard is **defensive and currently unreachable**: remark sets
 * `position` on every node it produces, and a measured sweep of 265 tracked
 * markdown documents found zero position-less nodes, so no test can turn it
 * red. It is here to make "no own key of a `ParseResult` is ever valued
 * `undefined`" true by construction rather than true by luck.
 */
function toResourceLink(
  node: Definition | Link | LinkReference,
  text: string,
  href: string,
  nodeType: NonNullable<ResourceLink['nodeType']>,
): ResourceLink {
  return {
    text,
    href,
    type: classifyLink(href),
    ...(node.position !== undefined && { line: node.position.start.line }),
    nodeType,
  };
}

/**
 * Resolve the deferred `linkReference` nodes against the completed definitions
 * map, in document order.
 *
 * Invariant: every `linkReference` node reaching this point already has a
 * matching `definition` — CommonMark resolves link references at PARSE time,
 * so micromark only ever emits a `linkReference` node when a definition
 * matched. A reference with no matching definition never becomes a node at
 * all; it degrades to literal bracketed text in the AST (and in the rendered
 * document), which is exactly why an AST-based checker is structurally blind
 * to it. That dangling case is detected separately, by
 * `findUnresolvedReferences`'s raw-source scan (see `parseMarkdownContent` and
 * `unresolved-references.ts`), which reports it as
 * `LINK_UNRESOLVED_REFERENCE`.
 *
 * The `undefined` branch below is therefore NOT the dangling-reference case —
 * it is unreachable unless micromark's own parse-time contract breaks. It
 * degrades (skips the node) rather than throwing because `parseMarkdown` runs
 * over third-party markdown on the `vat audit` / `vat skills validate` paths:
 * a parser quirk must not abort a whole audit run (repo CLAUDE.md, "be liberal
 * in what you accept" for data we do not control).
 */
function resolveLinkReferences(state: AstWalkState): ResourceLink[] {
  const links: ResourceLink[] = [];
  for (const node of state.linkReferenceNodes) {
    const resolvedUrl = state.definitions.get(node.identifier);
    if (resolvedUrl === undefined) continue;
    links.push(toResourceLink(node, extractLinkText(node), resolvedUrl, 'linkReference'));
  }
  return links;
}

/**
 * Extract text content from a link node.
 *
 * Delegates to `mdast-util-to-string` (the canonical mdast text-extraction
 * implementation) rather than a hand-rolled walker — it recurses through
 * container inline nodes (`strong`, `emphasis`, `delete`, nested links) the
 * same way the previous walker did.
 *
 * `includeImageAlt: false` is passed explicitly: the library's default is
 * `true` (fold image/imageReference `alt` text into the result), but the
 * hand-rolled walker it replaced silently dropped image alt text. This
 * option pins the behavior to match — swapping the implementation must not
 * silently change extracted text (and, for headings, anchor slugs — see
 * {@link extractHeadingText}).
 *
 * @param node - Link or LinkReference node
 * @returns Text content of the link
 */
function extractLinkText(node: Link | LinkReference): string {
  return mdastToString(node, { includeImageAlt: false });
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
 * ```
 */
export function classifyLink(href: string): LinkType {
  if (href.startsWith('http://') || href.startsWith('https://')) {
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

/** `id="…"` / `name="…"` attribute, single- or double-quoted. */
const HTML_ANCHOR_ATTRIBUTE = /\b(?:id|name)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;

/**
 * Collect explicit fragment targets declared as raw HTML inside markdown.
 *
 * An author can write `<a id="short"></a>` above a long heading and link to
 * `#short`; GitHub renders that id into the DOM and the fragment resolves.
 * Indexing heading slugs alone therefore reports a working link as broken.
 *
 * Only mdast `html` nodes reach here, which is what keeps this honest: a
 * fenced block is a `code` node, an indented block is a `code` node, and a
 * backticked span is `inlineCode`, so an `<a id="…">` being *documented*
 * rather than *declared* is never indexed. That is the whole reason this
 * reads the AST instead of scanning raw source.
 *
 * Values are lowercased because markdown fragments are matched case-folded
 * (the heading-slug policy — see `fragmentIndexEntry`). That is marginally
 * more permissive than a browser, which compares ids exactly; erring toward
 * resolving is deliberate, since the cost of the other direction is a false
 * `LINK_BROKEN_ANCHOR` on a link that works.
 *
 * @param anchors - Accumulator; insertion order becomes the emitted order
 * @param node - A raw-HTML node encountered during the walk
 */
function collectHtmlAnchors(anchors: Set<string>, node: Html): void {
  for (const match of node.value.matchAll(HTML_ANCHOR_ATTRIBUTE)) {
    const value = (match[1] ?? match[2] ?? '').trim();
    if (value !== '') {
      anchors.add(value.toLowerCase());
    }
  }
}

/**
 * Flatten one heading node, assigning its GitHub slug.
 *
 * `slugger` is stateful and MUST be fed headings in document order — that is
 * how it reproduces GitHub's `-1`/`-2` suffixing for repeated heading text.
 *
 * `line` is spread conditionally for the same reason, and with the same
 * caveat, as in {@link toResourceLink}: absent beats undefined-valued, and the
 * guard is defensive — remark always sets `position`, so it is unreachable in
 * practice and no test can falsify it.
 */
function toFlatHeading(slugger: GithubSlugger, node: Heading): HeadingNode {
  const text = extractHeadingText(node);
  return {
    level: node.depth,
    text,
    slug: slugger.slug(text),
    ...(node.position !== undefined && { line: node.position.start.line }),
  };
}

/**
 * Extract text content from a heading node.
 *
 * Uses `mdast-util-to-string` (see {@link extractLinkText}) so that styled
 * headings — e.g. `### **CRITICAL: ...**` — produce the same text (and
 * therefore the same GitHub slug) as their plain-text equivalents. Without
 * recursing into container inline nodes, bold/italic headings would yield
 * empty text and bogus slugs, causing false LINK_BROKEN_ANCHOR errors for
 * links targeting them.
 *
 * `includeImageAlt: false` (see {@link extractLinkText}) preserves the prior
 * hand-rolled walker's behavior of dropping image alt text from heading
 * text — and therefore from the slug fed to `github-slugger`. Whether GitHub
 * (or other renderers) actually includes image alt text when computing a
 * heading's anchor is NOT verified here; this is a deliberate
 * behavior-preservation choice, not a claim about renderer behavior. If a
 * renderer is later confirmed to include alt text in anchors, switching
 * `includeImageAlt` to `true` is a separate, deliberate change with its own
 * anchor-validation consequences (it would change slugs for every heading
 * containing an image) — do not flip it based on assumption alone.
 *
 * @param node - Heading node
 * @returns Text content of the heading
 */
function extractHeadingText(node: Heading): string {
  return mdastToString(node, { includeImageAlt: false });
}


/**
 * Build a nested heading tree from a flat list of headings.
 *
 * Uses a stack-based algorithm to correctly nest headings:
 * - When encountering a higher-level heading, pop stack until we find the parent
 * - Add the heading as a child of the top of stack
 * - Push the heading onto the stack
 *
 * @param flatHeadings - Array of headings in document order
 * @returns Array of top-level headings with nested children
 *
 * @example
 * For markdown:
 * ```
 * # Main
 * ## Sub
 * ### Deep
 * ## Sub2
 * ```
 *
 * Returns (note that a LEAF carries no `children` key at all — not an empty
 * array, and not an `undefined` value; see {@link cleanupEmptyChildren}):
 * ```
 * [
 *   {
 *     level: 1,
 *     text: 'Main',
 *     slug: 'main',
 *     children: [
 *       { level: 2, text: 'Sub', slug: 'sub', children: [
 *         { level: 3, text: 'Deep', slug: 'deep' }
 *       ]},
 *       { level: 2, text: 'Sub2', slug: 'sub2' }
 *     ]
 *   }
 * ]
 * ```
 */
function buildHeadingTree(flatHeadings: HeadingNode[]): HeadingNode[] {
  if (flatHeadings.length === 0) {
    return [];
  }

  const roots: HeadingNode[] = [];
  const stack: HeadingNode[] = [];

  for (const heading of flatHeadings) {
    // Initialize children array
    const headingWithChildren: HeadingNode = {
      ...heading,
      children: [],
    };

    // Pop stack until we find a heading with lower level (the parent)
    while (stack.length > 0 && (stack.at(-1)?.level ?? 0) >= heading.level) {
      stack.pop();
    }

    if (stack.length === 0) {
      // This is a root-level heading
      roots.push(headingWithChildren);
    } else {
      // Add as child of the top of stack
      const parent = stack.at(-1);
      if (parent) {
        parent.children ??= [];
        parent.children.push(headingWithChildren);
      }
    }

    // Push current heading onto stack
    stack.push(headingWithChildren);
  }

  // Leaves are built with `children: []`; strip the key back off them.
  cleanupEmptyChildren(roots);

  return roots;
}

/**
 * Strip the `children` key off leaf headings — **deleting** it, never assigning
 * `undefined`.
 *
 * ## Why `delete` and not `= undefined`
 *
 * The two are indistinguishable to every consumer (all of them use truthiness
 * or optional chaining, and the Zod schema uses `.optional()`), but they are
 * NOT indistinguishable to serialization: `JSON.stringify` drops an
 * undefined-valued key entirely, so a heading that went through a JSON-backed
 * parse cache comes back with the key ABSENT while a freshly parsed one has it
 * PRESENT-but-`undefined`. `assert.deepStrictEqual` and vitest's
 * `toStrictEqual` treat those as different values, so a cold-vs-warm
 * equivalence gate would go red on essentially every document in a corpus over
 * a difference nothing observes.
 *
 * Deleting makes the fresh result already equal to its own JSON round trip,
 * which is the property such a cache needs.
 *
 * @param headings - Array of headings to clean up, mutated in place
 */
function cleanupEmptyChildren(headings: HeadingNode[]): void {
  for (const heading of headings) {
    if (heading.children?.length === 0) {
      delete heading.children;
    } else if (heading.children && heading.children.length > 0) {
      cleanupEmptyChildren(heading.children);
    }
  }
}

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

/**
 * Record one frontmatter block on the walk state.
 *
 * `remark-frontmatter` emits a `yaml` node per frontmatter block, and it
 * recognises frontmatter **only at the start of the document** — a later `---`
 * fence is a thematic break, not a second block — so at most one such node is
 * reachable here (verified by probe). Nothing in this function relies on that:
 * each of the three fields independently keeps the last node that contributed
 * to it, so a block that fails to parse leaves a previously parsed object in
 * place, and vice versa. `frontmatterSource` follows the same rule and is set
 * for **every** node, including an empty one — the source is what was there,
 * regardless of what YAML made of it.
 *
 * The parse decision itself is {@link parseFrontmatterSource}'s, not this
 * function's, so a cache rebuilding a hit reaches the identical logic.
 *
 * @param state - Walk state to record the result on
 * @param node - A `yaml` frontmatter node encountered during the walk
 */
function collectFrontmatter(state: AstWalkState, node: Yaml): void {
  state.frontmatterSource = node.value;

  const { frontmatter, frontmatterError } = parseFrontmatterSource(node.value);
  if (frontmatter !== undefined) {
    state.frontmatter = frontmatter;
  }
  if (frontmatterError !== undefined) {
    state.frontmatterError = frontmatterError;
  }
}

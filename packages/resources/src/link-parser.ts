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
}

/**
 * Parse a markdown file and extract all links, headings, and metadata.
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

  const sizeBytes = stats.size;
  const estimatedTokenCount = Math.ceil(content.length / 4);

  // Parse markdown with unified/remark
  const processor = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkFrontmatter);

  const tree = processor.parse(content) as Root;

  // Links, headings, raw-HTML anchors and frontmatter, from ONE tree walk
  const { links, headings, anchors, frontmatter, frontmatterError } = collectAstFacts(tree);

  // Detect dangling reference-style links (full/collapsed forms with no
  // matching definition) — see findUnresolvedReferences for why this is a
  // raw-source scan rather than an AST visit.
  const unresolvedReferences = findUnresolvedReferences(content, tree);

  // With exactOptionalPropertyTypes: true, we must conditionally include the property
  // rather than assigning undefined to it
  return {
    links,
    headings,
    unresolvedReferences,
    ...(anchors.length > 0 && { anchors }),
    ...(frontmatter !== undefined && { frontmatter }),
    ...(frontmatterError !== undefined && { frontmatterError }),
    content,
    sizeBytes,
    estimatedTokenCount,
  };
}

/**
 * Everything a single walk of the markdown AST yields.
 *
 * `anchors` is always an array here (possibly empty); `parseMarkdown` is what
 * decides to omit the key entirely when a document declares none, so the
 * "absent, not empty" distinction lives at exactly one place.
 */
interface MarkdownAstFacts {
  links: ResourceLink[];
  headings: HeadingNode[];
  anchors: string[];
  frontmatter?: Record<string, unknown>;
  frontmatterError?: string;
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
   * ⚠️ KNOWN DEFECT, pre-existing and deliberately preserved by the traversal
   * collapse (which was held to byte-identical output): when a document
   * declares the same label twice, this map keeps the LAST definition, but
   * CommonMark resolves a reference to the FIRST one. So for
   *
   *     A [ref][dup].
   *     [dup]: ./first.md
   *     [dup]: ./last.md
   *
   * VAT reports the `linkReference`'s href as `./last.md` while every renderer
   * links to `./first.md` — meaning link validation checks a target the reader
   * never visits. Verified by probe, 2026-08-08. The fix is one line here
   * (`if (!definitions.has(id))` before the set), but it CHANGES OUTPUT, so it
   * belongs in its own commit with its own golden movement, not folded into a
   * refactor whose entire safety story is that nothing moved.
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
      state.definitions.set(node.identifier, node.url);
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
    line: node.position?.start.line,
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
 * `findUnresolvedReferences`'s raw-source scan (see `parseMarkdown` and
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
 */
function toFlatHeading(slugger: GithubSlugger, node: Heading): HeadingNode {
  const text = extractHeadingText(node);
  return {
    level: node.depth,
    text,
    slug: slugger.slug(text),
    line: node.position?.start.line,
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
 * Returns:
 * ```
 * [
 *   {
 *     level: 1,
 *     text: 'Main',
 *     slug: 'main',
 *     children: [
 *       { level: 2, text: 'Sub', slug: 'sub', children: [
 *         { level: 3, text: 'Deep', slug: 'deep', children: [] }
 *       ]},
 *       { level: 2, text: 'Sub2', slug: 'sub2', children: [] }
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

  // Clean up empty children arrays (convert to undefined)
  cleanupEmptyChildren(roots);

  return roots;
}

/**
 * Remove empty children arrays from heading tree (convert to undefined).
 *
 * @param headings - Array of headings to clean up
 */
function cleanupEmptyChildren(headings: HeadingNode[]): void {
  for (const heading of headings) {
    if (heading.children?.length === 0) {
      heading.children = undefined;
    } else if (heading.children && heading.children.length > 0) {
      cleanupEmptyChildren(heading.children);
    }
  }
}

/**
 * Parse one frontmatter block into the walk state.
 *
 * `remark-frontmatter` emits a `yaml` node per frontmatter block. A
 * well-formed document has at most one, but nothing enforces that, so
 * last-one-wins is preserved for both the parsed object and the error
 * message — and they are independent: a block that fails to parse leaves any
 * previously parsed object in place, and vice versa.
 *
 * An empty block contributes nothing at all: no frontmatter, no error.
 *
 * @param state - Walk state to record the result on
 * @param node - A `yaml` frontmatter node encountered during the walk
 */
function collectFrontmatter(state: AstWalkState, node: Yaml): void {
  if (node.value.trim() === '') {
    // Empty frontmatter block
    return;
  }

  try {
    const parsed = yaml.parse(node.value);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      state.frontmatter = parsed as Record<string, unknown>;
    }
  } catch (error) {
    // Capture YAML parsing error for validation reporting
    state.frontmatterError = error instanceof Error ? error.message : String(error);
  }
}

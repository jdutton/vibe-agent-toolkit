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
import type { Definition, Heading, Link, LinkReference, Root } from 'mdast';
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
  /** Fragment targets (HTML `id`/`name` attributes). Markdown leaves this undefined. */
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

  // Extract links
  const links = extractLinks(tree);

  // Extract headings with tree structure
  const headings = extractHeadings(tree);

  // Extract frontmatter
  const { frontmatter, error: frontmatterError } = extractFrontmatter(tree);

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
    ...(frontmatter !== undefined && { frontmatter }),
    ...(frontmatterError !== undefined && { frontmatterError }),
    content,
    sizeBytes,
    estimatedTokenCount,
  };
}

/**
 * Extract all links from the markdown AST.
 *
 * Handles:
 * - Regular links: [text](href)
 * - Reference-style links: [text][ref]
 * - Autolinks: <url>
 *
 * @param tree - Markdown AST from unified/remark
 * @returns Array of classified links with line numbers
 */
function extractLinks(tree: Root): ResourceLink[] {
  const links: ResourceLink[] = [];

  // First pass: collect all definition nodes (identifier → url)
  // This allows us to resolve linkReference nodes against their definitions
  const definitions = new Map<string, string>();
  visit(tree, 'definition', (node: Definition) => {
    definitions.set(node.identifier, node.url);
  });

  // Visit link nodes (regular links and autolinks)
  visit(tree, 'link', (node: Link) => {
    const link: ResourceLink = {
      text: extractLinkText(node),
      href: node.url,
      type: classifyLink(node.url),
      line: node.position?.start.line,
      nodeType: 'link',
    };
    links.push(link);
  });

  // Visit linkReference nodes (reference-style links).
  //
  // Invariant: every `linkReference` node visited here already has a matching
  // `definition` — CommonMark resolves link references at PARSE time, so
  // micromark only ever emits a `linkReference` node when a definition
  // matched. A reference with no matching definition never reaches this
  // visitor at all; it degrades to literal bracketed text in the AST (and in
  // the rendered document), which is exactly why an AST-based checker is
  // structurally blind to it. That dangling case is detected separately, by
  // `findUnresolvedReferences`'s raw-source scan (see `parseMarkdown` and
  // `unresolved-references.ts`), which reports it as
  // `LINK_UNRESOLVED_REFERENCE`.
  //
  // The `undefined` branch below is therefore NOT the dangling-reference case
  // — it is unreachable unless micromark's own parse-time contract breaks. It
  // degrades (skips the node) rather than throwing because `parseMarkdown`
  // runs over third-party markdown on the `vat audit` / `vat skills validate`
  // paths: a parser quirk must not abort a whole audit run (repo CLAUDE.md,
  // "be liberal in what you accept" for data we do not control).
  visit(tree, 'linkReference', (node: LinkReference) => {
    const resolvedUrl = definitions.get(node.identifier);
    if (resolvedUrl === undefined) return;
    const link: ResourceLink = {
      text: extractLinkText(node),
      href: resolvedUrl,
      type: classifyLink(resolvedUrl),
      line: node.position?.start.line,
      nodeType: 'linkReference',
    };
    links.push(link);
  });

  // Visit definition nodes (reference-style link definitions: [ref]: url)
  // These provide the actual URLs for linkReference nodes
  visit(tree, 'definition', (node: Definition) => {
    const link: ResourceLink = {
      text: node.identifier,
      href: node.url,
      type: classifyLink(node.url),
      line: node.position?.start.line,
      nodeType: 'definition',
    };
    links.push(link);
  });

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

/**
 * Extract headings from the markdown AST and build a nested tree structure.
 *
 * Builds a hierarchical structure where:
 * - h2 nodes are children of the preceding h1
 * - h3 nodes are children of the preceding h2
 * - etc.
 *
 * @param tree - Markdown AST from unified/remark
 * @returns Array of top-level heading nodes with nested children
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
function extractHeadings(tree: Root): HeadingNode[] {
  const flatHeadings: HeadingNode[] = [];
  const slugger = new GithubSlugger();

  // First pass: collect all headings in document order
  // GithubSlugger processes headings in order, deduplicating exactly as GitHub does
  visit(tree, 'heading', (node: Heading) => {
    const text = extractHeadingText(node);
    const heading: HeadingNode = {
      level: node.depth,
      text,
      slug: slugger.slug(text),
      line: node.position?.start.line,
    };
    flatHeadings.push(heading);
  });

  // Second pass: build tree structure using a stack
  return buildHeadingTree(flatHeadings);
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
 * Extract and parse frontmatter from the markdown AST.
 *
 * Uses remark-frontmatter which creates 'yaml' nodes for frontmatter blocks.
 * Parses YAML content and returns as plain object.
 *
 * @param tree - Markdown AST from unified/remark
 * @returns Object with parsed frontmatter and any error message
 */
function extractFrontmatter(tree: Root): {
  frontmatter?: Record<string, unknown>;
  error?: string;
} {
  let frontmatterData: Record<string, unknown> | undefined;
  let errorMessage: string | undefined;

  visit(tree, 'yaml', (node: { value: string }) => {
    if (node.value.trim() === '') {
      // Empty frontmatter block
      return;
    }

    try {
      const parsed = yaml.parse(node.value);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        frontmatterData = parsed as Record<string, unknown>;
      }
    } catch (error) {
      // Capture YAML parsing error for validation reporting
      errorMessage = error instanceof Error ? error.message : String(error);
    }
  });

  // With exactOptionalPropertyTypes: true, we must conditionally include properties
  return {
    ...(frontmatterData !== undefined && { frontmatter: frontmatterData }),
    ...(errorMessage !== undefined && { error: errorMessage }),
  };
}

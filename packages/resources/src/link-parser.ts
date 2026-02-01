/**
 * Markdown link parser and analyzer.
 *
 * Parses markdown files to extract:
 * - Links (regular, reference-style, autolinks)
 * - Headings (with GitHub-style slugs and nested tree structure)
 * - File size and token estimates
 *
 * Uses unified/remark for robust markdown parsing with GFM support.
 */

import { readFile, stat } from 'node:fs/promises';

import * as yaml from 'js-yaml';
import type { Heading, Link, LinkReference, Root } from 'mdast';
import remarkFrontmatter from 'remark-frontmatter';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';
import { visit } from 'unist-util-visit';

import type { HeadingNode, LinkType, ResourceLink } from './types.js';

/**
 * Result of parsing a markdown file.
 */
export interface ParseResult {
  links: ResourceLink[];
  headings: HeadingNode[];
  frontmatter?: Record<string, unknown>;
  content: string;
  sizeBytes: number;
  estimatedTokenCount: number;
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
  const frontmatter = extractFrontmatter(tree);

  // With exactOptionalPropertyTypes: true, we must conditionally include the property
  // rather than assigning undefined to it
  return {
    links,
    headings,
    ...(frontmatter !== undefined && { frontmatter }),
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

  // Visit link nodes (regular links and autolinks)
  visit(tree, 'link', (node: Link) => {
    const link: ResourceLink = {
      text: extractLinkText(node),
      href: node.url,
      type: classifyLink(node.url),
      line: node.position?.start.line,
    };
    links.push(link);
  });

  // Visit linkReference nodes (reference-style links)
  visit(tree, 'linkReference', (node: LinkReference) => {
    // For reference-style links, we use the identifier as href
    // In a full implementation, we'd resolve the definition, but for now
    // we'll classify based on the identifier pattern
    const href = node.identifier;
    const link: ResourceLink = {
      text: extractLinkText(node),
      href,
      type: 'unknown', // Reference links need definition resolution
      line: node.position?.start.line,
    };
    links.push(link);
  });

  return links;
}

/**
 * Extract text content from a link node.
 *
 * @param node - Link or LinkReference node
 * @returns Text content of the link
 */
function extractLinkText(node: Link | LinkReference): string {
  return extractTextFromChildren(node.children);
}

/**
 * Classify a link based on its href.
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
 * ```
 */
function classifyLink(href: string): LinkType {
  if (href.startsWith('http://') || href.startsWith('https://')) {
    return 'external';
  }
  if (href.startsWith('mailto:')) {
    return 'email';
  }
  if (href.startsWith('#')) {
    return 'anchor';
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
  return 'unknown';
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

  // First pass: collect all headings in document order
  visit(tree, 'heading', (node: Heading) => {
    const text = extractHeadingText(node);
    const heading: HeadingNode = {
      level: node.depth,
      text,
      slug: generateSlug(text),
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
 * @param node - Heading node
 * @returns Text content of the heading
 */
function extractHeadingText(node: Heading): string {
  return extractTextFromChildren(node.children);
}

/**
 * Extract text content from inline children nodes.
 *
 * Handles text nodes, inline code, emphasis, and other inline elements.
 *
 * @param children - Array of child nodes or undefined
 * @returns Concatenated text content
 */
function extractTextFromChildren(
  children: Array<{ type: string; value?: unknown }> | undefined
): string {
  if (!children || children.length === 0) {
    return '';
  }

  return children
    .map((child) => {
      if (child.type === 'text') {
        return child.value as string;
      }
      // Handle other inline elements (code, emphasis, etc.)
      if ('value' in child) {
        return String(child.value);
      }
      return '';
    })
    .join('');
}

/**
 * Generate a GitHub-style slug from heading text.
 *
 * Rules:
 * - Convert to lowercase
 * - Replace spaces with hyphens
 * - Remove special characters
 * - Collapse multiple hyphens
 *
 * @param text - Heading text
 * @returns GitHub-style slug for anchor links
 *
 * @example
 * ```typescript
 * generateSlug('Hello World') // 'hello-world'
 * generateSlug('Section 1.1') // 'section-11'
 * generateSlug('API Reference (v2)') // 'api-reference-v2'
 * ```
 */
function generateSlug(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replaceAll(/[^\w\s-]/g, '') // Remove special chars
    .replaceAll(/\s+/g, '-') // Replace spaces with hyphens
    .replaceAll(/-+/g, '-'); // Collapse multiple hyphens
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
 * @returns Parsed frontmatter object, or undefined if no frontmatter present
 */
function extractFrontmatter(tree: Root): Record<string, unknown> | undefined {
  let frontmatterData: Record<string, unknown> | undefined;

  visit(tree, 'yaml', (node: { value: string }) => {
    if (node.value.trim() === '') {
      // Empty frontmatter block
      return;
    }

    try {
      const parsed = yaml.load(node.value);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        frontmatterData = parsed as Record<string, unknown>;
      }
    } catch {
      // YAML parsing errors will be caught during validation
      // Don't fail parsing here, let validation report the error
    }
  });

  return frontmatterData;
}

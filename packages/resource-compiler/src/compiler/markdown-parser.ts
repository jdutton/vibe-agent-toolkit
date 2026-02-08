/**
 * Markdown parser for extracting frontmatter and H2 fragments
 */

import matter from 'gray-matter';
import slugifyModule from 'slugify';

import type { MarkdownResource, MarkdownFragment } from './types.js';

// Import slugify with type assertion to handle CJS module
const slugifyFn = slugifyModule as unknown as (
  string: string,
  options?: {
    replacement?: string;
    remove?: RegExp;
    lower?: boolean;
    strict?: boolean;
    locale?: string;
    trim?: boolean;
  },
) => string;

/**
 * Parse markdown file content into a MarkdownResource
 *
 * @param content - Raw markdown file content
 * @returns Parsed resource with frontmatter and fragments
 *
 * @example
 * ```typescript
 * const content = `---
 * title: My Document
 * ---
 * # Main Title
 *
 * ## First Section
 * Content here
 *
 * ## Second Section
 * More content
 * `;
 *
 * const resource = parseMarkdown(content);
 * console.log(resource.frontmatter.title); // "My Document"
 * console.log(resource.fragments.length); // 2
 * console.log(resource.fragments[0].slug); // "first-section"
 * ```
 */
export function parseMarkdown(content: string): MarkdownResource {
  // Parse frontmatter
  const { data: frontmatter, content: markdownContent } = matter(content);

  // Extract H2 fragments
  const fragments = extractH2Fragments(markdownContent);

  return {
    frontmatter,
    content: markdownContent,
    fragments,
  };
}

/**
 * Extract H2 heading fragments from markdown content
 *
 * @param content - Markdown content (without frontmatter)
 * @returns Array of parsed fragments
 */
function extractH2Fragments(content: string): MarkdownFragment[] {
  const fragments: MarkdownFragment[] = [];

  // Split by H2 headings (## at start of line)
  const h2Regex = /^## (.+)$/gm;
  const matches = [...content.matchAll(h2Regex)];

  if (matches.length === 0) {
    return [];
  }

  for (let i = 0; i < matches.length; i++) {
    const match = matches[i];
    if (!match || typeof match.index !== 'number') {
      continue;
    }

    const heading = match[1]?.trim() ?? '';
    const startIndex = match.index;

    // Find content between this heading and next (or end of file)
    const nextMatch = matches[i + 1];
    const endIndex = nextMatch?.index ?? content.length;

    // Extract the full text (header + body)
    const text = content.slice(startIndex, endIndex).trim();

    // Extract just the body (everything after the header line)
    const headerEndIndex = content.indexOf('\n', startIndex);
    const bodyStartIndex = headerEndIndex === -1 ? content.length : headerEndIndex + 1;
    const body = content.slice(bodyStartIndex, endIndex).trim();

    // Generate slug and camelCase name
    const slug = generateSlug(heading);
    const camelCase = slugToCamelCase(slug);

    fragments.push({
      heading,
      slug,
      camelCase,
      header: `## ${heading}`,
      body,
      text,
    });
  }

  return fragments;
}

/**
 * Generate a URL-safe slug from heading text
 *
 * @param heading - Original heading text
 * @returns Kebab-case slug
 *
 * @example
 * ```typescript
 * generateSlug("Purpose Driven")        // "purpose-driven"
 * generateSlug("API v2.0")              // "api-v2-0"
 * generateSlug("Hello, World!")         // "hello-world"
 * generateSlug("  Spaces  Everywhere  ") // "spaces-everywhere"
 * ```
 */
function generateSlug(heading: string): string {
  return slugifyFn(heading, {
    lower: true,
    strict: true,
    trim: true,
  });
}

/**
 * Convert kebab-case slug to camelCase
 *
 * @param slug - Kebab-case slug
 * @returns camelCase property name
 *
 * @example
 * ```typescript
 * slugToCamelCase("purpose-driven")  // "purposeDriven"
 * slugToCamelCase("api-v2-0")        // "apiV20"
 * slugToCamelCase("single")          // "single"
 * ```
 */
function slugToCamelCase(slug: string): string {
  return slug.replaceAll(/-([a-z0-9])/g, (_, char: string) => char.toUpperCase());
}

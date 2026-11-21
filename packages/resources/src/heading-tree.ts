/**
 * The heading tree: GitHub's slugs and nesting over a flat heading list.
 *
 * A module of its own, apart from the markdown composer, because two callers
 * need it on different threads: the composer inside the parse worker, and the
 * blob fact reader on the run's own thread, which replays it over stored
 * section rows. Importing it loads no parser.
 */
import GithubSlugger from 'github-slugger';

import type { FlatHeading } from './parse-capabilities.js';
import type { HeadingNode } from './types.js';

/**
 * Slug and nest a flat heading list — the two GitHub conventions VAT owns.
 *
 * Kept out of the `structure` capability deliberately: `github-slugger`'s
 * `-1`/`-2` suffixing and the parent/child nesting are conventions of the
 * *renderer*, not facts about the markdown dialect, so asking an implementation
 * for them would be asking it to reproduce something it has no reason to know.
 *
 * ⚠️ The slugger is stateful and MUST see headings in document order — that is
 * how it reproduces GitHub's duplicate suffixing. The blob fact reader replays it
 * over stored titles in ordinal order, so a stored slug is never trusted alone.
 *
 * @param flatHeadings - Headings in document order, from the structure capability
 * @returns Top-level headings with children nested beneath them
 */
export function toHeadingTree(flatHeadings: FlatHeading[]): HeadingNode[] {
  const slugger = new GithubSlugger();
  return buildHeadingTree(
    flatHeadings.map((heading) => ({
      level: heading.level,
      text: heading.text,
      slug: slugger.slug(heading.text),
      // Absent beats undefined-valued: it is what makes a fresh `ParseResult`
      // equal to its own JSON round trip, which a JSON-backed cache needs.
      ...(heading.line !== undefined && { line: heading.line }),
    })),
  );
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

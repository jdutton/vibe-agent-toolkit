/**
 * Internal utility functions for the resources package.
 * These are not exported from the public API.
 */

/**
 * Split an href into file path and anchor parts.
 *
 * @param href - The href to split (e.g., "./file.md#anchor")
 * @returns Tuple of [filePath, anchor], where anchor is undefined if no anchor exists
 *
 * @example
 * ```typescript
 * splitHrefAnchor('./file.md#heading')  // ['./file.md', 'heading']
 * splitHrefAnchor('./file.md')          // ['./file.md', undefined]
 * ```
 */
export function splitHrefAnchor(href: string): [string, string | undefined] {
  const anchorIndex = href.indexOf('#');
  if (anchorIndex === -1) {
    return [href, undefined];
  }

  const filePath = href.slice(0, anchorIndex);
  const anchor = href.slice(anchorIndex + 1);
  return [filePath, anchor];
}

/**
 * Declaration file generator for markdown modules
 * Generates .md.d.ts files that TypeScript can use for module resolution
 */

import { generateTypeScriptDeclarations } from '../compiler/dts-generator.js';
import type { MarkdownResource } from '../compiler/types.js';

/**
 * Generate a .md.d.ts declaration file for a markdown module
 *
 * For a file named `prompts.md`, this generates `prompts.md.d.ts` that contains
 * the exports directly (not wrapped in declare module), allowing TypeScript to
 * resolve the .md import using standard module resolution.
 *
 * @param mdPath - Absolute path to the markdown file (unused, kept for API compatibility)
 * @param resource - Parsed markdown resource
 * @returns Generated TypeScript declaration content
 *
 * @example
 * ```typescript
 * const resource = parseMarkdown(content);
 * const declaration = generateMarkdownDeclarationFile('/path/to/prompts.md', resource);
 * // Outputs:
 * // export interface Fragment {
 * //   readonly header: string;
 * //   readonly body: string;
 * //   readonly text: string;
 * // }
 * // export const meta: { ... };
 * // export const text: string;
 * // ...
 * ```
 */
export function generateMarkdownDeclarationFile(
  _mdPath: string,
  resource: MarkdownResource,
): string {
  // Simply return the declarations directly
  // TypeScript will associate prompts.md.d.ts with prompts.md automatically
  return generateTypeScriptDeclarations(resource);
}

/**
 * Get the output path for a .md.d.ts file
 * Places the declaration file alongside the source .md file
 *
 * @param mdPath - Absolute path to the markdown file
 * @returns Absolute path for the .md.d.ts file
 *
 * @example
 * ```typescript
 * getDeclarationPath('/path/to/file.md')
 * // Returns: '/path/to/file.md.d.ts'
 * ```
 */
export function getDeclarationPath(mdPath: string): string {
  return `${mdPath}.d.ts`;
}

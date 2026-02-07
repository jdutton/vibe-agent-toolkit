/**
 * TypeScript declaration (.d.ts) generator for markdown resources
 */

import type { MarkdownResource } from './types.js';

/**
 * Infer TypeScript type from a runtime value
 *
 * @param value - Runtime value to infer type from
 * @returns TypeScript type string
 *
 * @example
 * ```typescript
 * inferType("hello")           // "string"
 * inferType(42)                // "number"
 * inferType(true)              // "boolean"
 * inferType(["a", "b"])        // "readonly string[]"
 * inferType({ key: "value" })  // "{ readonly key: string }"
 * ```
 */
function inferType(value: unknown): string {
  if (value === null || value === undefined) {
    return 'undefined';
  }

  if (typeof value === 'string') {
    return 'string';
  }

  if (typeof value === 'number') {
    return 'number';
  }

  if (typeof value === 'boolean') {
    return 'boolean';
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      return 'readonly unknown[]';
    }
    // Infer type from first element (assuming homogeneous arrays)
    const elementType = inferType(value[0]);
    return `readonly ${elementType}[]`;
  }

  if (typeof value === 'object') {
    const entries = Object.entries(value);
    if (entries.length === 0) {
      return '{}';
    }
    const props = entries.map(([key, val]) => `readonly ${key}: ${inferType(val)}`);
    return `{\n  ${props.join(';\n  ')};\n}`;
  }

  return 'unknown';
}

/**
 * Generate TypeScript declaration from frontmatter
 *
 * @param frontmatter - Frontmatter object
 * @returns TypeScript type declaration
 */
function generateMetaType(frontmatter: Record<string, unknown>): string {
  if (Object.keys(frontmatter).length === 0) {
    return '{}';
  }

  const entries = Object.entries(frontmatter);
  const props = entries.map(([key, value]) => {
    const type = inferType(value);
    return `  readonly ${key}: ${type};`;
  });

  return `{\n${props.join('\n')}\n}`;
}

/**
 * Generate TypeScript declarations from a parsed markdown resource
 *
 * @param resource - Parsed markdown resource
 * @returns Generated TypeScript declaration code
 *
 * @example
 * ```typescript
 * const resource = parseMarkdown(content);
 * const dtsCode = generateTypeScriptDeclarations(resource);
 * // Outputs:
 * // export interface Fragment {
 * //   readonly header: string;
 * //   readonly body: string;
 * //   readonly text: string;
 * // }
 * //
 * // export const meta: { readonly title: string; readonly tags: readonly string[]; };
 * // export const text: string;
 * // export const fragments: { readonly sectionName: Fragment; };
 * // export type FragmentName = keyof typeof fragments;
 * ```
 */
export function generateTypeScriptDeclarations(resource: MarkdownResource): string {
  const lines: string[] = [];

  // Header comment
  lines.push(
    '/**',
    ' * Generated TypeScript declarations - DO NOT EDIT',
    ' */',
    '',
  );

  // Fragment interface (always same structure)
  lines.push(
    'export interface Fragment {',
    '  readonly header: string;',
    '  readonly body: string;',
    '  readonly text: string;',
    '}',
    '',
  );

  // Meta type (from frontmatter)
  const metaType = generateMetaType(resource.frontmatter);
  lines.push(...[`export const meta: ${metaType};`, '']);

  // Text export
  lines.push(...['export const text: string;', '']);

  // Fragments type (specific to this resource)
  if (resource.fragments.length === 0) {
    lines.push('export const fragments: {};');
  } else {
    lines.push('export const fragments: {');
    for (const fragment of resource.fragments) {
      lines.push(`  readonly ${fragment.camelCase}: Fragment;`);
    }
    lines.push('};');
  }
  lines.push('');

  // FragmentName union type
  if (resource.fragments.length === 0) {
    lines.push('export type FragmentName = never;');
  } else {
    lines.push('export type FragmentName = keyof typeof fragments;');
  }
  lines.push('');

  return lines.join('\n');
}

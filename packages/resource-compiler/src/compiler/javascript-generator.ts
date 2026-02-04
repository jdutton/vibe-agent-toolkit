/**
 * JavaScript code generator for markdown resources
 */

import type { MarkdownResource } from './types.js';

/**
 * Escape a string for use in JavaScript string literals
 *
 * @param str - String to escape
 * @returns Escaped string safe for JavaScript
 *
 * @example
 * ```typescript
 * escapeString('Hello "world"')     // 'Hello \\"world\\"'
 * escapeString("It's working")      // 'It\\'s working'
 * escapeString('Line 1\nLine 2')    // 'Line 1\\nLine 2'
 * escapeString('C:\\path\\to\\file') // 'C:\\\\path\\\\to\\\\file'
 * ```
 */
function escapeString(str: string): string {
  /* eslint-disable unicorn/prefer-string-raw -- Intentionally escaping strings for JavaScript code generation */
  return str
    .replaceAll('\\', '\\\\') // Backslash must be first
    .replaceAll('"', '\\"')   // Escape double quotes
    .replaceAll("'", "\\'")   // Escape single quotes
    .replaceAll('\n', '\\n')  // Escape newlines
    .replaceAll('\r', '\\r')  // Escape carriage returns
    .replaceAll('\t', '\\t')  // Escape tabs
    .replaceAll('`', '\\`');  // Escape backticks
  /* eslint-enable unicorn/prefer-string-raw */
}

/**
 * Serialize a value to JavaScript code
 *
 * @param value - Value to serialize
 * @param indent - Indentation level
 * @returns JavaScript code representing the value
 */
function serializeValue(value: unknown, indent: number = 0): string {
  const indentStr = '  '.repeat(indent);
  const nextIndentStr = '  '.repeat(indent + 1);

  if (value === null) {
    return 'null';
  }

  if (value === undefined) {
    return 'undefined';
  }

  if (typeof value === 'string') {
    return `"${escapeString(value)}"`;
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      return '[]';
    }
    const items = value.map((item) => `${nextIndentStr}${serializeValue(item, indent + 1)}`);
    return `[\n${items.join(',\n')}\n${indentStr}]`;
  }

  if (typeof value === 'object') {
    const entries = Object.entries(value);
    if (entries.length === 0) {
      return '{}';
    }
    const props = entries.map(
      ([key, val]) => `${nextIndentStr}${key}: ${serializeValue(val, indent + 1)}`,
    );
    return `{\n${props.join(',\n')}\n${indentStr}}`;
  }

  // Fallback for unsupported types
  return 'null';
}

/**
 * Generate JavaScript code from a parsed markdown resource
 *
 * @param resource - Parsed markdown resource
 * @returns Generated JavaScript code
 *
 * @example
 * ```typescript
 * const resource = parseMarkdown(content);
 * const jsCode = generateJavaScript(resource);
 * // Outputs:
 * // export const meta = { title: "Example", tags: ["test"] };
 * // export const text = "...";
 * // export const fragments = { sectionName: { header: "...", body: "...", text: "..." } };
 * ```
 */
export function generateJavaScript(resource: MarkdownResource): string {
  const lines: string[] = [];

  // Generate frontmatter export
  lines.push('/**');
  lines.push(' * Generated from markdown file - DO NOT EDIT');
  lines.push(' */');
  lines.push('');

  // Export meta (frontmatter)
  lines.push('export const meta = ' + serializeValue(resource.frontmatter, 0) + ';');
  lines.push('');

  // Export full text
  lines.push('export const text = ' + serializeValue(resource.content, 0) + ';');
  lines.push('');

  // Export fragments
  const fragmentsObj: Record<string, unknown> = {};
  for (const fragment of resource.fragments) {
    fragmentsObj[fragment.camelCase] = {
      header: fragment.header,
      body: fragment.body,
      text: fragment.text,
    };
  }

  lines.push('export const fragments = ' + serializeValue(fragmentsObj, 0) + ';');
  lines.push('');

  return lines.join('\n');
}

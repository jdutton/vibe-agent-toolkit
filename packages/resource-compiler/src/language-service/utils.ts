/**
 * Utility functions for TypeScript AST traversal and markdown path resolution
 */

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/explicit-module-boundary-types, sonarjs/cognitive-complexity, security/detect-non-literal-regexp, import/order -- TypeScript Language Service plugin API requires any and complex AST traversal */

import { readFileSync } from 'node:fs';

import { parseMarkdown } from '../compiler/markdown-parser.js';
import { resolveMarkdownPath as resolveMarkdownPathFromTransformer } from '../transformer/path-resolver.js';
import type { MarkdownResource } from '../compiler/types.js';

import { getMarkdownResource } from './markdown-cache.js';

/**
 * Find the AST node at a specific position in the source file
 *
 * @param ts - TypeScript module
 * @param sourceFile - Source file to search
 * @param position - Character position in the file
 * @returns The deepest node containing the position, or undefined
 */
export function findNodeAtPosition(
  ts: any,
  sourceFile: any,
  position: number,
): any {
  let foundNode: any;

  function visit(node: any): void {
    if (position >= node.pos && position < node.end) {
      foundNode = node;
      ts.forEachChild(node, visit);
    }
  }

  visit(sourceFile);
  return foundNode;
}

/**
 * Extract markdown file path from an import declaration or expression
 *
 * @param ts - TypeScript module
 * @param node - AST node to check
 * @returns Markdown file path if found, null otherwise
 *
 * @example
 * ```typescript
 * // For: import Core from './core.md';
 * getMarkdownPathFromImport(node) // → './core.md'
 *
 * // For: const x = 5;
 * getMarkdownPathFromImport(node) // → null
 * ```
 */
export function getMarkdownPathFromImport(
  ts: any,
  node: any,
): string | null {
  // Check if it's an import declaration
  if (ts.isImportDeclaration(node)) {
    const moduleSpecifier = node.moduleSpecifier;
    if (ts.isStringLiteral(moduleSpecifier) && moduleSpecifier.text.endsWith('.md')) {
      return moduleSpecifier.text;
    }
  }

  // Check if it's a dynamic import
  if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
    const argument = node.arguments[0];
    if (argument && ts.isStringLiteral(argument) && argument.text.endsWith('.md')) {
      return argument.text;
    }
  }

  return null;
}

/**
 * Extract markdown file path and fragment property from a property access expression
 *
 * @param ts - TypeScript module
 * @param node - AST node to check
 * @param sourceFile - Source file containing the node
 * @returns Object with markdown path and fragment name, or null
 *
 * @example
 * ```typescript
 * // For: Core.fragments.purposeDriven
 * getMarkdownPathFromExpression(node, sourceFile)
 * // → { markdownPath: './core.md', fragmentName: 'purposeDriven' }
 * ```
 */
export function getMarkdownPathFromExpression(
  ts: any,
  node: any,
  sourceFile: any,
): { markdownPath: string; fragmentName: string } | null {
  // Look for patterns like: Core.fragments.purposeDriven
  if (!ts.isPropertyAccessExpression(node)) {
    return null;
  }

  // Check if accessing a fragment property
  const fragmentName = node.name.text;

  // Check if parent is `.fragments`
  const parent = node.expression;
  if (!ts.isPropertyAccessExpression(parent)) {
    return null;
  }

  if (parent.name.text !== 'fragments') {
    return null;
  }

  // Get the imported identifier (e.g., 'Core')
  const identifier = parent.expression;
  if (!ts.isIdentifier(identifier)) {
    return null;
  }

  // Find the import declaration for this identifier
  const importPath = findImportPathForIdentifier(ts, identifier.text, sourceFile);
  if (!importPath?.endsWith('.md')) {
    return null;
  }

  return { markdownPath: importPath, fragmentName };
}

/**
 * Find the import path for a given identifier in the source file
 *
 * @param ts - TypeScript module
 * @param identifierName - Name of the imported identifier
 * @param sourceFile - Source file to search
 * @returns Import path string, or null if not found
 */
function findImportPathForIdentifier(
  ts: any,
  identifierName: string,
  sourceFile: any,
): string | null {
  let importPath: string | null = null;

  function visit(node: any): void {
    if (importPath) {
      return;
    }

    // Check import declarations
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      if (!clause) {
        return;
      }

      const moduleSpecifier = node.moduleSpecifier;
      if (!ts.isStringLiteral(moduleSpecifier)) {
        return;
      }

      // Check default import
      const defaultName = clause.name;
      if (defaultName?.text === identifierName) {
        importPath = moduleSpecifier.text;
        return;
      }

      // Check named imports
      const namedBindings = clause.namedBindings;
      if (namedBindings?.kind === ts.SyntaxKind.NamedImports) {
        for (const element of namedBindings.elements) {
          if (element.name.text === identifierName) {
            importPath = moduleSpecifier.text;
            return;
          }
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return importPath;
}

/**
 * Resolve a markdown import path to an absolute file path
 *
 * @param modulePath - Import path from TypeScript
 * @param containingFile - Absolute path of the file doing the import
 * @param compilerOptions - TypeScript compiler options
 * @returns Absolute path to markdown file, or null if not found
 */
export function resolveMarkdownPath(
  modulePath: string,
  containingFile: string,
  compilerOptions: any,
): string | null {
  return resolveMarkdownPathFromTransformer(modulePath, containingFile, compilerOptions);
}

/**
 * Load and parse a markdown file with caching
 *
 * @param filePath - Absolute path to markdown file
 * @returns Parsed markdown resource
 */
export function loadMarkdownResource(filePath: string): MarkdownResource {
  return getMarkdownResource(filePath, () => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Using validated path from TypeScript Language Service
    const content = readFileSync(filePath, 'utf-8');
    return parseMarkdown(content);
  });
}

/**
 * Find the position (line/character) of a heading in markdown content
 *
 * @param content - Markdown file content
 * @param heading - Heading text to find (without ## prefix)
 * @returns Object with line and character position, or null if not found
 */
export function findHeadingPosition(
  content: string,
  heading: string,
): { line: number; character: number } | null {
  const lines = content.split('\n');
  const headingPattern = new RegExp(String.raw`^##\s+${escapeRegex(heading)}\s*$`);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line && headingPattern.test(line)) {
      return { line: i, character: 0 };
    }
  }

  return null;
}

/**
 * Escape special regex characters in a string
 *
 * @param str - String to escape
 * @returns Escaped string safe for use in RegExp
 */
function escapeRegex(str: string): string {
  return str.replaceAll(/[$()*+.?[\\\]^{|}]/g, String.raw`\$&`);
}

/**
 * Common pattern: Get source file and node at position
 * Returns null if source file or node not found
 *
 * @param ts - TypeScript module
 * @param info - Plugin create info
 * @param fileName - File being edited
 * @param position - Cursor position
 * @returns Object with sourceFile and node, or null
 */
export function getSourceFileAndNode(
  ts: any,
  info: any,
  fileName: string,
  position: number,
): { sourceFile: any; node: any } | null {
  const program = info.languageService.getProgram();
  if (!program) {
    return null;
  }

  const sourceFile = program.getSourceFile(fileName);
  if (!sourceFile) {
    return null;
  }

  const node = findNodeAtPosition(ts, sourceFile, position);
  if (!node) {
    return null;
  }

  return { sourceFile, node };
}

/**
 * Common pattern: Resolve markdown path and load resource
 * Returns null if path cannot be resolved or file doesn't exist
 *
 * @param info - Plugin create info
 * @param markdownPath - Import path to markdown file
 * @param containingFile - File containing the import/access
 * @returns Object with absolutePath and resource, or null
 */
export function resolveAndLoadMarkdown(
  info: any,
  markdownPath: string,
  containingFile: string,
): { absolutePath: string; resource: MarkdownResource } | null {
  const compilerOptions = info.project.getCompilerOptions();
  const absolutePath = resolveMarkdownPath(markdownPath, containingFile, compilerOptions);

  if (!absolutePath) {
    return null;
  }

  const resource = loadMarkdownResource(absolutePath);
  return { absolutePath, resource };
}

/**
 * Common pattern: Resolve markdown path, load resource, and find fragment
 * Returns null if resolution fails or fragment doesn't exist
 * This is the shared logic for fragment-based operations (hover, diagnostics, etc.)
 *
 * @param info - Plugin create info
 * @param markdownPath - Import path to markdown file
 * @param fragmentName - camelCase fragment property name
 * @param containingFile - File containing the fragment access
 * @returns Object with absolutePath, resource, and fragment, or null
 */
export function resolveAndLoadFragment(
  info: any,
  markdownPath: string,
  fragmentName: string,
  containingFile: string,
): { absolutePath: string; resource: MarkdownResource; fragment: any } | null {
  // Resolve markdown path and load resource
  const result = resolveAndLoadMarkdown(info, markdownPath, containingFile);
  if (!result) {
    return null;
  }

  const { absolutePath, resource } = result;

  // Convert camelCase property name to heading text
  const headingText = fragmentName
    .replaceAll(/([A-Z])/g, ' $1')
    .trim()
    .split(' ')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');

  // Find the fragment in the markdown resource
  const fragment = resource.fragments.find((frag) => frag.heading === headingText);
  if (!fragment) {
    return null;
  }

  return { absolutePath, resource, fragment };
}

/**
 * Higher-order function for Language Service enhancement operations
 * Encapsulates common pattern: get source file/node, try operation, catch errors
 *
 * @param ts - TypeScript module
 * @param info - Plugin create info
 * @param prior - Original result from TypeScript
 * @param fileName - File being edited
 * @param position - Cursor position
 * @param operationName - Name for logging (e.g., "hover", "definitions")
 * @param enhancer - Function to enhance the result
 * @returns Enhanced result, or original if no enhancements needed
 */
export function enhanceLanguageServiceOperation(
  ts: any,
  info: any,
  prior: any,
  fileName: string,
  position: number,
  operationName: string,
  enhancer: (context: { sourceFile: any; node: any }) => any,
): any {
  try {
    // Get the source file and find the node at cursor
    const context = getSourceFileAndNode(ts, info, fileName, position);
    if (!context) {
      return prior;
    }

    // Call the specific enhancement logic
    const enhanced = enhancer(context);
    return enhanced ?? prior;
  } catch (error) {
    // Log error and return original result
    info.project.projectService.logger.info(
      `markdown-import-plugin: Error enhancing ${operationName}: ${String(error)}`,
    );
    return prior;
  }
}

/**
 * Get the property name node from a node
 * If the node is a PropertyAccessExpression, returns its name property
 * Otherwise returns the node itself
 *
 * @param ts - TypeScript module
 * @param node - AST node (property access or identifier)
 * @returns The property name node for precise text spans
 */
export function getPropertyNameNode(ts: any, node: any): any {
  if (ts.isPropertyAccessExpression(node)) {
    return node.name;
  }
  return node;
}

/**
 * Options for withFragmentResolution
 */
interface FragmentResolutionOptions {
  info: any;
  markdownPath: string;
  fragmentName: string;
  containingFile: string;
  node: any;
  operationName: string;
  onSuccess: (result: { absolutePath: string; resource: MarkdownResource; fragment: any }) => any;
  onNotFound?: () => any;
}

/**
 * Higher-order function for fragment-based operations (hover, diagnostics, etc.)
 * Encapsulates common pattern: resolve markdown path, load resource, find fragment, handle errors
 *
 * @param options - Configuration options
 * @returns Result from onSuccess or onNotFound callback
 */
export function withFragmentResolution(options: FragmentResolutionOptions): any {
  const { info, markdownPath, fragmentName, containingFile, operationName, onSuccess, onNotFound } = options;

  try {
    // Resolve markdown path, load resource, and find fragment
    const result = resolveAndLoadFragment(info, markdownPath, fragmentName, containingFile);
    if (!result) {
      return onNotFound ? onNotFound() : undefined;
    }

    return onSuccess(result);
  } catch (error) {
    info.project.projectService.logger.info(
      `markdown-import-plugin: Error during ${operationName}: ${String(error)}`,
    );
    return undefined;
  }
}

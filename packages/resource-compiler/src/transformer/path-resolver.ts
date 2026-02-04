/**
 * Path resolution utilities for markdown imports
 * Resolves relative and node_modules paths using TypeScript's module resolution
 */

import { existsSync } from 'node:fs';
import { dirname, resolve, join, isAbsolute } from 'node:path';

import { toForwardSlash } from '@vibe-agent-toolkit/utils';
import ts from 'typescript';

/**
 * Resolve a markdown import path to an absolute file path
 *
 * @param modulePath - The import path (e.g., "./core.md", "@pkg/prompts/core.md")
 * @param containingFile - The absolute path of the file doing the import
 * @param compilerOptions - TypeScript compiler options for module resolution
 * @returns Absolute path to the markdown file, or null if not found
 *
 * @example
 * ```typescript
 * // Relative import
 * resolveMarkdownPath('./core.md', '/path/to/file.ts', options)
 * // → '/path/to/core.md'
 *
 * // Node modules import
 * resolveMarkdownPath('@pkg/prompts/core.md', '/path/to/file.ts', options)
 * // → '/path/to/node_modules/@pkg/prompts/core.md'
 * ```
 */
export function resolveMarkdownPath(
  modulePath: string,
  containingFile: string,
  compilerOptions: ts.CompilerOptions,
): string | null {
  // Handle relative paths (normalize to forward slashes for cross-platform)
  const normalizedPath = toForwardSlash(modulePath);
  if (normalizedPath.startsWith('./') || normalizedPath.startsWith('../')) {
    return resolveRelativePath(modulePath, containingFile);
  }

  // Handle absolute paths (rare, but possible)
  if (isAbsolute(modulePath)) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Validated absolute path from module resolution
    return existsSync(modulePath) ? modulePath : null;
  }

  // Handle node_modules paths
  return resolveNodeModulesPath(modulePath, containingFile, compilerOptions);
}

/**
 * Resolve a relative markdown import path
 *
 * @param modulePath - Relative path (e.g., "./core.md", "../shared/core.md")
 * @param containingFile - Absolute path of the importing file
 * @returns Absolute path to the markdown file, or null if not found
 */
function resolveRelativePath(modulePath: string, containingFile: string): string | null {
  const containingDir = dirname(containingFile);
  const absolutePath = resolve(containingDir, modulePath);

  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Validated path from module resolution
  return existsSync(absolutePath) ? absolutePath : null;
}

/**
 * Resolve a node_modules markdown import path
 *
 * @param modulePath - Package path (e.g., "@pkg/prompts/core.md")
 * @param containingFile - Absolute path of the importing file
 * @param compilerOptions - TypeScript compiler options
 * @returns Absolute path to the markdown file, or null if not found
 */
function resolveNodeModulesPath(
  modulePath: string,
  containingFile: string,
  compilerOptions: ts.CompilerOptions,
): string | null {
  // Try TypeScript's module resolution
  const result = ts.resolveModuleName(
    modulePath,
    containingFile,
    compilerOptions,
    ts.sys,
  );

  if (result.resolvedModule) {
    return result.resolvedModule.resolvedFileName;
  }

  // Fallback: manually search node_modules
  return searchNodeModules(modulePath, containingFile);
}

/**
 * Manually search node_modules for a markdown file
 *
 * @param modulePath - Package path
 * @param containingFile - Absolute path of the importing file
 * @returns Absolute path to the markdown file, or null if not found
 */
function searchNodeModules(modulePath: string, containingFile: string): string | null {
  let currentDir = dirname(containingFile);

  // Walk up the directory tree looking for node_modules
  while (true) {
    const nodeModulesPath = join(currentDir, 'node_modules', modulePath);

    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Validated path from module resolution
    if (existsSync(nodeModulesPath)) {
      return nodeModulesPath;
    }

    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) {
      // Reached root directory
      break;
    }

    currentDir = parentDir;
  }

  return null;
}

/**
 * Create default compiler options for module resolution
 *
 * @returns Default TypeScript compiler options
 */
export function createDefaultCompilerOptions(): ts.CompilerOptions {
  return {
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    target: ts.ScriptTarget.ES2024,
    module: ts.ModuleKind.NodeNext,
    esModuleInterop: true,
    allowSyntheticDefaultImports: true,
    resolveJsonModule: true,
  };
}

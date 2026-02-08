/**
 * Enhance diagnostics to check markdown file and fragment existence
 */

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/explicit-module-boundary-types -- TypeScript Language Service plugin API requires any */

import { existsSync } from 'node:fs';

import {
  getMarkdownPathFromImport,
  getMarkdownPathFromExpression,
  resolveMarkdownPath,
  resolveAndLoadMarkdown,
} from './utils.js';

/**
 * Enhance semantic diagnostics with markdown-specific error checking
 *
 * @param ts - TypeScript module
 * @param info - Plugin create info
 * @param fileName - File being checked
 * @returns Enhanced diagnostics array
 */
export function enhanceDiagnostics(
  ts: any,
  info: any,
  fileName: string,
): readonly any[] {
  try {
    const baseDiagnostics = info.languageService.getSemanticDiagnostics(fileName);

    const program = info.languageService.getProgram();
    if (!program) {
      return baseDiagnostics;
    }

    const sourceFile = program.getSourceFile(fileName);
    if (!sourceFile) {
      return baseDiagnostics;
    }

    const additionalDiagnostics: any[] = [];

    // Traverse AST to find markdown-related nodes
    const visit = (node: any): void => {
      // Check markdown imports
      const importPath = getMarkdownPathFromImport(ts, node);
      if (importPath) {
        const diagnostic = checkMarkdownFileExists(
          info,
          importPath,
          fileName,
          node,
        );
        if (diagnostic) {
          additionalDiagnostics.push(diagnostic);
        }
      }

      // Check fragment accesses
      const expressionInfo = getMarkdownPathFromExpression(ts, node, sourceFile);
      if (expressionInfo) {
        const diagnostic = checkFragmentExists(
          info,
          expressionInfo.markdownPath,
          expressionInfo.fragmentName,
          fileName,
          node,
        );
        if (diagnostic) {
          additionalDiagnostics.push(diagnostic);
        }
      }

      ts.forEachChild(node, visit);
    };

    visit(sourceFile);

    return [...baseDiagnostics, ...additionalDiagnostics];
  } catch (error) {
    info.project.projectService.logger.info(
      `markdown-import-plugin: Error enhancing diagnostics: ${String(error)}`,
    );
    return info.languageService.getSemanticDiagnostics(fileName);
  }
}

/**
 * Check if a markdown file exists
 *
 * @param info - Plugin create info
 * @param markdownPath - Import path to markdown file
 * @param containingFile - File containing the import
 * @param node - AST node of the import
 * @returns Diagnostic if file doesn't exist, undefined otherwise
 */
function checkMarkdownFileExists(
  info: any,
  markdownPath: string,
  containingFile: string,
  node: any,
): any {
  const compilerOptions = info.project.getCompilerOptions();
  const absolutePath = resolveMarkdownPath(markdownPath, containingFile, compilerOptions);

  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Using validated path from TypeScript Language Service
  if (!absolutePath || !existsSync(absolutePath)) {
    return {
      file: node.getSourceFile(),
      start: node.moduleSpecifier ? node.moduleSpecifier.getStart() : node.getStart(),
      length: node.moduleSpecifier ? node.moduleSpecifier.getWidth() : node.getWidth(),
      messageText: `Cannot find markdown file: ${markdownPath}`,
      category: 1, // ts.DiagnosticCategory.Error
      code: 9999,
    };
  }

  return undefined;
}

/**
 * Check if a fragment exists in a markdown file
 *
 * @param info - Plugin create info
 * @param markdownPath - Import path to markdown file
 * @param fragmentName - camelCase fragment property name
 * @param containingFile - File containing the fragment access
 * @param node - AST node of the fragment access
 * @returns Diagnostic if fragment doesn't exist, undefined otherwise
 */
function checkFragmentExists(
  info: any,
  markdownPath: string,
  fragmentName: string,
  containingFile: string,
  node: any,
): any {
  try {
    // Resolve markdown path and load resource
    const result = resolveAndLoadMarkdown(info, markdownPath, containingFile);
    if (!result) {
      // File doesn't exist - this will be caught by checkMarkdownFileExists
      return undefined;
    }

    const { resource } = result;

    // Check if this is accessing a known property (meta, text, fragments)
    if (fragmentName === 'meta' || fragmentName === 'text' || fragmentName === 'fragments') {
      return undefined; // These are always valid
    }

    // Check if fragment exists
    const fragmentExists = resource.fragments.some((f: any) => f.camelCase === fragmentName);

    if (!fragmentExists) {
      // Get property name node for error span
      let propertyNode = node;
      if (node.name) {
        propertyNode = node.name;
      }

      // Suggest similar fragment names
      const suggestions = resource.fragments
        .map((f: any) => f.camelCase)
        .filter((name: string) => levenshteinDistance(name, fragmentName) <= 3)
        .slice(0, 3);

      let message = `Fragment '${fragmentName}' does not exist in ${markdownPath}`;
      if (suggestions.length > 0) {
        message += `. Did you mean: ${suggestions.join(', ')}?`;
      }

      return {
        file: propertyNode.getSourceFile(),
        start: propertyNode.getStart(),
        length: propertyNode.getWidth(),
        messageText: message,
        category: 1, // ts.DiagnosticCategory.Error
        code: 9998,
      };
    }

    return undefined;
  } catch (error) {
    info.project.projectService.logger.info(
      `markdown-import-plugin: Error checking fragment: ${String(error)}`,
    );
    return undefined;
  }
}

/**
 * Calculate Levenshtein distance between two strings (for suggestions)
 *
 * @param a - First string
 * @param b - Second string
 * @returns Edit distance
 */
function levenshteinDistance(a: string, b: string): number {
  const matrix: number[][] = [];

  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i];
  }

  for (let j = 0; j <= a.length; j++) {
    if (matrix[0]) {
      matrix[0][j] = j;
    }
  }

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      const cost = b.charAt(i - 1) === a.charAt(j - 1) ? 0 : 1;
      const row = matrix[i];
      const prevRow = matrix[i - 1];
      if (row && prevRow) {
        const deletion = (prevRow[j] ?? 0) + 1;
        const insertion = (row[j - 1] ?? 0) + 1;
        const substitution = (prevRow[j - 1] ?? 0) + cost;
        row[j] = Math.min(deletion, insertion, substitution);
      }
    }
  }

  const lastRow = matrix[b.length];
  return lastRow ? lastRow[a.length] ?? 0 : 0;
}

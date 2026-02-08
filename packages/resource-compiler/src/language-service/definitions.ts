/**
 * Enhance go-to-definition for markdown imports and fragments
 */

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/explicit-module-boundary-types -- TypeScript Language Service plugin API requires any */

import { readFileSync } from 'node:fs';

import {
  findNodeAtPosition,
  getMarkdownPathFromImport,
  getMarkdownPathFromExpression,
  resolveMarkdownPath,
  resolveAndLoadMarkdown,
  findHeadingPosition,
} from './utils.js';

/**
 * Enhance definition results with markdown file and fragment locations
 *
 * @param ts - TypeScript module
 * @param info - Plugin create info
 * @param fileName - File being edited
 * @param position - Cursor position
 * @returns Enhanced definition info, or original if no enhancements needed
 */
export function enhanceDefinitions(
  ts: any,
  info: any,
  fileName: string,
  position: number,
): readonly any[] | undefined {
  try {
    // Get the source file and program
    const program = info.languageService.getProgram();
    if (!program) {
      return info.languageService.getDefinitionAtPosition(fileName, position);
    }

    const sourceFile = program.getSourceFile(fileName);
    if (!sourceFile) {
      return info.languageService.getDefinitionAtPosition(fileName, position);
    }

    // Find the node at cursor position
    const node = findNodeAtPosition(ts, sourceFile, position);
    if (!node) {
      return info.languageService.getDefinitionAtPosition(fileName, position);
    }

    // Check if clicking on a markdown import
    const importPath = getMarkdownPathFromImport(ts, node);
    if (importPath) {
      return createMarkdownFileDefinition(info, importPath, fileName);
    }

    // Check if clicking on a fragment property
    const expressionInfo = getMarkdownPathFromExpression(ts, node, sourceFile);
    if (expressionInfo) {
      return createMarkdownFragmentDefinition(
        info,
        expressionInfo.markdownPath,
        expressionInfo.fragmentName,
        fileName,
      );
    }

    // Not a markdown context - return original definitions
    return info.languageService.getDefinitionAtPosition(fileName, position);
  } catch (error) {
    info.project.projectService.logger.info(
      `markdown-import-plugin: Error enhancing definitions: ${String(error)}`,
    );
    return info.languageService.getDefinitionAtPosition(fileName, position);
  }
}

/**
 * Create definition info for a markdown file
 *
 * @param info - Plugin create info
 * @param markdownPath - Import path to markdown file
 * @param containingFile - File containing the import
 * @returns Definition info array, or undefined if not found
 */
function createMarkdownFileDefinition(
  info: any,
  markdownPath: string,
  containingFile: string,
): any[] | undefined {
  const compilerOptions = info.project.getCompilerOptions();
  const absolutePath = resolveMarkdownPath(markdownPath, containingFile, compilerOptions);

  if (!absolutePath) {
    return undefined;
  }

  return [
    {
      fileName: absolutePath,
      textSpan: { start: 0, length: 0 },
      kind: 1, // ts.ScriptElementKind.moduleElement
      name: 'Markdown Resource',
      containerKind: 0, // ts.ScriptElementKind.unknown
      containerName: '',
    },
  ];
}

/**
 * Create definition info for a markdown fragment
 *
 * @param info - Plugin create info
 * @param markdownPath - Import path to markdown file
 * @param fragmentName - camelCase fragment property name
 * @param containingFile - File containing the fragment access
 * @returns Definition info array, or undefined if not found
 */
function createMarkdownFragmentDefinition(
  info: any,
  markdownPath: string,
  fragmentName: string,
  containingFile: string,
): any[] | undefined {
  try {
    // Resolve markdown path and load resource
    const result = resolveAndLoadMarkdown(info, markdownPath, containingFile);
    if (!result) {
      return undefined;
    }

    const { absolutePath, resource } = result;

    // Find the fragment matching this property name
    const fragment = resource.fragments.find((f: any) => f.camelCase === fragmentName);
    if (!fragment) {
      return undefined;
    }

    // Read markdown file content to find heading position
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Using validated path from TypeScript Language Service
    const content = readFileSync(absolutePath, 'utf-8');
    const position = findHeadingPosition(content, fragment.heading);

    if (!position) {
      // If we can't find the heading, just jump to start of file
      return [
        {
          fileName: absolutePath,
          textSpan: { start: 0, length: 0 },
          kind: 7, // ts.ScriptElementKind.constElement
          name: fragment.heading,
          containerKind: 0,
          containerName: '',
        },
      ];
    }

    // Calculate character offset from line/character position
    const lines = content.split('\n');
    let offset = 0;
    for (let i = 0; i < position.line; i++) {
      const line = lines[i];
      if (line !== undefined) {
        offset += line.length + 1; // +1 for newline
      }
    }
    offset += position.character;

    return [
      {
        fileName: absolutePath,
        textSpan: { start: offset, length: fragment.heading.length + 3 }, // +3 for "## "
        kind: 7, // ts.ScriptElementKind.constElement
        name: fragment.heading,
        containerKind: 0,
        containerName: '',
      },
    ];
  } catch (error) {
    info.project.projectService.logger.info(
      `markdown-import-plugin: Error creating fragment definition: ${String(error)}`,
    );
    return undefined;
  }
}

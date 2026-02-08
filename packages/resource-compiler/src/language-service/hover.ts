/**
 * Enhance hover tooltips with markdown content
 */

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/explicit-module-boundary-types -- TypeScript Language Service plugin API requires any */

import {
  findNodeAtPosition,
  getMarkdownPathFromExpression,
  resolveAndLoadMarkdown,
} from './utils.js';

/**
 * Enhance hover tooltips with markdown fragment information
 *
 * @param ts - TypeScript module
 * @param info - Plugin create info
 * @param prior - Original quick info from TypeScript
 * @param fileName - File being edited
 * @param position - Cursor position
 * @returns Enhanced quick info, or original if no enhancements needed
 */
export function enhanceHover(
  ts: any,
  info: any,
  prior: any,
  fileName: string,
  position: number,
): any {
  try {
    // Get the source file and program
    const program = info.languageService.getProgram();
    if (!program) {
      return prior;
    }

    const sourceFile = program.getSourceFile(fileName);
    if (!sourceFile) {
      return prior;
    }

    // Find the node at cursor position
    const node = findNodeAtPosition(ts, sourceFile, position);
    if (!node) {
      return prior;
    }

    // Check if hovering over a fragment property
    const expressionInfo = getMarkdownPathFromExpression(ts, node, sourceFile);
    if (expressionInfo) {
      return createMarkdownFragmentHover(
        ts,
        info,
        expressionInfo.markdownPath,
        expressionInfo.fragmentName,
        fileName,
        node,
      );
    }

    // Not a markdown context - return original hover info
    return prior;
  } catch (error) {
    // Log error and return original hover info
    info.project.projectService.logger.info(
      `markdown-import-plugin: Error enhancing hover: ${String(error)}`,
    );
    return prior;
  }
}

/**
 * Create hover information for a markdown fragment
 *
 * @param ts - TypeScript module
 * @param info - Plugin create info
 * @param markdownPath - Import path to markdown file
 * @param fragmentName - camelCase fragment property name
 * @param containingFile - File containing the fragment access
 * @param node - AST node being hovered
 * @returns Quick info with fragment details, or undefined if not found
 */
function createMarkdownFragmentHover(
  ts: any,
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
      return undefined;
    }

    const { resource } = result;

    // Find the fragment matching this property name
    const fragment = resource.fragments.find((f: any) => f.camelCase === fragmentName);
    if (!fragment) {
      return undefined;
    }

    // Get the property name node for text span
    let propertyNode = node;
    if (ts.isPropertyAccessExpression(node)) {
      propertyNode = node.name;
    }

    // Create quick info with fragment heading and content
    const quickInfo: any = {
      kind: ts.ScriptElementKind.memberVariableElement,
      kindModifiers: 'declare',
      textSpan: {
        start: propertyNode.getStart(),
        length: propertyNode.getWidth(),
      },
      displayParts: [
        { text: 'fragment', kind: 'keyword' },
        { text: ' ', kind: 'space' },
        { text: fragmentName, kind: 'propertyName' },
        { text: ':', kind: 'punctuation' },
        { text: ' ', kind: 'space' },
        { text: 'MarkdownFragment', kind: 'interfaceName' },
      ],
      documentation: createFragmentDocumentation(fragment.heading, fragment.body),
    };

    return quickInfo;
  } catch (error) {
    info.project.projectService.logger.info(
      `markdown-import-plugin: Error creating fragment hover: ${String(error)}`,
    );
    return undefined;
  }
}

/**
 * Create documentation display parts for a fragment
 *
 * @param heading - Fragment heading text
 * @param body - Fragment body content
 * @returns Array of display parts for documentation
 */
function createFragmentDocumentation(
  heading: string,
  body: string,
): any[] | undefined {
  const parts: any[] = [];

  // Add heading
  parts.push(
    { text: '## ', kind: 'text' },
    { text: heading, kind: 'text' },
    { text: '\n\n', kind: 'lineBreak' },
  );

  // Add body content (truncate if too long)
  const maxBodyLength = 500;
  let bodyText = body.trim();

  if (bodyText.length > maxBodyLength) {
    bodyText = bodyText.slice(0, maxBodyLength) + '...';
  }

  if (bodyText.length > 0) {
    parts.push({ text: bodyText, kind: 'text' });
  } else {
    parts.push({ text: '(empty fragment)', kind: 'text' });
  }

  return parts;
}

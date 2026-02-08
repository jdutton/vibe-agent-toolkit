/**
 * Enhance autocomplete with markdown fragment suggestions
 */

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/explicit-module-boundary-types, max-depth, sonarjs/cognitive-complexity -- TypeScript Language Service plugin API requires any and complex AST traversal */

import {
  getSourceFileAndNode,
  getMarkdownPathFromExpression,
  resolveAndLoadMarkdown,
} from './utils.js';

/**
 * Enhance completion items with markdown fragment suggestions
 *
 * @param ts - TypeScript module
 * @param info - Plugin create info
 * @param prior - Original completion results from TypeScript
 * @param fileName - File being edited
 * @param position - Cursor position
 * @returns Enhanced completion results, or original if no enhancements needed
 */
export function enhanceCompletions(
  ts: any,
  info: any,
  prior: any,
  fileName: string,
  position: number,
): any {
  // If no prior completions, return undefined
  if (!prior) {
    return undefined;
  }

  try {
    // Get the source file and find the node at cursor
    const context = getSourceFileAndNode(ts, info, fileName, position);
    if (!context) {
      return prior;
    }

    // Check if we're in a markdown fragment access context
    // Look for patterns like: Core.fragments.<cursor>
    let parent = context.node.parent;
    while (parent) {
      if (ts.isPropertyAccessExpression(parent)) {
        const expressionInfo = getMarkdownPathFromExpression(ts, parent, context.sourceFile);
        if (expressionInfo) {
          // Found markdown fragment access - add completions
          return addMarkdownFragmentCompletions(
            ts,
            info,
            prior,
            expressionInfo.markdownPath,
            fileName,
          );
        }
      }
      parent = parent.parent;
    }

    // Not in a markdown context - return original completions
    return prior;
  } catch (error) {
    // Log error and return original completions
    info.project.projectService.logger.info(
      `markdown-import-plugin: Error enhancing completions: ${String(error)}`,
    );
    return prior;
  }
}

/**
 * Add markdown fragment completions to the completion list
 *
 * @param ts - TypeScript module
 * @param info - Plugin create info
 * @param prior - Original completion results
 * @param markdownPath - Import path to markdown file
 * @param containingFile - File containing the completion request
 * @returns Enhanced completion results with markdown fragments
 */
function addMarkdownFragmentCompletions(
  ts: any,
  info: any,
  prior: any,
  markdownPath: string,
  containingFile: string,
): any {
  try {
    // Resolve markdown path and load resource
    const result = resolveAndLoadMarkdown(info, markdownPath, containingFile);
    if (!result) {
      return prior;
    }

    // Create completion entries for each fragment
    const fragmentEntries: any[] = result.resource.fragments.map((fragment) => ({
      name: fragment.camelCase,
      kind: ts.ScriptElementKind.propertyElement,
      sortText: '0', // Sort before other completions
      insertText: fragment.camelCase,
      kindModifiers: 'declare',
    }));

    // Merge with original completions
    return {
      ...prior,
      entries: [...fragmentEntries, ...prior.entries],
    };
  } catch (error) {
    // Log error and return original completions
    info.project.projectService.logger.info(
      `markdown-import-plugin: Error loading markdown for completions: ${String(error)}`,
    );
    return prior;
  }
}

/**
 * Get detailed information for a completion entry
 * Called when user hovers over a completion item
 *
 * @param ts - TypeScript module
 * @param info - Plugin create info
 * @param fileName - File being edited
 * @param position - Cursor position
 * @param entryName - Name of the completion entry
 * @returns Detailed completion entry info, or undefined
 */
export function getCompletionEntryDetails(
  ts: any,
  info: any,
  fileName: string,
  position: number,
  entryName: string,
): any {
  try {
    // Get the source file and node
    const context = getSourceFileAndNode(ts, info, fileName, position);
    if (!context) {
      return undefined;
    }

    // Find markdown context
    let parent = context.node.parent;
    while (parent) {
      if (ts.isPropertyAccessExpression(parent)) {
        const expressionInfo = getMarkdownPathFromExpression(ts, parent, context.sourceFile);
        if (expressionInfo) {
          // Resolve and load the markdown file
          const result = resolveAndLoadMarkdown(info, expressionInfo.markdownPath, fileName);
          if (!result) {
            return undefined;
          }

          // Find the fragment matching this entry
          const fragment = result.resource.fragments.find((f) => f.camelCase === entryName);
          if (!fragment) {
            return undefined;
          }

          // Return detailed info with fragment heading
          return {
            name: entryName,
            kind: ts.ScriptElementKind.propertyElement,
            kindModifiers: 'declare',
            displayParts: [
              { text: 'fragment', kind: 'keyword' },
              { text: ' ', kind: 'space' },
              { text: entryName, kind: 'propertyName' },
            ],
            documentation: [
              {
                text: `Markdown fragment: ${fragment.heading}`,
                kind: 'text',
              },
            ],
          };
        }
      }
      parent = parent.parent;
    }

    return undefined;
  } catch {
    return undefined;
  }
}

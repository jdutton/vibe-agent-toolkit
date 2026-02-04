/**
 * TypeScript Language Service Plugin for markdown imports
 * Provides autocomplete, go-to-definition, diagnostics, and hover support
 */

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/explicit-module-boundary-types -- TypeScript Language Service plugin API requires any */

import { enhanceCompletions } from './completions.js';
import { enhanceDefinitions } from './definitions.js';
import { enhanceDiagnostics } from './diagnostics.js';
import { enhanceHover } from './hover.js';

/**
 * Plugin initialization function
 * Called by TypeScript when loading the plugin
 */
function init(modules: { typescript: any }) {
  const ts = modules.typescript;

  /**
   * Create the Language Service plugin
   */
  function create(info: any): any {
    const logger = info.project.projectService.logger;

    logger.info('markdown-import-plugin: Plugin initialized');

    // Get the original Language Service
    const languageService = info.languageService;

    // Create proxy to intercept Language Service methods
    const proxy: any = {
      ...languageService,

      // Enhance autocomplete with markdown fragment suggestions
      getCompletionsAtPosition(
        fileName: string,
        position: number,
        options: any,
      ): any {
        const prior = languageService.getCompletionsAtPosition(fileName, position, options);
        return enhanceCompletions(ts, info, prior, fileName, position);
      },

      // Enhance go-to-definition for markdown imports and fragments
      getDefinitionAtPosition(
        fileName: string,
        position: number,
      ): any {
        return enhanceDefinitions(ts, info, fileName, position);
      },

      // Enhance diagnostics to check markdown file/fragment existence
      getSemanticDiagnostics(fileName: string): any {
        return enhanceDiagnostics(ts, info, fileName);
      },

      // Enhance hover tooltips with markdown content
      getQuickInfoAtPosition(fileName: string, position: number): any {
        const prior = languageService.getQuickInfoAtPosition(fileName, position);
        return enhanceHover(ts, info, prior, fileName, position);
      },
    };

    return proxy;
  }

  return { create };
}

export default init;

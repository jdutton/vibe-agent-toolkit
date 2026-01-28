import { RESULT_SUCCESS, type OneShotAgentOutput } from '@vibe-agent-toolkit/agent-schema';

import type { MCPToolResult } from '../types.js';

/**
 * Translates VAT agent results to MCP tool results
 */
export class ResultTranslator {
  /**
   * Convert VAT agent output envelope to MCP tool result
   */
  toMCPResult(agentOutput: OneShotAgentOutput<unknown, string>): MCPToolResult {
    const { result } = agentOutput;

    if (result.status === RESULT_SUCCESS) {
      return {
        content: [
          {
            type: 'text',
            text: this.formatSuccess(result.data, result.confidence, result.warnings),
          },
        ],
        isError: false,
      };
    }

    return {
      content: [
        {
          type: 'text',
          text: this.formatError(result.error, result.confidence),
        },
      ],
      isError: true,
    };
  }

  /**
   * Format success data for MCP text response
   */
  private formatSuccess(
    data: unknown,
    confidence?: number,
    warnings?: string[]
  ): string {
    const lines: string[] = [];

    // If data has a reply field, return that directly (conversational)
    if (this.isReplyData(data)) {
      lines.push(data.reply);
    } else {
      // Otherwise, return JSON
      lines.push(JSON.stringify(data, null, 2));
    }

    // Add observability metadata if present
    if (confidence !== undefined) {
      lines.push(`\nConfidence: ${confidence}`);
    }

    if (warnings && warnings.length > 0) {
      lines.push('\nWarnings:');
      for (const warning of warnings) {
        lines.push(`  • ${warning}`);
      }
    }

    return lines.join('\n');
  }

  /**
   * Format error for MCP text response
   */
  private formatError(errorType: string, confidence?: number): string {
    const lines: string[] = [];

    lines.push(`Error: ${errorType}`);

    if (confidence !== undefined) {
      lines.push(`Confidence: ${confidence}`);
    }

    return lines.join('\n');
  }

  /**
   * Type guard for conversational reply data
   */
  private isReplyData(data: unknown): data is { reply: string } {
    return (
      typeof data === 'object' &&
      data !== null &&
      'reply' in data &&
      typeof (data as { reply: unknown }).reply === 'string'
    );
  }
}

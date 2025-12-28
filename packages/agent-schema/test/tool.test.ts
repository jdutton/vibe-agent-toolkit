import { describe, expect, it } from 'vitest';

import { ToolSchema } from '../src/tool';

const BRAVE_SEARCH_SERVER = 'brave-search';

describe('ToolSchema', () => {
  it('should validate MCP tool', () => {
    const data = {
      name: 'web_search',
      type: 'mcp',
      server: BRAVE_SEARCH_SERVER,
      description: 'Search the web',
    };

    const result = ToolSchema.safeParse(data);
    expect(result.success).toBe(true);
  });

  it('should validate builtin tool with LLM mapping', () => {
    const data = {
      name: 'web_fetch',
      type: 'builtin',
      llmMapping: {
        anthropic: 'claude_fetch',
        openai: 'function_call',
      },
    };

    const result = ToolSchema.safeParse(data);
    expect(result.success).toBe(true);
  });

  it('should validate tool with alternatives', () => {
    const data = {
      name: 'web_search',
      type: 'mcp',
      server: BRAVE_SEARCH_SERVER,
      alternatives: [
        {
          type: 'library',
          package: 'duckduckgo-search',
          function: 'ddg_search',
        },
      ],
    };

    const result = ToolSchema.safeParse(data);
    expect(result.success).toBe(true);
  });

  it('should require name', () => {
    const data = {
      type: 'mcp',
      server: BRAVE_SEARCH_SERVER,
    };

    const result = ToolSchema.safeParse(data);
    expect(result.success).toBe(false);
  });
});

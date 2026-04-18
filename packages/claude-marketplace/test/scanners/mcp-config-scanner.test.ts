import { describe, expect, it } from 'vitest';

import { scanMcpConfig } from '../../src/scanners/mcp-config-scanner.js';

describe('scanMcpConfig', () => {
  it('returns empty for config with no servers', () => {
    const result = scanMcpConfig({}, '.mcp.json');
    expect(result).toEqual([]);
  });

  it('emits MCP_SERVER_COMMAND for a node MCP server', () => {
    const config = {
      mcpServers: {
        myServer: { command: 'node', args: ['server.mjs'] },
      },
    };
    const result = scanMcpConfig(config, '.mcp.json');
    expect(result).toHaveLength(1);
    expect(result[0]?.patternId).toBe('MCP_SERVER_COMMAND');
    expect(result[0]?.matchText).toContain('node');
  });

  it('emits MCP_SERVER_COMMAND for a python3 MCP server', () => {
    const config = {
      mcpServers: {
        weather: { command: 'python3', args: ['-m', 'weather_server'] },
      },
    };
    const result = scanMcpConfig(config, '.mcp.json');
    expect(result[0]?.patternId).toBe('MCP_SERVER_COMMAND');
    expect(result[0]?.matchText).toContain('python3');
  });

  it('emits MCP_SERVER_COMMAND for uv-based MCP server', () => {
    const config = {
      mcpServers: {
        weather: { command: 'uv', args: ['run', 'weather.py'] },
      },
    };
    const result = scanMcpConfig(config, '.mcp.json');
    expect(result[0]?.patternId).toBe('MCP_SERVER_COMMAND');
    expect(result[0]?.matchText).toContain('uv');
  });

  it('emits MCP_SERVER_COMMAND for npx commands', () => {
    const config = {
      mcpServers: {
        tool: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem'] },
      },
    };
    const result = scanMcpConfig(config, '.mcp.json');
    expect(result[0]?.patternId).toBe('MCP_SERVER_COMMAND');
  });

  it('emits MCP_SERVER_URL for HTTP-style server entries', () => {
    const config = {
      mcpServers: {
        remote: { url: 'https://example.com/mcp' },
      },
    };
    const result = scanMcpConfig(config, '.mcp.json');
    expect(result).toHaveLength(1);
    expect(result[0]?.patternId).toBe('MCP_SERVER_URL');
    expect(result[0]?.matchText).toContain('https://example.com/mcp');
  });

  it('handles multiple servers', () => {
    const config = {
      mcpServers: {
        nodeServer: { command: 'node', args: ['a.mjs'] },
        pythonServer: { command: 'python3', args: ['b.py'] },
      },
    };
    const result = scanMcpConfig(config, '.mcp.json');
    expect(result).toHaveLength(2);
  });
});

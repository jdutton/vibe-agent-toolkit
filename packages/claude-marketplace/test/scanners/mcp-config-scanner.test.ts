import { describe, expect, it } from 'vitest';

import { scanMcpConfig } from '../../src/scanners/mcp-config-scanner.js';

describe('scanMcpConfig', () => {
  it('returns empty for config with no servers', () => {
    const result = scanMcpConfig({}, '.mcp.json');
    expect(result).toEqual([]);
  });

  it('treats node MCP server as compatible everywhere', () => {
    const config = {
      mcpServers: {
        myServer: { command: 'node', args: ['server.mjs'] },
      },
    };
    const result = scanMcpConfig(config, '.mcp.json');
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      source: 'mcp-server',
      signal: 'mcp-server: node',
      impact: {
        'claude-desktop': 'ok',
        cowork: 'ok',
        'claude-code': 'ok',
      },
    });
  });

  it('flags python3 MCP server as needs-review for desktop', () => {
    const config = {
      mcpServers: {
        weather: { command: 'python3', args: ['-m', 'weather_server'] },
      },
    };
    const result = scanMcpConfig(config, '.mcp.json');
    expect(result[0]?.impact['claude-desktop']).toBe('needs-review');
  });

  it('flags uv-based MCP server as needs-review for desktop', () => {
    const config = {
      mcpServers: {
        weather: { command: 'uv', args: ['run', 'weather.py'] },
      },
    };
    const result = scanMcpConfig(config, '.mcp.json');
    expect(result[0]?.signal).toBe('mcp-server: uv');
    expect(result[0]?.impact['claude-desktop']).toBe('needs-review');
  });

  it('handles npx commands', () => {
    const config = {
      mcpServers: {
        tool: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem'] },
      },
    };
    const result = scanMcpConfig(config, '.mcp.json');
    expect(result[0]?.impact['claude-desktop']).toBe('ok');
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

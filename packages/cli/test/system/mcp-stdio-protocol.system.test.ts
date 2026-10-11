/**
 * MCP stdio protocol compliance tests
 *
 * Verifies that the MCP gateway correctly implements stdio transport:
 * - stdout: JSON-RPC messages ONLY
 * - stderr: logs, debug output, errors
 */

import { it } from 'vitest';

import {
  describe,
  dirname,
  expect,
  fileURLToPath,
  getBinPath,
  resolve,
} from './test-common.js';
import { executeCli, MCPTestClient } from './test-helpers/index.js';

const binPath = getBinPath(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));

// Test constants
const CAT_AGENTS_PACKAGE = '@vibe-agent-toolkit/vat-example-cat-agents';
const REPO_ROOT = resolve(__dirname, '../../../..');

function spawnTestClient(): Promise<MCPTestClient> {
  return MCPTestClient.spawn(
    binPath,
    ['mcp', 'serve', CAT_AGENTS_PACKAGE],
    { VAT_ROOT_DIR: REPO_ROOT }
  );
}

describe('MCP stdio protocol compliance (system test)', () => {
  it('should write ONLY JSON-RPC to stdout, logs to stderr', async () => {
    const client = await spawnTestClient();

    try {
      await client.initialize();
      await client.request('tools/list');

      // CRITICAL: stdout must contain ONLY valid JSON-RPC messages
      expect(client.stdoutLines.length).toBeGreaterThan(0);

      for (const line of client.stdoutLines) {
        expect(() => JSON.parse(line), `stdout line should be valid JSON: ${line}`).not.toThrow();

        const parsed = JSON.parse(line);
        expect(parsed).toHaveProperty('jsonrpc');
        expect(parsed.jsonrpc).toBe('2.0');

        // Should NOT contain log prefixes
        expect(line).not.toMatch(/\[INFO\]/);
        expect(line).not.toMatch(/\[DEBUG\]/);
        expect(line).not.toMatch(/\[ERROR\]/);
        expect(line).not.toMatch(/\[WARN\]/);
      }

      // stderr should contain logs (optional, but if present should have log format)
      if (client.stderrLines.length > 0) {
        const hasLogPrefix = client.stderrLines.some(
          (line) =>
            line.includes('[INFO]') ||
            line.includes('[DEBUG]') ||
            line.includes('[ERROR]') ||
            line.includes('[WARN]')
        );

        expect(hasLogPrefix).toBe(true);
      }
    } finally {
      await client.close();
    }
  }, 20_000);

  it('should respond to initialize with correct capabilities', async () => {
    const client = await spawnTestClient();

    try {
      const response = await client.initialize();

      expect(response).toHaveProperty('result');
      const result = (response as { result: { capabilities: { tools?: object } } }).result;
      expect(result).toHaveProperty('capabilities');
      expect(result.capabilities).toHaveProperty('tools');
    } finally {
      await client.close();
    }
  }, 20_000);

  it('should list haiku-validator and photo-analyzer tools', async () => {
    const client = await spawnTestClient();

    try {
      await client.initialize();
      const toolsResponse = await client.request('tools/list');

      expect(toolsResponse).toHaveProperty('result');
      const result = (toolsResponse as { result: { tools: Array<{ name: string }> } }).result;
      expect(result).toHaveProperty('tools');
      expect(Array.isArray(result.tools)).toBe(true);

      const toolNames = result.tools.map((tool) => tool.name);
      expect(toolNames).toContain('haiku-validator');
      expect(toolNames).toContain('photo-analyzer');
    } finally {
      await client.close();
    }
  }, 20_000);

  it('mcp serve --print-config writes only the JSON config to stdout', () => {
    const result = executeCli(binPath, ['mcp', 'serve', CAT_AGENTS_PACKAGE, '--print-config']);

    expect(result.status, result.stderr).toBe(0);
    // stdout is the artifact an operator redirects into a file: the config and nothing else.
    expect(JSON.parse(result.stdout)).toStrictEqual({
      mcpServers: { 'vat-vat-example-cat-agents': { command: 'vat', args: ['mcp', 'serve', CAT_AGENTS_PACKAGE] } },
    });
    // The instructions around it are for the human, on stderr.
    expect(result.stderr).toContain('Claude Desktop configuration');
  });
});

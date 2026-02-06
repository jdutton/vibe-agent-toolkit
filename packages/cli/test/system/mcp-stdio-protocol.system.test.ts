/**
 * MCP stdio protocol compliance tests
 *
 * Verifies that the MCP gateway correctly implements stdio transport:
 * - stdout: JSON-RPC messages ONLY
 * - stderr: logs, debug output, errors
 */

import { spawn } from 'node:child_process';

import { it, beforeAll, afterAll } from 'vitest';

import {
  describe,
  dirname,
  expect,
  fileURLToPath,
  fs,
  getBinPath,
  resolve,
} from './test-common.js';
import { createTestTempDir, waitForStreamData } from './test-helpers.js';

const binPath = getBinPath(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));

// Test constants
const CAT_AGENTS_PACKAGE = '@vibe-agent-toolkit/vat-example-cat-agents';
const MCP_SERVE_COMMAND = 'mcp';
const MCP_SERVE_SUBCOMMAND = 'serve';
const REPO_ROOT_RELATIVE = '../../../..';
const MCP_PROTOCOL_VERSION = '2024-11-05';
const TEST_CLIENT_NAME = 'test-client';

/**
 * Helper to spawn MCP server for testing
 */
function spawnMCPServer() {
  const repoRoot = resolve(__dirname, REPO_ROOT_RELATIVE);

  // eslint-disable-next-line sonarjs/no-os-command-from-path -- Test spawns CLI process intentionally
  return spawn('node', [binPath, MCP_SERVE_COMMAND, MCP_SERVE_SUBCOMMAND, CAT_AGENTS_PACKAGE], {
    env: { ...process.env, VAT_ROOT_DIR: repoRoot },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

/**
 * Helper to send MCP initialize request
 */
function createInitializeRequest(id: number) {
  return {
    jsonrpc: '2.0',
    id,
    method: 'initialize',
    params: {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: TEST_CLIENT_NAME, version: '1.0.0' },
    },
  };
}

/**
 * Helper to capture JSON-RPC response with specific ID
 */
function captureResponseById(server: ReturnType<typeof spawnMCPServer>, targetId: number) {
  let response: unknown = null;

  server.stdout.on('data', (chunk) => {
    const lines = chunk.toString().split('\n').filter((line: string) => line.trim());
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        if (parsed.id === targetId) {
          response = parsed;
        }
      } catch {
        // Ignore parse errors (shouldn't happen, but defensive)
      }
    }
  });

  return {
    getResponse: () => response,
  };
}

describe('MCP stdio protocol compliance (system test)', () => {
  let tempDir: string;

  beforeAll(() => {
    tempDir = createTestTempDir('vat-mcp-stdio-test-');
  });

  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('should write ONLY JSON-RPC to stdout, logs to stderr', async () => {
    const server = spawnMCPServer();

    const stdoutLines: string[] = [];
    const stderrLines: string[] = [];
    let stdoutBuffer = '';

    // Collect stdout (should be JSON-RPC only)
    server.stdout.on('data', (chunk) => {
      stdoutBuffer += chunk.toString();
      const lines = stdoutBuffer.split('\n');
      stdoutBuffer = lines.pop() ?? ''; // Keep incomplete line in buffer
      stdoutLines.push(...lines.filter((line) => line.trim()));
    });

    // Collect stderr (should contain logs)
    server.stderr.on('data', (chunk) => {
      stderrLines.push(...chunk.toString().split('\n').filter((line: string) => line.trim()));
    });

    // Send MCP initialize request
    const initRequest = createInitializeRequest(1);
    server.stdin.write(`${JSON.stringify(initRequest)}\n`);

    // Wait for initialize response
    await waitForStreamData(server.stdout, { timeout: 2000, pattern: /"id":\s*1/ });

    // Send tools/list request
    const toolsRequest = {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params: {},
    };

    server.stdin.write(`${JSON.stringify(toolsRequest)}\n`);

    // Wait for tools/list response
    await waitForStreamData(server.stdout, { timeout: 1000, pattern: /"id":\s*2/ });

    // Cleanup
    server.kill('SIGTERM');
    await waitForStreamData(server.stdout, { timeout: 500 });

    // CRITICAL: stdout must contain ONLY valid JSON-RPC messages
    expect(stdoutLines.length).toBeGreaterThan(0);

    for (const line of stdoutLines) {
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
    if (stderrLines.length > 0) {
      const hasLogPrefix = stderrLines.some(
        (line) =>
          line.includes('[INFO]') ||
          line.includes('[DEBUG]') ||
          line.includes('[ERROR]') ||
          line.includes('[WARN]')
      );

      // If we got stderr output, at least some should be log messages
      expect(hasLogPrefix).toBe(true);
    }
  }, 10000); // 10s timeout for process spawning

  it('should respond to initialize with correct capabilities', async () => {
    const server = spawnMCPServer();
    const responseCapture = captureResponseById(server, 1);

    // Send initialize request
    const initRequest = createInitializeRequest(1);
    server.stdin.write(`${JSON.stringify(initRequest)}\n`);

    // Wait for initialize response
    await waitForStreamData(server.stdout, { timeout: 2000, pattern: /"id":\s*1/ });

    // Cleanup
    server.kill('SIGTERM');
    await waitForStreamData(server.stdout, { timeout: 500 });

    const response = responseCapture.getResponse();
    expect(response).not.toBeNull();
    expect(response).toHaveProperty('result');
    const result = (response as { result: { capabilities: { tools?: object } } }).result;
    expect(result).toHaveProperty('capabilities');
    expect(result.capabilities).toHaveProperty('tools');
  }, 10000);

  it('should list haiku-validator and photo-analyzer tools', async () => {
    const server = spawnMCPServer();
    const toolsCapture = captureResponseById(server, 2);

    // Initialize first
    const initRequest = createInitializeRequest(1);
    server.stdin.write(`${JSON.stringify(initRequest)}\n`);
    await waitForStreamData(server.stdout, { timeout: 1000, pattern: /"id":\s*1/ });

    // Request tools list
    const toolsRequest = {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params: {},
    };

    server.stdin.write(`${JSON.stringify(toolsRequest)}\n`);
    await waitForStreamData(server.stdout, { timeout: 2000, pattern: /"id":\s*2/ });

    // Cleanup
    server.kill('SIGTERM');
    await waitForStreamData(server.stdout, { timeout: 500 });

    const toolsResponse = toolsCapture.getResponse();
    expect(toolsResponse).not.toBeNull();
    expect(toolsResponse).toHaveProperty('result');
    const result = (toolsResponse as { result: { tools: Array<{ name: string }> } }).result;
    expect(result).toHaveProperty('tools');
    expect(Array.isArray(result.tools)).toBe(true);

    const toolNames = result.tools.map((tool) => tool.name);
    expect(toolNames).toContain('haiku-validator');
    expect(toolNames).toContain('photo-analyzer');
  }, 10000);
});

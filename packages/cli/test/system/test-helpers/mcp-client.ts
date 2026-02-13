/**
 * MCP test client for system tests
 */

import { spawn, type ChildProcess } from 'node:child_process';

// ── MCP Test Client ──────────────────────────────────────────────────

/** JSON-RPC response shape */
interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

/**
 * Reusable MCP test client that handles server lifecycle reliably.
 *
 * Eliminates race conditions by:
 * 1. Waiting for the server's readiness signal on stderr before sending requests
 * 2. Using a single stdout listener that buffers, parses, and resolves pending requests
 * 3. Auto-incrementing request IDs so tests don't collide
 *
 * Usage:
 * ```ts
 * const client = await MCPTestClient.spawn(binPath, ['mcp', 'serve', pkg], { VAT_ROOT_DIR: root });
 * const initResult = await client.initialize();
 * const tools = await client.request('tools/list');
 * await client.close();
 * ```
 */
export class MCPTestClient {
  private readonly proc: ChildProcess;
  private readonly stdin: NodeJS.WritableStream;
  private readonly stdout: NodeJS.ReadableStream;
  private readonly stderr: NodeJS.ReadableStream;
  private nextId = 1;
  private stdoutBuffer = '';
  private readonly pending = new Map<number, {
    resolve: (value: JsonRpcResponse) => void;
    reject: (reason: Error) => void;
    timer: NodeJS.Timeout;
  }>();

  /** All complete lines received on stdout (for protocol compliance checks) */
  readonly stdoutLines: string[] = [];
  /** All lines received on stderr (for log verification) */
  readonly stderrLines: string[] = [];

  private constructor(proc: ChildProcess) {
    if (!proc.stdin || !proc.stdout || !proc.stderr) {
      throw new Error('MCPTestClient requires stdio: [pipe, pipe, pipe]');
    }
    this.proc = proc;
    this.stdin = proc.stdin;
    this.stdout = proc.stdout;
    this.stderr = proc.stderr;

    // Single stdout listener: buffer lines, parse JSON-RPC, resolve pending requests
    this.stdout.on('data', (chunk: Buffer) => {
      this.stdoutBuffer += chunk.toString();
      const lines = this.stdoutBuffer.split('\n');
      this.stdoutBuffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        this.stdoutLines.push(trimmed);

        try {
          const parsed = JSON.parse(trimmed) as JsonRpcResponse;
          if (typeof parsed.id === 'number') {
            const entry = this.pending.get(parsed.id);
            if (entry) {
              clearTimeout(entry.timer);
              this.pending.delete(parsed.id);
              entry.resolve(parsed);
            }
          }
        } catch {
          // Non-JSON on stdout — tests can check stdoutLines for compliance
        }
      }
    });

    // Collect stderr
    this.stderr.on('data', (chunk: Buffer) => {
      this.stderrLines.push(
        ...chunk.toString().split('\n').filter((l: string) => l.trim())
      );
    });
  }

  /**
   * Spawn an MCP server and wait for its readiness signal.
   * Resolves only after the server logs "[MCP Gateway] Ready" on stderr.
   */
  static async spawn(
    binPath: string,
    args: string[],
    env?: Record<string, string>,
    options?: { readyTimeout?: number }
  ): Promise<MCPTestClient> {
    const readyTimeout = options?.readyTimeout ?? 10_000;

    // eslint-disable-next-line sonarjs/no-os-command-from-path -- Test spawns CLI process intentionally
    const proc = spawn('node', [binPath, ...args], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const client = new MCPTestClient(proc);

    // Wait for readiness signal on stderr
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(
          `MCP server did not become ready within ${readyTimeout}ms.\n` +
            `stderr: ${client.stderrLines.join('\n')}`
        ));
      }, readyTimeout);

      const check = () => {
        if (client.stderrLines.some(l => l.includes('[MCP Gateway] Ready'))) {
          clearTimeout(timer);
          resolve();
        }
      };

      // Check each new stderr line
      client.stderr.on('data', () => check());
      // Also check immediately in case it arrived already
      check();
    });

    return client;
  }

  /**
   * Send the MCP initialize handshake and return the server's response.
   */
  async initialize(options?: { timeout?: number }): Promise<JsonRpcResponse> {
    return this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'vat-test-client', version: '1.0.0' },
    }, options);
  }

  /**
   * Send a JSON-RPC request and wait for the response with matching ID.
   */
  async request(
    method: string,
    params?: unknown,
    options?: { timeout?: number }
  ): Promise<JsonRpcResponse> {
    const id = this.nextId++;
    const timeout = options?.timeout ?? 5000;

    const promise = new Promise<JsonRpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(
          `MCP request "${method}" (id=${id}) timed out after ${timeout}ms.\n` +
            `stdout lines: ${this.stdoutLines.length}\n` +
            `stderr: ${this.stderrLines.slice(-5).join('\n')}`
        ));
      }, timeout);

      this.pending.set(id, { resolve, reject, timer });
    });

    const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params: params ?? {} });
    this.stdin.write(`${msg}\n`);

    return promise;
  }

  /**
   * Gracefully shut down the server process.
   */
  async close(): Promise<void> {
    // Clear any pending requests
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      this.pending.delete(id);
    }

    if (this.proc.exitCode === null) {
      this.proc.kill('SIGTERM');
      // Wait for exit (up to 2s)
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => {
          this.proc.kill('SIGKILL');
          resolve();
        }, 2000);
        this.proc.on('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }

    // Prevent unbounded memory growth from accumulated output lines
    this.stdoutLines.length = 0;
    this.stderrLines.length = 0;
  }
}

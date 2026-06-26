/**
 * Tests for WebSocket transport.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import type { ConversationalFunction } from '../src/types.js';
import { WebSocketTransport, type WebSocketIncomingMessage } from '../src/websocket.js';

import { createConnectedClient, startTransport, waitForClose, waitForResponse } from './test-helpers.js';

// Port 0 lets the OS assign a free ephemeral port at start(); the actual bound
// port is read back via `transport.boundPort`. A hardcoded port made these
// tests flake with EADDRINUSE when a prior server had not fully released it or
// a parallel worker claimed the same number.
const ephemeralPort = 0;

/** The OS-assigned port a started transport is listening on. */
function boundPort(t: WebSocketTransport<{ count: number }>): number {
  const port = t.boundPort;
  if (port === null) throw new Error('transport is not listening');
  return port;
}

describe('WebSocketTransport', () => {
  let mockFn: ConversationalFunction<string, string, { count: number }>;
  let transport: WebSocketTransport<{ count: number }>;

  beforeEach(() => {
    // Mock conversational function that tracks message count
    mockFn = vi.fn(async (input: string, context) => {
      const count = (context.state?.count ?? 0) + 1;
      context.state = { count };
      return `Message #${String(count)}: ${String(input)}`;
    });
  });

  afterEach(async () => {
    if (transport) {
      await transport.stop();
    }
  });

  it('should create transport with default options', () => {
    transport = new WebSocketTransport({ fn: mockFn, port: ephemeralPort });
    expect(transport).toBeDefined();
  });

  it('should create transport with custom options', () => {
    transport = new WebSocketTransport({
      fn: mockFn,
      port: ephemeralPort,
      host: '127.0.0.1',
      createInitialState: () => ({ count: 0 }),
    });
    expect(transport).toBeDefined();
  });

  it('should start and stop server', async () => {
    transport = new WebSocketTransport({ fn: mockFn, port: ephemeralPort });

    await transport.start();
    expect(transport).toBeDefined();
    await transport.stop();
  });

  it('should handle client connection and message exchange', async () => {
    transport = await startTransport({
      fn: mockFn,
      port: ephemeralPort,
      createInitialState: () => ({ count: 0 }),
    });

    const client = await createConnectedClient(boundPort(transport));

    // Send message
    const message: WebSocketIncomingMessage = {
      type: 'message',
      content: 'Hello',
    };

    const responsePromise = waitForResponse(client);
    client.send(JSON.stringify(message));
    const response = await responsePromise;

    expect(response.type).toBe('message');
    expect(response.reply).toBe('Message #1: Hello');
    expect(response.state).toEqual({ count: 1 });

    // Verify mock was called
    expect(mockFn).toHaveBeenCalledTimes(1);

    client.close();
    await transport.stop();
  });

  it('should maintain separate sessions per connection', async () => {
    transport = await startTransport({
      fn: mockFn,
      port: ephemeralPort,
      createInitialState: () => ({ count: 0 }),
    });

    const port = boundPort(transport);

    // Create two client connections
    const [client1, client2] = await Promise.all([createConnectedClient(port), createConnectedClient(port)]);

    // Send message from client1
    const message1: WebSocketIncomingMessage = {
      type: 'message',
      content: 'Client 1',
    };

    const response1Promise = waitForResponse(client1);
    client1.send(JSON.stringify(message1));
    const response1 = await response1Promise;

    expect(response1.state).toEqual({ count: 1 });

    // Send message from client2
    const message2: WebSocketIncomingMessage = {
      type: 'message',
      content: 'Client 2',
    };

    const response2Promise = waitForResponse(client2);
    client2.send(JSON.stringify(message2));
    const response2 = await response2Promise;

    // Each client should have independent state
    expect(response2.state).toEqual({ count: 1 });

    client1.close();
    client2.close();
    await transport.stop();
  });

  it('should handle invalid message format', async () => {
    transport = new WebSocketTransport({ fn: mockFn, port: ephemeralPort });

    await transport.start();

    const client = await createConnectedClient(boundPort(transport));

    const errorPromise = waitForResponse(client);
    client.send(JSON.stringify({ type: 'invalid' }));
    const errorResponse = await errorPromise;

    expect(errorResponse.type).toBe('error');
    expect(errorResponse.error).toContain('Invalid message format');

    client.close();
    await transport.stop();
  });

  it('should handle disconnect gracefully', async () => {
    transport = new WebSocketTransport({ fn: mockFn, port: ephemeralPort });

    await transport.start();

    const client = await createConnectedClient(boundPort(transport));

    // Send a message
    const message: WebSocketIncomingMessage = {
      type: 'message',
      content: 'Test',
    };

    const responsePromise = waitForResponse(client);
    client.send(JSON.stringify(message));
    await responsePromise;

    // Close connection
    client.close();
    await waitForClose(client);

    // Verify mock was called for the message
    expect(mockFn).toHaveBeenCalledOnce();

    // Server should still be running
    await transport.stop();
  });
});

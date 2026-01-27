/**
 * Tests for WebSocket transport.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import type { ConversationalFunction, Session } from '../src/types.js';
import { WebSocketTransport, type WebSocketIncomingMessage } from '../src/websocket.js';

import { createConnectedClient, startTransport, waitForClose, waitForResponse } from './test-helpers.js';

describe('WebSocketTransport', () => {
  let mockFn: ConversationalFunction<string, string, { count: number }>;
  let transport: WebSocketTransport<{ count: number }>;
  const testPort = 8081; // Use non-default port for tests

  beforeEach(() => {
    // Mock conversational function that tracks message count
    mockFn = vi.fn(async (input: string, session: Session<{ count: number }>) => {
      const count = (session.state?.count ?? 0) + 1;
      const newHistory = [
        ...session.history,
        { role: 'user' as const, content: input },
        { role: 'assistant' as const, content: `Message #${count}: ${input}` },
      ];
      return {
        output: `Message #${count}: ${input}`,
        session: { history: newHistory, state: { count } },
      };
    });
  });

  afterEach(async () => {
    if (transport) {
      await transport.stop();
    }
  });

  it('should create transport with default options', () => {
    transport = new WebSocketTransport({ fn: mockFn, port: testPort });
    expect(transport).toBeDefined();
  });

  it('should create transport with custom options', () => {
    transport = new WebSocketTransport({
      fn: mockFn,
      port: testPort,
      host: '127.0.0.1',
      createInitialSession: () => ({ history: [], state: { count: 0 } }),
    });
    expect(transport).toBeDefined();
  });

  it('should start and stop server', async () => {
    transport = new WebSocketTransport({ fn: mockFn, port: testPort });

    await transport.start();
    expect(transport).toBeDefined();
    await transport.stop();
  });

  it('should handle client connection and message exchange', async () => {
    transport = await startTransport({
      fn: mockFn,
      port: testPort,
      createInitialSession: () => ({ history: [], state: { count: 0 } }),
    });

    const client = await createConnectedClient(testPort);

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
      port: testPort,
      createInitialSession: () => ({ history: [], state: { count: 0 } }),
    });

    // Create two client connections
    const [client1, client2] = await Promise.all([
      createConnectedClient(testPort),
      createConnectedClient(testPort),
    ]);

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
    transport = new WebSocketTransport({ fn: mockFn, port: testPort });

    await transport.start();

    const client = await createConnectedClient(testPort);

    const errorPromise = waitForResponse(client);
    client.send(JSON.stringify({ type: 'invalid' }));
    const errorResponse = await errorPromise;

    expect(errorResponse.type).toBe('error');
    expect(errorResponse.error).toContain('Invalid message format');

    client.close();
    await transport.stop();
  });

  it('should handle disconnect gracefully', async () => {
    transport = new WebSocketTransport({ fn: mockFn, port: testPort });

    await transport.start();

    const client = await createConnectedClient(testPort);

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

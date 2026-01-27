/**
 * Test helpers for transports package.
 */

import { WebSocket } from 'ws';

import { WebSocketTransport, type WebSocketOutgoingMessage, type WebSocketTransportOptions } from '../src/websocket.js';

/**
 * Helper to create and wait for WebSocket client connection.
 */
export async function createConnectedClient(port: number): Promise<WebSocket> {
  const client = new WebSocket(`ws://localhost:${port}`);

  await new Promise<void>((resolve) => {
    client.on('open', () => {
      resolve();
    });
  });

  return client;
}

/**
 * Helper to wait for a single WebSocket response.
 */
export async function waitForResponse(client: WebSocket): Promise<WebSocketOutgoingMessage> {
  return new Promise<WebSocketOutgoingMessage>((resolve) => {
    client.on('message', (data: Buffer) => {
      const response = JSON.parse(data.toString()) as WebSocketOutgoingMessage;
      resolve(response);
    });
  });
}

/**
 * Helper to wait for client close event.
 */
export async function waitForClose(client: WebSocket): Promise<void> {
  return new Promise<void>((resolve) => {
    client.on('close', () => {
      resolve();
    });
  });
}

/**
 * Helper to start a WebSocket transport.
 */
export async function startTransport<TState>(
  options: WebSocketTransportOptions<TState>
): Promise<WebSocketTransport<TState>> {
  const transport = new WebSocketTransport(options);
  await transport.start();
  return transport;
}

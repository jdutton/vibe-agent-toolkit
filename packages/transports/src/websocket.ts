/**
 * WebSocket transport for conversational agents.
 *
 * Provides a WebSocket server with:
 * - Per-connection session isolation
 * - JSON message format
 * - Automatic session cleanup on disconnect
 */

import type { Message } from '@vibe-agent-toolkit/agent-runtime';
import { WebSocketServer, type WebSocket } from 'ws';

import type { ConversationalFunction, Transport, TransportSessionContext } from './types.js';

/**
 * Options for WebSocket transport.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface WebSocketTransportOptions<TState = any> {
  /** The conversational function to run */
  fn: ConversationalFunction<string, string, TState>;
  /** Port to listen on (default: 8080) */
  port?: number;
  /** Host to bind to (default: 'localhost') */
  host?: string;
  /** Session ID generator (default: crypto.randomUUID) */
  generateSessionId?: () => string;
  /** Factory for initial session state per connection */
  createInitialState?: () => TState;
}

/**
 * WebSocket message format (client → server).
 */
export interface WebSocketIncomingMessage {
  type: 'message';
  content: string;
}

/**
 * WebSocket response format (server → client).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface WebSocketOutgoingMessage<TState = any> {
  type: 'message' | 'error';
  reply?: string;
  state?: TState;
  error?: string;
}

/**
 * WebSocket session data (in-memory for MVP)
 */
interface WebSocketSession<TState> {
  sessionId: string;
  conversationHistory: Message[];
  state: TState;
}

/**
 * WebSocket transport implementation.
 *
 * Each connection maintains its own isolated session.
 * Uses in-memory session management for MVP.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export class WebSocketTransport<TState = any> implements Transport {
  private readonly fn: ConversationalFunction<string, string, TState>;
  private readonly port: number;
  private readonly host: string;
  private readonly generateSessionId: () => string;
  private readonly createInitialState: () => TState;
  private server: WebSocketServer | null = null;
  private readonly sessions = new WeakMap<WebSocket, WebSocketSession<TState>>();

  constructor(options: WebSocketTransportOptions<TState>) {
    this.fn = options.fn;
    this.port = options.port ?? 8080;
    this.host = options.host ?? 'localhost';
    this.generateSessionId = options.generateSessionId ?? (() => crypto.randomUUID());
    this.createInitialState = options.createInitialState ?? (() => undefined as TState);
  }

  /**
   * Start the WebSocket server.
   */
  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = new WebSocketServer({ host: this.host, port: this.port });

      this.server.on('error', reject);

      this.server.on('listening', () => {
        console.log(`WebSocket server listening on ws://${this.host}:${this.port}`);
        resolve();
      });

      this.server.on('connection', (ws: WebSocket) => {
        this.handleConnection(ws);
      });
    });
  }

  /**
   * Stop the WebSocket server.
   */
  async stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.server) {
        resolve();
        return;
      }

      // Close all active connections
      for (const client of this.server.clients) {
        if (client.readyState === client.OPEN) {
          client.close(1000, 'Server shutting down');
        }
      }

      // Close the server
      this.server.close((err) => {
        if (err) {
          reject(err);
        } else {
          this.server = null;
          resolve();
        }
      });
    });
  }

  /**
   * Handle a new WebSocket connection.
   */
  private handleConnection(ws: WebSocket): void {
    // Create session for this connection
    const sessionId = this.generateSessionId();
    const session: WebSocketSession<TState> = {
      sessionId,
      conversationHistory: [],
      state: this.createInitialState(),
    };
    this.sessions.set(ws, session);

    console.log(`Client connected (session: ${sessionId})`);

    ws.on('message', (data: Buffer) => {
      void this.handleMessage(ws, data);
    });

    ws.on('close', () => {
      // Session cleanup happens automatically via WeakMap
      console.log(`Client disconnected (session: ${sessionId})`);
    });

    ws.on('error', (error: Error) => {
      console.error('WebSocket error:', error);
    });
  }

  /**
   * Handle an incoming message from a client.
   */
  private async handleMessage(ws: WebSocket, data: Buffer): Promise<void> {
    try {
      // Parse message
      const message = JSON.parse(data.toString()) as WebSocketIncomingMessage;

      if (message.type !== 'message' || typeof message.content !== 'string') {
        this.sendError(ws, 'Invalid message format. Expected: { type: "message", content: string }');
        return;
      }

      // Get session for this connection
      const session = this.sessions.get(ws);
      if (!session) {
        // Session lost (shouldn't happen, but handle gracefully)
        this.sendError(ws, 'Session not found');
        return;
      }

      // Add user message to history
      session.conversationHistory.push({ role: 'user', content: message.content });

      // Pass session context
      const context: TransportSessionContext<TState> = {
        sessionId: session.sessionId,
        conversationHistory: session.conversationHistory,
        state: session.state,
      };

      // Process message through conversational function
      const output = await this.fn(message.content, context);

      // Update session state (function may have mutated context.state)
      session.state = context.state;

      // Add assistant response to history
      session.conversationHistory.push({ role: 'assistant', content: output });

      // Send response
      const response: WebSocketOutgoingMessage<TState> = {
        type: 'message',
        reply: output,
        state: session.state,
      };

      ws.send(JSON.stringify(response));
    } catch (error) {
      console.error('Error processing message:', error);
      this.sendError(ws, error instanceof Error ? error.message : 'Unknown error');
    }
  }

  /**
   * Send an error message to a client.
   */
  private sendError(ws: WebSocket, error: string): void {
    const response: WebSocketOutgoingMessage = {
      type: 'error',
      error,
    };
    ws.send(JSON.stringify(response));
  }
}

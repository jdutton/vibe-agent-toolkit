/**
 * Core types for VAT transport layer.
 *
 * Transports connect conversational functions to different interaction channels
 * (CLI, WebSocket, HTTP, etc.) without coupling to specific runtime implementations.
 */

import type { Message } from '@vibe-agent-toolkit/agent-runtime';

/**
 * Transport-level session context.
 *
 * Contains session identification only - not storage.
 * Runtime adapters are responsible for loading/saving session data.
 *
 * @template TState - Custom state type (application-specific)
 */
export interface TransportSessionContext<TState = unknown> {
  /** Session identifier (opaque to transport) */
  sessionId: string;
  /** Conversation history (loaded by runtime) */
  conversationHistory: Message[];
  /** Application-specific state (loaded by runtime) */
  state: TState;
}

/**
 * A conversational function that uses session context.
 *
 * The runtime adapter is responsible for loading/saving session data.
 *
 * @template TInput - Input type (e.g., string for text, object for structured)
 * @template TOutput - Output type (e.g., string for text, object for structured)
 * @template TState - Session state type
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ConversationalFunction<TInput = any, TOutput = any, TState = any> = (
  input: TInput,
  context: TransportSessionContext<TState>
) => Promise<TOutput>;

/**
 * DEPRECATED: Old Session type for backward compatibility.
 *
 * Use RuntimeSession from @vibe-agent-toolkit/agent-runtime instead.
 *
 * @deprecated Use TransportSessionContext instead
 * @template TState - Custom state type (application-specific)
 */
export type Session<TState = unknown> = {
  /** Conversation history */
  history: Message[];
  /** Application-specific state */
  state: TState;
};

/**
 * Transport interface for running conversational agents.
 *
 * Transports handle lifecycle and I/O for different interaction channels.
 */
export interface Transport {
  /** Start the transport (e.g., begin listening for connections) */
  start(): Promise<void>;
  /** Stop the transport (e.g., close connections and clean up) */
  stop(): Promise<void>;
}

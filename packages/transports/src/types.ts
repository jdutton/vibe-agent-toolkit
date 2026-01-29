/**
 * Core types for VAT transport layer.
 *
 * Transports connect conversational functions to different interaction channels
 * (CLI, WebSocket, HTTP, etc.) without coupling to specific runtime implementations.
 */

import type { Message } from '@vibe-agent-toolkit/agent-runtime';

/**
 * Session state for a conversation.
 *
 * @template TState - Custom state type (application-specific)
 */
export type Session<TState = unknown> = {
  /** Conversation history */
  history: Message[];
  /** Application-specific state */
  state: TState;
};

/**
 * A conversational function that processes input and maintains session state.
 *
 * @template TInput - Input type (e.g., string for text, object for structured)
 * @template TOutput - Output type (e.g., string for text, object for structured)
 * @template TState - Session state type
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ConversationalFunction<TInput = any, TOutput = any, TState = any> = (
  input: TInput,
  session: Session<TState>
) => Promise<{
  output: TOutput;
  session: Session<TState>;
}>;

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

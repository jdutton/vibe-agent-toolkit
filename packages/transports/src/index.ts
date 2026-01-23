/**
 * @vibe-agent-toolkit/transports
 *
 * Transport adapters for VAT conversational agents.
 *
 * Provides implementations for different interaction channels:
 * - CLI: Interactive command-line interface
 * - WebSocket: Real-time bidirectional communication
 *
 * @packageDocumentation
 */

export type { Message, Session, ConversationalFunction, Transport } from './types.js';
export { CLITransport, type CLITransportOptions } from './cli.js';
export { WebSocketTransport, type WebSocketTransportOptions, type WebSocketIncomingMessage, type WebSocketOutgoingMessage } from './websocket.js';

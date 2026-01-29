import type { Agent, OneShotAgentOutput } from '@vibe-agent-toolkit/agent-schema';

/**
 * Brand types for session identity (strong typing)
 */
export type ConnectionId = string & { readonly __brand: 'ConnectionId' };
export type ConversationId = string & { readonly __brand: 'ConversationId' };
export type RuntimeSessionId = string & { readonly __brand: 'RuntimeSessionId' };
export type TraceId = string & { readonly __brand: 'TraceId' };

/**
 * MCP tool definition that will be exposed to MCP clients
 */
export interface MCPToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>; // JSON Schema
}

/**
 * MCP tool result (what MCP clients receive)
 */
export interface MCPToolResult {
  content: Array<{
    type: 'text';
    text: string;
  }>;
  isError?: boolean;
}

/**
 * Agent registration entry
 */
export interface AgentRegistration<TInput = unknown, TOutput = unknown> {
  name: string;
  agent: Agent<TInput, OneShotAgentOutput<TOutput, string>>;
  adapter?: ArchetypeAdapter; // Optional, auto-detected from manifest
}

/**
 * Gateway configuration
 */
export interface GatewayConfig {
  agents: AgentRegistration[];
  transport: 'stdio' | 'http';
  observability?: ObservabilityProvider;
}

/**
 * Archetype adapter interface (stateless for Phase 1)
 */
export interface ArchetypeAdapter {
  readonly name: string;

  /**
   * Converts agent to MCP tool definition
   */
  createToolDefinition(agent: Agent<unknown, unknown>): MCPToolDefinition;

  /**
   * Executes agent and returns MCP-formatted result
   */
  execute(
    agent: Agent<unknown, unknown>,
    args: Record<string, unknown>,
    connectionId: ConnectionId
  ): Promise<MCPToolResult>;
}

/**
 * Observability provider interface (OTel-aligned)
 */
export interface ObservabilityProvider {
  getLogger(): Logger;
  getTracer(): Tracer;
  getMeter(): Meter;
}

/**
 * Logger interface (simplified for Phase 1)
 */
export interface Logger {
  info(message: string, context?: Record<string, unknown>): void;
  error(message: string, error?: Error, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  debug(message: string, context?: Record<string, unknown>): void;
}

/**
 * Tracer interface (no-op for Phase 1, OTel-aligned)
 */
export interface Tracer {
  startActiveSpan<T>(
    name: string,
    fn: (span: Span) => Promise<T>
  ): Promise<T>;
}

/**
 * Span interface (no-op for Phase 1, OTel-aligned)
 */
export interface Span {
  setAttribute(key: string, value: string | number | boolean): void;
  recordException(error: Error): void;
  setStatus(status: { code: number }): void;
  end(): void;
}

/**
 * Meter interface (no-op for Phase 1, OTel-aligned)
 */
export interface Meter {
  createCounter(name: string): Counter;
  createHistogram(name: string): Histogram;
}

/**
 * Counter interface (no-op for Phase 1)
 */
export interface Counter {
  add(value: number, attributes?: Record<string, string>): void;
}

/**
 * Histogram interface (no-op for Phase 1)
 */
export interface Histogram {
  record(value: number, attributes?: Record<string, string>): void;
}

/**
 * Helper to create branded ConnectionId
 */
export function createConnectionId(id: string): ConnectionId {
  return id as ConnectionId;
}

/**
 * Helper to create branded ConversationId
 */
export function createConversationId(id: string): ConversationId {
  return id as ConversationId;
}

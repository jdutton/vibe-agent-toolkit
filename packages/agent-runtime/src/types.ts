/**
 * Core types for the VAT agent runtime framework
 */

import type { z } from 'zod';

/**
 * Represents an executable agent with a defined input/output contract
 */
export interface Agent<TInput, TOutput> {
  /** Unique name for the agent */
  name: string;

  /** Execute the agent with validated input */
  execute: (input: TInput, ...args: unknown[]) => TOutput | Promise<TOutput>;

  /** Metadata describing the agent's interface and capabilities */
  manifest: AgentManifest;
}

/**
 * Base configuration shared by all agent types
 * Eliminates duplication across archetype config interfaces
 */
export interface BaseAgentConfig<TInput, TOutput> {
  /** Unique name for the agent */
  name: string;

  /** Human-readable description of what the agent does */
  description: string;

  /** Semantic version (e.g., "1.0.0") */
  version: string;

  /** Zod schema for input validation */
  inputSchema: z.ZodType<TInput>;

  /** Zod schema for output validation */
  outputSchema: z.ZodType<TOutput>;

  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Represents a pure function agent with synchronous execution
 */
export interface PureFunctionAgent<TInput, TOutput> extends Agent<TInput, TOutput> {
  /** Execute the agent synchronously with validated input */
  execute: (input: TInput) => TOutput;
}

/**
 * Metadata describing an agent's interface and capabilities
 */
export interface AgentManifest {
  /** Unique name for the agent */
  name: string;

  /** Human-readable description of what the agent does */
  description: string;

  /** Semantic version (e.g., "1.0.0") */
  version: string;

  /** JSON Schema for input validation */
  inputSchema: Record<string, unknown>;

  /** JSON Schema for output validation */
  outputSchema: Record<string, unknown>;

  /** Agent archetype (e.g., "pure-function", "llm-analyzer") */
  archetype: string;

  /** Additional metadata (model, temperature, mockable, etc.) */
  metadata?: Record<string, unknown>;
}

/**
 * Message format for LLM communication
 */
export interface Message {
  /** Message role (system, user, assistant) */
  role: 'system' | 'user' | 'assistant';

  /** Message content */
  content: string;
}

/**
 * Context provided to LLM-based agents
 */
export interface LLMAnalyzerContext {
  /** Whether this agent can be mocked in tests */
  mockable: boolean;

  /** LLM model identifier (optional) */
  model?: string;

  /** Temperature for LLM generation (0-1, optional) */
  temperature?: number;

  /** Function to call the LLM with a prompt or messages */
  callLLM: (prompt: string | Message[]) => Promise<string>;
}

/**
 * Context provided to conversational assistant agents
 */
export interface ConversationalContext {
  /** Whether this agent can be mocked in tests */
  mockable: boolean;

  /** Conversation history */
  history: Message[];

  /** Add a message to conversation history */
  addToHistory: (role: 'system' | 'user' | 'assistant', content: string) => void;

  /** Function to call the LLM with messages */
  callLLM: (messages: Message[]) => Promise<string>;
}

/**
 * Context provided to agentic researcher agents
 */
export interface ResearcherContext {
  /** Whether this agent can be mocked in tests */
  mockable: boolean;

  /** Available tools for research */
  tools: Record<string, Function>;

  /** Function to call the LLM with a prompt */
  callLLM: (prompt: string) => Promise<string>;

  /** Function to call a tool by name */
  callTool: (toolName: string, input: unknown) => Promise<unknown>;

  /** Current iteration count */
  iterationCount: number;

  /** Maximum allowed iterations */
  maxIterations: number;
}

/**
 * Retry options for function calls
 */
export interface RetryOptions {
  /** Maximum number of retry attempts */
  maxAttempts?: number;
  /** Delay between retries in milliseconds */
  delayMs?: number;
  /** Backoff multiplier for exponential backoff */
  backoffMultiplier?: number;
}

/**
 * Context provided to function orchestrator agents
 */
export interface OrchestratorContext {
  /** Call another agent by name */
  call: <T, R>(agentName: string, input: T) => Promise<R>;

  /** Execute multiple calls in parallel */
  parallel: <T>(calls: Array<() => Promise<T>>) => Promise<T[]>;

  /** Retry a function call with exponential backoff */
  retry: <T>(fn: () => Promise<T>, options?: RetryOptions) => Promise<T>;

  /** Shared state for the orchestration */
  state: Map<string, unknown>;
}

/**
 * Context provided to LLM coordinator agents
 */
export interface CoordinatorContext {
  /** Whether this agent can be mocked in tests */
  mockable: boolean;

  /** Call another agent by name */
  call: <T, R>(agentName: string, input: T) => Promise<R>;

  /** Function to call the LLM with a prompt */
  callLLM: (prompt: string) => Promise<string>;

  /** Route to different paths based on LLM decision */
  route: (
    decision: string,
    routes: Record<string, () => Promise<unknown>>,
  ) => Promise<unknown>;

  /** Shared state for coordination */
  state: Map<string, unknown>;
}

/**
 * Context provided to function event consumer agents
 */
export interface EventConsumerContext {
  /** Type of the event being consumed */
  eventType: string;

  /** Data payload of the event */
  eventData: unknown;

  /** Shared state for the consumer */
  state: Map<string, unknown>;

  /** Emit a new event */
  emit: (eventType: string, data: unknown) => Promise<void>;
}

/**
 * Context provided to LLM event handler agents
 */
export interface LLMEventHandlerContext {
  /** Whether this agent can be mocked in tests */
  mockable: boolean;

  /** Type of the event being handled */
  eventType: string;

  /** Data payload of the event */
  eventData: unknown;

  /** Function to call the LLM with a prompt */
  callLLM: (prompt: string) => Promise<string>;

  /** Emit a new event */
  emit: (eventType: string, data: unknown) => Promise<void>;

  /** Shared state for the handler */
  state: Map<string, unknown>;
}

/**
 * Context provided to external event integrator agents
 */
export interface ExternalEventContext {
  /** Emit an event to external systems */
  emit: (eventType: string, data: unknown) => Promise<void>;

  /** Wait for an external event with timeout */
  waitFor: <T>(eventType: string, timeoutMs: number) => Promise<T>;

  /** Timeout in milliseconds (optional) */
  timeoutMs?: number;

  /** Action to take on timeout: approve, reject, or error */
  onTimeout?: 'approve' | 'reject' | 'error';
}

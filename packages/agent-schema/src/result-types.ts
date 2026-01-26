/**
 * Core result types for VAT agents.
 * Based on Railway-Oriented Programming pattern.
 */

/**
 * Standard result envelope for agents.
 *
 * Provides type-safe success/error handling for orchestration.
 * Based on functional programming Result<T, E> pattern (Rust, F#).
 */
export type AgentResult<TData, TError = string> =
  | { status: 'success'; data: TData }
  | { status: 'error'; error: TError };

/**
 * Extended result for stateful/multi-turn agents.
 *
 * Adds 'in-progress' state for conversational, async, or long-running agents.
 */
export type StatefulAgentResult<TData, TError = string, TMetadata = unknown> =
  | { status: 'in-progress'; metadata?: TMetadata }
  | { status: 'success'; data: TData }
  | { status: 'error'; error: TError };

/**
 * Standard LLM error types that all LLM-based agents can use.
 *
 * These represent expected LLM failure modes that should be handled
 * gracefully by orchestrators (retry, fallback, etc.) rather than
 * treated as system failures.
 */
export type LLMError =
  | 'llm-refusal'           // Content policy violation
  | 'llm-invalid-output'    // Malformed/invalid response
  | 'llm-token-limit'       // Exceeded max tokens
  | 'llm-timeout'           // API timeout
  | 'llm-rate-limit'        // Rate limited
  | 'llm-unavailable';      // Service down/unreachable

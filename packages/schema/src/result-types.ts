/**
 * Core result types for VAT agents.
 * Based on Railway-Oriented Programming pattern.
 */

// ============================================================================
// Status Constants
// ============================================================================

/** Success status constant */
export const RESULT_SUCCESS = 'success' as const;

/** Error status constant */
export const RESULT_ERROR = 'error' as const;

/** In-progress status constant (for stateful agents) */
export const RESULT_IN_PROGRESS = 'in-progress' as const;

export type ResultStatus = typeof RESULT_SUCCESS | typeof RESULT_ERROR;

export type StatefulResultStatus =
  | typeof RESULT_IN_PROGRESS
  | typeof RESULT_SUCCESS
  | typeof RESULT_ERROR;

// ============================================================================
// LLM Error Constants
// ============================================================================

/** LLM refused to generate output (content policy violation) */
export const LLM_REFUSAL = 'llm-refusal' as const;

/** LLM output didn't match expected format (parsing failed) */
export const LLM_INVALID_OUTPUT = 'llm-invalid-output' as const;

/** Request timed out */
export const LLM_TIMEOUT = 'llm-timeout' as const;

/** Hit rate limit */
export const LLM_RATE_LIMIT = 'llm-rate-limit' as const;

/** Exceeded token limit */
export const LLM_TOKEN_LIMIT = 'llm-token-limit' as const;

/** Service unavailable */
export const LLM_UNAVAILABLE = 'llm-unavailable' as const;

/**
 * Standard LLM error types that all LLM-based agents can use.
 *
 * These represent expected LLM failure modes that should be handled
 * gracefully by orchestrators (retry, fallback, etc.) rather than
 * treated as system failures.
 */
export type LLMError =
  | typeof LLM_REFUSAL
  | typeof LLM_INVALID_OUTPUT
  | typeof LLM_TIMEOUT
  | typeof LLM_RATE_LIMIT
  | typeof LLM_TOKEN_LIMIT
  | typeof LLM_UNAVAILABLE;

/**
 * LLM errors that are retryable (transient failures).
 * Orchestrators should retry these with exponential backoff.
 */
export const RETRYABLE_LLM_ERRORS = new Set<LLMError>([
  LLM_TIMEOUT,
  LLM_RATE_LIMIT,
  LLM_UNAVAILABLE,
]);

/**
 * LLM errors that are NOT retryable (permanent failures).
 * Orchestrators should not retry these.
 */
export const NON_RETRYABLE_LLM_ERRORS = new Set<LLMError>([
  LLM_REFUSAL,
  LLM_INVALID_OUTPUT,
  LLM_TOKEN_LIMIT,
]);

// ============================================================================
// External Event Error Constants
// ============================================================================

/** External event timed out */
export const EVENT_TIMEOUT = 'event-timeout' as const;

/** External system unavailable */
export const EVENT_UNAVAILABLE = 'event-unavailable' as const;

/** External system rejected request */
export const EVENT_REJECTED = 'event-rejected' as const;

/** External system returned invalid response */
export const EVENT_INVALID_RESPONSE = 'event-invalid-response' as const;

/**
 * Standard external event error types for agents that integrate with
 * external systems or humans.
 *
 * These represent expected integration failure modes that should be
 * handled gracefully by orchestrators (retry, fallback, escalation)
 * rather than treated as system failures.
 */
export type ExternalEventError =
  | typeof EVENT_TIMEOUT
  | typeof EVENT_UNAVAILABLE
  | typeof EVENT_REJECTED
  | typeof EVENT_INVALID_RESPONSE;

/**
 * External event errors that are retryable (transient failures).
 * Orchestrators should retry these with exponential backoff.
 */
export const RETRYABLE_EVENT_ERRORS = new Set<ExternalEventError>([
  EVENT_TIMEOUT,
  EVENT_UNAVAILABLE,
]);

/**
 * External event errors that are NOT retryable (permanent failures).
 * Orchestrators should not retry these.
 */
export const NON_RETRYABLE_EVENT_ERRORS = new Set<ExternalEventError>([
  EVENT_REJECTED,
  EVENT_INVALID_RESPONSE,
]);

// ============================================================================
// Execution Metadata (Observability)
// ============================================================================

/**
 * Execution metadata for production observability.
 *
 * Optional fields that agents can populate for monitoring,
 * cost tracking, and debugging.
 *
 * @property durationMs - Total execution duration in milliseconds
 * @property tokensUsed - Total LLM tokens consumed
 * @property cost - Estimated cost in USD
 * @property model - Model identifier (e.g., 'gpt-4o-mini')
 * @property provider - Provider identifier (e.g., 'openai', 'anthropic')
 * @property retryCount - Number of times orchestrator retried (0 = no retries)
 * @property timestamp - ISO 8601 timestamp of execution start
 */
export interface ExecutionMetadata {
  /** Total execution duration in milliseconds */
  durationMs?: number;

  /** Total LLM tokens consumed */
  tokensUsed?: number;

  /** Estimated cost in USD */
  cost?: number;

  /** Model identifier (e.g., 'gpt-4o-mini') */
  model?: string;

  /** Provider identifier (e.g., 'openai', 'anthropic') */
  provider?: string;

  /**
   * Number of times orchestrator retried agent execution.
   * - 0 = no retries (succeeded on first attempt)
   * - 1 = one retry (failed once, succeeded on second attempt)
   * - N = N retries
   *
   * Set by orchestrator's retry wrapper, not by agent.
   */
  retryCount?: number;

  /** ISO 8601 timestamp of execution start */
  timestamp?: string;
}

// ============================================================================
// Result Constructors
// ============================================================================

/**
 * Internal helper to build observability fields object.
 * Reduces duplication across result constructors.
 *
 * @internal
 */
function buildObservabilityFields(options?: {
  confidence?: number;
  warnings?: string[];
  execution?: ExecutionMetadata;
}): {
  confidence?: number;
  warnings?: string[];
  execution?: ExecutionMetadata;
} {
  const fields: {
    confidence?: number;
    warnings?: string[];
    execution?: ExecutionMetadata;
  } = {};

  if (options?.confidence !== undefined) {
    fields.confidence = options.confidence;
  }
  if (options?.warnings) {
    fields.warnings = options.warnings;
  }
  if (options?.execution) {
    fields.execution = options.execution;
  }

  return fields;
}

/**
 * Create a success result with optional observability fields.
 *
 * @example
 * return createSuccess({ name: 'Fluffy', valid: true });
 *
 * @example
 * return createSuccess(data, {
 *   confidence: 0.95,
 *   warnings: ['Unusual pattern detected'],
 * });
 */
export function createSuccess<TData>(
  data: TData,
  options?: {
    confidence?: number;
    warnings?: string[];
    execution?: ExecutionMetadata;
  }
): AgentResult<TData, never> {
  return {
    status: RESULT_SUCCESS,
    data,
    ...buildObservabilityFields(options),
  };
}

/**
 * Create an error result with optional observability fields.
 *
 * @example
 * return createError('invalid-format');
 *
 * @example
 * return createError(LLM_TIMEOUT, {
 *   confidence: 0.9,
 *   execution: { durationMs: 5000 },
 * });
 */
export function createError<TError extends string>(
  error: TError,
  options?: {
    confidence?: number;
    execution?: ExecutionMetadata;
  }
): AgentResult<never, TError> {
  return {
    status: RESULT_ERROR,
    error,
    ...buildObservabilityFields(options),
  };
}

/**
 * Create an in-progress result for stateful agents with optional observability fields.
 *
 * @example
 * return createInProgress({ step: 2, totalSteps: 5 });
 *
 * @example
 * return createInProgress(undefined, {
 *   confidence: 0.7,
 *   warnings: ['Still gathering information'],
 * });
 */
export function createInProgress<TMetadata>(
  metadata?: TMetadata,
  options?: {
    confidence?: number;
    warnings?: string[];
    execution?: ExecutionMetadata;
  }
): StatefulAgentResult<never, never, TMetadata> {
  return {
    status: RESULT_IN_PROGRESS,
    ...(metadata !== undefined && { metadata }),
    ...buildObservabilityFields(options),
  };
}

// ============================================================================
// Result Types
// ============================================================================

/**
 * Standard result envelope for agents.
 *
 * Provides type-safe success/error handling for orchestration.
 * Based on functional programming Result<T, E> pattern (Rust, F#).
 *
 * @template TData - Success data type
 * @template TError - Error type (use constants, not string literals)
 */
export type AgentResult<TData, TError extends string = string> =
  | {
      status: typeof RESULT_SUCCESS;
      data: TData;

      /** Confidence in result (0-1 scale) */
      confidence?: number;

      /** Non-fatal warnings */
      warnings?: string[];

      /** Execution metadata for observability */
      execution?: ExecutionMetadata;
    }
  | {
      status: typeof RESULT_ERROR;
      error: TError;

      /** Confidence in error classification (0-1 scale) */
      confidence?: number;

      /** Execution metadata for observability */
      execution?: ExecutionMetadata;
    };

/**
 * Extended result for stateful/multi-turn agents.
 *
 * Adds 'in-progress' state for conversational, async, or long-running agents.
 * Composes AgentResult (success/error) with an additional in-progress state.
 *
 * @template TData - Success data type
 * @template TError - Error type (use constants, not string literals)
 * @template TMetadata - Metadata type for in-progress state
 */
export type StatefulAgentResult<
  TData,
  TError extends string = string,
  TMetadata = unknown,
> =
  | {
      status: typeof RESULT_IN_PROGRESS;
      metadata?: TMetadata;

      /** Progress indicator (0-1 scale) */
      confidence?: number;

      /** Non-fatal warnings */
      warnings?: string[];

      /** Execution metadata for observability */
      execution?: ExecutionMetadata;
    }
  | AgentResult<TData, TError>;

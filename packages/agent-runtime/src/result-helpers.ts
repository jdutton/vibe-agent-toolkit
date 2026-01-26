/**
 * Helper functions for working with agent results.
 * Provides Railway-Oriented Programming patterns for orchestration.
 */

import {
  EVENT_TIMEOUT,
  EVENT_UNAVAILABLE,
  LLM_RATE_LIMIT,
  LLM_TIMEOUT,
  LLM_UNAVAILABLE,
  RESULT_SUCCESS,
  RETRYABLE_EVENT_ERRORS,
  RETRYABLE_LLM_ERRORS,
  type AgentResult,
  type ExecutionMetadata,
  type ExternalEventError,
  type LLMError,
  type OneShotAgentOutput,
  type StatefulAgentResult,
} from '@vibe-agent-toolkit/agent-schema';

/**
 * Map success value, propagate errors.
 * Classic functor map operation.
 *
 * @example
 * const result = { status: 'success', data: 5 };
 * const doubled = mapResult(result, x => x * 2);
 * // doubled = { status: 'success', data: 10 }
 */
export function mapResult<T, U, E extends string>(
  result: AgentResult<T, E>,
  fn: (data: T) => U
): AgentResult<U, E> {
  if (result.status === 'success') {
    return {
      status: 'success',
      data: fn(result.data),
      ...(result.confidence !== undefined && { confidence: result.confidence }),
      ...(result.warnings && { warnings: result.warnings }),
      ...(result.execution && { execution: result.execution }),
    };
  }
  return result;
}

/**
 * Chain dependent operations (monadic bind).
 * Only runs next operation if current succeeded.
 *
 * @example
 * const result1 = await agent1.execute(input);
 * const result2 = await andThen(result1.result, async (data) => {
 *   const output = await agent2.execute(data);
 *   return output.result;
 * });
 */
export async function andThen<T, U, E extends string>(
  result: AgentResult<T, E>,
  fn: (data: T) => Promise<AgentResult<U, E>>
): Promise<AgentResult<U, E>> {
  if (result.status === 'success') {
    return await fn(result.data);
  }
  return result;
}

/**
 * Pattern matching on result status.
 * Exhaustive handling of all cases.
 *
 * @example
 * const message = match(result, {
 *   success: (data) => `Success: ${data}`,
 *   error: (err) => `Error: ${err}`,
 *   inProgress: () => 'Still working...'
 * });
 */
export function match<T, E extends string, R>(
  result: StatefulAgentResult<T, E>,
  handlers: {
    success: (data: T) => R;
    error: (error: E) => R;
    inProgress?: (metadata?: unknown) => R;
  }
): R | undefined {
  switch (result.status) {
    case 'success':
      return handlers.success(result.data);
    case 'error':
      return handlers.error(result.error);
    case 'in-progress':
      return handlers.inProgress?.(result.metadata);
  }
}

/**
 * Unwrap result or throw error.
 * Use when you want to convert to exception-based flow.
 *
 * @example
 * try {
 *   const data = unwrap(result);
 *   console.log('Success:', data);
 * } catch (err) {
 *   console.error('Failed:', err);
 * }
 */
export function unwrap<T, E extends string>(result: AgentResult<T, E>): T {
  if (result.status === 'success') {
    return result.data;
  }
  throw new Error(`Agent error: ${String(result.error)}`);
}

// ============================================================================
// Orchestration Helpers
// ============================================================================

/**
 * Backoff delays for different error types (milliseconds).
 * Orchestrators use these for exponential backoff retry logic.
 *
 * @internal
 */
const BACKOFF_DELAYS: Record<string, number> = {
  [LLM_RATE_LIMIT]: 5000, // Rate limits need longer waits
  [LLM_TIMEOUT]: 1000, // Timeouts can retry quickly
  [LLM_UNAVAILABLE]: 10000, // Service issues need long waits
  [EVENT_TIMEOUT]: 2000,
  [EVENT_UNAVAILABLE]: 5000,
};

/**
 * Check if an error type is retryable.
 *
 * @internal
 */
function isRetryable(error: string): boolean {
  return (
    RETRYABLE_LLM_ERRORS.has(error as LLMError) ||
    RETRYABLE_EVENT_ERRORS.has(error as ExternalEventError)
  );
}

/**
 * Calculate exponential backoff delay for retry.
 *
 * @internal
 */
function getBackoffDelay(error: string, attempt: number): number {
  const baseDelay = BACKOFF_DELAYS[error] ?? 2000;
  return Math.min(baseDelay * Math.pow(2, attempt), 30000); // Cap at 30s
}

/**
 * Sleep for a given number of milliseconds.
 *
 * @internal
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wrap agent execution with retry logic.
 *
 * Automatically retries on transient failures (timeouts, rate limits, unavailable),
 * injects retry count into execution metadata, and uses exponential backoff.
 *
 * @example
 * const agent = createAgent({...});
 * const withRetries = withRetry(() => agent.execute(input), 5);
 * const output = await withRetries;
 * // output.result.execution.retryCount shows how many retries were needed
 */
export async function withRetry<TData, TError extends string>(
  agentFn: () => Promise<OneShotAgentOutput<TData, TError>>,
  maxAttempts: number = 5
): Promise<OneShotAgentOutput<TData, TError>> {
  let lastOutput: OneShotAgentOutput<TData, TError> | undefined;
  let totalDurationMs = 0;
  let totalTokensUsed = 0;
  let totalCost = 0;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    lastOutput = await agentFn();

    // Accumulate metrics across attempts
    if (lastOutput.result.execution) {
      totalDurationMs += lastOutput.result.execution.durationMs ?? 0;
      totalTokensUsed += lastOutput.result.execution.tokensUsed ?? 0;
      totalCost += lastOutput.result.execution.cost ?? 0;
    }

    // Success: inject retry count and accumulated metrics
    if (lastOutput.result.status === RESULT_SUCCESS) {
      return {
        ...lastOutput,
        result: {
          ...lastOutput.result,
          execution: {
            ...lastOutput.result.execution,
            retryCount: attempt,
            durationMs: totalDurationMs,
            tokensUsed: totalTokensUsed,
            cost: totalCost,
          },
        },
      };
    }

    // Non-retryable error: inject retry count and return
    if (!isRetryable(lastOutput.result.error)) {
      return {
        ...lastOutput,
        result: {
          ...lastOutput.result,
          execution: {
            ...lastOutput.result.execution,
            retryCount: attempt,
            durationMs: totalDurationMs,
            tokensUsed: totalTokensUsed,
            cost: totalCost,
          },
        },
      };
    }

    // Wait before next retry (except on last attempt)
    if (attempt < maxAttempts - 1) {
      await sleep(getBackoffDelay(lastOutput.result.error, attempt));
    }
  }

  // Max retries exceeded: return last error with retry count
  // lastOutput is guaranteed to be defined here because loop runs at least once
  if (!lastOutput) {
    throw new Error('withRetry: lastOutput is undefined (should never happen)');
  }

  return {
    ...lastOutput,
    result: {
      ...lastOutput.result,
      execution: {
        ...lastOutput.result.execution,
        retryCount: maxAttempts - 1,
        durationMs: totalDurationMs,
        tokensUsed: totalTokensUsed,
        cost: totalCost,
      },
    },
  };
}

/**
 * Wrap agent execution with timing metadata.
 *
 * Measures execution duration and injects it into ExecutionMetadata.
 *
 * @example
 * const output = await withTiming(() => agent.execute(input));
 * console.log(`Execution took ${output.result.execution?.durationMs}ms`);
 */
export async function withTiming<TData, TError extends string>(
  agentFn: () => Promise<OneShotAgentOutput<TData, TError>>
): Promise<OneShotAgentOutput<TData, TError>> {
  const startTime = Date.now();
  const timestamp = new Date(startTime).toISOString();

  const output = await agentFn();

  const durationMs = Date.now() - startTime;

  return {
    ...output,
    result: {
      ...output.result,
      execution: {
        ...output.result.execution,
        durationMs,
        timestamp,
      } as ExecutionMetadata,
    },
  };
}

/**
 * Helper functions for working with agent results.
 * Provides Railway-Oriented Programming patterns for orchestration.
 */

import type { AgentResult, StatefulAgentResult } from '@vibe-agent-toolkit/agent-schema';

/**
 * Map success value, propagate errors.
 * Classic functor map operation.
 *
 * @example
 * const result = { status: 'success', data: 5 };
 * const doubled = mapResult(result, x => x * 2);
 * // doubled = { status: 'success', data: 10 }
 */
export function mapResult<T, U, E>(
  result: AgentResult<T, E>,
  fn: (data: T) => U
): AgentResult<U, E> {
  if (result.status === 'success') {
    return { status: 'success', data: fn(result.data) };
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
export async function andThen<T, U, E>(
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
export function match<T, E, R>(
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
export function unwrap<T, E>(result: AgentResult<T, E>): T {
  if (result.status === 'success') {
    return result.data;
  }
  throw new Error(`Agent error: ${String(result.error)}`);
}

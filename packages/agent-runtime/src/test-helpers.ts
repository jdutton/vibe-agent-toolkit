/**
 * Test helpers for asserting on agent results.
 */

import type { AgentResult, StatefulAgentResult } from '@vibe-agent-toolkit/agent-schema';
import { expect } from 'vitest';

/**
 * Test matchers for agent results.
 *
 * Provides type-safe assertions that narrow TypeScript types.
 */
export const resultMatchers = {
  /**
   * Assert result is success and extract data.
   *
   * @example
   * const output = await agent.execute(input);
   * resultMatchers.expectSuccess(output.result);
   * // TypeScript knows output.result.data exists here
   * expect(output.result.data.field).toBe('value');
   */
  expectSuccess<T, E extends string>(
    result: AgentResult<T, E>
  ): asserts result is { status: 'success'; data: T } {
    expect(result.status).toBe('success');
  },

  /**
   * Assert result is error and extract error.
   *
   * @example
   * const output = await agent.execute(badInput);
   * resultMatchers.expectError(output.result);
   * // TypeScript knows output.result.error exists here
   * expect(output.result.error).toBe('invalid-input');
   */
  expectError<T, E extends string>(
    result: AgentResult<T, E>
  ): asserts result is { status: 'error'; error: E } {
    expect(result.status).toBe('error');
  },

  /**
   * Assert result is in-progress.
   *
   * @example
   * const output = await conversationalAgent.execute(message);
   * resultMatchers.expectInProgress(output.result);
   * // TypeScript knows output.result.metadata might exist
   */
  expectInProgress<T, E extends string, M>(
    result: StatefulAgentResult<T, E, M>
  ): asserts result is { status: 'in-progress'; metadata?: M } {
    expect(result.status).toBe('in-progress');
  },
};

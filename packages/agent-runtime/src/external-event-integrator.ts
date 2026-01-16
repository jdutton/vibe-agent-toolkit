import { type z } from 'zod';

import { buildManifest, createAsyncExecuteWrapperWithContext } from './execute-wrapper.js';
import type { Agent, ExternalEventContext } from './types.js';

/**
 * Configuration for defining an external event integrator agent
 */
export interface ExternalEventIntegratorConfig<TInput, TOutput> {
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

  /** Timeout in milliseconds (optional) */
  timeoutMs?: number;

  /** Action to take on timeout: approve, reject, or error (default: error) */
  onTimeout?: 'approve' | 'reject' | 'error';

  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Defines an external event integrator agent that coordinates with
 * external systems or human users via events.
 *
 * The agent validates inputs and outputs using Zod schemas and provides
 * utilities for emitting events and waiting for responses with timeout handling.
 *
 * @param config - Agent configuration including schemas and timeout settings
 * @param handler - Async function that integrates with external events
 * @returns Agent with validated execute function and manifest
 *
 * @example
 * ```typescript
 * const approvalAgent = defineExternalEventIntegrator(
 *   {
 *     name: 'human-approval',
 *     description: 'Requests human approval for actions',
 *     version: '1.0.0',
 *     inputSchema: z.object({ action: z.string(), details: z.string() }),
 *     outputSchema: z.object({ approved: z.boolean(), feedback: z.string().optional() }),
 *     timeoutMs: 60000, // 1 minute
 *     onTimeout: 'reject',
 *   },
 *   async (input, ctx) => {
 *     // Emit approval request to external system
 *     await ctx.emit('approval.requested', {
 *       action: input.action,
 *       details: input.details,
 *     });
 *
 *     // Wait for human response
 *     const response = await ctx.waitFor<{ approved: boolean; feedback?: string }>(
 *       'approval.response',
 *       ctx.timeoutMs ?? 60000
 *     );
 *
 *     return response;
 *   }
 * );
 * ```
 */
export function defineExternalEventIntegrator<TInput, TOutput>(
  config: ExternalEventIntegratorConfig<TInput, TOutput>,
  handler: (input: TInput, ctx: ExternalEventContext) => Promise<TOutput>,
): Agent<TInput, TOutput> {
  // Build manifest
  const manifest = buildManifest(config, 'external-event-integrator', {
    ...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }),
    onTimeout: config.onTimeout ?? 'error',
  });

  // Create validated execute function
  const execute = createAsyncExecuteWrapperWithContext(
    config,
    handler,
    (ctx: ExternalEventContext): ExternalEventContext => ({
      emit: ctx.emit,
      waitFor: ctx.waitFor,
      ...(config.timeoutMs !== undefined && { timeoutMs: config.timeoutMs }),
      onTimeout: config.onTimeout ?? 'error',
    }),
  );

  return {
    name: config.name,
    execute,
    manifest,
  };
}

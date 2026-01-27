/**
 * Helper functions for creating agents.
 */

import type {
  AgentResult,
  ExternalEventError,
  LLMError,
  OneShotAgentOutput,
} from '@vibe-agent-toolkit/agent-schema';

/**
 * Default LLM error for unknown failures.
 * @internal
 */
const LLM_UNAVAILABLE_ERROR: LLMError = 'llm-unavailable';

/**
 * Validate agent input against a Zod schema.
 *
 * Returns parsed data on success, or OneShotAgentOutput error envelope on failure.
 *
 * @example
 * // For LLM agents
 * const validatedOrError = validateAgentInput<MyInput, MyOutput, LLMError>(input, InputSchema, 'llm-invalid-output');
 * if ('result' in validatedOrError) {
 *   return validatedOrError; // Validation error
 * }
 * const { characteristics, mockable } = validatedOrError;
 *
 * @example
 * // For external event agents
 * const validatedOrError = validateAgentInput<MyInput, MyOutput, ExternalEventError>(
 *   input,
 *   InputSchema,
 *   'event-invalid-response'
 * );
 */
// eslint-disable-next-line sonarjs/function-return-type -- Intentional discriminated union pattern
export function validateAgentInput<TInput, TData, TError extends string = LLMError>(
  input: unknown,
  schema: { safeParse: (data: unknown) => { success: boolean; data?: TInput } },
  invalidInputError: TError = 'llm-invalid-output' as TError
): TInput | OneShotAgentOutput<TData, TError> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    return {
      result: { status: 'error', error: invalidInputError },
    } as OneShotAgentOutput<TData, TError>;
  }
  return parsed.data as TInput;
}

/**
 * Wrap LLM calls to catch expected failures and map to result errors.
 *
 * Handles common LLM failure modes:
 * - API timeouts → 'llm-timeout'
 * - Rate limits → 'llm-rate-limit'
 * - Content policy → 'llm-refusal'
 * - Invalid output → 'llm-invalid-output'
 * - Service errors → 'llm-unavailable'
 *
 * @example
 * const llmResult = await executeLLMCall(
 *   () => llm.chat.completions.create({...}),
 *   {
 *     parseOutput: (raw) => CatCharacteristicsSchema.parse(raw),
 *     timeoutMs: 30000,
 *   }
 * );
 */
export async function executeLLMCall<T>(
  fn: () => Promise<T>,
  options?: {
    parseOutput?: (raw: unknown) => T;
    timeoutMs?: number;
  }
): Promise<AgentResult<T, LLMError>> {
  try {
    const result = await fn();

    // Optionally parse/validate output
    if (options?.parseOutput) {
      try {
        const parsed = options.parseOutput(result);
        return { status: 'success', data: parsed };
      } catch (error_) {
        // Convert parse errors to llm-invalid-output
        // Log the error for debugging but don't expose details in result
        if (error_ instanceof Error) {
          console.warn('LLM output parse error:', error_.message);
        }
        return {
          status: 'error',
          error: 'llm-invalid-output' as const,
        };
      }
    }

    return { status: 'success', data: result };
  } catch (err) {
    // Map known LLM exceptions to error codes
    const error = mapLLMException(err);
    return { status: 'error', error };
  }
}

/**
 * Execute an LLM analyzer agent with mock/real mode support.
 *
 * Eliminates boilerplate for LLM analyzer agents by handling:
 * - Mock vs real mode switching
 * - Metadata generation
 * - Error handling with llm-unavailable fallback
 * - Consistent return envelope structure
 *
 * @example
 * // With real implementation
 * execute: async (input) => {
 *   return executeLLMAnalyzer({
 *     mockable: input.mockable ?? true,
 *     mockFn: () => mockParseDescription(input.description),
 *     realFn: async () => callLLM(...),
 *     parseOutput: (raw) => CatCharacteristicsSchema.parse(JSON.parse(raw)),
 *     errorContext: 'Description parsing',
 *   });
 * }
 *
 * @example
 * // Mock-only (no real implementation)
 * execute: async (input) => {
 *   return executeLLMAnalyzer({
 *     mockable: input.mockable ?? true,
 *     mockFn: () => mockGenerateName(input.characteristics),
 *     notImplementedMessage: 'Real LLM name generation requires runtime adapter',
 *   });
 * }
 */
export async function executeLLMAnalyzer<TData>(config: {
  mockable: boolean;
  mockFn: () => TData;
  realFn?: () => Promise<unknown>;
  parseOutput?: (raw: unknown) => TData;
  errorContext?: string;
  notImplementedMessage?: string;
}): Promise<OneShotAgentOutput<TData, LLMError>> {
  try {
    // Mock mode: return mock data immediately
    if (config.mockable) {
      const data = config.mockFn();
      return {
        result: { status: 'success', data },
        metadata: {
          mode: 'mock',
          executedAt: new Date().toISOString(),
        },
      };
    }

    // Real mode: check if implemented
    if (!config.realFn) {
      // Not implemented: return error with custom message
      return {
        result: {
          status: 'error',
          error: LLM_UNAVAILABLE_ERROR,
        },
        metadata: {
          mode: 'real',
          message: config.notImplementedMessage ?? 'Real LLM implementation not available',
          executedAt: new Date().toISOString(),
        },
      };
    }

    // Real mode: use LLM
    const result = await executeLLMCall<TData>(
      config.realFn as () => Promise<TData>,
      config.parseOutput ? { parseOutput: config.parseOutput } : undefined,
    );

    return {
      result,
      metadata: {
        mode: 'real',
        executedAt: new Date().toISOString(),
      },
    };
  } catch (err) {
    // Unexpected errors
    if (err instanceof Error && config.errorContext) {
      console.warn(`${config.errorContext} error:`, err.message);
    }
    return {
      result: { status: 'error', error: LLM_UNAVAILABLE_ERROR },
    };
  }
}

/**
 * Execute an external event integrator agent (HITL, webhook, etc).
 *
 * Handles common external event failure modes:
 * - Timeouts waiting for response
 * - System unavailable
 * - Explicit rejection
 * - Invalid responses
 *
 * @example
 * // With auto-response (testing)
 * execute: async (input) => {
 *   return executeExternalEvent({
 *     autoResponse: input.autoResponse,
 *     handler: async () => requestApproval(input.prompt, input.context),
 *     timeoutMs: 60000,
 *   });
 * }
 *
 * @example
 * // Production mode (waits for real human/external system)
 * execute: async (input) => {
 *   return executeExternalEvent({
 *     handler: async () => requestApproval(input.prompt, input.context),
 *     timeoutMs: input.timeoutMs ?? 60000,
 *   });
 * }
 */
export async function executeExternalEvent<TData>(config: {
  autoResponse?: TData;
  handler: () => Promise<TData>;
  timeoutMs?: number;
  errorContext?: string;
}): Promise<OneShotAgentOutput<TData, ExternalEventError>> {
  try {
    // Auto-response mode (testing)
    if (config.autoResponse !== undefined) {
      return {
        result: { status: 'success', data: config.autoResponse },
        metadata: {
          mode: 'auto',
          executedAt: new Date().toISOString(),
        },
      };
    }

    // Real mode: execute handler
    const data = await config.handler();

    return {
      result: { status: 'success', data },
      metadata: {
        mode: 'real',
        executedAt: new Date().toISOString(),
        ...(config.timeoutMs !== undefined && { timeoutMs: config.timeoutMs }),
      },
    };
  } catch (err) {
    // Map exceptions to external event errors
    const error = mapExternalEventException(err, config.errorContext);
    return {
      result: { status: 'error', error },
      metadata: {
        mode: 'real',
        executedAt: new Date().toISOString(),
        ...(err instanceof Error && { errorMessage: err.message }),
      },
    };
  }
}

/**
 * Map common external event exceptions to standard error codes.
 *
 * @internal
 */
function mapExternalEventException(err: unknown, context?: string): ExternalEventError {
  if (err instanceof Error) {
    const message = err.message.toLowerCase();

    // Timeouts
    if (message.includes('timeout') || message.includes('timed out') || message.includes('etimedout')) {
      return 'event-timeout';
    }

    // Rejected
    if (message.includes('reject') || message.includes('denied') || message.includes('refused')) {
      return 'event-rejected';
    }

    // Invalid response
    if (message.includes('invalid') || message.includes('malformed') || message.includes('parse')) {
      return 'event-invalid-response';
    }

    // Log unexpected errors for debugging
    if (context) {
      console.warn(`${context} error:`, err.message);
    }
  }

  // Default to unavailable for unknown errors
  return 'event-unavailable';
}

/**
 * Map common LLM SDK exceptions to standard error codes.
 *
 * @internal
 */
function mapLLMException(err: unknown): LLMError {
  if (err instanceof Error) {
    const message = err.message.toLowerCase();

    // Content policy violations
    if (message.includes('content_policy') || message.includes('content filter') || message.includes('content policy')) {
      return 'llm-refusal';
    }

    // Rate limiting
    if (message.includes('rate limit') || message.includes('429')) {
      return 'llm-rate-limit';
    }

    // Timeouts
    if (message.includes('timeout') || message.includes('etimedout')) {
      return 'llm-timeout';
    }

    // Token limits
    if (message.includes('token') && message.includes('limit')) {
      return 'llm-token-limit';
    }

    // Service unavailable
    if (message.includes('503') || message.includes('502')) {
      return LLM_UNAVAILABLE_ERROR;
    }
  }

  // Default to unavailable for unknown errors
  return LLM_UNAVAILABLE_ERROR;
}

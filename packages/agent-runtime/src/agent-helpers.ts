/**
 * Helper functions for creating agents.
 */

import type {
  Agent,
  AgentResult,
  LLMError,
  OneShotAgentOutput,
} from '@vibe-agent-toolkit/agent-schema';

/**
 * Agent manifest metadata (simplified runtime version).
 */
export interface AgentManifest {
  name: string;
  version: string;
  description: string;
  archetype: string;
  metadata?: Record<string, unknown>;
}

/**
 * Wrap a synchronous pure function as an agent.
 *
 * Use for deterministic functions that don't do I/O.
 * The wrapper makes them async-compatible with all other agents.
 *
 * @example
 * const validator = createPureFunctionAgent(
 *   (haiku: Haiku) => {
 *     if (isValid(haiku)) {
 *       return { status: 'success', data: { valid: true } };
 *     }
 *     return { status: 'error', error: 'invalid-format' };
 *   },
 *   { name: 'haiku-validator', archetype: 'pure-function-tool' }
 * );
 */
export function createPureFunctionAgent<TInput, TData, TError = string>(
  fn: (input: TInput) => AgentResult<TData, TError>,
  manifest?: Partial<AgentManifest>
): Agent<TInput, OneShotAgentOutput<TData, TError>> {
  return {
    name: manifest?.name ?? 'pure-function-agent',
    manifest: {
      name: manifest?.name ?? 'pure-function-agent',
      version: manifest?.version ?? '1.0.0',
      description: manifest?.description ?? 'Pure function agent',
      archetype: manifest?.archetype ?? 'pure-function-tool',
    },
    execute: async (input: TInput) => {
      const result = fn(input);
      return {
        result,
        metadata: {
          synchronous: true,
          executedAt: new Date().toISOString(),
        },
      };
    },
  };
}

/**
 * Wrap a synchronous function that throws as an agent.
 *
 * Converts exceptions into error results automatically.
 *
 * @example
 * const parser = createSafePureFunctionAgent(
 *   (text: string) => JSON.parse(text),
 *   { name: 'json-parser' }
 * );
 */
export function createSafePureFunctionAgent<TInput, TData>(
  fn: (input: TInput) => TData,
  manifest?: Partial<AgentManifest>
): Agent<TInput, OneShotAgentOutput<TData, 'execution-error'>> {
  return {
    name: manifest?.name ?? 'safe-pure-function-agent',
    manifest: {
      name: manifest?.name ?? 'safe-pure-function-agent',
      version: manifest?.version ?? '1.0.0',
      description: manifest?.description ?? 'Safe pure function agent',
      archetype: manifest?.archetype ?? 'pure-function-tool',
    },
    execute: async (input: TInput) => {
      try {
        const data = fn(input);
        return {
          result: { status: 'success', data },
        };
      } catch (err) {
        return {
          result: {
            status: 'error',
            error: 'execution-error' as const,
          },
          metadata: {
            errorMessage: err instanceof Error ? err.message : String(err),
          },
        };
      }
    },
  };
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
      } catch (parseErr) {
        // Convert parse errors to llm-invalid-output
        // Log the error for debugging but don't expose details in result
        if (parseErr instanceof Error) {
          console.warn('LLM output parse error:', parseErr.message);
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
    if (message.includes('timeout') || message.includes('ETIMEDOUT')) {
      return 'llm-timeout';
    }

    // Token limits
    if (message.includes('token') && message.includes('limit')) {
      return 'llm-token-limit';
    }

    // Service unavailable
    if (message.includes('503') || message.includes('502')) {
      return 'llm-unavailable';
    }
  }

  // Default to unavailable for unknown errors
  return 'llm-unavailable';
}

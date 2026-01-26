# Result Envelope Design Specification

## Overview

This document specifies the complete design for VAT agent result envelopes, including error constants, observability fields, and retry semantics.

## Design Principles

1. **Errors are data** - Return errors in result envelopes, don't throw exceptions
2. **Type safety** - TypeScript discriminated unions for compile-time correctness
3. **Observability** - Optional metadata for production monitoring
4. **Separation of concerns** - Agents classify errors, orchestrators decide retry policy
5. **No string literals** - Export constants, derive types from constants

## Core Types

### AgentResult (Single-Execution Agents)

```typescript
// Status constants
export const RESULT_SUCCESS = 'success' as const;
export const RESULT_ERROR = 'error' as const;

export type ResultStatus =
  | typeof RESULT_SUCCESS
  | typeof RESULT_ERROR;

// Result type
export type AgentResult<TData, TError extends string> =
  | {
      status: typeof RESULT_SUCCESS;
      data: TData;
      confidence?: number;           // 0-1 scale
      warnings?: string[];           // Non-fatal issues
      execution?: ExecutionMetadata; // Observability
    }
  | {
      status: typeof RESULT_ERROR;
      error: TError;
      confidence?: number;           // Confidence in error classification
      execution?: ExecutionMetadata; // Observability
    };
```

### StatefulAgentResult (Conversational Agents)

```typescript
// Status constants
export const RESULT_IN_PROGRESS = 'in-progress' as const;

export type StatefulResultStatus =
  | typeof RESULT_IN_PROGRESS
  | typeof RESULT_SUCCESS
  | typeof RESULT_ERROR;

// Result type
export type StatefulAgentResult<TData, TError extends string, TMetadata = unknown> =
  | {
      status: typeof RESULT_IN_PROGRESS;
      metadata?: TMetadata;
      confidence?: number;           // 0-1 progress indicator
      warnings?: string[];
      execution?: ExecutionMetadata;
    }
  | {
      status: typeof RESULT_SUCCESS;
      data: TData;
      confidence?: number;
      warnings?: string[];
      execution?: ExecutionMetadata;
    }
  | {
      status: typeof RESULT_ERROR;
      error: TError;
      confidence?: number;
      execution?: ExecutionMetadata;
    };
```

### ExecutionMetadata (Observability)

```typescript
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

  /** Number of times orchestrator retried agent execution (0 = no retries) */
  retryCount?: number;

  /** ISO 8601 timestamp of execution start */
  timestamp?: string;
}
```

## Standard Error Types

### LLM Errors

```typescript
// Error constants (export these, not the strings!)
export const LLM_REFUSAL = 'llm-refusal' as const;
export const LLM_INVALID_OUTPUT = 'llm-invalid-output' as const;
export const LLM_TIMEOUT = 'llm-timeout' as const;
export const LLM_RATE_LIMIT = 'llm-rate-limit' as const;
export const LLM_TOKEN_LIMIT = 'llm-token-limit' as const;
export const LLM_UNAVAILABLE = 'llm-unavailable' as const;

// Type derived from constants
export type LLMError =
  | typeof LLM_REFUSAL          // Model refused to generate output
  | typeof LLM_INVALID_OUTPUT   // Output didn't match expected format
  | typeof LLM_TIMEOUT          // Request timed out
  | typeof LLM_RATE_LIMIT       // Hit rate limit
  | typeof LLM_TOKEN_LIMIT      // Exceeded token limit
  | typeof LLM_UNAVAILABLE;     // Service unavailable

// Retryability classification (for orchestrators)
export const RETRYABLE_LLM_ERRORS = new Set<LLMError>([
  LLM_TIMEOUT,
  LLM_RATE_LIMIT,
  LLM_UNAVAILABLE,
]);

export const NON_RETRYABLE_LLM_ERRORS = new Set<LLMError>([
  LLM_REFUSAL,
  LLM_INVALID_OUTPUT,
  LLM_TOKEN_LIMIT,
]);
```

### External Event Errors

```typescript
// Error constants
export const EVENT_TIMEOUT = 'event-timeout' as const;
export const EVENT_UNAVAILABLE = 'event-unavailable' as const;
export const EVENT_REJECTED = 'event-rejected' as const;
export const EVENT_INVALID_RESPONSE = 'event-invalid-response' as const;

// Type derived from constants
export type ExternalEventError =
  | typeof EVENT_TIMEOUT           // External event timed out
  | typeof EVENT_UNAVAILABLE       // External system unavailable
  | typeof EVENT_REJECTED          // External system rejected request
  | typeof EVENT_INVALID_RESPONSE; // External system returned invalid data

// Retryability classification
export const RETRYABLE_EVENT_ERRORS = new Set<ExternalEventError>([
  EVENT_TIMEOUT,
  EVENT_UNAVAILABLE,
]);

export const NON_RETRYABLE_EVENT_ERRORS = new Set<ExternalEventError>([
  EVENT_REJECTED,
  EVENT_INVALID_RESPONSE,
]);
```

### Validation Errors

```typescript
// Generic validation error (agents should define domain-specific errors)
export const INVALID_INPUT = 'invalid-input' as const;

export type ValidationError = typeof INVALID_INPUT;
```

## Output Envelopes

### OneShotAgentOutput

```typescript
export interface OneShotAgentOutput<TData, TError extends string> {
  result: AgentResult<TData, TError>;
}
```

**Use for:**
- Pure function tools (validators, transformers)
- One-shot LLM analyzers (photo analysis, text parsing)
- External event integrators (approval gates, webhooks)

### ConversationalAgentOutput

```typescript
export interface ConversationalAgentOutput<
  TData,
  TError extends string,
  TState
> {
  /** Natural language response to user */
  reply: string;

  /** Updated session state (carry to next turn) */
  sessionState: TState;

  /** Machine-readable result for orchestration */
  result: StatefulAgentResult<TData, TError, unknown>;
}
```

**Use for:**
- Multi-turn conversational assistants
- Progressive data collection agents
- Workflows with user interaction

## Observability Fields

### Confidence (0-1 scale)

**Purpose:** Indicates certainty in the result for intelligent orchestration

**Use cases:**
- Orchestration decisions (retry if confidence < 0.8)
- Chain validation (verify uncertain results with another agent)
- User transparency (show uncertainty: "I'm 70% confident")
- Stopping criteria (iterate until confidence > 0.9)

**Examples:**

```typescript
// Uncertain photo analysis
{
  status: RESULT_SUCCESS,
  data: { breed: 'Maine Coon' },
  confidence: 0.65  // Low confidence → verify with another agent
}

// Confident validation
{
  status: RESULT_SUCCESS,
  data: { valid: true },
  confidence: 0.98  // High confidence → proceed
}

// Uncertain error classification
{
  status: RESULT_ERROR,
  error: LLM_REFUSAL,
  confidence: 0.7  // Might be misclassified
}

// Conversational progress
{
  status: RESULT_IN_PROGRESS,
  confidence: 0.5,  // 50% of factors collected
  metadata: { factorsCollected: 2, requiredFactors: 4 }
}
```

### Warnings (Non-Fatal Issues)

**Purpose:** Success with caveats, graceful degradation

**Use cases:**
- User transparency (show quality issues)
- Context for downstream agents
- Logging/debugging

**Examples:**

```typescript
{
  status: RESULT_SUCCESS,
  data: { breed: 'Persian' },
  warnings: [
    'Image quality was poor, confidence may be lower',
    'Breed database last updated 6 months ago'
  ]
}

{
  status: RESULT_SUCCESS,
  data: { name: 'Fluffy' },
  warnings: [
    'Name validation was lenient due to unusual characteristics'
  ]
}
```

### Execution Metadata

**Purpose:** Production observability, performance monitoring, cost tracking

**Fields:**
- `durationMs` - Total execution time (including retries if set by orchestrator)
- `tokensUsed` - LLM tokens consumed (sum across all LLM calls)
- `cost` - Estimated cost in USD
- `model` - Model identifier for A/B testing
- `provider` - Provider for cost attribution
- `retryCount` - Set by orchestrator's retry wrapper (0 = no retries)
- `timestamp` - Execution start time (ISO 8601)

**Who sets what:**
- Agent sets: `durationMs`, `tokensUsed`, `cost`, `model`, `provider`, `timestamp`
- Orchestrator sets: `retryCount` (wraps and injects)

**Examples:**

```typescript
// Agent-level metadata
{
  status: RESULT_SUCCESS,
  data: { characteristics: {...} },
  execution: {
    durationMs: 1234,
    tokensUsed: 450,
    cost: 0.0045,
    model: 'gpt-4o-mini',
    provider: 'openai',
    timestamp: '2024-01-26T15:30:00Z'
  }
}

// After orchestrator retry wrapper
{
  status: RESULT_SUCCESS,
  data: { characteristics: {...} },
  execution: {
    durationMs: 3456,      // Sum of all attempts
    tokensUsed: 1200,      // Sum across retries
    cost: 0.012,           // Total cost
    model: 'gpt-4o-mini',
    provider: 'openai',
    retryCount: 2,         // Orchestrator retried 2 times (3rd attempt succeeded)
    timestamp: '2024-01-26T15:30:00Z'
  }
}
```

## Error Classification & Retryability

**Design principle:** Agents classify errors, orchestrators decide retry policy.

### Agent Responsibility

Classify the error accurately:

```typescript
// Agent maps exception to standard error type
try {
  const response = await context.callLLM(messages);
  return { result: { status: RESULT_SUCCESS, data: parseResponse(response) } };
} catch (error) {
  if (error.code === 'rate_limit_exceeded') {
    return { result: { status: RESULT_ERROR, error: LLM_RATE_LIMIT } };
  }
  if (error.code === 'timeout') {
    return { result: { status: RESULT_ERROR, error: LLM_TIMEOUT } };
  }
  return { result: { status: RESULT_ERROR, error: LLM_UNAVAILABLE } };
}
```

### Orchestrator Responsibility

Decide retry policy based on error type:

```typescript
const RETRYABLE_ERRORS = new Set([
  LLM_TIMEOUT,
  LLM_RATE_LIMIT,
  LLM_UNAVAILABLE,
  EVENT_TIMEOUT,
  EVENT_UNAVAILABLE,
]);

const BACKOFF_DELAYS = {
  [LLM_RATE_LIMIT]: 5000,    // Rate limits need longer waits
  [LLM_TIMEOUT]: 1000,       // Timeouts can retry quickly
  [LLM_UNAVAILABLE]: 10000,  // Service issues need long waits
  [EVENT_TIMEOUT]: 2000,
  [EVENT_UNAVAILABLE]: 5000,
} as const;

function isRetryable(error: string): boolean {
  return RETRYABLE_ERRORS.has(error as any);
}

function getBackoffDelay(error: string, attempt: number): number {
  const baseDelay = BACKOFF_DELAYS[error as keyof typeof BACKOFF_DELAYS] ?? 2000;
  return Math.min(baseDelay * Math.pow(2, attempt), 30000); // Cap at 30s
}
```

### Why This Separation?

1. **Agent focus:** Simple error classification, no retry logic
2. **Orchestrator control:** Centralized retry policy, easy to tune
3. **Testing:** Test agents without retry complexity
4. **Flexibility:** Different orchestrators can have different policies

## Retry Count Semantics

### Who Sets It?

**Orchestrator** wraps agent execution and injects `retryCount`:

```typescript
async function withRetry<T, E extends string>(
  agentFn: () => Promise<OneShotAgentOutput<T, E>>,
  maxAttempts: number = 5
): Promise<OneShotAgentOutput<T, E>> {
  let lastOutput: OneShotAgentOutput<T, E>;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    lastOutput = await agentFn();

    if (lastOutput.result.status === RESULT_SUCCESS) {
      return {
        result: {
          ...lastOutput.result,
          execution: {
            ...lastOutput.result.execution,
            retryCount: attempt,  // 0 = no retries, 1 = one retry, etc.
          },
        },
      };
    }

    if (!isRetryable(lastOutput.result.error)) {
      return {
        result: {
          ...lastOutput.result,
          execution: {
            ...lastOutput.result.execution,
            retryCount: attempt,
          },
        },
      };
    }

    if (attempt < maxAttempts - 1) {
      await sleep(getBackoffDelay(lastOutput.result.error, attempt));
    }
  }

  return {
    result: {
      ...lastOutput!.result,
      execution: {
        ...lastOutput!.result.execution,
        retryCount: maxAttempts - 1,
      },
    },
  };
}
```

### Interpretation

- `retryCount: 0` - Succeeded on first attempt (no retries)
- `retryCount: 1` - Failed once, succeeded on second attempt (one retry)
- `retryCount: 2` - Failed twice, succeeded on third attempt (two retries)
- `retryCount: 4` - Failed 5 times (max retries exceeded)

### Internal LLM Retries

Runtime's `context.callLLM` may retry internally (transparent to agent):

```typescript
class RuntimeContext {
  private llmCallCount = 0;

  async callLLM(messages: Message[]): Promise<string> {
    for (let attempt = 0; attempt < 3; attempt++) {
      this.llmCallCount++;
      try {
        return await this.provider.complete(messages);
      } catch (error) {
        if (attempt < 2 && isTransientError(error)) {
          await sleep(1000);
          continue;
        }
        throw error;
      }
    }
  }
}
```

**Agent sees:** Single call to `callLLM` (internal retries are transparent)

**Result contains:** Agent-level `retryCount` only (orchestrator's retry count)

**Future (v2):** Could add `execution.internal.llmCallCount` for deep observability

## Implementation Checklist

### Phase 1: Update agent-schema Package

- [ ] Update `src/result-types.ts` with constants
- [ ] Add `ExecutionMetadata` interface
- [ ] Add optional fields to `AgentResult` and `StatefulAgentResult`
- [ ] Export error constants and retryability sets
- [ ] Generate updated JSON schemas
- [ ] Update tests

### Phase 2: Update agent-runtime Package

- [ ] Update helper functions to preserve new fields
- [ ] Add `withRetry` helper that injects `retryCount`
- [ ] Add `withTiming` helper for `ExecutionMetadata`
- [ ] Update test helpers to check new fields

### Phase 3: Update Example Agents

- [ ] Update all agents to use error constants (not strings)
- [ ] Update all agents to return `ExecutionMetadata`
- [ ] Update breed-advisor to use constants
- [ ] Update all tests to use constants

### Phase 4: Update Documentation

- [ ] Update orchestration.md with retry examples
- [ ] Update agent-authoring.md with metadata examples
- [ ] Update architecture README with design rationale
- [ ] Update cat-agents README with examples

### Phase 5: Validation

- [ ] Run full test suite (`vv validate`)
- [ ] Test conversational demo
- [ ] Verify no string duplication (ESLint)
- [ ] Check all imports work correctly

## Migration Guide (for existing agents)

### Before (string literals)

```typescript
return {
  result: {
    status: 'error',
    error: 'llm-timeout'
  }
};

const isRetryable = error === 'llm-timeout' || error === 'llm-rate-limit';
```

### After (constants)

```typescript
import { RESULT_ERROR, LLM_TIMEOUT, RETRYABLE_LLM_ERRORS } from '@vibe-agent-toolkit/agent-schema';

return {
  result: {
    status: RESULT_ERROR,
    error: LLM_TIMEOUT
  }
};

const isRetryable = RETRYABLE_LLM_ERRORS.has(error);
```

## Benefits Summary

1. **No string duplication** - Use constants everywhere
2. **Autocomplete** - IDE suggests available errors
3. **Typo prevention** - Compile-time errors for typos
4. **Production observability** - Track performance, cost, retries
5. **Intelligent orchestration** - Confidence-based decisions
6. **Graceful degradation** - Warnings for non-fatal issues
7. **Type safety** - Discriminated unions throughout
8. **Separation of concerns** - Agents classify, orchestrators retry
9. **Easy refactoring** - Change constant values once
10. **Better testing** - Test against constants, not strings

## Design Rationale

### Why Not Put retryAfterMs in Result?

**Problem:** Mixes concerns (agent describes what, orchestrator decides how)

**Solution:** Error type implies retryability, orchestrator encodes retry delays

### Why Optional Fields?

**Answer:** Backward compatibility, gradual adoption, not all agents need all fields

### Why Separate Success/Error Types?

**Answer:** TypeScript discriminated unions enable type narrowing (compile-time safety)

### Why Export Constants?

**Answer:** Prevent string duplication, enable autocomplete, catch typos at compile time

### Why retryCount in Result?

**Answer:** Observability - see how many retries were needed for debugging/metrics

# Agent Authoring Guide

## Introduction

This guide shows how to create VAT agents that return standardized result envelopes. All agents follow consistent patterns for error handling, type safety, and orchestration.

## Quick Start

### Minimal Pure Function Agent

The simplest agent is a pure function that validates or transforms data:

```typescript
import { z } from 'zod';
import { defineAgent, type OneShotAgentOutput } from '@vibe-agent-toolkit/agent-schema';

// 1. Define input schema
const InputSchema = z.object({
  text: z.string(),
});

// 2. Define output data schema
const OutputDataSchema = z.object({
  valid: z.boolean(),
  reason: z.string().optional(),
});

// 3. Define error type
type ValidationError = 'too-short' | 'too-long' | 'invalid-format';

// 4. Define agent
export const myValidator = defineAgent<
  z.infer<typeof InputSchema>,
  OneShotAgentOutput<z.infer<typeof OutputDataSchema>, ValidationError>
>({
  name: 'my-validator',
  description: 'Validates text input',
  version: '1.0.0',
  inputSchema: InputSchema,
  outputSchema: z.object({
    result: z.discriminatedUnion('status', [
      z.object({
        status: z.literal('success'),
        data: OutputDataSchema,
      }),
      z.object({
        status: z.literal('error'),
        error: z.enum(['too-short', 'too-long', 'invalid-format']),
      }),
    ]),
  }),

  // 5. Implement execution logic
  async execute(input) {
    if (input.text.length < 5) {
      return {
        result: {
          status: 'error' as const,
          error: 'too-short' as const,
        },
      };
    }

    if (input.text.length > 100) {
      return {
        result: {
          status: 'error' as const,
          error: 'too-long' as const,
        },
      };
    }

    return {
      result: {
        status: 'success' as const,
        data: {
          valid: true,
          reason: 'Passes all validation rules',
        },
      },
    };
  },
});
```

### Minimal LLM-Based Agent

Add LLM calls with error handling:

```typescript
import { z } from 'zod';
import { defineAgent, type OneShotAgentOutput, type LLMError } from '@vibe-agent-toolkit/agent-schema';

const InputSchema = z.object({
  text: z.string(),
});

const OutputDataSchema = z.object({
  sentiment: z.enum(['positive', 'negative', 'neutral']),
  confidence: z.number().min(0).max(1),
});

export const sentimentAnalyzer = defineAgent<
  z.infer<typeof InputSchema>,
  OneShotAgentOutput<z.infer<typeof OutputDataSchema>, LLMError>
>({
  name: 'sentiment-analyzer',
  description: 'Analyzes sentiment of text',
  version: '1.0.0',
  inputSchema: InputSchema,
  outputSchema: z.object({
    result: z.discriminatedUnion('status', [
      z.object({
        status: z.literal('success'),
        data: OutputDataSchema,
      }),
      z.object({
        status: z.literal('error'),
        error: z.enum([
          'llm-refusal',
          'llm-invalid-output',
          'llm-timeout',
          'llm-rate-limit',
          'llm-token-limit',
          'llm-unavailable',
        ]),
      }),
    ]),
  }),

  async execute(input, context) {
    try {
      const prompt = `Analyze the sentiment of this text: "${input.text}"\n\nRespond with JSON: {"sentiment": "positive" | "negative" | "neutral", "confidence": 0.0-1.0}`;

      const response = await context.callLLM([
        { role: 'user', content: prompt },
      ]);

      // Parse LLM response
      const parsed = JSON.parse(response);
      const validated = OutputDataSchema.parse(parsed);

      return {
        result: {
          status: 'success' as const,
          data: validated,
        },
      };
    } catch (error) {
      // Map exceptions to LLMError types
      if (error instanceof Error && error.message.includes('timeout')) {
        return {
          result: { status: 'error' as const, error: 'llm-timeout' as const },
        };
      }

      return {
        result: { status: 'error' as const, error: 'llm-invalid-output' as const },
      };
    }
  },
});
```

### Minimal Conversational Agent

Multi-turn conversation with session state:

```typescript
import { z } from 'zod';
import { defineAgent, type ConversationalAgentOutput } from '@vibe-agent-toolkit/agent-schema';

const ProfileSchema = z.object({
  name: z.string().optional(),
  age: z.number().optional(),
  conversationPhase: z.enum(['gathering', 'ready']).default('gathering'),
});

const InputSchema = z.object({
  message: z.string(),
  sessionState: z.object({
    profile: ProfileSchema,
  }).optional(),
});

const FinalDataSchema = z.object({
  profile: ProfileSchema,
  greeting: z.string(),
});

export const greeterAgent = defineAgent<
  z.infer<typeof InputSchema>,
  ConversationalAgentOutput<z.infer<typeof FinalDataSchema>, 'abandoned', z.infer<typeof ProfileSchema>>
>({
  name: 'greeter',
  description: 'Gathers user info and provides personalized greeting',
  version: '1.0.0',
  inputSchema: InputSchema,
  outputSchema: z.object({
    reply: z.string(),
    sessionState: ProfileSchema,
    result: z.discriminatedUnion('status', [
      z.object({
        status: z.literal('in-progress'),
        metadata: ProfileSchema.optional(),
      }),
      z.object({
        status: z.literal('success'),
        data: FinalDataSchema,
      }),
      z.object({
        status: z.literal('error'),
        error: z.literal('abandoned'),
      }),
    ]),
  }),

  async execute(input, context) {
    const profile = input.sessionState?.profile ?? { conversationPhase: 'gathering' as const };

    // Gathering phase
    if (profile.conversationPhase === 'gathering') {
      if (!profile.name) {
        return {
          reply: "Hi! What's your name?",
          sessionState: profile,
          result: {
            status: 'in-progress' as const,
            metadata: profile,
          },
        };
      }

      if (!profile.age) {
        return {
          reply: `Nice to meet you, ${profile.name}! How old are you?`,
          sessionState: { ...profile, conversationPhase: 'gathering' as const },
          result: {
            status: 'in-progress' as const,
            metadata: profile,
          },
        };
      }

      // Have all info - transition to ready
      const greeting = `Great, ${profile.name}! At ${profile.age} years old, you're in your prime!`;
      return {
        reply: greeting,
        sessionState: { ...profile, conversationPhase: 'ready' as const },
        result: {
          status: 'success' as const,
          data: {
            profile: { ...profile, conversationPhase: 'ready' as const },
            greeting,
          },
        },
      };
    }

    // Already complete
    return {
      reply: 'We already completed our conversation!',
      sessionState: profile,
      result: {
        status: 'success' as const,
        data: {
          profile,
          greeting: `Hello again, ${profile.name}!`,
        },
      },
    };
  },
});
```

## Core Patterns

### Pattern 1: Pure Function Agent

**When to use**: Stateless validation, transformation, or computation

**Characteristics**:
- No LLM calls
- Deterministic output
- Fast execution
- Easy to test

**Template**:

```typescript
export const myAgent = defineAgent({
  name: 'my-agent',
  // ... metadata

  async execute(input) {
    // Validate input
    if (/* invalid condition */) {
      return {
        result: { status: 'error', error: 'specific-error-code' },
      };
    }

    // Compute result
    const data = computeData(input);

    return {
      result: { status: 'success', data },
    };
  },
});
```

**Examples**: `haiku-validator`, `name-validator`

### Pattern 2: One-Shot LLM Analyzer

**When to use**: Single LLM call for analysis, classification, or generation

**Characteristics**:
- One LLM call per execution
- Stateless
- Handles LLM errors
- Parses and validates LLM output

**Template**:

```typescript
export const myAnalyzer = defineAgent({
  name: 'my-analyzer',
  // ... metadata

  async execute(input, context) {
    try {
      // Build prompt
      const prompt = buildPrompt(input);

      // Call LLM
      const response = await context.callLLM([
        { role: 'user', content: prompt },
      ]);

      // Parse and validate
      const parsed = parseResponse(response);
      const validated = OutputSchema.parse(parsed);

      return {
        result: { status: 'success', data: validated },
      };
    } catch (error) {
      return {
        result: { status: 'error', error: mapError(error) },
      };
    }
  },
});
```

**Examples**: `photo-analyzer`, `description-parser`, `name-generator`, `haiku-generator`

### Pattern 3: Conversational Assistant

**When to use**: Multi-turn dialogue, progressive data collection

**Characteristics**:
- Multiple LLM calls across turns
- Maintains session state
- Phases (gathering → ready → complete)
- Natural language replies + machine-readable results

**Template**:

```typescript
export const myAssistant = defineAgent({
  name: 'my-assistant',
  // ... metadata

  async execute(input, context) {
    // Get current state
    const state = input.sessionState ?? getInitialState();

    // Phase 1: Gathering
    if (state.phase === 'gathering') {
      if (/* need more info */) {
        return {
          reply: 'Question to gather info?',
          sessionState: state,
          result: {
            status: 'in-progress',
            metadata: { progress: state },
          },
        };
      }

      // Enough info - transition to ready
      state.phase = 'ready';
    }

    // Phase 2: Ready/Complete
    if (state.phase === 'ready') {
      const finalData = computeFinalData(state);

      return {
        reply: 'Here is your result!',
        sessionState: { ...state, phase: 'complete' },
        result: {
          status: 'success',
          data: finalData,
        },
      };
    }

    // Already complete
    return {
      reply: 'We finished!',
      sessionState: state,
      result: {
        status: 'success',
        data: state.finalData,
      },
    };
  },
});
```

**Examples**: `breed-advisor`

### Pattern 4: External Event Integrator

**When to use**: Waiting for external events (human approval, webhooks, etc.)

**Characteristics**:
- Emits event, blocks waiting for response
- Timeout handling
- External system unavailability
- Can be mocked for testing

**Template**:

```typescript
export const myEventAgent = defineAgent({
  name: 'my-event-agent',
  // ... metadata

  async execute(input, options = {}) {
    const { mockable = true, timeout = 30000 } = options;

    if (mockable) {
      // Mock mode - instant response for testing
      return {
        result: {
          status: 'success',
          data: getMockResponse(input),
        },
      };
    }

    try {
      // Emit event to external system
      const response = await emitEvent(input, timeout);

      return {
        result: {
          status: 'success',
          data: response,
        },
      };
    } catch (error) {
      if (error.code === 'TIMEOUT') {
        return {
          result: { status: 'error', error: 'event-timeout' },
        };
      }

      return {
        result: { status: 'error', error: 'event-unavailable' },
      };
    }
  },
});
```

**Examples**: `human-approval`

## Error Handling Strategy

### Principle: Errors are Data

Errors are part of the result envelope, not exceptions:

```typescript
// ✅ GOOD - Error as data
return {
  result: { status: 'error', error: 'llm-timeout' },
};

// ❌ BAD - Throwing exceptions
throw new Error('LLM timeout');
```

### Standard Error Types

Use standard error enums when possible:

```typescript
import { type LLMError, type ExternalEventError } from '@vibe-agent-toolkit/agent-schema';

// LLM-based agents
type MyError = LLMError;

// Event-based agents
type MyError = ExternalEventError;

// Custom domain errors
type MyError =
  | LLMError
  | 'domain-specific-error'
  | 'another-domain-error';
```

### Mapping Exceptions

Catch exceptions and map to error types:

```typescript
async execute(input, context) {
  try {
    const response = await context.callLLM(/* ... */);
    // ... process response
  } catch (error) {
    // Map to standard error types
    if (error instanceof Error) {
      if (error.message.includes('timeout')) {
        return { result: { status: 'error', error: 'llm-timeout' } };
      }
      if (error.message.includes('rate limit')) {
        return { result: { status: 'error', error: 'llm-rate-limit' } };
      }
    }

    // Default to generic error
    return { result: { status: 'error', error: 'llm-unavailable' } };
  }
}
```

### Validation Errors

Use Zod for input/output validation:

```typescript
async execute(input) {
  // Validate input (automatic with schemas)
  const validated = InputSchema.parse(input);

  // ... process

  // Validate output before returning
  try {
    const data = OutputDataSchema.parse(computedData);
    return { result: { status: 'success', data } };
  } catch (error) {
    return { result: { status: 'error', error: 'llm-invalid-output' } };
  }
}
```

## Testing Patterns

### Unit Tests for Pure Functions

```typescript
import { describe, expect, it } from 'vitest';
import { resultMatchers } from '@vibe-agent-toolkit/agent-runtime';

describe('myValidator', () => {
  it('should validate correct input', async () => {
    const output = await myValidator.execute({
      text: 'valid input',
    });

    resultMatchers.expectSuccess(output.result);
    expect(output.result.data.valid).toBe(true);
  });

  it('should reject invalid input', async () => {
    const output = await myValidator.execute({
      text: 'x', // too short
    });

    resultMatchers.expectError(output.result);
    expect(output.result.error).toBe('too-short');
  });
});
```

### Integration Tests with Mock LLM

```typescript
import { createMockContext } from '@vibe-agent-toolkit/agent-runtime';

describe('myAnalyzer with mock LLM', () => {
  it('should parse LLM response', async () => {
    const mockContext = createMockContext(
      JSON.stringify({ sentiment: 'positive', confidence: 0.9 })
    );

    const output = await myAnalyzer.execute(
      { text: 'Great product!' },
      mockContext
    );

    resultMatchers.expectSuccess(output.result);
    expect(output.result.data.sentiment).toBe('positive');
  });

  it('should handle invalid LLM output', async () => {
    const mockContext = createMockContext('invalid json');

    const output = await myAnalyzer.execute(
      { text: 'Test' },
      mockContext
    );

    resultMatchers.expectError(output.result);
    expect(output.result.error).toBe('llm-invalid-output');
  });
});
```

### Conversational Agent Tests

```typescript
describe('greeterAgent conversation flow', () => {
  it('should gather name first', async () => {
    const output = await greeterAgent.execute({
      message: 'Hello',
    });

    expect(output.reply).toContain("What's your name?");
    resultMatchers.expectInProgress(output.result);
  });

  it('should gather age second', async () => {
    const output = await greeterAgent.execute({
      message: 'My name is Alice',
      sessionState: {
        profile: { name: 'Alice', conversationPhase: 'gathering' },
      },
    });

    expect(output.reply).toContain('How old are you?');
    expect(output.sessionState.name).toBe('Alice');
    resultMatchers.expectInProgress(output.result);
  });

  it('should complete with greeting', async () => {
    const output = await greeterAgent.execute({
      message: 'I am 30',
      sessionState: {
        profile: {
          name: 'Alice',
          age: 30,
          conversationPhase: 'gathering',
        },
      },
    });

    expect(output.reply).toContain('in your prime');
    resultMatchers.expectSuccess(output.result);
    expect(output.result.data.greeting).toBeDefined();
  });
});
```

## Best Practices

### 1. Define Clear Schemas

Use Zod for type-safe schemas:

```typescript
// ✅ GOOD - Explicit schemas
const InputSchema = z.object({
  text: z.string().min(1).max(1000),
  options: z.object({
    strict: z.boolean().default(false),
  }).optional(),
});

// ❌ BAD - Loose types
const InputSchema = z.object({
  text: z.string(),
  options: z.any(),
});
```

### 2. Use Discriminated Unions

Leverage TypeScript's type narrowing:

```typescript
// ✅ GOOD - Discriminated union
type Result =
  | { status: 'success'; data: Data }
  | { status: 'error'; error: Error };

// ❌ BAD - Flat structure
type Result = {
  status: 'success' | 'error';
  data?: Data;
  error?: Error;
};
```

### 3. Consistent Error Types

Use enums or literal unions:

```typescript
// ✅ GOOD - Typed errors
type Error = 'too-short' | 'too-long' | 'invalid';

// ❌ BAD - String errors
type Error = string;
```

### 4. Document Metadata

For conversational agents, document metadata structure:

```typescript
/**
 * Metadata for in-progress state
 */
interface Metadata {
  /** Current conversation phase */
  phase: 'gathering' | 'ready';
  /** Number of questions answered */
  answered: number;
  /** Total questions required */
  total: number;
}
```

### 5. Test All Paths

Cover success, errors, and edge cases:

```typescript
describe('myAgent', () => {
  it('should handle success case', /* ... */);
  it('should handle validation error', /* ... */);
  it('should handle LLM timeout', /* ... */);
  it('should handle malformed input', /* ... */);
});
```

### 6. Use Mock Mode for External Events

Enable testing without external dependencies:

```typescript
async execute(input, options = {}) {
  const { mockable = true } = options;

  if (mockable) {
    // Instant response for tests
    return getMockResponse(input);
  }

  // Real external call
  return await callExternalSystem(input);
}
```

## Related Documentation

- [Orchestration Guide](./orchestration.md) - Composing agents into workflows
- [Architecture Overview](./architecture/README.md) - Package structure

## Examples

See `@vibe-agent-toolkit/vat-example-cat-agents` for complete working examples:

```bash
cd packages/vat-example-cat-agents
bun run test           # Run all tests
bun run demo:photos    # Photo analysis demo
bun run demo:conversation  # Conversational demo
```

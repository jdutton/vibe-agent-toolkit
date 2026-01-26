# Agent Orchestration Guide

## Introduction

This guide shows how to orchestrate VAT agents using standardized result envelopes and Railway-Oriented Programming (ROP) patterns. All VAT agents return consistent result types, enabling type-safe composition, error handling, and complex workflows.

## Core Concepts

### Result Types

VAT defines two core result types in `@vibe-agent-toolkit/agent-schema`:

#### AgentResult<TData, TError>

For single-execution agents (pure functions, one-shot LLM analyzers):

```typescript
type AgentResult<TData, TError> =
  | { status: 'success'; data: TData }
  | { status: 'error'; error: TError };
```

**Examples:**
- Pure function validators return `AgentResult<ValidationData, ValidationError>`
- One-shot LLM analyzers return `AgentResult<AnalysisData, LLMError>`

#### StatefulAgentResult<TData, TError, TMetadata>

For multi-turn conversational agents that maintain state:

```typescript
type StatefulAgentResult<TData, TError, TMetadata> =
  | { status: 'in-progress'; metadata?: TMetadata }
  | { status: 'success'; data: TData }
  | { status: 'error'; error: TError };
```

**Examples:**
- Conversational assistants return `StatefulAgentResult<FinalData, ConversationError, ProgressMetadata>`
- Multi-step workflows return `StatefulAgentResult<WorkflowResult, WorkflowError, StepMetadata>`

### Output Envelopes

Agents return output envelopes that wrap results with additional context:

#### OneShotAgentOutput<TData, TError>

```typescript
interface OneShotAgentOutput<TData, TError> {
  result: AgentResult<TData, TError>;
}
```

**Use for:**
- Pure function tools (validators, transformers)
- One-shot LLM analyzers (photo analysis, text parsing)
- External event integrators (approval gates, webhooks)

**Example:**
```typescript
const output = await haikuValidator.execute({
  text: 'Ancient pond, frog leaps in, splash',
  syllables: [5, 7, 5],
});

// output.result is AgentResult<ValidationData, ValidationError>
if (output.result.status === 'success') {
  console.log('Valid:', output.result.data.valid);
} else {
  console.error('Invalid:', output.result.error);
}
```

#### ConversationalAgentOutput<TData, TError, TState>

```typescript
interface ConversationalAgentOutput<TData, TError, TState> {
  reply: string;                               // Natural language response
  sessionState: TState;                        // Updated session state
  result: StatefulAgentResult<TData, TError, TMetadata>;  // Machine-readable result
}
```

**Use for:**
- Multi-turn conversational assistants
- Progressive data collection agents
- Workflows with user interaction

**Example:**
```typescript
const output = await breedAdvisor.execute({
  message: 'I love classical music',
  sessionState: { profile: { conversationPhase: 'gathering' } },
});

// output.reply - Natural language for user
console.log('Agent says:', output.reply);

// output.sessionState - Carry to next turn
const nextInput = { message: 'I live in an apartment', sessionState: output.sessionState };

// output.result - Machine-readable status
if (output.result.status === 'in-progress') {
  console.log('Gathering info, progress:', output.result.metadata);
} else if (output.result.status === 'success') {
  console.log('Recommendation:', output.result.data);
}
```

### Standard Error Types

#### LLMError

For LLM-related failures:

```typescript
type LLMError =
  | 'llm-refusal'          // LLM refused to generate output
  | 'llm-invalid-output'   // Output didn't match expected format
  | 'llm-timeout'          // Request timed out
  | 'llm-rate-limit'       // Hit rate limit
  | 'llm-token-limit'      // Exceeded token limit
  | 'llm-unavailable';     // Service unavailable
```

#### ExternalEventError

For external system integration failures:

```typescript
type ExternalEventError =
  | 'event-timeout'           // External event timed out
  | 'event-unavailable'       // External system unavailable
  | 'event-rejected'          // External system rejected request
  | 'event-invalid-response'; // External system returned invalid data
```

#### Custom Error Types

Agents can define domain-specific errors:

```typescript
type ValidationError =
  | 'invalid-syllables'
  | 'missing-kigo'
  | 'missing-kireji'
  | 'too-long'
  | 'too-short';
```

## Result Helpers

The `@vibe-agent-toolkit/agent-runtime` package provides helper functions for working with results.

### mapResult()

Transform success data while preserving errors:

```typescript
import { mapResult } from '@vibe-agent-toolkit/agent-runtime';

const result1 = { status: 'success' as const, data: 10 };
const result2 = mapResult(result1, (n) => n * 2);
// result2 = { status: 'success', data: 20 }

const result3 = { status: 'error' as const, error: 'failed' };
const result4 = mapResult(result3, (n) => n * 2);
// result4 = { status: 'error', error: 'failed' } (unchanged)
```

### andThen()

Chain operations that return results (monadic bind):

```typescript
import { andThen } from '@vibe-agent-toolkit/agent-runtime';

const result1 = { status: 'success' as const, data: 10 };
const result2 = andThen(result1, (n) => {
  if (n > 5) {
    return { status: 'success' as const, data: n * 2 };
  }
  return { status: 'error' as const, error: 'too-small' };
});
// result2 = { status: 'success', data: 20 }

const result3 = { status: 'error' as const, error: 'failed' };
const result4 = andThen(result3, (n) => {
  return { status: 'success' as const, data: n * 2 };
});
// result4 = { status: 'error', error: 'failed' } (not called)
```

### match()

Pattern match on result status:

```typescript
import { match } from '@vibe-agent-toolkit/agent-runtime';

const result = { status: 'success' as const, data: 'hello' };

const message = match(result, {
  success: (data) => `Success: ${data}`,
  error: (err) => `Error: ${err}`,
});
// message = "Success: hello"

// For stateful results, add inProgress handler
const statefulResult = { status: 'in-progress' as const, metadata: { step: 2 } };

const status = match(statefulResult, {
  success: (data) => `Done: ${data}`,
  error: (err) => `Failed: ${err}`,
  inProgress: (meta) => `Working: step ${meta?.step}`,
});
// status = "Working: step 2"
```

### unwrap()

Extract data, throwing on error:

```typescript
import { unwrap } from '@vibe-agent-toolkit/agent-runtime';

const result1 = { status: 'success' as const, data: 'hello' };
const data = unwrap(result1);
// data = "hello"

const result2 = { status: 'error' as const, error: 'failed' };
const data2 = unwrap(result2);
// Throws: Error: Result was error: failed
```

## Orchestration Patterns

### Sequential Execution

Execute agents in order, passing results forward:

```typescript
import { andThen } from '@vibe-agent-toolkit/agent-runtime';

async function analyzeAndNameCat(imagePath: string) {
  // Step 1: Analyze photo
  const analysisOutput = await photoAnalyzer.execute({ imagePath });

  // Step 2: Generate name (only if analysis succeeded)
  const nameOutput = await andThen(
    analysisOutput.result,
    async (characteristics) => {
      const output = await nameGenerator.execute({ characteristics });
      return output.result;
    }
  );

  // Step 3: Validate name (only if generation succeeded)
  const validationOutput = await andThen(
    nameOutput,
    async (name) => {
      const output = await nameValidator.execute({
        name: name.name,
        characteristics: name.characteristics,
      });
      return output.result;
    }
  );

  return validationOutput;
}

// Usage
const result = await analyzeAndNameCat('photos/orange-tabby.jpg');

match(result, {
  success: (data) => console.log('Valid name:', data),
  error: (err) => console.error('Failed:', err),
});
```

### Parallel Execution

Execute multiple agents concurrently:

```typescript
async function analyzeMultipleSources(
  imagePath: string,
  description: string
) {
  // Run both analyzers in parallel
  const [photoOutput, descOutput] = await Promise.all([
    photoAnalyzer.execute({ imagePath }),
    descriptionParser.execute({ text: description }),
  ]);

  // Combine results
  if (photoOutput.result.status === 'success' &&
      descOutput.result.status === 'success') {
    // Both succeeded - merge characteristics
    return {
      status: 'success' as const,
      data: mergeCharacteristics(
        photoOutput.result.data,
        descOutput.result.data
      ),
    };
  } else if (photoOutput.result.status === 'success') {
    // Photo succeeded, use that
    return photoOutput.result;
  } else if (descOutput.result.status === 'success') {
    // Description succeeded, use that
    return descOutput.result;
  } else {
    // Both failed
    return {
      status: 'error' as const,
      error: 'both-analyzers-failed' as const,
    };
  }
}
```

### Retry with Fallback

Retry operations with exponential backoff:

```typescript
async function analyzeWithRetry(
  imagePath: string,
  maxRetries = 3
): Promise<AgentResult<CatCharacteristics, LLMError>> {
  let lastError: LLMError = 'llm-unavailable';

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const output = await photoAnalyzer.execute({ imagePath });

    if (output.result.status === 'success') {
      return output.result;
    }

    lastError = output.result.error;

    // Retry on transient errors
    if (lastError === 'llm-timeout' ||
        lastError === 'llm-rate-limit' ||
        lastError === 'llm-unavailable') {
      const delay = Math.pow(2, attempt) * 1000;
      await new Promise(resolve => setTimeout(resolve, delay));
      continue;
    }

    // Don't retry on permanent errors
    return output.result;
  }

  return { status: 'error', error: lastError };
}
```

### Conversational Multi-Turn

Handle multi-turn conversations with state:

```typescript
async function runConversation() {
  let session = {
    history: [],
    state: { profile: { conversationPhase: 'gathering' as const } },
  };

  while (true) {
    const userMessage = await getUserInput();

    const output = await breedAdvisor.execute({
      message: userMessage,
      sessionState: session.state,
    });

    // Show agent's reply
    console.log('Agent:', output.reply);

    // Update session for next turn
    session = {
      history: [
        ...session.history,
        { role: 'user', content: userMessage },
        { role: 'assistant', content: output.reply },
      ],
      state: output.sessionState,
    };

    // Check if conversation is complete
    if (output.result.status === 'success') {
      console.log('Final recommendation:', output.result.data);
      break;
    } else if (output.result.status === 'error') {
      console.error('Conversation failed:', output.result.error);
      break;
    }

    // status === 'in-progress', continue conversation
  }
}
```

### Fan-Out/Fan-In

Execute multiple agents and combine results:

```typescript
async function generateMultipleNames(
  characteristics: CatCharacteristics,
  count: number = 3
) {
  // Generate multiple names in parallel
  const outputs = await Promise.all(
    Array.from({ length: count }, () =>
      nameGenerator.execute({ characteristics })
    )
  );

  // Collect successful results
  const successfulNames = outputs
    .map(output => output.result)
    .filter(result => result.status === 'success')
    .map(result => result.data);

  if (successfulNames.length === 0) {
    return {
      status: 'error' as const,
      error: 'all-generations-failed' as const,
    };
  }

  return {
    status: 'success' as const,
    data: {
      suggestions: successfulNames,
      count: successfulNames.length,
    },
  };
}
```

### Validation Loop

Generator + Validator feedback loop:

```typescript
async function generateValidName(
  characteristics: CatCharacteristics,
  maxAttempts: number = 5
): Promise<AgentResult<string, 'max-attempts-exceeded'>> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    // Generate name
    const nameOutput = await nameGenerator.execute({ characteristics });
    if (nameOutput.result.status === 'error') {
      continue; // Try again
    }

    const { name } = nameOutput.result.data;

    // Validate name
    const validationOutput = await nameValidator.execute({
      name,
      characteristics,
    });

    if (validationOutput.result.status === 'success' &&
        validationOutput.result.data.valid) {
      // Found valid name!
      return { status: 'success', data: name };
    }

    // Invalid, try again with feedback
    console.log('Attempt', attempt + 1, 'invalid:', validationOutput.result.data.reason);
  }

  return { status: 'error', error: 'max-attempts-exceeded' };
}
```

### Human-in-the-Loop

Integrate human approval into workflows:

```typescript
import { humanApprovalAgent } from '@vibe-agent-toolkit/vat-example-cat-agents';

async function generateWithApproval(
  characteristics: CatCharacteristics
) {
  // Generate name
  const nameOutput = await nameGenerator.execute({ characteristics });
  if (nameOutput.result.status === 'error') {
    return nameOutput.result;
  }

  const { name, reasoning } = nameOutput.result.data;

  // Request human approval
  const approvalOutput = await humanApprovalAgent.execute({
    actionType: 'cat-name-generation',
    content: { name, reasoning },
    context: {
      characteristics: {
        physical: characteristics.physical,
        behavioral: characteristics.behavioral,
      },
    },
  });

  if (approvalOutput.result.status === 'error') {
    return { status: 'error' as const, error: 'approval-failed' as const };
  }

  const { approved, feedback } = approvalOutput.result.data;

  if (approved) {
    return { status: 'success' as const, data: name };
  } else {
    return {
      status: 'error' as const,
      error: 'rejected-by-human' as const,
    };
  }
}
```

## Testing Patterns

### Test Helpers

Use test helpers from `@vibe-agent-toolkit/agent-runtime`:

```typescript
import { resultMatchers } from '@vibe-agent-toolkit/agent-runtime';
import { describe, expect, it } from 'vitest';

describe('haikuValidator', () => {
  it('should return success for valid haiku', async () => {
    const output = await haikuValidator.execute({
      text: 'Ancient pond, frog leaps in, splash',
      syllables: [5, 7, 5],
      kigo: 'pond',
      kireji: 'splash',
    });

    // Type-safe assertions
    resultMatchers.expectSuccess(output.result);
    expect(output.result.data.valid).toBe(true);
  });

  it('should return error for invalid syllables', async () => {
    const output = await haikuValidator.execute({
      text: 'Too many syllables here, not a haiku, nope',
      syllables: [7, 7, 5],
      kigo: 'syllables',
      kireji: 'nope',
    });

    resultMatchers.expectError(output.result);
    expect(output.result.error).toBe('invalid-syllables');
  });
});
```

### Mocking External Events

Mock external event integrators in tests:

```typescript
import { vi } from 'vitest';

describe('workflow with approval', () => {
  it('should handle approved case', async () => {
    // Mock approval agent to auto-approve
    const mockApproval = vi.fn().mockResolvedValue({
      result: {
        status: 'success',
        data: { approved: true, feedback: null },
      },
    });

    const result = await generateWithApproval(characteristics, {
      approvalAgent: { execute: mockApproval },
    });

    resultMatchers.expectSuccess(result);
    expect(mockApproval).toHaveBeenCalledOnce();
  });
});
```

## Best Practices

### 1. Always Handle Errors

Never assume success - always check result status:

```typescript
// ❌ BAD - Assumes success
const output = await analyzer.execute(input);
const data = output.result.data; // TypeScript error if result is error!

// ✅ GOOD - Check status first
const output = await analyzer.execute(input);
if (output.result.status === 'success') {
  const data = output.result.data; // Type-safe
  console.log(data);
} else {
  console.error('Failed:', output.result.error);
}
```

### 2. Use Helpers for Composition

Use `andThen()` and `mapResult()` instead of manual checks:

```typescript
// ❌ VERBOSE - Manual checks
const output1 = await agent1.execute(input);
let output2;
if (output1.result.status === 'success') {
  output2 = await agent2.execute(output1.result.data);
} else {
  output2 = { result: output1.result };
}

// ✅ CONCISE - Use andThen
const output1 = await agent1.execute(input);
const output2 = await andThen(output1.result, (data) =>
  agent2.execute(data).then(out => out.result)
);
```

### 3. Leverage Discriminated Unions

TypeScript's discriminated unions provide type safety:

```typescript
function handleResult(result: AgentResult<string, LLMError>) {
  // TypeScript knows which properties are available
  if (result.status === 'success') {
    console.log(result.data);   // ✅ data available
    console.log(result.error);  // ❌ TypeScript error
  } else {
    console.log(result.error);  // ✅ error available
    console.log(result.data);   // ❌ TypeScript error
  }
}
```

### 4. Define Clear Error Types

Use enums or literal unions for errors:

```typescript
// ✅ GOOD - Clear error types
type ValidationError =
  | 'invalid-syllables'
  | 'missing-kigo'
  | 'too-long';

// ❌ BAD - Generic string
type ValidationError = string;
```

### 5. Document Metadata Schemas

For conversational agents, document metadata structure:

```typescript
/**
 * Metadata for breed advisor in-progress state
 */
interface BreedAdvisorMetadata {
  /** Number of factors collected so far */
  factorsCollected: number;
  /** Minimum factors required for recommendations */
  requiredFactors: number;
  /** Current conversation phase */
  conversationPhase: 'gathering' | 'ready-to-recommend' | 'refining';
  /** Current breed recommendations (if in refining phase) */
  recommendations?: Array<{ breed: string; score: number }>;
}
```

## Related Documentation

- [Agent Authoring Guide](./agent-authoring.md) - How to create agents with result envelopes
- [Architecture Overview](./architecture/README.md) - Package structure and design principles

## Examples

See the `@vibe-agent-toolkit/vat-example-cat-agents` package for complete working examples:

- **Pure Function Tool**: `haiku-validator` - Validation with typed errors
- **One-Shot LLM Analyzer**: `photo-analyzer`, `description-parser` - LLM with error handling
- **Conversational Assistant**: `breed-advisor` - Multi-turn with stateful results
- **External Event Integrator**: `human-approval` - Event integration with timeouts

Run demos:
```bash
cd packages/vat-example-cat-agents
bun run demo:photos        # Photo analysis pipeline
bun run demo:conversation  # Interactive breed advisor
```

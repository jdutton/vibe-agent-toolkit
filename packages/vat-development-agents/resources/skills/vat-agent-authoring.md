---
name: vat-agent-authoring
description: Use when authoring TypeScript portable agents — agent archetypes, agent.yaml, result envelopes, orchestration patterns, and runtime adapters (Vercel/LangChain/OpenAI/Claude Agent SDK). Paired with vat-skill-authoring for the SKILL.md side.
---

# VAT Agent Authoring: Archetypes, Envelopes, Orchestration

This skill covers authoring TypeScript portable agents — the runtime side of a VAT agent package. For SKILL.md authoring (frontmatter, body structure, references, packagingOptions, validation overrides) use `vibe-agent-toolkit:vat-skill-authoring`.

## Agent Archetypes

VAT supports four agent archetypes for different use cases.

### Archetype 1: Pure Function Tool

**When to use:** Stateless validation, transformation, computation — no LLM needed.

**Characteristics:** Deterministic output, fast execution, easy to test.

**Example use cases:** Input validation, data transformation, format conversion, rules-based logic.

```typescript
export async function validateInput(input: MyInput): Promise<ValidationResult> {
  if (input.text.length < 5) {
    return { status: 'error', error: 'too-short' };
  }
  return { status: 'success', data: { valid: true } };
}
```

### Archetype 2: One-Shot LLM Analyzer

**When to use:** Single LLM call for analysis, classification, or generation.

**Characteristics:** One LLM call per execution, stateless, handles LLM errors.

**Example use cases:** Sentiment analysis, text classification, entity extraction, creative generation.

```typescript
export async function analyzeSentiment(text: string, context: AgentContext) {
  const response = await context.callLLM([
    { role: 'user', content: `Analyze sentiment: "${text}"` }
  ]);

  const parsed = JSON.parse(response);
  return { status: 'success', data: parsed };
}
```

### Archetype 3: Conversational Assistant

**When to use:** Multi-turn dialogue, progressive data collection across sessions.

**Characteristics:** Multiple LLM calls, maintains session state, phases (gathering → ready → complete).

**Example use cases:** Customer support chatbots, product advisors, interview agents, multi-step forms.

```typescript
export async function conversationalAgent(
  message: string,
  sessionState: SessionState
) {
  if (sessionState.phase === 'gathering') {
    return {
      reply: "Can you tell me more about X?",
      sessionState: { ...sessionState },
      result: { status: 'in-progress' }
    };
  }

  return {
    reply: "Here's your result!",
    sessionState: { ...sessionState, phase: 'complete' },
    result: { status: 'success', data: finalResult }
  };
}
```

### Archetype 4: External Event Integrator

**When to use:** Waiting for external events (approvals, webhooks, third-party APIs).

**Characteristics:** Emits event, blocks waiting for response, timeout handling, mockable for testing.

**Example use cases:** Human-in-the-loop approval, webhook integrations, external API polling.

```typescript
export async function humanApproval(
  request: ApprovalRequest,
  options = { mockable: true, timeout: 30000 }
) {
  if (options.mockable) {
    return { status: 'success', data: { approved: true } };
  }

  const response = await emitEvent(request, options.timeout);
  return { status: 'success', data: response };
}
```

## Result Envelopes

Always return result envelopes — never throw exceptions for expected errors.

```typescript
// AgentResult<TData, TError> — for single-execution agents
type AgentResult<TData, TError> =
  | { status: 'success'; data: TData }
  | { status: 'error'; error: TError };

// StatefulAgentResult — for conversational agents
type StatefulAgentResult<TData, TError, TMetadata> =
  | { status: 'in-progress'; metadata?: TMetadata }
  | { status: 'success'; data: TData }
  | { status: 'error'; error: TError };
```

Standard LLM error literals: `'llm-refusal'`, `'llm-invalid-output'`, `'llm-timeout'`, `'llm-rate-limit'`, `'llm-token-limit'`, `'llm-unavailable'`.

Always check status before accessing data:

```typescript
const output = await myAgent.execute(input);
if (output.result.status === 'success') {
  console.log(output.result.data);
} else if (output.result.status === 'error') {
  console.error('Failed:', output.result.error);
}
```

## Orchestration Patterns

### Sequential Pipeline

```typescript
const analysisOutput = await analyzer.execute(input);
const processedOutput = await andThen(
  analysisOutput.result,
  async (data) => {
    const out = await processor.execute(data);
    return out.result;
  }
);
```

### Parallel Execution

```typescript
const [output1, output2, output3] = await Promise.all([
  agent1.execute(input),
  agent2.execute(input),
  agent3.execute(input),
]);
```

### Validation Loop (Generate + Validate with Retry)

```typescript
async function generateValidOutput(input: MyInput, maxAttempts = 5) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const generatorOutput = await generator.execute(input);
    if (generatorOutput.result.status === 'error') continue;

    const validatorOutput = await validator.execute(generatorOutput.result.data);
    if (validatorOutput.result.status === 'success' &&
        validatorOutput.result.data.valid) {
      return generatorOutput.result.data;
    }
  }
  throw new Error('Max attempts exceeded');
}
```

### Human-in-the-Loop

```typescript
const generatorOutput = await generator.execute(input);
if (generatorOutput.result.status === 'success') {
  const approvalOutput = await humanApproval.execute({
    content: generatorOutput.result.data,
    context: input,
  });
  if (approvalOutput.result.data.approved) {
    return generatorOutput.result.data;
  }
}
```

### Conversational Multi-Turn

```typescript
let session = { state: { phase: 'gathering' }, history: [] };

while (true) {
  const userMessage = await getUserInput();
  const output = await conversationalAgent.execute({
    message: userMessage,
    sessionState: session.state,
  });

  console.log('Agent:', output.reply);
  session = {
    state: output.sessionState,
    history: [...session.history,
      { role: 'user', content: userMessage },
      { role: 'assistant', content: output.reply }
    ],
  };

  if (output.result.status === 'success') break;
  if (output.result.status === 'error') break;
  // status === 'in-progress': continue
}
```

## Testing Agents

### Unit Testing Pure Functions

```typescript
import { describe, expect, it } from 'vitest';
import { resultMatchers } from '@vibe-agent-toolkit/agent-runtime';

describe('myValidator', () => {
  it('should validate correct input', async () => {
    const output = await myValidator.execute({ text: 'valid' });
    resultMatchers.expectSuccess(output.result);
    expect(output.result.data.valid).toBe(true);
  });
});
```

### Integration Testing with Mock LLM

```typescript
import { createMockContext } from '@vibe-agent-toolkit/agent-runtime';

const mockContext = createMockContext(
  JSON.stringify({ sentiment: 'positive', confidence: 0.9 })
);
const output = await myAnalyzer.execute({ text: 'Great!' }, mockContext);
resultMatchers.expectSuccess(output.result);
```

### Testing Conversational Flows

```typescript
// Turn 1
const output1 = await agent.execute({ message: 'Hello' });
expect(output1.reply).toContain('name?');
resultMatchers.expectInProgress(output1.result);

// Turn 2 — pass session state forward
const output2 = await agent.execute({
  message: 'My name is Alice',
  sessionState: output1.sessionState,
});
```

## Best Practices

1. **Return result envelopes, never throw** for expected errors.
2. **Define error types as literal unions** (`'invalid-format' | 'timeout'`), not `string`.
3. **Use Zod schemas** for all input/output validation.
4. **Test all paths** — success, each error type, edge cases.
5. **Use mock mode** for external dependencies to enable offline testing.
6. **Document with JSDoc** — purpose, params, return type, example, `@throws Never throws`.
7. **Keep SKILL.md focused** — if the skill documentation exceeds ~300 lines, split the skill or use progressive disclosure (see `vibe-agent-toolkit:vat-skill-authoring`).

## References

- `vibe-agent-toolkit:vat-skill-authoring` — sibling skill covering SKILL.md frontmatter, body structure, references, packagingOptions, and validation overrides
- `vibe-agent-toolkit:vat-skill-review` — pre-publication quality checklist
- [agent-authoring.md](../../../../docs/agent-authoring.md) — Complete patterns guide
- [orchestration.md](../../../../docs/orchestration.md) — Multi-agent workflows
- [Building Effective Agents — Anthropic](https://www.anthropic.com/research/building-effective-agents)

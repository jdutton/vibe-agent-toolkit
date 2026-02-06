# @vibe-agent-toolkit/test-agents

Simple test agents for validating runtime adapter functionality.

## Purpose

This package provides minimal, focused agents specifically designed for testing runtime adapters. Unlike the rich example agents in `vat-example-cat-agents`, these agents are intentionally simple to:

- Test adapter functionality without domain complexity
- Avoid circular dependencies (this package has no internal dependencies)
- Provide fast, predictable test execution
- Serve as minimal examples of agent patterns

## Agents Included

### Pure Function Agent

**simpleValidatorAgent** - Validates text length

```typescript
import { simpleValidatorAgent, SimpleValidationInputSchema } from '@vibe-agent-toolkit/test-agents';

const result = simpleValidatorAgent({
  text: 'Hello world',
  minLength: 5,
  maxLength: 20,
});
// { valid: true, reason: 'Text length is valid' }
```

### LLM Analyzer Agent

**simpleNameGeneratorAgent** - Generates creative names

```typescript
import { simpleNameGeneratorAgent } from '@vibe-agent-toolkit/test-agents';

// Use with your runtime adapter
const result = await runtimeAdapter.executeLLMAgent(
  simpleNameGeneratorAgent,
  { adjective: 'Swift', noun: 'River' }
);
// { name: 'Rivermist', reasoning: 'Evokes flowing water with speed' }
```

## Usage in Tests

```typescript
import { simpleValidatorAgent, simpleNameGeneratorAgent } from '@vibe-agent-toolkit/test-agents';
import { convertPureFunctionToTool } from '@vibe-agent-toolkit/runtime-vercel-ai-sdk';

describe('Runtime Adapter', () => {
  it('converts pure functions correctly', () => {
    const tool = convertPureFunctionToTool(simpleValidatorAgent);
    // Test tool functionality
  });

  it('converts LLM analyzers correctly', async () => {
    const executor = convertLLMAnalyzerToFunction(simpleNameGeneratorAgent);
    const result = await executor({ adjective: 'Golden', noun: 'Mountain' });
    expect(result.name).toBeDefined();
  });
});
```

## Why Separate from Examples?

| Feature | test-agents | vat-example-cat-agents |
|---------|-------------|------------------------|
| Purpose | Test adapters | Demonstrate VAT patterns |
| Complexity | Minimal | Rich/realistic |
| Dependencies | None | Runtime packages (for demos) |
| Domain | Generic | Cat breeding |
| Use Case | Testing | Learning & examples |

## License

MIT

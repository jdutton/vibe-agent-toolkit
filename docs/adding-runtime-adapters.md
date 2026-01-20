# Adding Runtime Adapters

This guide documents best practices for adding new runtime adapters to the Vibe Agent Toolkit.

## Overview

A runtime adapter converts VAT agents into runtime-specific formats (tools, functions, etc.) for use with specific LLM frameworks (Vercel AI SDK, LangChain, OpenAI SDK, Claude Agent SDK, etc.).

## Quick Start Checklist

- [ ] Create package structure in `packages/runtime-{name}/`
- [ ] Use shared test factories (zero code duplication)
- [ ] Use shared demo infrastructure (common-demo.ts)
- [ ] Add TypeScript project reference
- [ ] Implement both pure function and LLM analyzer adapters
- [ ] Write comprehensive tests with test helpers
- [ ] Create demo showcasing both providers (if applicable)
- [ ] Update root tsconfig.json

## Package Structure

```
packages/runtime-{name}/
├── src/
│   ├── adapters/
│   │   ├── common-helpers.ts    # Shared utilities across adapters
│   │   ├── pure-function.ts     # Pure function agent adapter
│   │   └── llm-analyzer.ts      # LLM analyzer agent adapter
│   ├── types.ts                 # TypeScript type definitions
│   └── index.ts                 # Public API exports
├── test/
│   ├── pure-function.test.ts    # Pure function adapter tests
│   ├── llm-analyzer.test.ts     # LLM analyzer adapter tests
│   └── test-helpers.ts          # Test utilities (extract when 2-3+ tests)
├── examples/
│   └── demo.ts                  # Demo using common-demo infrastructure
├── package.json
├── tsconfig.json
└── README.md
```

## 1. Package Configuration

### package.json

```json
{
  "name": "@vibe-agent-toolkit/runtime-{name}",
  "version": "0.1.1",
  "description": "{Runtime Name} runtime adapter for VAT agents",
  "type": "module",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    }
  },
  "files": ["dist"],
  "scripts": {
    "build": "tsc",
    "demo": "tsx examples/demo.ts",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@vibe-agent-toolkit/agent-runtime": "workspace:*",
    "zod": "^3.24.1",
    "{runtime-sdk}": "^x.y.z"
  },
  "devDependencies": {
    "@types/node": "^22.10.5",
    "@vibe-agent-toolkit/dev-tools": "workspace:*",
    "@vibe-agent-toolkit/vat-example-cat-agents": "workspace:*",
    "tsx": "^4.19.2",
    "typescript": "^5.7.3",
    "vitest": "^2.1.8"
  }
}
```

**Key points:**
- Use `workspace:*` for all internal dependencies
- Add runtime SDK as dependency
- Include dev-tools for test factories
- Include vat-example-cat-agents for testing

### tsconfig.json

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "composite": true,
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src/**/*"],
  "references": [
    { "path": "../agent-runtime" },
    { "path": "../utils" }
  ]
}
```

**Key points:**
- Always set `composite: true` for monorepo builds
- Add references for packages you depend on
- Use `../../tsconfig.base.json` for consistency

### Root tsconfig.json

Add your package to the root tsconfig.json references:

```json
{
  "references": [
    // ... existing packages
    { "path": "./packages/runtime-{name}" }
  ]
}
```

## 2. Adapter Implementation

### Common Pattern

Both pure function and LLM analyzer adapters follow similar patterns:

```typescript
// src/adapters/pure-function.ts
import type { PureFunctionAgent } from '@vibe-agent-toolkit/agent-runtime';
import type { z } from 'zod';

export function convertPureFunctionToTool<TInput, TOutput>(
  agent: PureFunctionAgent<TInput, TOutput>,
  inputSchema: z.ZodType<TInput>,
  outputSchema: z.ZodType<TOutput>,
) {
  // 1. Extract agent manifest
  const { manifest } = agent;

  // 2. Create runtime-specific tool/function
  const tool = createRuntimeTool(
    manifest.name,
    manifest.description,
    inputSchema,
    async (input: TInput) => {
      // 3. Validate input
      const validatedInput = inputSchema.parse(input);

      // 4. Execute agent
      const result = await agent.execute(validatedInput);

      // 5. Validate output
      const validatedOutput = outputSchema.parse(result);

      // 6. Return in runtime-specific format
      return formatOutput(validatedOutput);
    }
  );

  // 7. Return tool with metadata
  return {
    tool,
    metadata: {
      name: manifest.name,
      description: manifest.description,
      version: manifest.version,
      archetype: 'pure-function',
    },
  };
}
```

### LLM Analyzer Adapter Pattern

```typescript
// src/adapters/llm-analyzer.ts
export function convertLLMAnalyzerToTool<TInput, TOutput>(
  agent: Agent<TInput, TOutput>,
  inputSchema: z.ZodType<TInput>,
  outputSchema: z.ZodType<TOutput>,
  llmConfig: RuntimeLLMConfig,
) {
  // 1. Create LLM client
  const client = createLLMClient(llmConfig);

  // 2. Create callLLM function
  const callLLM = async (prompt: string): Promise<string> => {
    const response = await client.generate({ prompt, ...llmConfig });
    return response.text;
  };

  // 3. Create tool that provides context
  const tool = createRuntimeTool(
    agent.manifest.name,
    agent.manifest.description,
    inputSchema,
    async (input: TInput) => {
      const context = {
        mockable: false,
        model: llmConfig.model,
        temperature: llmConfig.temperature,
        callLLM,
      };

      const result = await agent.execute(input, context);
      return outputSchema.parse(result);
    }
  );

  return { tool, metadata: { ... } };
}
```

### Common Helpers

Extract shared logic to `common-helpers.ts`:

```typescript
// src/adapters/common-helpers.ts

/**
 * Creates metadata object for single agent conversion
 */
export function createSingleToolMetadata(
  manifest: { name: string; description: string; version: string },
  archetype: string,
) {
  return {
    name: manifest.name,
    description: manifest.description,
    version: manifest.version,
    archetype,
    toolName: `${manifest.name}`,
  };
}

/**
 * Creates metadata object for batch conversion
 */
export function createBatchToolMetadata(
  key: string,
  manifest: { name: string; description: string; version: string },
  archetype: string,
) {
  return {
    name: manifest.name,
    description: manifest.description,
    version: manifest.version,
    archetype,
    toolName: key,
  };
}
```

## 3. Testing with Shared Factories

**CRITICAL: Use shared test factories from dev-tools to maintain zero code duplication.**

### Pure Function Tests

```typescript
// test/pure-function.test.ts
import { createPureFunctionTestSuite } from '@vibe-agent-toolkit/dev-tools';
import { HaikuSchema, HaikuValidationResultSchema, haikuValidatorAgent } from '@vibe-agent-toolkit/vat-example-cat-agents';

import { convertPureFunctionToTool, convertPureFunctionsToTools } from '../src/adapters/pure-function.js';

// Generate complete test suite using factory
createPureFunctionTestSuite({
  runtimeName: 'Your Runtime Name',
  convertPureFunctionToTool,
  convertPureFunctionsToTools: (configs) => {
    // Convert and return tools/functions
    const result = convertPureFunctionsToTools(configs);
    return extractExecutableFunctions(result);
  },
  agent: haikuValidatorAgent,
  inputSchema: HaikuSchema,
  outputSchema: HaikuValidationResultSchema,
  getToolFromResult: (result) => result.tool,
  executeFunction: async (result, input) => {
    // Execute the tool/function
    return await result.tool.execute(input);
  },
  parseOutput: (output) => output,
  assertToolStructure: (result) => {
    expect(result.tool).toBeDefined();
    expect(result.metadata.name).toBe('haiku-validator');
  },
});
```

### LLM Analyzer Tests

```typescript
// test/llm-analyzer.test.ts
import { createLLMAnalyzerTestSuite } from '@vibe-agent-toolkit/dev-tools';
import { nameGeneratorAgent, NameGeneratorInputSchema, NameSuggestionSchema } from '@vibe-agent-toolkit/vat-example-cat-agents';

import { convertLLMAnalyzerToTool, convertLLMAnalyzersToTools } from '../src/adapters/llm-analyzer.js';

createLLMAnalyzerTestSuite({
  runtimeName: 'Your Runtime Name',
  convertLLMAnalyzerToFunction: (agent, inputSchema, outputSchema, llmConfig) => {
    const { tool } = convertLLMAnalyzerToTool(agent, inputSchema, outputSchema, llmConfig);
    return (input) => tool.execute(input);
  },
  convertLLMAnalyzersToFunctions: (configs, llmConfig) => {
    const { tools } = convertLLMAnalyzersToTools(configs, llmConfig);
    return convertToolsToFunctions(tools);
  },
  agent: nameGeneratorAgent,
  inputSchema: NameGeneratorInputSchema,
  outputSchema: NameSuggestionSchema,
  llmConfig: {
    apiKey: 'test-key',
    model: 'test-model',
  },
});
```

### Test Helpers (Extract Early!)

**Rule: Extract test helpers after 2-3 similar tests to avoid duplication.**

```typescript
// test/test-helpers.ts

/**
 * Executes a runtime tool and returns the result
 */
export async function executeToolHandler(
  handler: (input: unknown) => Promise<unknown>,
  input: unknown,
): Promise<unknown> {
  const response = await handler(input);
  return parseToolResponse(response);
}

/**
 * Creates an executor function for a single tool
 */
export function createToolExecutor(
  tool: RuntimeTool,
): (input: unknown) => Promise<unknown> {
  return async (input: unknown) => {
    return await executeToolHandler(tool.handler, input);
  };
}

/**
 * Creates executor functions for multiple tools
 */
export function createBatchToolExecutors(
  tools: Record<string, RuntimeTool>,
): Record<string, (input: unknown) => Promise<unknown>> {
  const executors: Record<string, (input: unknown) => Promise<unknown>> = {};

  for (const [key, tool] of Object.entries(tools)) {
    executors[key] = createToolExecutor(tool);
  }

  return executors;
}
```

## 4. Demo with Common Infrastructure

**CRITICAL: Use shared common-demo infrastructure to avoid duplicating demo code.**

```typescript
// examples/demo.ts
import { convertLLMAnalyzerToTool } from '../src/adapters/llm-analyzer.js';
import { convertPureFunctionToTool, convertPureFunctionsToTools } from '../src/adapters/pure-function.js';

import type { RuntimeAdapter } from '../../runtime-vercel-ai-sdk/examples/common-demo.js';
import { runCommonDemo } from '../../runtime-vercel-ai-sdk/examples/common-demo.js';

/**
 * Your Runtime Adapter implementation
 */
const yourRuntimeAdapter: RuntimeAdapter = {
  name: 'Your Runtime Name',

  convertPureFunctionToTool: convertPureFunctionToTool as unknown as RuntimeAdapter['convertPureFunctionToTool'],

  convertPureFunctionsToTools: convertPureFunctionsToTools as unknown as RuntimeAdapter['convertPureFunctionsToTools'],

  convertLLMAnalyzerToFunction: (agent, inputSchema, outputSchema, llmConfig) => {
    const { tool } = convertLLMAnalyzerToTool(agent, inputSchema, outputSchema, llmConfig);
    return (input) => tool.execute(input);
  },

  createPrimaryLLMConfig: () => ({
    provider: 'primary-provider',
    apiKey: process.env['PRIMARY_API_KEY'],
    model: 'primary-model',
    temperature: 0.9,
  }),

  // Optional: Add secondary provider for comparison
  createSecondaryLLMConfig: () => ({
    provider: 'secondary-provider',
    apiKey: process.env['SECONDARY_API_KEY'],
    model: 'secondary-model',
    temperature: 0.9,
  }),

  // Optional: Add tool calling demo if your runtime supports it
  demoToolCalling: async (tool, prompt) => {
    const result = await yourRuntime.callWithTools({
      tools: [tool],
      prompt,
    });
    return {
      text: result.text,
      toolCalls: result.toolCalls,
      toolResults: result.toolResults,
    };
  },
};

// Run the common demo with your runtime adapter
runCommonDemo(yourRuntimeAdapter).catch(console.error);
```

**Demo benefits:**
- ✅ No duplicated demo code across runtimes
- ✅ Consistent demo experience
- ✅ Automatic multi-provider support
- ✅ Tool calling demo (if supported)
- ✅ Formatted output with colors

## 5. Best Practices

### Zero Code Duplication

**CRITICAL: Maintain zero code duplication across all tests.**

**When to extract helpers:**
1. After writing 2-3 similar test blocks
2. When you copy-paste test setup code
3. When you see similar assertion patterns

**Example - Before extraction:**
```typescript
// ❌ BAD: Duplicated across 3 test files
describe('Pure Function Tests', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'test-'));
    // ... 8 more lines of setup
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
    // ... cleanup logic
  });
});
```

**Example - After extraction:**
```typescript
// ✅ GOOD: Shared helper
const suite = setupTestSuite('my-test-');

describe('Pure Function Tests', () => {
  beforeEach(suite.beforeEach);
  afterEach(suite.afterEach);

  it('should work', () => {
    // Use suite.tempDir, suite.registry, etc.
  });
});
```

### TypeScript Best Practices

1. **Always use `composite: true`** in tsconfig.json
2. **Always add project references** for dependencies
3. **Use `workspace:*`** for internal dependencies in package.json
4. **Export types** from `types.ts`, not inline
5. **Use Zod schemas** for runtime validation

### Testing Best Practices

1. **Use shared test factories** from dev-tools
2. **Extract helpers early** (2-3 rule)
3. **Test both single and batch conversions**
4. **Test with real agent examples** from vat-example-cat-agents
5. **Run `bun run duplication-check`** before committing

### Adapter Design Principles

1. **Keep it synchronous if possible** - async adapters complicate testing
2. **Validate inputs and outputs** - use Zod schemas
3. **Extract common logic** to common-helpers.ts
4. **Support batch conversion** - multiple agents in one call
5. **Return structured metadata** - name, version, archetype, etc.

## 6. Validation Checklist

Before committing your new runtime adapter:

```bash
# Build
bun run build

# Type check
bun run typecheck

# Lint (must pass with zero warnings)
bun run lint

# Test
bun run test:unit

# Check for duplication (MUST be zero!)
bun run duplication-check

# Run demo
cd packages/runtime-{name}
bun run demo

# Full validation
vv validate
```

**CRITICAL: `duplication-check` must pass with 0 clones before committing.**

## 7. Common Pitfalls

### ❌ Don't: Duplicate demo code
```typescript
// BAD: Don't create custom demo from scratch
console.log('Testing pure functions...');
const result = await agent.execute(input);
console.log(`Result: ${JSON.stringify(result)}`);
```

### ✅ Do: Use common demo infrastructure
```typescript
// GOOD: Use RuntimeAdapter interface
const adapter: RuntimeAdapter = {
  name: 'Your Runtime',
  // ... implement interface
};

runCommonDemo(adapter);
```

### ❌ Don't: Duplicate test setup
```typescript
// BAD: Repeated in multiple test files
beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'test-'));
  // ... more setup
});
```

### ✅ Do: Extract to test helper
```typescript
// GOOD: Shared setup function
const suite = setupTestSuite('my-test-');
beforeEach(suite.beforeEach);
afterEach(suite.afterEach);
```

### ❌ Don't: Create async adapters unless necessary
```typescript
// BAD: Unnecessary async
export async function convertPureFunctionToTool(...) {
  // Makes testing harder, breaks interface compatibility
}
```

### ✅ Do: Keep adapters synchronous when possible
```typescript
// GOOD: Synchronous adapter
export function convertPureFunctionToTool(...) {
  // Simpler testing, better compatibility
}
```

## 8. Examples to Reference

**Best Practice Implementations:**

1. **Claude Agent SDK** (`packages/runtime-claude-agent-sdk/`)
   - Clean synchronous adapter (Anthropic-only)
   - Multi-provider demo (Anthropic + OpenAI wrapper)
   - Zero test duplication with helpers
   - Uses shared test factories

2. **Vercel AI SDK** (`packages/runtime-vercel-ai-sdk/`)
   - Multi-provider support (OpenAI + Anthropic)
   - Tool calling demo
   - Common demo infrastructure
   - Shared test factories

3. **LangChain** (`packages/runtime-langchain/`)
   - LangChain tool format
   - Uses common demo
   - Shared test factories

## 9. Getting Help

- Review existing runtime packages for patterns
- Check dev-tools test factories for test infrastructure
- See common-demo.ts for demo infrastructure
- Run `bun run duplication-check` frequently
- Ask questions early rather than duplicating code

## Summary

**Key Takeaways:**
1. ✅ Use shared test factories from dev-tools (zero duplication)
2. ✅ Use common-demo infrastructure for demos
3. ✅ Extract test helpers after 2-3 similar tests
4. ✅ Keep adapters synchronous when possible
5. ✅ Always run duplication-check (must be 0 clones)
6. ✅ Use `workspace:*` for internal dependencies
7. ✅ Add project references to tsconfig.json
8. ✅ Support both single and batch conversion

**This guide will evolve as we learn more. PRs welcome!**

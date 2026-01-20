# @vibe-agent-toolkit/runtime-openai

OpenAI SDK runtime adapter for VAT (Vibe Agent Toolkit) agents.

Converts VAT archetype agents to OpenAI SDK primitives (function calling, chat completions), enabling direct API access without framework overhead while maintaining type safety and agent semantics.

## Installation

```bash
npm install @vibe-agent-toolkit/runtime-openai openai
# or
bun add @vibe-agent-toolkit/runtime-openai openai
```

## Supported Archetypes

### Pure Function Tools → Function Calling

Converts synchronous, deterministic VAT agents to OpenAI function calling tools.

**Use cases:** Validation, transformation, computation, structured data operations.

#### Example: Haiku Validator

```typescript
import OpenAI from 'openai';
import { haikuValidatorAgent, HaikuSchema, HaikuValidationResultSchema } from '@vibe-agent-toolkit/vat-example-cat-agents';
import { convertPureFunctionToTool } from '@vibe-agent-toolkit/runtime-openai';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Convert VAT agent to OpenAI tool
const { tool, execute } = convertPureFunctionToTool(
  haikuValidatorAgent,
  HaikuSchema,
  HaikuValidationResultSchema
);

// Use with OpenAI function calling
const response = await openai.chat.completions.create({
  model: 'gpt-4o-mini',
  messages: [
    { role: 'user', content: 'Write a haiku about an orange cat and validate it' }
  ],
  tools: [tool],
});

// Execute tool calls
for (const toolCall of response.choices[0].message.tool_calls ?? []) {
  if (toolCall.function.name === tool.function.name) {
    const args = JSON.parse(toolCall.function.arguments);
    const result = await execute(args);
    console.log(result); // { valid: true, syllables: { line1: 5, line2: 7, line3: 5 } }
  }
}
```

### LLM Analyzer → Chat Completions

Converts LLM-powered VAT agents to executable async functions using OpenAI chat completions API.

**Use cases:** Content generation, analysis, transformation, structured output from LLMs.

#### Example: Name Generator

```typescript
import OpenAI from 'openai';
import { nameGeneratorAgent, NameGeneratorInputSchema, NameSuggestionSchema } from '@vibe-agent-toolkit/vat-example-cat-agents';
import { convertLLMAnalyzerToFunction } from '@vibe-agent-toolkit/runtime-openai';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Convert VAT agent to executable function
const generateName = convertLLMAnalyzerToFunction(
  nameGeneratorAgent,
  NameGeneratorInputSchema,
  NameSuggestionSchema,
  {
    client: openai,
    model: 'gpt-4o-mini',
    temperature: 0.9,
  }
);

// Execute directly
const result = await generateName({
  characteristics: {
    physical: { furColor: 'Orange' },
    behavioral: { personality: ['Distinguished'] },
    description: 'A noble orange cat',
  },
});

console.log(result.name);      // "Sir Whiskersworth III"
console.log(result.reasoning); // "This name captures..."
```

## Why Direct OpenAI SDK?

Unlike framework-based adapters (Vercel AI SDK, LangChain), this adapter provides:

- **Zero framework overhead** - Direct API access, minimal abstraction
- **Lightweight** - Only OpenAI SDK dependency
- **Full API control** - Access to all OpenAI-specific features
- **Simpler debugging** - Fewer layers between your code and the API

Perfect for:
- Production applications requiring minimal dependencies
- Users already familiar with OpenAI SDK
- Projects needing fine-grained control over API calls
- Serverless/edge environments with size constraints

## API Reference

### `convertPureFunctionToTool()`

Converts a VAT Pure Function agent to an OpenAI function calling tool definition.

**Parameters:**
- `agent: PureFunctionAgent<TInput, TOutput>` - The VAT agent to convert
- `inputSchema: z.ZodType<TInput>` - Zod schema for input validation
- `outputSchema: z.ZodType<TOutput>` - Zod schema for output validation

**Returns:** Object with:
- `tool: OpenAI.Chat.ChatCompletionTool` - OpenAI tool definition
- `execute: (args: TInput) => Promise<TOutput>` - Function to execute tool calls
- `metadata: { name, description, version, archetype }` - Agent metadata
- `inputSchema: z.ZodType<TInput>` - Original input schema
- `outputSchema: z.ZodType<TOutput>` - Original output schema

### `convertPureFunctionsToTools()`

Batch converts multiple pure function agents to OpenAI tools.

**Parameters:**
- `configs: Record<string, ToolConversionConfig>` - Map of tool names to conversion configs

**Returns:** `Record<string, { tool, execute, metadata }>` - Map of converted tools

### `convertLLMAnalyzerToFunction()`

Converts a VAT LLM Analyzer agent to an executable async function.

**Parameters:**
- `agent: Agent<TInput, TOutput>` - The VAT agent to convert
- `inputSchema: z.ZodType<TInput>` - Zod schema for input validation
- `outputSchema: z.ZodType<TOutput>` - Zod schema for output validation
- `openaiConfig: OpenAIConfig` - OpenAI configuration

**Returns:** `(input: TInput) => Promise<TOutput>` - Executable async function

### `convertLLMAnalyzersToFunctions()`

Batch converts multiple LLM Analyzer agents with shared OpenAI config.

**Parameters:**
- `configs: Record<string, LLMAnalyzerConversionConfig>` - Map of function names to conversion configs
- `openaiConfig: OpenAIConfig` - Shared OpenAI configuration

**Returns:** `Record<string, (input: any) => Promise<any>>` - Map of executable functions

## Type Definitions

### `OpenAIConfig`

```typescript
interface OpenAIConfig {
  client: OpenAI;                 // OpenAI client instance
  model: string;                  // Model to use (e.g., 'gpt-4o-mini')
  temperature?: number;           // 0-2, default 0.7
  maxTokens?: number;             // Maximum tokens to generate
  additionalSettings?: Omit<...>; // Other chat completion params
}
```

## Examples

See [@vibe-agent-toolkit/vat-example-cat-agents](../vat-example-cat-agents) for complete agent examples that work with this adapter.

## Comparison with Other Adapters

| Feature | runtime-openai | runtime-vercel-ai-sdk | runtime-langchain |
|---------|----------------|----------------------|-------------------|
| **Dependencies** | 1 (openai) | 2 (ai, @ai-sdk/*) | 2 (langchain, @langchain/core) |
| **Bundle Size** | Smallest | Medium | Largest |
| **API Control** | Full | High | High |
| **Learning Curve** | Low (if you know OpenAI SDK) | Medium | High |
| **Best For** | Direct API access, minimal deps | Multi-provider, streaming | Agent frameworks, RAG |

## License

MIT

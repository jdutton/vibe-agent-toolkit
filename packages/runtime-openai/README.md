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

### Conversational Assistant → Multi-Turn Chat

Converts conversational assistant agents to stateful chat functions with conversation history management.

**Use cases:** Interactive assistants, multi-turn dialogues, context-aware conversations, customer support bots.

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

#### Example: Breed Advisor (Multi-Turn)

```typescript
import OpenAI from 'openai';
import { breedAdvisorAgent, BreedAdvisorInputSchema, BreedAdvisorOutputSchema } from '@vibe-agent-toolkit/vat-example-cat-agents';
import { convertConversationalAssistantToFunction, type ConversationalSessionState } from '@vibe-agent-toolkit/runtime-openai';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Convert VAT agent to executable function
const chat = convertConversationalAssistantToFunction(
  breedAdvisorAgent,
  BreedAdvisorInputSchema,
  BreedAdvisorOutputSchema,
  {
    client: openai,
    model: 'gpt-4o',
    temperature: 0.8,
  }
);

// Initialize session state (persists across turns)
const session: ConversationalSessionState = { history: [] };
let profile = { conversationPhase: 'gathering' };

// Turn 1
const result1 = await chat(
  { message: 'I need help finding a cat breed', sessionState: { profile } },
  session
);
console.log(result1.reply); // "I'd love to help! ..."
profile = result1.updatedProfile;

// Turn 2 (uses accumulated history)
const result2 = await chat(
  { message: 'I live in an apartment and love classical music', sessionState: { profile } },
  session
);
console.log(result2.reply); // "Classical music! That's wonderful..."
profile = result2.updatedProfile;

// Turn 3 (recommendations appear when ready)
const result3 = await chat(
  { message: "I prefer calm cats and don't mind grooming", sessionState: { profile } },
  session
);
console.log(result3.recommendations); // [{ breed: 'Persian', matchScore: 95, ... }]
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

### `convertConversationalAssistantToFunction()`

Converts a VAT Conversational Assistant agent to an executable async function with session state management.

**Parameters:**
- `agent: Agent<TInput, TOutput>` - The VAT conversational assistant agent to convert
- `inputSchema: z.ZodType<TInput>` - Zod schema for input validation
- `outputSchema: z.ZodType<TOutput>` - Zod schema for output validation
- `openaiConfig: OpenAIConfig` - OpenAI configuration
- `systemPrompt?: string` - Optional system prompt (overrides agent's system prompt)

**Returns:** `(input: TInput, session: ConversationalSessionState) => Promise<TOutput>` - Executable async function with session state

**Session State:**
```typescript
interface ConversationalSessionState {
  history: Message[];              // Conversation history
  state?: Record<string, unknown>; // Custom state data
}
```

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

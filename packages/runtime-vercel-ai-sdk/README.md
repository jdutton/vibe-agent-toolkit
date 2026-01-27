# @vibe-agent-toolkit/runtime-vercel-ai-sdk

Vercel AI SDK runtime adapter for VAT (Vibe Agent Toolkit) agents.

Converts VAT archetype agents to Vercel AI SDK primitives, enabling portability across LLM providers (OpenAI, Anthropic, etc.) while maintaining type safety and agent semantics.

## Installation

```bash
npm install @vibe-agent-toolkit/runtime-vercel-ai-sdk ai
# or
bun add @vibe-agent-toolkit/runtime-vercel-ai-sdk ai
```

You'll also need an LLM provider package:
```bash
npm install @ai-sdk/openai    # For OpenAI
npm install @ai-sdk/anthropic # For Anthropic Claude
```

## Supported Archetypes

### Pure Function Tools → `tool()`

Converts synchronous, deterministic VAT agents to Vercel AI SDK tools that can be called by LLMs.

**Use cases:** Validation, transformation, computation, structured data operations.

**Archetypes:** Pure Function Tool (Archetype 1)

#### Example: Haiku Validator

```typescript
import { openai } from '@ai-sdk/openai';
import { generateText } from 'ai';
import { haikuValidatorAgent } from '@vibe-agent-toolkit/vat-example-cat-agents';
import { HaikuSchema, HaikuValidationResultSchema } from '@vibe-agent-toolkit/vat-example-cat-agents';
import { convertPureFunctionToTool } from '@vibe-agent-toolkit/runtime-vercel-ai-sdk';

// Convert VAT agent to Vercel AI tool
const haikuTool = convertPureFunctionToTool(
  haikuValidatorAgent,
  HaikuSchema,
  HaikuValidationResultSchema
);

// Use with generateText()
const result = await generateText({
  model: openai('gpt-4'),
  tools: {
    validateHaiku: haikuTool.tool
  },
  prompt: `
    Write a haiku about an orange cat and validate it using the validateHaiku tool.
  `
});

console.log(result.text);
console.log(result.toolCalls); // Shows validation results
```

#### Batch Conversion

```typescript
import { convertPureFunctionsToTools } from '@vibe-agent-toolkit/runtime-vercel-ai-sdk';
import { haikuValidatorAgent, nameValidatorAgent } from '@vibe-agent-toolkit/vat-example-cat-agents';
import { HaikuSchema, HaikuValidationResultSchema, NameValidationInputSchema, NameValidationResultSchema } from '@vibe-agent-toolkit/vat-example-cat-agents';

const tools = convertPureFunctionsToTools({
  validateHaiku: {
    agent: haikuValidatorAgent,
    inputSchema: HaikuSchema,
    outputSchema: HaikuValidationResultSchema,
  },
  validateName: {
    agent: nameValidatorAgent,
    inputSchema: NameValidationInputSchema,
    outputSchema: NameValidationResultSchema,
  },
});

const result = await generateText({
  model: openai('gpt-4'),
  tools,
  prompt: 'Generate and validate cat names and haikus...'
});
```

### Conversational Assistants → `streamText()` with History

Converts multi-turn conversational agents to executable functions that maintain conversation history.

**Use cases:** Interactive dialogs, multi-turn decision-making, stateful conversations, progressive information gathering.

**Archetypes:** Conversational Assistant (Archetype 3)

#### Example: Breed Advisor

```typescript
import { openai } from '@ai-sdk/openai';
import { breedAdvisorAgent } from '@vibe-agent-toolkit/vat-example-cat-agents';
import { BreedAdvisorInputSchema, BreedAdvisorOutputSchema } from '@vibe-agent-toolkit/vat-example-cat-agents';
import { convertConversationalAssistantToFunction, type ConversationSession } from '@vibe-agent-toolkit/runtime-vercel-ai-sdk';

// Convert VAT agent to executable function
const breedAdvisor = convertConversationalAssistantToFunction(
  breedAdvisorAgent,
  BreedAdvisorInputSchema,
  BreedAdvisorOutputSchema,
  {
    model: openai('gpt-4'),
    temperature: 0.8,
  }
);

// Initialize conversation session
const session: ConversationSession = { history: [] };

// Turn 1: Initial inquiry
const turn1 = await breedAdvisor(
  { message: "I'm looking for a cat", sessionState: {} },
  session
);
console.log(turn1.reply); // "Great! What's your living situation?"

// Turn 2: Continue conversation (history is maintained)
const turn2 = await breedAdvisor(
  { message: "Small apartment, love jazz music", sessionState: turn1.sessionState },
  session
);
console.log(turn2.recommendations); // Breed recommendations based on profile
```

#### Batch Conversion with Independent Sessions

```typescript
import { convertConversationalAssistantsToFunctions } from '@vibe-agent-toolkit/runtime-vercel-ai-sdk';
import { breedAdvisorAgent, petCareAdvisorAgent } from '@vibe-agent-toolkit/vat-example-cat-agents';

const assistants = convertConversationalAssistantsToFunctions(
  {
    breedAdvisor: {
      agent: breedAdvisorAgent,
      inputSchema: BreedAdvisorInputSchema,
      outputSchema: BreedAdvisorOutputSchema,
    },
    petCareAdvisor: {
      agent: petCareAdvisorAgent,
      inputSchema: PetCareInputSchema,
      outputSchema: PetCareOutputSchema,
    },
  },
  {
    model: openai('gpt-4'),
    temperature: 0.8,
  }
);

// Each assistant maintains its own independent session
const breedSession: ConversationSession = { history: [] };
const careSession: ConversationSession = { history: [] };

const breedResponse = await assistants.breedAdvisor({ message: "I want a cat" }, breedSession);
const careResponse = await assistants.petCareAdvisor({ message: "Feeding schedule?" }, careSession);
```

### LLM Analyzers → `generateText()`

Converts single-shot LLM analysis agents to executable functions powered by Vercel AI SDK.

**Use cases:** Classification, extraction, generation, summarization, sentiment analysis.

**Archetypes:** One-Shot LLM Analyzer (Archetype 2)

#### Example: Cat Name Generator

```typescript
import { openai } from '@ai-sdk/openai';
import { nameGeneratorAgent } from '@vibe-agent-toolkit/vat-example-cat-agents';
import { NameGeneratorInputSchema, NameSuggestionSchema } from '@vibe-agent-toolkit/vat-example-cat-agents';
import { convertLLMAnalyzerToFunction } from '@vibe-agent-toolkit/runtime-vercel-ai-sdk';

// Convert VAT agent to executable function
const generateName = convertLLMAnalyzerToFunction(
  nameGeneratorAgent,
  NameGeneratorInputSchema,
  NameSuggestionSchema,
  {
    model: openai('gpt-4'),
    temperature: 0.9, // High creativity for name generation
  }
);

// Use the function directly
const result = await generateName({
  characteristics: {
    physical: {
      furColor: 'Orange',
      size: 'medium',
    },
    behavioral: {
      personality: ['Mischievous', 'Energetic'],
      quirks: ['Knocks things off tables'],
    },
    description: 'A mischievous orange cat who loves causing trouble',
  },
});

console.log(result.name);        // "Sir Knocksalot"
console.log(result.reasoning);   // "Given the cat's tendency to knock..."
console.log(result.alternatives); // ["Lord Tumbleton", "Duke Paws"]
```

#### Batch Conversion with Shared Config

```typescript
import { convertLLMAnalyzersToFunctions } from '@vibe-agent-toolkit/runtime-vercel-ai-sdk';
import { nameGeneratorAgent, haikuGeneratorAgent } from '@vibe-agent-toolkit/vat-example-cat-agents';

const analyzers = convertLLMAnalyzersToFunctions(
  {
    generateName: {
      agent: nameGeneratorAgent,
      inputSchema: NameGeneratorInputSchema,
      outputSchema: NameSuggestionSchema,
    },
    generateHaiku: {
      agent: haikuGeneratorAgent,
      inputSchema: HaikuGeneratorInputSchema,
      outputSchema: HaikuSchema,
    },
  },
  {
    model: openai('gpt-4'),
    temperature: 0.8, // Shared config for all analyzers
  }
);

// Use the functions
const name = await analyzers.generateName({ characteristics });
const haiku = await analyzers.generateHaiku({ characteristics });
```

## Provider Support

Works with any Vercel AI SDK provider:

```typescript
import { openai } from '@ai-sdk/openai';
import { anthropic } from '@ai-sdk/anthropic';
import { google } from '@ai-sdk/google';

// OpenAI
const llmConfig = { model: openai('gpt-4'), temperature: 0.7 };

// Anthropic Claude
const llmConfig = { model: anthropic('claude-3-5-sonnet-20241022'), temperature: 0.8 };

// Google Gemini
const llmConfig = { model: google('gemini-2.0-flash-001'), temperature: 0.9 };
```

## Mock Mode vs. Real LLM

VAT agents support mock mode for testing. When using this adapter, agents always run in real LLM mode:

```typescript
// In VAT agent definition (supports both modes)
export const nameGeneratorAgent = defineLLMAnalyzer(
  { name: 'name-generator', ... },
  async (input, ctx) => {
    if (ctx.mockable) {
      // Fast mock for testing
      return mockGenerateName(input);
    }
    // Real LLM call
    const response = await ctx.callLLM(prompt);
    return JSON.parse(response);
  }
);

// With Vercel AI SDK adapter (always real LLM)
const generateName = convertLLMAnalyzerToFunction(
  nameGeneratorAgent,
  NameGeneratorInputSchema,
  NameSuggestionSchema,
  { model: openai('gpt-4') }
);
// ctx.mockable = false, uses ctx.callLLM() powered by Vercel AI SDK
```

## API Reference

### `convertConversationalAssistantToFunction<TInput, TOutput>`

Converts a Conversational Assistant agent to an executable async function with conversation history.

**Parameters:**
- `agent: Agent<TInput, TOutput>` - The VAT conversational assistant agent
- `inputSchema: z.ZodType<TInput>` - Input Zod schema
- `outputSchema: z.ZodType<TOutput>` - Output Zod schema
- `llmConfig: VercelAILLMConfig` - LLM configuration (model, temperature, etc.)

**Returns:** `(input: TInput, session: ConversationSession) => Promise<TOutput>` - Executable async function that requires a session parameter

**Session Management:**
```typescript
interface ConversationSession {
  history: Message[];      // Maintained across turns
  state?: Record<string, unknown>;  // Agent-specific state
}
```

### `convertConversationalAssistantsToFunctions`

Batch converts multiple Conversational Assistant agents with shared LLM config.

**Parameters:**
- `configs: Record<string, ConversationalAssistantConversionConfig>` - Map of assistant names to conversion configs
- `llmConfig: VercelAILLMConfig` - Shared LLM configuration

**Returns:** `Record<string, (input: any, session: ConversationSession) => Promise<any>>` - Map of assistant names to executable functions

### `convertPureFunctionToTool<TInput, TOutput>`

Converts a PureFunctionAgent to a Vercel AI SDK tool.

**Parameters:**
- `agent: PureFunctionAgent<TInput, TOutput>` - The VAT agent
- `inputSchema: z.ZodType<TInput>` - Input Zod schema
- `outputSchema: z.ZodType<TOutput>` - Output Zod schema

**Returns:** `ConversionResult<TInput, TOutput>`
- `tool: VercelAITool` - The tool ready for use with generateText()
- `inputSchema: z.ZodType<TInput>` - Original input schema
- `outputSchema: z.ZodType<TOutput>` - Original output schema
- `metadata` - Agent name, description, version, archetype

### `convertPureFunctionsToTools`

Batch converts multiple PureFunctionAgents to tools.

**Parameters:**
- `configs: Record<string, ToolConversionConfig>` - Map of tool names to conversion configs

**Returns:** `Record<string, VercelAITool>` - Map of tool names to Vercel AI tools

### `convertLLMAnalyzerToFunction<TInput, TOutput>`

Converts an LLM Analyzer agent to an executable async function.

**Parameters:**
- `agent: Agent<TInput, TOutput>` - The VAT LLM analyzer agent
- `inputSchema: z.ZodType<TInput>` - Input Zod schema
- `outputSchema: z.ZodType<TOutput>` - Output Zod schema
- `llmConfig: VercelAILLMConfig` - LLM configuration (model, temperature, etc.)

**Returns:** `(input: TInput) => Promise<TOutput>` - Executable async function

### `convertLLMAnalyzersToFunctions`

Batch converts multiple LLM Analyzer agents with shared LLM config.

**Parameters:**
- `configs: Record<string, LLMAnalyzerConversionConfig>` - Map of function names to conversion configs
- `llmConfig: VercelAILLMConfig` - Shared LLM configuration

**Returns:** `Record<string, (input: any) => Promise<any>>` - Map of function names to executable functions

## Type Definitions

### `VercelAILLMConfig`

```typescript
interface VercelAILLMConfig {
  model: LanguageModelV1;           // From Vercel AI SDK
  temperature?: number;              // 0-1, default 0.7
  maxTokens?: number;                // Maximum tokens to generate
  additionalSettings?: Record<string, unknown>; // Provider-specific settings
}
```

### `ToolConversionConfig<TInput, TOutput>`

```typescript
interface ToolConversionConfig<TInput, TOutput> {
  agent: PureFunctionAgent<TInput, TOutput>;
  inputSchema: z.ZodType<TInput>;
  outputSchema: z.ZodType<TOutput>;
}
```

### `ConversationalAssistantConversionConfig<TInput, TOutput>`

```typescript
interface ConversationalAssistantConversionConfig<TInput, TOutput> {
  agent: Agent<TInput, TOutput>;
  inputSchema: z.ZodType<TInput>;
  outputSchema: z.ZodType<TOutput>;
}
```

### `LLMAnalyzerConversionConfig<TInput, TOutput>`

```typescript
interface LLMAnalyzerConversionConfig<TInput, TOutput> {
  agent: Agent<TInput, TOutput>;
  inputSchema: z.ZodType<TInput>;
  outputSchema: z.ZodType<TOutput>;
}
```

## Examples

See [@vibe-agent-toolkit/vat-example-cat-agents](../vat-example-cat-agents) for complete agent examples that work with this adapter.

## Testing

### Unit Tests

Standard unit tests verify adapter structure and type safety without making real LLM calls:

```bash
bun run test        # Run all unit tests (free, fast)
bun run test:watch  # Watch mode for development
```

### LLM Regression Tests

LLM regression tests make **real API calls** to OpenAI and Anthropic to verify end-to-end integration. These tests are:
- **Expensive**: Cost money (API calls to GPT-4o-mini and Claude 4.5 Sonnet)
- **Slow**: Take 15-60 seconds depending on API latency
- **Skipped by default**: Only run when explicitly requested

**Run regression tests:**

```bash
# From this package directory
bun run test:llm-regression

# Or manually with environment variable
RUN_LLM_TESTS=true bun test test/llm-regression.test.ts
```

**What they test:**
- ✅ Pure function tools work with real LLMs
- ✅ LLM analyzer functions work with OpenAI
- ✅ LLM analyzer functions work with Anthropic Claude
- ✅ Same adapter code works across providers (provider-agnostic architecture)

**Requirements:**
- `OPENAI_API_KEY` environment variable for OpenAI tests
- `ANTHROPIC_API_KEY` environment variable for Anthropic tests
- Tests gracefully skip if API keys are not set

**When to run:**
- Before releases to verify provider integrations still work
- After upgrading `ai` or provider packages (e.g., `@ai-sdk/openai`)
- When adding support for new LLM providers
- Periodically (weekly/monthly) to catch API breaking changes

**Cost estimate:**
- Full test suite: ~4 LLM calls (2 OpenAI, 2 Anthropic)
- Approximate cost: $0.01-0.05 per run (varies by model pricing)

## License

MIT

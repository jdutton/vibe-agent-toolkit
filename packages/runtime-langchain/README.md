# @vibe-agent-toolkit/runtime-langchain

LangChain.js runtime adapter for VAT (Vibe Agent Toolkit) agents.

Converts VAT archetype agents to LangChain primitives, enabling portability across LLM providers (OpenAI, Anthropic, etc.) while maintaining type safety and agent semantics.

## Installation

```bash
npm install @vibe-agent-toolkit/runtime-langchain langchain @langchain/core
# or
bun add @vibe-agent-toolkit/runtime-langchain langchain @langchain/core
```

You'll also need an LLM provider package:
```bash
npm install @langchain/openai    # For OpenAI
npm install @langchain/anthropic # For Anthropic Claude
```

## Supported Archetypes

### Conversational Assistant → Async Function with History

Converts multi-turn conversational VAT agents to stateful async functions that manage conversation history and session state.

**Use cases:** Chatbots, advisory systems, interactive assistants, context-aware conversations.

#### Example: Breed Advisor

```typescript
import { ChatOpenAI } from '@langchain/openai';
import { breedAdvisorAgent, BreedAdvisorInputSchema, BreedAdvisorOutputSchema } from '@vibe-agent-toolkit/vat-example-cat-agents';
import { convertConversationalAssistantToFunction } from '@vibe-agent-toolkit/runtime-langchain';

// Convert VAT agent to conversational function
const chat = convertConversationalAssistantToFunction({
  agent: breedAdvisorAgent,
  inputSchema: BreedAdvisorInputSchema,
  outputSchema: BreedAdvisorOutputSchema,
  llmConfig: {
    model: new ChatOpenAI({ model: 'gpt-4o' }),
    temperature: 0.7,
  },
});

// First turn
let result = await chat({
  message: 'I need help finding a cat breed',
});
console.log(result.output.reply);

// Second turn (pass session to maintain history)
result = await chat(
  {
    message: 'I love classical music',
    sessionState: { profile: result.output.updatedProfile },
  },
  result.session
);
console.log(result.output.reply);

// Continue conversation with accumulated context
result = await chat(
  {
    message: 'I live in an apartment with kids',
    sessionState: { profile: result.output.updatedProfile },
  },
  result.session
);

// Get recommendations
if (result.output.recommendations) {
  console.log('Recommended breeds:', result.output.recommendations);
}
```

### Pure Function Tools → `DynamicStructuredTool`

Converts synchronous, deterministic VAT agents to LangChain tools that can be called by LLMs.

**Use cases:** Validation, transformation, computation, structured data operations.

#### Example: Haiku Validator

```typescript
import { ChatOpenAI } from '@langchain/openai';
import { createToolCallingAgent, AgentExecutor } from 'langchain/agents';
import { ChatPromptTemplate } from '@langchain/core/prompts';
import { haikuValidatorAgent, HaikuSchema, HaikuValidationResultSchema } from '@vibe-agent-toolkit/vat-example-cat-agents';
import { convertPureFunctionToTool } from '@vibe-agent-toolkit/runtime-langchain';

// Convert VAT agent to LangChain tool
const { tool } = convertPureFunctionToTool(
  haikuValidatorAgent,
  HaikuSchema,
  HaikuValidationResultSchema
);

// Use with LangChain agent
const llm = new ChatOpenAI({ model: 'gpt-4o-mini' });
const prompt = ChatPromptTemplate.fromMessages([
  ['system', 'You are a helpful assistant'],
  ['human', '{input}'],
  ['placeholder', '{agent_scratchpad}'],
]);

const agent = await createToolCallingAgent({
  llm,
  tools: [tool],
  prompt,
});

const executor = new AgentExecutor({ agent, tools: [tool] });
const result = await executor.invoke({
  input: 'Write a haiku about an orange cat and validate it'
});
```

### LLM Analyzer → Async Function

Converts LLM-powered VAT agents to executable async functions that work with any LangChain chat model.

**Use cases:** Content generation, analysis, transformation, structured output from LLMs.

#### Example: Name Generator

```typescript
import { ChatOpenAI } from '@langchain/openai';
import { nameGeneratorAgent, NameGeneratorInputSchema, NameSuggestionSchema } from '@vibe-agent-toolkit/vat-example-cat-agents';
import { convertLLMAnalyzerToFunction } from '@vibe-agent-toolkit/runtime-langchain';

// Convert VAT agent to executable function
const generateName = convertLLMAnalyzerToFunction(
  nameGeneratorAgent,
  NameGeneratorInputSchema,
  NameSuggestionSchema,
  {
    model: new ChatOpenAI({ model: 'gpt-4o-mini' }),
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

## Provider-Agnostic Architecture

The same VAT agent code works with any LangChain-supported LLM provider:

```typescript
import { ChatOpenAI } from '@langchain/openai';
import { ChatAnthropic } from '@langchain/anthropic';
import { convertLLMAnalyzerToFunction } from '@vibe-agent-toolkit/runtime-langchain';

// OpenAI
const generateNameOpenAI = convertLLMAnalyzerToFunction(
  nameGeneratorAgent,
  NameGeneratorInputSchema,
  NameSuggestionSchema,
  { model: new ChatOpenAI({ model: 'gpt-4o-mini' }) }
);

// Anthropic
const generateNameAnthropic = convertLLMAnalyzerToFunction(
  nameGeneratorAgent,
  NameGeneratorInputSchema,
  NameSuggestionSchema,
  { model: new ChatAnthropic({ model: 'claude-sonnet-4-5-20250929' }) }
);

// Same agent, different providers
const [openaiResult, anthropicResult] = await Promise.all([
  generateNameOpenAI(input),
  generateNameAnthropic(input),
]);
```

## API Reference

### `convertPureFunctionToTool()`

Converts a VAT Pure Function agent to a LangChain `DynamicStructuredTool`.

**Parameters:**
- `agent: PureFunctionAgent<TInput, TOutput>` - The VAT agent to convert
- `inputSchema: z.ZodType<TInput>` - Zod schema for input validation
- `outputSchema: z.ZodType<TOutput>` - Zod schema for output validation

**Returns:** Object with:
- `tool: DynamicStructuredTool` - LangChain tool ready for agent use
- `metadata: { name, description, version, archetype }` - Agent metadata
- `inputSchema: z.ZodType<TInput>` - Original input schema
- `outputSchema: z.ZodType<TOutput>` - Original output schema

### `convertPureFunctionsToTools()`

Batch converts multiple pure function agents to LangChain tools.

**Parameters:**
- `configs: Record<string, ToolConversionConfig>` - Map of tool names to conversion configs

**Returns:** `Record<string, { tool: DynamicStructuredTool, metadata }>` - Map of converted tools

### `convertLLMAnalyzerToFunction()`

Converts a VAT LLM Analyzer agent to an executable async function.

**Parameters:**
- `agent: Agent<TInput, TOutput>` - The VAT agent to convert
- `inputSchema: z.ZodType<TInput>` - Zod schema for input validation
- `outputSchema: z.ZodType<TOutput>` - Zod schema for output validation
- `llmConfig: LangChainLLMConfig` - LangChain LLM configuration

**Returns:** `(input: TInput) => Promise<TOutput>` - Executable async function

### `convertLLMAnalyzersToFunctions()`

Batch converts multiple LLM Analyzer agents with shared LLM config.

**Parameters:**
- `configs: Record<string, LLMAnalyzerConversionConfig>` - Map of function names to conversion configs
- `llmConfig: LangChainLLMConfig` - Shared LangChain LLM configuration

**Returns:** `Record<string, (input: any) => Promise<any>>` - Map of executable functions

### `convertConversationalAssistantToFunction()`

Converts a VAT Conversational Assistant agent to a stateful async function with conversation history management.

**Parameters:**
- `config: ConversationalAssistantConfig<TInput, TOutput, TState>` - Configuration object containing:
  - `agent: Agent<TInput, TOutput>` - The VAT agent to convert
  - `inputSchema: z.ZodType<TInput>` - Zod schema for input validation
  - `outputSchema: z.ZodType<TOutput>` - Zod schema for output validation
  - `llmConfig: LangChainLLMConfig` - LangChain LLM configuration
  - `initialState?: TState` - Optional initial session state
  - `systemPrompt?: string` - Optional system prompt override

**Returns:** `(input: TInput, session?: ConversationalSession<TState>) => Promise<ConversationalResult<TOutput, TState>>`

The returned function accepts:
- `input` - User input for this turn
- `session` - Optional session from previous turn (for conversation continuity)

And returns:
- `output` - Agent's validated output
- `session` - Updated session to pass to next turn (includes history and state)

### `convertConversationalAssistantsToFunctions()`

Batch converts multiple Conversational Assistant agents with shared LLM config.

**Parameters:**
- `configs: Record<string, ConversationalAssistantConversionConfig>` - Map of function names to conversion configs
- `llmConfig: LangChainLLMConfig` - Shared LangChain LLM configuration

**Returns:** `Record<string, (input: any, session?: ConversationalSession) => Promise<ConversationalResult<any>>>` - Map of executable functions

## Type Definitions

### `LangChainLLMConfig`

```typescript
interface LangChainLLMConfig {
  model: BaseChatModel;              // LangChain chat model instance
  temperature?: number;               // 0-1, default 0.7
  maxTokens?: number;                 // Maximum tokens to generate
  additionalSettings?: Record<string, unknown>; // Provider-specific settings
}
```

### `ConversationalSession<TState>`

```typescript
interface ConversationalSession<TState = Record<string, unknown>> {
  history: Message[];     // Conversation history (system/user/assistant messages)
  state: TState;          // Session-specific state (e.g., user profile)
}
```

### `ConversationalResult<TOutput, TState>`

```typescript
interface ConversationalResult<TOutput, TState = Record<string, unknown>> {
  output: TOutput;                        // Agent's validated output
  session: ConversationalSession<TState>; // Updated session for next turn
}
```

## Examples

See [@vibe-agent-toolkit/vat-example-cat-agents](../vat-example-cat-agents) for complete agent examples that work with this adapter.

## License

MIT

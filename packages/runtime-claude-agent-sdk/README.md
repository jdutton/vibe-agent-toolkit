# @vibe-agent-toolkit/runtime-claude-agent-sdk

Runtime adapter for deploying VAT agents as Claude Agent SDK MCP tools.

## Features

- Converts VAT agents to Claude Agent SDK MCP tools
- Supports Pure Function, LLM Analyzer, and Conversational Assistant archetypes
- Maintains conversation history for multi-turn interactions
- Validates inputs and outputs using Zod schemas
- Single-agent or batch conversion patterns

## Installation

```bash
npm install @vibe-agent-toolkit/runtime-claude-agent-sdk
# or
bun add @vibe-agent-toolkit/runtime-claude-agent-sdk
```

## Supported Archetypes

### 1. Pure Function Tools

Stateless, deterministic agents with no external dependencies.

```typescript
import { query } from '@anthropic-ai/claude-agent-sdk';
import { haikuValidatorAgent } from '@vibe-agent-toolkit/vat-example-cat-agents';
import { convertPureFunctionToTool } from '@vibe-agent-toolkit/runtime-claude-agent-sdk';

const { server, metadata } = convertPureFunctionToTool(
  haikuValidatorAgent,
  HaikuSchema,
  HaikuValidationResultSchema
);

// Use with Claude Agent SDK
for await (const message of query({
  prompt: "Validate this haiku: 'Cat sits on warm mat / Purring in the sunshine / Dreams of tuna fish'",
  options: {
    mcpServers: { 'haiku-tools': server },
    allowedTools: [metadata.toolName]
  }
})) {
  if (message.type === 'result') {
    console.log(message.result);
  }
}
```

### 2. LLM Analyzer Tools

Single LLM call agents for classification and extraction.

```typescript
import { query } from '@anthropic-ai/claude-agent-sdk';
import { nameGeneratorAgent } from '@vibe-agent-toolkit/vat-example-cat-agents';
import { convertLLMAnalyzerToTool } from '@vibe-agent-toolkit/runtime-claude-agent-sdk';

const { server, metadata } = convertLLMAnalyzerToTool(
  nameGeneratorAgent,
  NameGeneratorInputSchema,
  NameSuggestionSchema,
  {
    apiKey: process.env.ANTHROPIC_API_KEY,
    model: 'claude-3-5-haiku-20241022',
    temperature: 0.9
  }
);

// Use with Claude Agent SDK
for await (const message of query({
  prompt: "Generate a distinguished cat name for an orange cat",
  options: {
    mcpServers: { 'name-tools': server },
    allowedTools: [metadata.toolName]
  }
})) {
  if (message.type === 'result') {
    console.log(message.result);
  }
}
```

### 3. Conversational Assistant Tools

Multi-turn conversation agents with session state and history.

```typescript
import { query } from '@anthropic-ai/claude-agent-sdk';
import { breedAdvisorAgent } from '@vibe-agent-toolkit/vat-example-cat-agents';
import { convertConversationalAssistantToTool } from '@vibe-agent-toolkit/runtime-claude-agent-sdk';

const { server, metadata } = convertConversationalAssistantToTool(
  breedAdvisorAgent,
  BreedAdvisorInputSchema,
  BreedAdvisorOutputSchema,
  {
    apiKey: process.env.ANTHROPIC_API_KEY,
    model: 'claude-3-5-haiku-20241022',
    temperature: 0.7
  }
);

// Multi-turn conversation
const turns = [
  "Hi! I'm looking for a cat breed. I live in a small apartment.",
  "I love classical music! Chopin and Debussy are my favorites.",
  "I don't mind grooming. What breeds would you recommend?"
];

for (const turn of turns) {
  for await (const message of query({
    prompt: turn,
    options: {
      mcpServers: { 'breed-advisor': server },
      allowedTools: [metadata.toolName]
    }
  })) {
    if (message.type === 'result') {
      console.log(message.result);
    }
  }
}
```

## Batch Conversion

Convert multiple agents to a single MCP server:

```typescript
import { convertLLMAnalyzersToTools } from '@vibe-agent-toolkit/runtime-claude-agent-sdk';

const { server, metadata } = convertLLMAnalyzersToTools({
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
}, {
  apiKey: process.env.ANTHROPIC_API_KEY,
  model: 'claude-3-5-haiku-20241022',
  temperature: 0.8,
});

// Use all tools together
for await (const message of query({
  prompt: "Generate a cat name and haiku",
  options: {
    mcpServers: { 'cat-llm-tools': server },
    allowedTools: [
      'mcp__cat-llm-tools__generateName',
      'mcp__cat-llm-tools__generateHaiku'
    ]
  }
})) {
  console.log(message);
}
```

## API Reference

### Single Agent Conversion

#### `convertPureFunctionToTool(agent, inputSchema, outputSchema, serverName?)`

Converts a VAT Pure Function agent to Claude Agent SDK MCP tool.

**Parameters:**
- `agent` - The VAT pure function agent
- `inputSchema` - Zod schema for input validation
- `outputSchema` - Zod schema for output validation
- `serverName` - Optional server name (defaults to agent name)

**Returns:** `AgentConversionResult<TInput, TOutput>`

#### `convertLLMAnalyzerToTool(agent, inputSchema, outputSchema, llmConfig, serverName?)`

Converts a VAT LLM Analyzer agent to Claude Agent SDK MCP tool.

**Parameters:**
- `agent` - The VAT LLM analyzer agent
- `inputSchema` - Zod schema for input validation
- `outputSchema` - Zod schema for output validation
- `llmConfig` - LLM configuration (`{ apiKey?, model?, temperature?, maxTokens? }`)
- `serverName` - Optional server name (defaults to agent name)

**Returns:** `AgentConversionResult<TInput, TOutput>`

#### `convertConversationalAssistantToTool(agent, inputSchema, outputSchema, llmConfig, serverName?)`

Converts a VAT Conversational Assistant agent to Claude Agent SDK MCP tool.

**Parameters:**
- `agent` - The VAT conversational assistant agent
- `inputSchema` - Zod schema for input validation
- `outputSchema` - Zod schema for output validation
- `llmConfig` - LLM configuration (`{ apiKey?, model?, temperature?, maxTokens? }`)
- `serverName` - Optional server name (defaults to agent name)

**Returns:** `AgentConversionResult<TInput, TOutput>`

### Batch Conversion

#### `convertPureFunctionsToTools(configs, serverName?)`

Batch converts multiple Pure Function agents.

**Parameters:**
- `configs` - Map of tool names to agent configurations
- `serverName` - Server name (defaults to 'vat-agents')

**Returns:** `BatchConversionResult`

#### `convertLLMAnalyzersToTools(configs, llmConfig, serverName?)`

Batch converts multiple LLM Analyzer agents.

**Parameters:**
- `configs` - Map of tool names to agent configurations
- `llmConfig` - Shared LLM configuration
- `serverName` - Server name (defaults to 'vat-llm-agents')

**Returns:** `BatchConversionResult`

#### `convertConversationalAssistantsToTools(configs, llmConfig, serverName?)`

Batch converts multiple Conversational Assistant agents.

**Parameters:**
- `configs` - Map of tool names to agent configurations
- `llmConfig` - Shared LLM configuration
- `serverName` - Server name (defaults to 'vat-conversational-agents')

**Returns:** `BatchConversionResult`

## Types

### `AgentConversionResult<TInput, TOutput>`

```typescript
interface AgentConversionResult<TInput, TOutput> {
  server: ClaudeAgentMcpServer;
  metadata: {
    name: string;
    description: string;
    version: string;
    archetype: string;
    serverName: string;
    toolName: string;
  };
  inputSchema: z.ZodType<TInput>;
  outputSchema: z.ZodType<TOutput>;
}
```

### `BatchConversionResult`

```typescript
interface BatchConversionResult {
  server: ClaudeAgentMcpServer;
  metadata: {
    serverName: string;
    tools: Record<string, {
      name: string;
      description: string;
      version: string;
      archetype: string;
      toolName: string;
    }>;
  };
}
```

### `ClaudeAgentLLMConfig`

```typescript
interface ClaudeAgentLLMConfig {
  apiKey?: string;        // Defaults to ANTHROPIC_API_KEY env var
  model?: string;         // Defaults to 'claude-3-5-haiku-20241022'
  temperature?: number;   // Defaults to 0.7
  maxTokens?: number;     // Defaults to 4096
}
```

## Examples

This adapter implements the `RuntimeAdapter` interface and can be tested with the runtime-agnostic demo:

```bash
# See vat-example-cat-agents/examples/runtime-adapter-demo.ts
# The common demo works with ALL runtime adapters via the RuntimeAdapter interface
```

For usage patterns, see the code examples in this README above.

## Architecture

This adapter:

1. **Wraps VAT agents** as Claude Agent SDK MCP tools
2. **Validates inputs/outputs** using Zod schemas
3. **Manages conversation history** for conversational agents
4. **Provides LLM context** for agents that need it
5. **Returns structured results** in Claude Agent SDK format

## License

MIT

## Related Packages

- [@vibe-agent-toolkit/agent-runtime](../agent-runtime) - Core agent definitions
- [@vibe-agent-toolkit/vat-example-cat-agents](../vat-example-cat-agents) - Example agents
- [@vibe-agent-toolkit/agent-skills](../agent-skills) - Agent Skills adapter

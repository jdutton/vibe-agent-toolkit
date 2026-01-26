# @vibe-agent-toolkit/agent-runtime

Runtime framework for building portable AI agents across multiple agent archetypes.

## Features

- **Agent Archetypes**: Pre-defined patterns for common agent types
- **Type-Safe**: Full TypeScript support with Zod schema validation
- **Framework Agnostic**: Agents work with any LLM provider
- **Declarative Configuration**: Minimal boilerplate, maximum clarity

## Agent Archetypes

### 1. Pure Function Tool
Stateless, deterministic functions with no external dependencies.

```typescript
import { definePureFunction } from '@vibe-agent-toolkit/agent-runtime';
import { z } from 'zod';

export const haiku Validator = definePureFunction({
  name: 'haiku-validator',
  description: 'Validates haiku structure (5-7-5 syllables)',
  version: '1.0.0',
  inputSchema: z.object({ line1: z.string(), line2: z.string(), line3: z.string() }),
  outputSchema: z.object({ valid: z.boolean(), errors: z.array(z.string()) }),
}, (input) => {
  // Implementation
  return { valid: true, errors: [] };
});
```

### 2. LLM Analyzer
Single LLM call for classification or extraction tasks.

```typescript
import { defineLLMAnalyzer } from '@vibe-agent-toolkit/agent-runtime';

export const photoAnalyzer = defineLLMAnalyzer({
  name: 'photo-analyzer',
  description: 'Analyzes cat photos using vision LLM',
  version: '1.0.0',
  inputSchema: PhotoInputSchema,
  outputSchema: CatCharacteristicsSchema,
  systemPrompt: 'You are an expert cat analyzer...',
}, async (input, ctx) => {
  const analysis = await ctx.callLLM(`Analyze this cat: ${input.imagePath}`);
  return JSON.parse(analysis);
});
```

### 3. Conversational Assistant
Multi-turn dialogue with conversation history.

```typescript
import { defineConversationalAssistant } from '@vibe-agent-toolkit/agent-runtime';

export const chatAgent = defineConversationalAssistant({
  name: 'breed-advisor',
  description: 'Helps users find their perfect cat breed',
  version: '1.0.0',
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  systemPrompt: 'You are a friendly cat breed advisor...',
}, async (input, ctx) => {
  ctx.addToHistory('user', input.message);
  const response = await ctx.callLLM(ctx.history);
  ctx.addToHistory('assistant', response);
  return { reply: response };
});
```

### 3a. Two-Phase Conversational Assistant ⭐ NEW

**Recommended pattern for conversational agents that gather information.**

The two-phase pattern solves the "JSON every turn" anti-pattern by separating:
- **Phase 1 (Gathering)**: Natural conversational text responses
- **Phase 2 (Extraction)**: Structured data extraction when ready

```typescript
import { defineTwoPhaseConversationalAssistant } from '@vibe-agent-toolkit/agent-runtime';

export const breedAdvisor = defineTwoPhaseConversationalAssistant({
  name: 'breed-advisor',
  description: 'Helps users find their perfect cat breed',
  version: '2.0.0',
  inputSchema: BreedAdvisorInputSchema,
  outputSchema: BreedAdvisorOutputSchema,

  gatheringPhase: {
    tone: 'enthusiastic',
    factors: [
      {
        name: 'musicPreference',
        type: 'enum',
        values: ['classical', 'jazz', 'rock', 'pop'],
        required: true,
        clarificationHint: 'Ask which category fits best for non-standard genres',
      },
      {
        name: 'livingSpace',
        type: 'enum',
        values: ['apartment', 'house', 'farm'],
        naturalLanguageMappings: {
          'flat': 'apartment',
          'big house': 'house',
        },
      },
    ],
    readinessCheck: (profile) => Object.keys(profile).length >= 4,
  },

  extractionPhase: {
    generateRecommendations: (profile) => matchBreeds(profile),
    useStructuredOutputs: false, // Set true for OpenAI gpt-4o-2024-08-06+
  },
});
```

**Key Benefits:**
- **Declarative Configuration**: 200+ lines of manual prompts → 50 lines of config
- **Automatic Validation**: Enum guidance generated from factor definitions
- **Natural Language Mappings**: Common phrases → formal values
- **Priority Factors**: Guide conversation flow

See [docs/structured-outputs.md](../../docs/structured-outputs.md) for detailed pattern comparison and best practices.

### 4. Agentic Researcher
ReAct pattern with tool calling and iterative reasoning.

```typescript
import { defineAgenticResearcher } from '@vibe-agent-toolkit/agent-runtime';

export const researcher = defineAgenticResearcher({
  name: 'breed-historian',
  description: 'Researches cat breed history with web search',
  version: '1.0.0',
  inputSchema: ResearchInputSchema,
  outputSchema: ResearchOutputSchema,
  tools: {
    webSearch: async (query: string) => { /* ... */ },
  },
}, async (input, ctx) => {
  // ReAct loop: Thought → Action → Observation
  for (let i = 0; i < ctx.maxIterations; i++) {
    const thought = await ctx.callLLM(`Research: ${input.query}`);
    const result = await ctx.callTool('webSearch', thought);
    // Process result...
  }
});
```

### 5. Function Workflow Orchestrator
Deterministic multi-agent coordination.

```typescript
import { defineFunctionOrchestrator } from '@vibe-agent-toolkit/agent-runtime';

export const orchestrator = defineFunctionOrchestrator({
  name: 'adoption-pipeline',
  description: 'Coordinates multi-step adoption process',
  version: '1.0.0',
  inputSchema: AdoptionInputSchema,
  outputSchema: AdoptionOutputSchema,
}, async (input, ctx) => {
  // Call multiple agents in sequence
  const analysis = await ctx.call('photo-analyzer', { image: input.photo });
  const validation = await ctx.call('name-validator', { name: input.name });
  const approval = await ctx.call('human-approval', { data: { analysis, validation } });

  return { approved: approval.approved };
});
```

### 6. LLM Intelligent Coordinator
LLM-based routing decisions in workflows.

```typescript
import { defineLLMCoordinator } from '@vibe-agent-toolkit/agent-runtime';

export const coordinator = defineLLMCoordinator({
  name: 'smart-router',
  description: 'Routes submissions based on complexity',
  version: '1.0.0',
  inputSchema: SubmissionSchema,
  outputSchema: RoutingSchema,
  systemPrompt: 'Route submissions to the right handler...',
}, async (input, ctx) => {
  const decision = await ctx.callLLM(`Route: ${input.submission}`);

  return ctx.route(decision, {
    simple: async () => ctx.call('auto-approver', input),
    complex: async () => ctx.call('human-review', input),
  });
});
```

### 7. Function Event Consumer
Event-triggered execution without LLM.

```typescript
import { defineFunctionEventConsumer } from '@vibe-agent-toolkit/agent-runtime';

export const processor = defineFunctionEventConsumer({
  name: 'pedigree-processor',
  description: 'Processes uploaded pedigree files',
  version: '1.0.0',
  inputSchema: FileEventSchema,
  outputSchema: ProcessingResultSchema,
}, async (input, ctx) => {
  const file = await parseFile(input.filePath);
  await ctx.emit('pedigree-processed', { result: file });
  return { status: 'processed' };
});
```

### 8. LLM Event Handler
Event-triggered with LLM processing.

```typescript
import { defineLLMEventHandler } from '@vibe-agent-toolkit/agent-runtime';

export const handler = defineLLMEventHandler({
  name: 'triage-handler',
  description: 'Triages incoming submissions with LLM',
  version: '1.0.0',
  inputSchema: SubmissionEventSchema,
  outputSchema: TriageResultSchema,
  systemPrompt: 'Triage submissions by urgency...',
}, async (input, ctx) => {
  const priority = await ctx.callLLM(`Triage: ${input.submission}`);
  await ctx.emit('submission-triaged', { priority });
  return { priority };
});
```

### 9. External Event Integrator
Human-in-the-loop approval gates.

```typescript
import { defineExternalEventIntegrator } from '@vibe-agent-toolkit/agent-runtime';

export const approvalGate = defineExternalEventIntegrator({
  name: 'human-approval',
  description: 'Waits for human approval',
  version: '1.0.0',
  inputSchema: ApprovalRequestSchema,
  outputSchema: ApprovalResultSchema,
  timeoutMs: 60000,
  onTimeout: 'reject',
}, async (input, ctx) => {
  await ctx.emit('approval-requested', input);
  const result = await ctx.waitFor('approval-response', ctx.timeoutMs);
  return result;
});
```

## Agent Manifest

Every agent exposes a manifest describing its interface:

```typescript
const agent = defineAgentType(config, handler);

console.log(agent.manifest);
// {
//   name: 'agent-name',
//   description: 'What this agent does',
//   version: '1.0.0',
//   archetype: 'archetype-name',
//   inputSchema: { /* JSON Schema */ },
//   outputSchema: { /* JSON Schema */ },
//   metadata: { /* Additional info */ }
// }
```

## Runtime Adapters

Agents are framework-agnostic. Use runtime adapters to integrate with specific LLM frameworks:

- `@vibe-agent-toolkit/runtime-openai` - OpenAI SDK
- `@vibe-agent-toolkit/runtime-vercel-ai-sdk` - Vercel AI SDK
- `@vibe-agent-toolkit/runtime-langchain` - LangChain
- `@vibe-agent-toolkit/runtime-claude-agent-sdk` - Claude Agent SDK

See individual runtime packages for usage examples.

## Examples

See `@vibe-agent-toolkit/vat-example-cat-agents` for complete examples across all archetypes.

## License

MIT

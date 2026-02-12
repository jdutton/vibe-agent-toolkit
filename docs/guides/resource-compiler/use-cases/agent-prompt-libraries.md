---
title: Building Agent Prompt Libraries
description: Patterns for creating and using type-safe prompt libraries for AI agents
category: guide
tags: [resource-compiler, agents, prompts, ai, llm]
audience: intermediate
---

# Building Agent Prompt Libraries

Create type-safe, version-controlled prompt libraries for AI agents using compiled markdown resources.

---

## What This Guide Covers

- Building conversational agents from fragments
- Multi-agent systems with dynamic routing
- Dynamic prompt composition
- Runtime fragment selection
- Model-specific prompts
- Testing prompt libraries

**Audience:** AI developers building agents with LLMs.

---

## Prerequisites

- Understanding of [resource compilation](../compiling-markdown-to-typescript.md)
- Basic AI/LLM experience (Claude, GPT, etc.)
- TypeScript knowledge

---

## Basic Agent Prompting

### Creating a Simple Agent

```typescript
import * as SystemPrompts from '@acme/prompts/generated/resources/prompts/system.js';
import { Anthropic } from '@anthropic-ai/sdk';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function createAgent(role: keyof typeof SystemPrompts.fragments) {
  const systemPrompt = SystemPrompts.fragments[role].body;

  return async (userMessage: string) => {
    const response = await client.messages.create({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    });

    return response.content[0].text;
  };
}

// Create specialized agents from fragments
const technicalAgent = await createAgent('technicalAssistant');
const reviewAgent = await createAgent('codeReviewer');

// Use them
const answer = await technicalAgent('How do I use async/await?');
const feedback = await reviewAgent('Review this code: function foo() {...}');
```

### Stateful Agent with History

```typescript
import * as Prompts from '@acme/prompts/generated/resources/prompts/system.js';

class Agent {
  private history: Array<{ role: string; content: string }> = [];
  private systemPrompt: string;

  constructor(role: keyof typeof Prompts.fragments) {
    this.systemPrompt = Prompts.fragments[role].body;
  }

  async chat(userMessage: string): Promise<string> {
    this.history.push({ role: 'user', content: userMessage });

    const response = await client.messages.create({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 2048,
      system: this.systemPrompt,
      messages: this.history,
    });

    const assistantMessage = response.content[0].text;
    this.history.push({ role: 'assistant', content: assistantMessage });

    return assistantMessage;
  }

  reset() {
    this.history = [];
  }
}

// Usage
const agent = new Agent('technicalAssistant');
await agent.chat('What is TypeScript?');
await agent.chat('Can you give me an example?');
```

---

## Multi-Agent Systems

### Agent Registry

```typescript
import * as Agents from '@acme/agents/generated/resources/agents.js';

interface AgentDefinition {
  name: string;
  systemPrompt: string;
  capabilities: string[];
}

function buildAgentRegistry(): Map<string, AgentDefinition> {
  const registry = new Map<string, AgentDefinition>();

  // Iterate over all agent fragments
  for (const [name, fragment] of Object.entries(Agents.fragments)) {
    registry.set(name, {
      name: fragment.header.replace('## ', ''),
      systemPrompt: fragment.body,
      capabilities: (Agents.meta[`${name}_capabilities`] as string[]) || [],
    });
  }

  return registry;
}

const agents = buildAgentRegistry();

// Get agent by name
const codeReviewer = agents.get('codeReviewer');
console.log(codeReviewer?.systemPrompt);
```

### Intent-Based Routing

```typescript
import * as Agents from '@acme/agents/generated/resources/agents.js';

interface RouterConfig {
  [intent: string]: keyof typeof Agents.fragments;
}

const routingMap: RouterConfig = {
  help: 'supportAgent',
  code: 'technicalAssistant',
  review: 'codeReviewer',
  debug: 'debugger',
  explain: 'educator',
};

function routeToAgent(userIntent: string): string {
  const fragmentName = routingMap[userIntent] || 'general';

  if (fragmentName in Agents.fragments) {
    return Agents.fragments[fragmentName].body;
  }

  return Agents.fragments.general.body;
}

// Usage
const intent = classifyIntent(userMessage); // Your classifier
const systemPrompt = routeToAgent(intent);
```

### Capability-Based Selection

```typescript
import * as Agents from '@acme/agents/generated/resources/agents.js';

interface AgentMetadata {
  capabilities: string[];
  expertise: string[];
  constraints: string[];
}

function selectAgentByCapability(
  requiredCapability: string
): keyof typeof Agents.fragments | null {
  for (const [name, fragment] of Object.entries(Agents.fragments)) {
    const meta = Agents.meta[`${name}_metadata`] as AgentMetadata;

    if (meta?.capabilities.includes(requiredCapability)) {
      return name as keyof typeof Agents.fragments;
    }
  }

  return null;
}

// Usage
const agentName = selectAgentByCapability('code-review');
if (agentName) {
  const prompt = Agents.fragments[agentName].body;
}
```

---

## Dynamic Prompt Composition

### Layered Prompt Building

```typescript
import * as BasePrompts from '@acme/prompts/generated/resources/base.js';
import * as DomainPrompts from '@acme/prompts/generated/resources/domains.js';

interface PromptContext {
  role: string;
  domain: string;
  constraints?: string[];
  examples?: string[];
}

function buildPrompt(context: PromptContext): string {
  const parts: string[] = [];

  // Base role prompt
  const baseFragment = BasePrompts.fragments[context.role as keyof typeof BasePrompts.fragments];
  if (baseFragment) {
    parts.push(baseFragment.body);
  }

  // Domain-specific instructions
  const domainFragment = DomainPrompts.fragments[context.domain as keyof typeof DomainPrompts.fragments];
  if (domainFragment) {
    parts.push('\n## Domain Knowledge\n');
    parts.push(domainFragment.body);
  }

  // Add constraints
  if (context.constraints?.length) {
    parts.push('\n## Constraints\n');
    parts.push(context.constraints.map(c => `- ${c}`).join('\n'));
  }

  // Add examples
  if (context.examples?.length) {
    parts.push('\n## Examples\n');
    parts.push(context.examples.join('\n\n'));
  }

  return parts.filter(Boolean).join('\n');
}

// Usage
const prompt = buildPrompt({
  role: 'technicalWriter',
  domain: 'cloudInfrastructure',
  constraints: [
    'Use simple language',
    'Include code examples',
    'Focus on AWS services',
  ],
  examples: [
    'Good: "Deploy using `aws deploy`"',
    'Bad: "Utilize the deployment mechanism"',
  ],
});
```

### Template Variables in Prompts

```markdown
<!-- resources/prompts/contextual.md -->
## Project Helper

You are helping with the {{projectName}} project.
The project uses {{primaryLanguage}} and is focused on {{projectDomain}}.

When providing answers:
- Reference {{projectName}} conventions
- Use {{primaryLanguage}} syntax
- Consider {{projectDomain}} best practices
```

```typescript
import * as Prompts from '@acme/prompts/generated/resources/prompts/contextual.js';

function renderPrompt(
  fragmentName: keyof typeof Prompts.fragments,
  variables: Record<string, string>
): string {
  let prompt = Prompts.fragments[fragmentName].body;

  for (const [key, value] of Object.entries(variables)) {
    const placeholder = new RegExp(`\\{\\{${key}\\}\\}`, 'g');
    prompt = prompt.replace(placeholder, value);
  }

  return prompt;
}

// Usage
const prompt = renderPrompt('projectHelper', {
  projectName: 'vibe-agent-toolkit',
  primaryLanguage: 'TypeScript',
  projectDomain: 'AI development',
});
```

---

## Runtime Fragment Selection

### State-Based Role Switching

```typescript
import * as AgentRoles from '@acme/agents/generated/resources/roles.js';

interface ConversationState {
  history: Array<{ role: string; content: string }>;
  currentIntent: string;
  userPreferences: Record<string, unknown>;
  phase: 'discovery' | 'execution' | 'review';
}

function selectAgentRole(state: ConversationState): string {
  // Phase-based selection
  const phaseRoles = {
    discovery: 'interviewer',
    execution: 'implementer',
    review: 'critic',
  };

  const roleName = phaseRoles[state.phase];

  if (roleName && roleName in AgentRoles.fragments) {
    return AgentRoles.fragments[roleName as keyof typeof AgentRoles.fragments].body;
  }

  return AgentRoles.fragments.general.body;
}

// State machine for multi-turn conversations
class StatefulAgent {
  private state: ConversationState = {
    history: [],
    currentIntent: '',
    userPreferences: {},
    phase: 'discovery',
  };

  async respond(userMessage: string): Promise<string> {
    // Update state based on user message
    this.analyzeAndUpdateState(userMessage);

    // Select appropriate role dynamically
    const systemPrompt = selectAgentRole(this.state);

    // Generate response with selected role
    const response = await client.messages.create({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 1024,
      system: systemPrompt,
      messages: [
        ...this.state.history,
        { role: 'user', content: userMessage },
      ],
    });

    return response.content[0].text;
  }

  private analyzeAndUpdateState(message: string) {
    // Analyze message and update conversation state
    // (intent detection, phase transition logic, etc.)
  }
}
```

### User Preference-Based Selection

```typescript
import * as Prompts from '@acme/prompts/generated/resources/style-variants.js';

interface UserPreferences {
  verbosity: 'concise' | 'detailed' | 'comprehensive';
  tone: 'formal' | 'casual' | 'technical';
  codeStyle: 'minimal' | 'commented' | 'tutorial';
}

function selectPromptByPreference(
  baseRole: string,
  prefs: UserPreferences
): string {
  // Build fragment name from preferences
  const variantKey = `${baseRole}_${prefs.verbosity}_${prefs.tone}` as keyof typeof Prompts.fragments;

  if (variantKey in Prompts.fragments) {
    return Prompts.fragments[variantKey].body;
  }

  // Fallback to base role
  return Prompts.fragments[baseRole as keyof typeof Prompts.fragments]?.body || '';
}

// Usage
const userPrefs: UserPreferences = {
  verbosity: 'concise',
  tone: 'technical',
  codeStyle: 'minimal',
};

const prompt = selectPromptByPreference('technicalAssistant', userPrefs);
```

---

## Model-Specific Prompts

### Provider-Optimized Prompts

```typescript
import * as Prompts from '@acme/prompts/generated/resources/model-specific.js';

type ModelProvider = 'anthropic' | 'openai' | 'google';

interface ModelConfig {
  provider: ModelProvider;
  model: string;
  systemPrompt: string;
}

function getModelConfig(task: string): ModelConfig {
  // Different models get optimized prompts
  const configs: Record<ModelProvider, ModelConfig> = {
    anthropic: {
      provider: 'anthropic',
      model: 'claude-3-5-sonnet-20241022',
      systemPrompt: Prompts.fragments.claudeSystemPrompt.body,
    },
    openai: {
      provider: 'openai',
      model: 'gpt-4-turbo',
      systemPrompt: Prompts.fragments.gptSystemPrompt.body,
    },
    google: {
      provider: 'google',
      model: 'gemini-1.5-pro',
      systemPrompt: Prompts.fragments.geminiSystemPrompt.body,
    },
  };

  // Route based on task requirements
  if (task.includes('creative')) return configs.anthropic;
  if (task.includes('code')) return configs.openai;
  return configs.google;
}

// Usage
const config = getModelConfig('creative writing task');
```

### Fallback Chain

```typescript
import * as Prompts from '@acme/prompts/generated/resources/prompts.js';

type FragmentKey = keyof typeof Prompts.fragments;

function getPromptWithFallback(...fragmentNames: FragmentKey[]): string {
  for (const name of fragmentNames) {
    if (name in Prompts.fragments) {
      return Prompts.fragments[name].body;
    }
  }

  throw new Error('No valid prompt found in fallback chain');
}

// Usage: try specialized, fall back to general
const prompt = getPromptWithFallback(
  'specialized_v2',
  'specialized_v1',
  'general'
);
```

---

## Testing Prompt Libraries

### Snapshot Testing

```typescript
import { describe, it, expect } from 'vitest';
import * as Prompts from '@acme/prompts/generated/resources/system.js';

describe('System Prompts', () => {
  it('should have all required fragments', () => {
    expect(Prompts.fragments).toHaveProperty('technicalAssistant');
    expect(Prompts.fragments).toHaveProperty('codeReviewer');
    expect(Prompts.fragments).toHaveProperty('debugger');
  });

  it('should have valid metadata', () => {
    expect(Prompts.meta.version).toBeDefined();
    expect(Prompts.meta.lastUpdated).toBeDefined();
  });

  it('prompts should not be empty', () => {
    for (const [name, fragment] of Object.entries(Prompts.fragments)) {
      expect(fragment.body.length).toBeGreaterThan(0);
      expect(fragment.header).toContain('##');
    }
  });

  it('matches snapshot', () => {
    expect(Prompts.fragments.technicalAssistant.body).toMatchSnapshot();
  });
});
```

### Integration Testing with Real LLMs

```typescript
import { describe, it, expect } from 'vitest';
import { Anthropic } from '@anthropic-ai/sdk';
import * as Prompts from '@acme/prompts/generated/resources/system.js';

describe('Prompt Validation', () => {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  it('code reviewer prompt produces valid feedback', async () => {
    const testCode = `
function add(a, b) {
  return a + b;
}
    `;

    const response = await client.messages.create({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 1024,
      system: Prompts.fragments.codeReviewer.body,
      messages: [{ role: 'user', content: testCode }],
    });

    const feedback = response.content[0].text;

    // Validate feedback structure
    expect(feedback).toContain('function');
    expect(feedback.length).toBeGreaterThan(50);
  });

  it('technical assistant answers questions accurately', async () => {
    const response = await client.messages.create({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 512,
      system: Prompts.fragments.technicalAssistant.body,
      messages: [{ role: 'user', content: 'What is TypeScript?' }],
    });

    const answer = response.content[0].text;

    expect(answer).toContain('TypeScript');
    expect(answer.length).toBeGreaterThan(100);
  });
});
```

### Prompt Quality Metrics

```typescript
import * as Prompts from '@acme/prompts/generated/resources/system.js';

interface PromptQualityMetrics {
  lengthScore: number;
  clarityScore: number;
  specificityScore: number;
}

function analyzePromptQuality(
  fragmentName: keyof typeof Prompts.fragments
): PromptQualityMetrics {
  const fragment = Prompts.fragments[fragmentName];
  const text = fragment.body;

  // Length score (optimal 100-500 words)
  const wordCount = text.split(/\s+/).length;
  const lengthScore = wordCount >= 100 && wordCount <= 500 ? 1 : 0.5;

  // Clarity score (based on readability heuristics)
  const sentenceCount = text.split(/[.!?]+/).length;
  const avgWordsPerSentence = wordCount / sentenceCount;
  const clarityScore = avgWordsPerSentence < 25 ? 1 : 0.7;

  // Specificity score (contains examples or constraints)
  const hasExamples = /example/i.test(text) || /e\.g\./i.test(text);
  const hasConstraints = /must|should|always|never/i.test(text);
  const specificityScore = (hasExamples ? 0.5 : 0) + (hasConstraints ? 0.5 : 0);

  return { lengthScore, clarityScore, specificityScore };
}

// Test
const metrics = analyzePromptQuality('technicalAssistant');
console.log(metrics);
```

---

## Best Practices

### 1. Organize by Role and Context

```
resources/prompts/
├── base/              # Base role prompts
│   ├── assistant.md
│   ├── reviewer.md
│   └── educator.md
├── domains/           # Domain-specific extensions
│   ├── cloud.md
│   ├── security.md
│   └── data.md
└── variants/          # Style/tone variants
    ├── concise.md
    ├── detailed.md
    └── tutorial.md
```

### 2. Use Frontmatter for Metadata

```markdown
---
role: technical-assistant
capabilities: [coding, debugging, architecture]
modelHints: [claude-3, gpt-4]
complexity: intermediate
lastReviewed: 2024-02-15
---
```

### 3. Version Control Prompts

- Commit prompt changes separately from code
- Use descriptive commit messages
- Tag releases when prompts are stable
- Document changes in CHANGELOG

### 4. Test Prompts with Real Inputs

- Create test suites with actual user queries
- Validate responses meet quality criteria
- Compare prompt versions for regressions

### 5. Monitor Prompt Performance

```typescript
interface PromptMetrics {
  usageCount: number;
  avgResponseTime: number;
  avgTokens: number;
  satisfactionScore: number;
}

const metrics = new Map<string, PromptMetrics>();

async function trackPromptUsage(
  fragmentName: keyof typeof Prompts.fragments,
  responseTime: number,
  tokens: number
) {
  const current = metrics.get(fragmentName) || {
    usageCount: 0,
    avgResponseTime: 0,
    avgTokens: 0,
    satisfactionScore: 0,
  };

  current.usageCount++;
  current.avgResponseTime =
    (current.avgResponseTime * (current.usageCount - 1) + responseTime) / current.usageCount;
  current.avgTokens =
    (current.avgTokens * (current.usageCount - 1) + tokens) / current.usageCount;

  metrics.set(fragmentName, current);
}
```

---

## Next Steps

- [Creating RAG Knowledge Bases](./rag-knowledge-bases.md) - For documentation and semantic search
- [Template System Patterns](./template-systems.md) - For dynamic content generation
- [Advanced Patterns](./advanced-patterns.md) - Multi-collection packages and typed schemas

---

## See Also

- [Overview: Compiling Markdown to TypeScript](../compiling-markdown-to-typescript.md)
- [Publishing Packages](../publishing-packages.md)
- [Consuming Packages](../consuming-packages.md)
- [Guide Index](../README.md)

# Conversational Agents Architecture (Archetype 3)

## Overview

Conversational assistants are agents that maintain context across multiple dialogue turns, accumulating information through natural conversation to provide personalized guidance and recommendations. They represent Archetype 3 in the VAT agent taxonomy.

**Key Characteristics:**
- Multi-turn dialogue with session state management
- Context accumulation across conversation turns
- Natural language factor extraction
- Flexible conversation flow (not rigid workflows)
- Personalized responses based on gathered information

**Use Cases:**
- Advisory chatbots (financial, medical, lifestyle)
- Guided workflows (onboarding, configuration)
- Interactive Q&A systems
- Personalized recommendation engines
- Tutoring and educational assistants

**Contrast with One-Shot LLM Analyzers:**

| Aspect | One-Shot Analyzer | Conversational Assistant |
|--------|------------------|--------------------------|
| Turns | Single | Multiple |
| State | Stateless | Session state persisted |
| Context | None | Accumulates across turns |
| Flow | Fire-and-forget | Interactive dialogue |
| Memory | None | Conversation history |

## Core Requirements

### 1. Conversation History Management

Every conversational agent must track the full conversation history to maintain context:

```typescript
interface Message {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface ConversationalContext {
  history: Message[];
  addToHistory(role: string, content: string): void;
  callLLM(messages: Message[]): Promise<string>;
}
```

**Purpose:**
- Enables the LLM to reference previous turns
- Maintains coherent, contextual responses
- Supports clarification and refinement

### 2. Session State Persistence

Agents must persist session-specific data between turns:

```typescript
interface BreedAdvisorInput {
  message: string;
  sessionState?: {
    profile: SelectionProfile;  // Accumulated factors
  };
}

interface BreedAdvisorOutput {
  reply: string;
  updatedProfile: SelectionProfile;  // Pass back to next turn
}
```

**State Flow:**
1. User sends message with optional `sessionState` from previous turn
2. Agent processes message, updates state
3. Agent returns `updatedProfile` (or similar) in response
4. Client stores `updatedProfile` for next turn
5. Next turn receives updated state in `sessionState` field

**Key Principle:** State is **client-managed**, not stored server-side. This enables stateless agent deployment while supporting stateful conversations.

### 3. Context Accumulation

Agents extract structured information from unstructured dialogue:

```typescript
// Turn 1: "I love classical music and live in an apartment"
// Extracts: musicPreference='classical', livingSpace='apartment'

// Turn 2: "I prefer minimal grooming"
// Extracts: groomingTolerance='minimal'
// Profile now has 3 factors accumulated
```

**Implementation:**
- System prompt instructs LLM how to extract factors
- LLM updates profile JSON in response
- Profile schema defines all trackable factors
- Factors remain until explicitly changed

### 4. Required APIs

Runtime adapters must provide these APIs to conversational agents:

#### `addToHistory(role: string, content: string): void`

Appends a message to the conversation history.

```typescript
ctx.addToHistory('system', 'Current profile: {...}');
ctx.addToHistory('user', input.message);
```

**When to use:**
- Before calling LLM (add user message)
- After LLM response (add assistant message)
- For system messages (state, instructions)

#### `callLLM(messages: Message[]): Promise<string>`

Sends conversation history to LLM and returns response.

```typescript
const response = await ctx.callLLM(ctx.history);
```

**Behavior:**
- Accepts array of messages with role + content
- Returns plain text response (may be JSON)
- Runtime determines LLM provider, model, temperature
- May include system prompt from agent config

#### `history: Message[]`

Read-only access to current conversation history.

```typescript
console.log(`History has ${ctx.history.length} messages`);
```

**Usage:**
- Inspect conversation state
- Pass to `callLLM()`
- Debug conversation flow

## Implementation Pattern

### Agent Definition

Use `defineConversationalAssistant` from `@vibe-agent-toolkit/agent-runtime`:

```typescript
import { defineConversationalAssistant, type Agent } from '@vibe-agent-toolkit/agent-runtime';

export const myAgent: Agent<MyInput, MyOutput> = defineConversationalAssistant(
  {
    name: 'my-agent',
    description: 'What the agent does',
    version: '1.0.0',
    inputSchema: MyInputSchema,
    outputSchema: MyOutputSchema,
    systemPrompt: `Instructions for the LLM...`,
    mockable: false, // true for testing
  },
  async (input, ctx) => {
    // Handler implementation
  }
);
```

### Handler Function Signature

```typescript
async (input: TInput, ctx: ConversationalContext) => Promise<TOutput>
```

**Parameters:**
- `input`: Validated input (user message + session state)
- `ctx`: Conversation context with history and LLM access

**Returns:**
- Validated output (reply + updated state)

### Context Object Structure

```typescript
interface ConversationalContext {
  mockable: boolean;
  history: Message[];
  addToHistory(role: string, content: string): void;
  callLLM(messages: Message[]): Promise<string>;
}
```

**Provided by runtime adapter:**
- `history`: Starts empty, grows as messages added
- `addToHistory`: Mutates history array
- `callLLM`: Configured by runtime (provider, model, API keys)
- `mockable`: Flag from agent config

### State Management Approach

**Pattern: Client-Managed State**

```typescript
// Turn 1: No prior state
const turn1 = await agent.execute({ message: 'Hi!' }, context);
// Returns: { reply: '...', updatedProfile: { phase: 'gathering' } }

// Turn 2: Pass updated profile from turn 1
const turn2 = await agent.execute({
  message: 'I love jazz',
  sessionState: { profile: turn1.updatedProfile }
}, context);
// Returns: { reply: '...', updatedProfile: { phase: 'gathering', music: 'jazz' } }
```

**Why client-managed?**
- Enables stateless agent deployment
- Works with any runtime (HTTP, websockets, CLI)
- Client controls session lifetime
- No server-side session storage needed

**State Schema:**
- Define with Zod for validation
- Keep minimal and serializable
- Avoid storing conversation history in state (use `ctx.history`)

## Runtime Adapter Pattern

Runtime adapters translate framework-specific LLM APIs into the VAT conversational context interface.

### What Each Runtime Must Implement

#### 1. History Array Management

```typescript
// Example: Vercel AI SDK adapter
const history: Message[] = [];

const context: ConversationalContext = {
  history,
  addToHistory: (role: string, content: string) => {
    history.push({ role, content });
  },
  // ...
};
```

**Behavior:**
- Start with empty array for new conversations
- Mutate array when `addToHistory` called
- Pass to `callLLM` when agent requests

#### 2. LLM Call Integration

```typescript
// Example: OpenAI adapter
async callLLM(messages: Message[]): Promise<string> {
  const response = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: messages.map(m => ({
      role: m.role,
      content: m.content,
    })),
  });
  return response.choices[0]?.message?.content ?? '';
}
```

**Requirements:**
- Accept `Message[]` array
- Map to framework's message format
- Handle system prompt (if not in messages)
- Return response as string
- Handle errors gracefully

#### 3. State Passing Between Turns

```typescript
// Example: HTTP API adapter
app.post('/agent/chat', async (req, res) => {
  const { message, sessionState } = req.body;

  // Create fresh context for this turn
  const context = createConversationalContext();

  // Execute agent
  const result = await agent.execute({ message, sessionState }, context);

  // Return updated state to client
  res.json({
    reply: result.reply,
    sessionState: { profile: result.updatedProfile }
  });
});
```

**Pattern:**
- Extract `sessionState` from request
- Pass to agent in input
- Return updated state in response
- Client stores and sends back next turn

## Example Implementation: Breed Advisor

The breed advisor demonstrates all conversational patterns:

### Agent Definition

```typescript
export const breedAdvisorAgent = defineConversationalAssistant(
  {
    name: 'breed-advisor',
    description: 'Conversational assistant that helps users find their perfect cat breed',
    version: '1.0.0',
    inputSchema: BreedAdvisorInputSchema,
    outputSchema: BreedAdvisorOutputSchema,
    systemPrompt: `You are an enthusiastic cat breed advisor...

    You track these factors across conversation:
    1. Living space
    2. Activity level
    3. Grooming tolerance
    4. Family composition
    5. Allergies
    6. Music preference (CRITICAL!)

    Return JSON with:
    {
      "reply": "your conversational response",
      "updatedProfile": { ...all factors and conversationPhase },
      "recommendations": [...] // optional
    }`,
    mockable: false,
  },
  async (input, ctx) => {
    // Implementation
  }
);
```

### Input/Output Schemas

```typescript
const BreedAdvisorInputSchema = z.object({
  message: z.string().describe('User message'),
  sessionState: z.object({
    profile: SelectionProfileSchema,
  }).optional().describe('Current session state'),
});

const BreedAdvisorOutputSchema = z.object({
  reply: z.string().describe('Agent response to user'),
  updatedProfile: SelectionProfileSchema.describe('Updated selection profile'),
  recommendations: z.array(z.object({
    breed: z.string(),
    matchScore: z.number().min(0).max(100),
    reasoning: z.string(),
  })).optional().describe('Breed recommendations if ready'),
});

const SelectionProfileSchema = z.object({
  livingSpace: z.enum(['apartment', 'small-house', 'large-house', 'farm']).optional(),
  activityLevel: z.enum(['couch-companion', 'playful-moderate', 'active-explorer', 'high-energy-athlete']).optional(),
  groomingTolerance: z.enum(['minimal', 'weekly', 'daily']).optional(),
  familyComposition: z.enum(['single', 'couple', 'young-kids', 'older-kids', 'multi-pet']).optional(),
  allergies: z.boolean().optional(),
  musicPreference: z.enum(['classical', 'jazz', 'rock', 'metal', 'pop', 'country', 'electronic', 'none']).optional(),
  conversationPhase: z.enum(['gathering', 'ready-to-recommend', 'refining']),
});
```

### Handler Implementation

```typescript
async (input, ctx) => {
  // 1. Initialize profile from session state or start fresh
  const currentProfile: SelectionProfile = input.sessionState?.profile ?? {
    conversationPhase: 'gathering',
  };

  // 2. Add context to conversation history
  ctx.addToHistory('system', 'Current profile: ' + JSON.stringify(currentProfile));
  ctx.addToHistory('user', input.message);

  // 3. Call LLM with full conversation history
  const llmResponse = await ctx.callLLM(ctx.history);

  // 4. Parse and validate response
  let parsed: BreedAdvisorOutput;
  try {
    const cleaned = stripMarkdownFences(llmResponse);
    parsed = BreedAdvisorOutputSchema.parse(JSON.parse(cleaned));
  } catch (error) {
    // Retry once with schema error feedback
    ctx.addToHistory('system', `ERROR: Invalid output format. Error: ${error}. Please return valid JSON matching the schema.`);
    const retryResponse = await ctx.callLLM(ctx.history);
    const cleaned = stripMarkdownFences(retryResponse);
    parsed = BreedAdvisorOutputSchema.parse(JSON.parse(cleaned));
  }

  // 5. Generate recommendations if factors sufficient
  const factorCount = countFactors(parsed.updatedProfile);
  if (factorCount >= 4 && parsed.recommendations === undefined) {
    parsed.recommendations = matchBreeds(parsed.updatedProfile);
  }

  // 6. Update conversation phase based on factors
  if (factorCount < 4) {
    parsed.updatedProfile.conversationPhase = 'gathering';
  } else if (factorCount < 6) {
    parsed.updatedProfile.conversationPhase = 'ready-to-recommend';
  } else {
    parsed.updatedProfile.conversationPhase = 'refining';
  }

  // 7. Add assistant response to history
  ctx.addToHistory('assistant', parsed.reply);

  return parsed;
}
```

### Multi-Turn Conversation Flow

```typescript
// Turn 1: Initial greeting
const turn1 = await breedAdvisorAgent.execute({
  message: "Hi! I need help finding a cat breed."
}, context);
// Returns: { reply: "Hello! What kind of music do you enjoy?", updatedProfile: { conversationPhase: 'gathering' } }

// Turn 2: Music preference + apartment (2 factors extracted)
const turn2 = await breedAdvisorAgent.execute({
  message: "I love classical music and I live in a small apartment.",
  sessionState: { profile: turn1.updatedProfile }
}, context);
// Returns: {
//   reply: "Excellent! Classical music suggests calm, regal breeds...",
//   updatedProfile: {
//     musicPreference: 'classical',
//     livingSpace: 'apartment',
//     conversationPhase: 'gathering'
//   }
// }

// Turn 3: Grooming preference (3 factors)
const turn3 = await breedAdvisorAgent.execute({
  message: "I can handle weekly grooming, but daily would be too much.",
  sessionState: { profile: turn2.updatedProfile }
}, context);
// Returns: { ..., updatedProfile: { ..., groomingTolerance: 'weekly', conversationPhase: 'gathering' } }

// Turn 4: Activity level (4 factors → ready phase with recommendations!)
const turn4 = await breedAdvisorAgent.execute({
  message: "I want a cat that is playful but not too high-energy.",
  sessionState: { profile: turn3.updatedProfile }
}, context);
// Returns: {
//   reply: "Based on your preferences, I recommend...",
//   updatedProfile: { ..., activityLevel: 'playful-moderate', conversationPhase: 'ready-to-recommend' },
//   recommendations: [
//     { breed: 'Ragdoll', matchScore: 85, reasoning: '...' },
//     { breed: 'Persian', matchScore: 80, reasoning: '...' },
//   ]
// }

// Turn 5: Specific breed question (refining phase)
const turn5 = await breedAdvisorAgent.execute({
  message: "Tell me more about the Ragdoll breed.",
  sessionState: { profile: turn4.updatedProfile }
}, context);
// Returns: { reply: "Ragdolls are gentle giants known for...", updatedProfile: { ..., conversationPhase: 'refining' } }
```

### Music-Breed Matching System

The breed advisor uses a whimsical but realistic matching algorithm:

**Music as CRITICAL Factor:**
- Music preference receives 30 points (30% weight, 2x any other factor)
- Theory: Music genre aligns with breed temperament through "vibrational frequency compatibility"

**Breed-Music Alignment:**
- Classical → Calm, regal breeds (Persian, Ragdoll)
- Jazz → Intelligent, unpredictable breeds (Siamese, Bengal)
- Rock/Metal → High-energy, bold breeds (Maine Coon, Abyssinian)
- Pop → Social, adaptable breeds (Domestic Shorthair)
- Electronic → Modern, quirky breeds (Sphynx, Devon Rex)
- Country → Traditional, loyal breeds (American Shorthair)
- None/Silence → Independent, mysterious breeds (Russian Blue)

**Scoring Algorithm:**
```typescript
function matchBreeds(profile: SelectionProfile): BreedMatch[] {
  // Music preference: 30 points (CRITICAL!)
  // Activity level: 20 points
  // Living space: 15 points
  // Grooming tolerance: 15 points
  // Family composition: 10 points
  // Hard filters: allergies, young kids

  // Score each breed, sort by score, return top 5
}
```

### State Management

**Profile Accumulation:**
```typescript
// Turn 1: { conversationPhase: 'gathering' }
// Turn 2: { musicPreference: 'classical', livingSpace: 'apartment', conversationPhase: 'gathering' }
// Turn 3: { ..., groomingTolerance: 'weekly', conversationPhase: 'gathering' }
// Turn 4: { ..., activityLevel: 'playful-moderate', conversationPhase: 'ready-to-recommend' }
```

**Phase Transitions:**
- **Gathering** (<4 factors): Agent asks questions to collect missing factors
- **Ready** (4-6 factors): Agent provides initial recommendations, may still gather more
- **Refining** (6+ factors): Agent explores alternatives, answers detailed questions

**Factor Count Drives Behavior:**
```typescript
const factorCount = [
  profile.musicPreference,
  profile.activityLevel,
  profile.livingSpace,
  profile.groomingTolerance,
  profile.familyComposition,
  profile.allergies === undefined ? undefined : 'allergies',
].filter(Boolean).length;

if (factorCount < 4) {
  profile.conversationPhase = 'gathering';
} else if (factorCount < 6) {
  profile.conversationPhase = 'ready-to-recommend';
} else {
  profile.conversationPhase = 'refining';
}
```

## Testing Strategy

### Mock Contexts for Unit Tests

```typescript
function createMockContext(llmResponse: string): ConversationalContext {
  return {
    mockable: true,
    history: [],
    addToHistory: () => {},
    callLLM: async () => llmResponse,
  };
}

it('should extract music preference from natural language', async () => {
  const mockContext = createMockContext(JSON.stringify({
    reply: 'Excellent! Classical music suggests calm breeds.',
    updatedProfile: {
      musicPreference: 'classical',
      conversationPhase: 'gathering',
    },
  }));

  const result = await breedAdvisorAgent.execute({
    message: 'I love classical music',
    sessionState: { profile: { conversationPhase: 'gathering' } }
  }, mockContext);

  expect(result.updatedProfile.musicPreference).toBe('classical');
});
```

**Advantages:**
- Fast (no real LLM calls)
- Deterministic (same input = same output)
- Test agent logic without LLM variability
- CI/CD friendly

### Multi-Turn Conversation Tests

```typescript
it('should transition to ready phase with 4 factors', async () => {
  const mockContext = createMockContext(JSON.stringify({
    reply: 'Great! Here are my recommendations:',
    updatedProfile: {
      musicPreference: 'pop',
      livingSpace: 'apartment',
      familyComposition: 'couple',
      groomingTolerance: 'minimal',
      conversationPhase: 'ready-to-recommend',
    },
    recommendations: [
      { breed: 'Domestic Shorthair', matchScore: 80, reasoning: '...' }
    ],
  }));

  const result = await breedAdvisorAgent.execute({
    message: 'I prefer minimal grooming',
    sessionState: {
      profile: {
        musicPreference: 'pop',
        livingSpace: 'apartment',
        familyComposition: 'couple',
        conversationPhase: 'gathering',
      }
    }
  }, mockContext);

  expect(result.updatedProfile.conversationPhase).toBe('ready-to-recommend');
  expect(result.recommendations).toBeDefined();
  expect(result.recommendations?.length).toBeGreaterThan(0);
});
```

### State Persistence Verification

```typescript
it('should preserve factors across turns', async () => {
  // Turn 1: Add music preference
  const turn1 = await agent.execute({ message: 'I love jazz' }, mockContext1);
  expect(turn1.updatedProfile.musicPreference).toBe('jazz');

  // Turn 2: Add living space, preserve music
  const turn2 = await agent.execute({
    message: 'I live in an apartment',
    sessionState: { profile: turn1.updatedProfile }
  }, mockContext2);

  expect(turn2.updatedProfile.musicPreference).toBe('jazz'); // Preserved!
  expect(turn2.updatedProfile.livingSpace).toBe('apartment'); // Added!
});
```

### Phase Transition Testing

```typescript
describe('conversation phase transitions', () => {
  it('gathering → ready-to-recommend at 4 factors', async () => {
    const profile = {
      musicPreference: 'classical',
      livingSpace: 'apartment',
      activityLevel: 'couch-companion',
      groomingTolerance: 'daily',
      conversationPhase: 'gathering' as const,
    };

    // Agent should transition to ready phase
    const result = await agent.execute({ message: 'What do you recommend?', sessionState: { profile } }, mockContext);
    expect(result.updatedProfile.conversationPhase).toBe('ready-to-recommend');
    expect(result.recommendations).toBeDefined();
  });

  it('ready-to-recommend → refining at 6 factors', async () => {
    const profile = {
      musicPreference: 'classical',
      livingSpace: 'apartment',
      activityLevel: 'couch-companion',
      groomingTolerance: 'daily',
      familyComposition: 'couple',
      allergies: false,
      conversationPhase: 'ready-to-recommend' as const,
    };

    const result = await agent.execute({ message: 'Tell me more about Persians', sessionState: { profile } }, mockContext);
    expect(result.updatedProfile.conversationPhase).toBe('refining');
  });
});
```

## Best Practices

### 1. Keep State Minimal and Serializable

**Good:**
```typescript
interface SessionState {
  profile: SelectionProfile;  // Simple object with enums and primitives
}
```

**Bad:**
```typescript
interface SessionState {
  database: Database;  // Not serializable
  callbacks: Map<string, Function>;  // Not serializable
  fullHistory: Message[];  // Bloated (use ctx.history instead)
}
```

**Why:**
- State must serialize to JSON for HTTP APIs, storage, etc.
- Keep state small to reduce network transfer
- Use `ctx.history` for conversation context (not duplicated in state)

### 2. Use Zod Schemas for Validation

```typescript
// Define once, get validation + TypeScript types
const ProfileSchema = z.object({
  musicPreference: z.enum(['classical', 'jazz', 'rock']).optional(),
  // ...
});

type Profile = z.infer<typeof ProfileSchema>;

// Runtime validation
const result = ProfileSchema.safeParse(data);
if (!result.success) {
  console.error('Validation errors:', result.error.issues);
}
```

**Benefits:**
- Single source of truth
- Runtime validation prevents bad state
- TypeScript types stay in sync
- Clear error messages

### 3. Implement Retry Logic for LLM Errors

```typescript
try {
  parsed = OutputSchema.parse(JSON.parse(llmResponse));
} catch (error) {
  // Retry once with schema error feedback
  ctx.addToHistory('system', `ERROR: Invalid output. Error: ${error}. Return valid JSON.`);
  const retryResponse = await ctx.callLLM(ctx.history);
  parsed = OutputSchema.parse(JSON.parse(retryResponse));
}
```

**Why:**
- LLMs occasionally return invalid JSON
- Schema feedback helps LLM correct itself
- One retry typically sufficient
- Fail fast after retry (don't loop forever)

### 4. Document Conversation Phases

```typescript
/**
 * Conversation phases:
 * - gathering: <4 factors, agent asks questions
 * - ready-to-recommend: 4-6 factors, can provide recommendations
 * - refining: 6+ factors, explores alternatives
 */
conversationPhase: z.enum(['gathering', 'ready-to-recommend', 'refining'])
```

**Benefits:**
- Clear state machine
- Easy to reason about behavior
- Testable transitions
- Documented in schema

### 5. Strip Markdown Fences from LLM Responses

```typescript
function stripMarkdownFences(text: string): string {
  let cleaned = text.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```[a-zA-Z]*\n?/, '');
    cleaned = cleaned.replace(/\n?```$/, '');
  }
  return cleaned;
}
```

**Why:**
- LLMs often wrap JSON in markdown code fences
- Makes parsing more robust
- Handles `json`, `typescript`, and plain `` ``` ``

### 6. Use System Messages to Pass State

```typescript
ctx.addToHistory('system', 'Current profile: ' + JSON.stringify(currentProfile));
ctx.addToHistory('user', input.message);
```

**Why:**
- LLM sees current state before user message
- More context = better responses
- System messages don't clutter conversation display

### 7. Factor Count Determines Recommendations

```typescript
const factorCount = countFactors(profile);

if (factorCount >= 4 && recommendations === undefined) {
  recommendations = generateRecommendations(profile);
}
```

**Pattern:**
- Don't force recommendations too early (bad UX)
- Don't wait too long (user impatience)
- 4-6 factors = good balance
- Always respect explicit requests for recommendations

### 8. Hard Filters vs Soft Scoring

```typescript
// Hard filters (must match)
if (profile.allergies === true) {
  candidates = candidates.filter(breed => breed.hypoallergenic);
}

// Soft scoring (nice to have)
if (profile.musicPreference === breed.musicAlignment) {
  score += 30;
}
```

**When to use:**
- Hard filters: Safety, legal, absolute requirements
- Soft scoring: Preferences, tradeoffs, recommendations

## Related Documentation

- [VAT Architecture Overview](./README.md) - Package structure and evolution
- [Agent Schema Documentation](../../packages/agent-schema/README.md) - Manifest format
- [Breed Advisor Source](../../packages/vat-example-cat-agents/src/conversational-assistant/breed-advisor.ts) - Reference implementation
- [Conversational Demo](../../packages/vat-example-cat-agents/examples/conversational-demo.ts) - Multi-turn example
- [Agent Runtime API](../../packages/agent-runtime/src/index.ts) - Runtime framework exports

## Summary

Conversational agents in VAT:
- Maintain context across multiple turns using conversation history
- Manage session state through client-side persistence
- Extract structured information from natural dialogue
- Provide personalized responses based on accumulated context
- Use phase transitions to guide conversation flow
- Require runtime adapters to implement history + LLM APIs

The breed advisor serves as the canonical reference implementation, demonstrating:
- Multi-turn state accumulation
- Natural language factor extraction
- Phase-driven conversation flow
- Music-based matching algorithm (whimsical but realistic)
- Robust LLM error handling with retry logic
- Comprehensive test coverage with mock contexts

When building conversational agents, follow the patterns demonstrated in the breed advisor for reliable, maintainable, and testable implementations.

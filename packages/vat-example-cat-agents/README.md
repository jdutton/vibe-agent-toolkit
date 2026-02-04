# @vibe-agent-toolkit/vat-example-cat-agents

**Example agents demonstrating VAT patterns across 9 agent archetypes.**

## Purpose

This package serves as a **reference implementation** for the Vibe Agent Toolkit (VAT). It demonstrates how to build portable agents that work across multiple frameworks (Vercel AI SDK, LangChain, Claude Agent SDK, n8n) using a whimsical but realistic cat breeding domain.

**Why cats?** The domain provides realistic complexity (genetics, compliance, multi-step workflows) while remaining approachable and fun. Think of it as the "TodoMVC" of agentic AI frameworks.

## Current Status

**Implementation Progress:** 4 of 9 archetypes, 8 agents

| Archetype | Status | Agents |
|-----------|--------|--------|
| 1. Pure Function Tool | ✅ Complete | 2 agents |
| 2. One-Shot LLM Analyzer | ✅ Complete | 4 agents |
| 3. Conversational Assistant | ✅ Complete | 1 agent |
| 4. Agentic Researcher (ReAct) | ⏸️ Planned | 0 agents |
| 5. Function Workflow Orchestrator | ⏸️ Planned | 0 agents |
| 6. LLM Intelligent Coordinator | ⏸️ Planned | 0 agents |
| 7. Function Event Consumer | ⏸️ Planned | 0 agents |
| 8. LLM Event Handler | ⏸️ Planned | 0 agents |
| 9. External Event Integrator | ✅ Complete | 1 agent |

**Note:** This is a living example package. Archetypes are implemented as we validate the VAT framework design.

## Installation

```bash
npm install @vibe-agent-toolkit/vat-example-cat-agents
```

## Result Envelopes

All VAT agents return standardized result envelopes following Railway-Oriented Programming (ROP) principles. This provides consistent error handling, type-safe result processing, and clear orchestration patterns.

### OneShotAgentOutput (Pure Functions & One-Shot LLM)

Pure function tools and one-shot LLM analyzers return `OneShotAgentOutput<TData, TError>`:

```typescript
interface OneShotAgentOutput<TData, TError> {
  result: AgentResult<TData, TError>;
}

type AgentResult<TData, TError> =
  | { status: 'success'; data: TData }
  | { status: 'error'; error: TError };
```

**Example:**
```typescript
const output = await haikuValidator.execute({ text, syllables, kigo, kireji });

if (output.result.status === 'success') {
  console.log('Valid:', output.result.data.valid);
} else {
  console.error('Invalid:', output.result.error);
}
```

### ConversationalAgentOutput (Multi-Turn Agents)

Conversational assistants return `ConversationalAgentOutput<TData, TError, TState>`:

```typescript
interface ConversationalAgentOutput<TData, TError, TState> {
  reply: string;                // Natural language response
  sessionState: TState;         // Updated session state
  result: StatefulAgentResult<TData, TError, TMetadata>;
}

type StatefulAgentResult<TData, TError, TMetadata> =
  | { status: 'in-progress'; metadata?: TMetadata }
  | { status: 'success'; data: TData }
  | { status: 'error'; error: TError };
```

**Example:**
```typescript
const output = await breedAdvisor.execute({
  message: 'I love classical music',
  sessionState: { profile: { conversationPhase: 'gathering' } },
});

console.log('Agent says:', output.reply);           // For user
const nextState = output.sessionState;              // Carry to next turn

if (output.result.status === 'in-progress') {
  console.log('Gathering info:', output.result.metadata);
} else if (output.result.status === 'success') {
  console.log('Recommendation:', output.result.data);
}
```

See [Orchestration Guide](../../docs/orchestration.md) for detailed patterns and examples.

## Agent Catalog

### Archetype 1: Pure Function Tool

**Characteristics:** Stateless, synchronous, deterministic, no external dependencies

**Use Cases:** Validation, calculation, formatting, rule-based logic

#### Haiku Validator

Validates haiku structure according to traditional Japanese poetry rules.

```typescript
import { validateHaiku, type Haiku } from '@vibe-agent-toolkit/vat-example-cat-agents';

const haiku: Haiku = {
  line1: 'Autumn moon rises',
  line2: 'Silver light on quiet waves',
  line3: 'The cat sits and waits',
};

const result = validateHaiku(haiku);
console.log(result);
// {
//   valid: true,
//   syllables: { line1: 5, line2: 7, line3: 5 },
//   errors: [],
//   hasKigo: true,    // Seasonal reference detected
//   hasKireji: false  // No cutting word
// }
```

**Validation Rules:**
- 5-7-5 syllable structure (strict)
- Kigo detection (seasonal words: spring, autumn, winter, summer, etc.)
- Kireji detection (cutting words: や, かな, けり, etc.)

**Not Cat-Specific:** This is a general-purpose haiku validator, reusable for any haiku validation.

#### Name Validator

Validates cat names against whimsical characteristic-based rules.

```typescript
import { validateCatName, type CatCharacteristics } from '@vibe-agent-toolkit/vat-example-cat-agents';

const cat: CatCharacteristics = {
  physical: {
    furColor: 'Orange',
    furPattern: 'Tabby',
    eyeColor: 'Green',
    size: 'large',
  },
  behavioral: {
    personality: ['Regal', 'Demanding'],
  },
  description: 'A large orange tabby who rules the household',
};

const result = validateCatName('Duke Marmalade III', cat);
console.log(result);
// {
//   status: 'valid',
//   reason: 'Proper masculine nobility with food-related theme!'
// }
```

**Quirky Validation Rules:**
- Three-legged cats must have three-syllable names
- Black cats cannot have names containing the letter 'e'
- Orange cats must have food-related names (Marmalade, Pumpkin, etc.)
- High-energy cats need short names (≤5 letters)
- Fluffy cats need repeated consonants (Mittens, Fluffy, etc.)

**Purpose:** Tests feedback loops (60-70% rejection rate forces iteration patterns)

---

### Archetype 2: One-Shot LLM Analyzer

**Characteristics:** Single LLM call, no iteration, stateless, classification/extraction/generation

**Use Cases:** Image analysis, text parsing, classification, structured extraction, generation

#### Photo Analyzer

Extracts structured cat characteristics from images using vision LLM.

```typescript
import { analyzePhoto } from '@vibe-agent-toolkit/vat-example-cat-agents';

const characteristics = await analyzePhoto('/path/to/cat-photo.jpg');
console.log(characteristics);
// {
//   physical: {
//     furColor: 'Orange',
//     furPattern: 'Tabby',
//     eyeColor: 'Green',
//     breed: 'Domestic Shorthair',
//     size: 'medium'
//   },
//   behavioral: {
//     personality: ['Playful', 'Curious'],
//     quirks: []
//   },
//   description: 'An orange tabby cat with green eyes...'
// }
```

**Mock Mode:** Default behavior extracts from EXIF metadata + filename patterns (fast, free, deterministic). Set `mockable: false` to use real vision API.

**Multi-Modal Input:** Produces same `CatCharacteristics` schema as Description Parser (interchangeable inputs).

#### Description Parser

Parses unstructured text descriptions into structured cat characteristics.

```typescript
import { parseDescription } from '@vibe-agent-toolkit/vat-example-cat-agents';

const text = "Fluffy is a large, playful orange tabby with green eyes. She's very curious and loves to explore.";
const characteristics = await parseDescription(text);
// Returns same CatCharacteristics schema as Photo Analyzer
```

**Multi-Modal Convergence:** Text input → same schema as image input. Enables pipelines that accept either photos or descriptions.

#### Name Generator

Generates creative cat names based on characteristics.

```typescript
import { generateCatName } from '@vibe-agent-toolkit/vat-example-cat-agents';

const name = await generateCatName(characteristics);
console.log(name);
// {
//   name: 'Duke Marmalade III',
//   reasoning: 'Orange color suggests food theme, regal personality demands nobility',
//   alternatives: ['Sir Butterscotch', 'Lord Pumpkin']
// }
```

**No Knowledge of Rules:** Generator does NOT know the validation rules. This is intentional - tests feedback loop patterns where generator → validator → retry.

#### Haiku Generator

Creates cat-themed haikus from characteristics.

```typescript
import { generateHaiku } from '@vibe-agent-toolkit/vat-example-cat-agents';

const haiku = await generateHaiku(characteristics);
console.log(haiku);
// {
//   line1: 'Orange fur gleaming',
//   line2: 'Playful paws dance in sunshine',
//   line3: 'Green eyes watch and wait'
// }
```

**Feedback Loop:** Generated haikus can be validated with Haiku Validator. Tests iteration patterns.

---

### Archetype 3: Conversational Assistant

**Characteristics:** Multi-turn conversation, session state management, context accumulation, flexible dialogue

**Use Cases:** Advisory chatbots, guided workflows, interactive Q&A, personalized recommendations

#### Breed Selection Advisor

Helps users find their perfect cat breed through flexible, natural conversation. Tracks selection factors across multiple turns and provides personalized recommendations based on a whimsical music-breed compatibility theory.

```typescript
import { breedAdvisorAgent } from '@vibe-agent-toolkit/vat-example-cat-agents';

// Turn 1: Initial greeting
let result = await breedAdvisorAgent({
  message: "Hi! I'm looking for a cat breed that fits my lifestyle.",
  sessionState: undefined, // No prior state
});

console.log(result.reply);
// "Hello! I'd love to help you find the perfect breed! To get started, tell me..."
console.log(result.updatedProfile.conversationPhase); // "gathering"

// Turn 2: Provide information
result = await breedAdvisorAgent({
  message: "I live in a small apartment and work from home. I listen to jazz music while coding.",
  sessionState: {
    profile: result.updatedProfile, // Pass updated profile from previous turn
  },
});

console.log(result.reply);
// "Excellent! Jazz lovers tend to appreciate cats with..."
console.log(result.updatedProfile);
// {
//   livingSpace: 'apartment',
//   musicPreference: 'jazz',
//   conversationPhase: 'gathering'
// }

// Turn 3: More information
result = await breedAdvisorAgent({
  message: "I prefer low-maintenance grooming and I'm moderately active.",
  sessionState: {
    profile: result.updatedProfile,
  },
});

console.log(result.updatedProfile.conversationPhase); // "ready-to-recommend"
console.log(result.recommendations);
// [
//   {
//     breed: 'Siamese',
//     matchScore: 85,
//     reasoning: 'music preference (jazz) aligns perfectly; activity level (playful-moderate) matches well; suitable for apartment living'
//   },
//   {
//     breed: 'Bengal',
//     matchScore: 70,
//     reasoning: 'music preference (jazz) aligns perfectly; grooming needs (minimal) match tolerance'
//   },
//   // ... more recommendations
// ]

// Turn 4: Follow-up question
result = await breedAdvisorAgent({
  message: "Tell me more about the Siamese - are they vocal?",
  sessionState: {
    profile: result.updatedProfile,
  },
});

console.log(result.updatedProfile.conversationPhase); // "refining"
// Agent provides detailed information about Siamese cats
```

**Selection Factors Tracked:**

1. **Living Space** - apartment, small-house, large-house, farm
2. **Activity Level** - couch-companion, playful-moderate, active-explorer, high-energy-athlete
3. **Grooming Tolerance** - minimal, weekly, daily
4. **Family Composition** - single, couple, young-kids, older-kids, multi-pet
5. **Allergies** - boolean (requires hypoallergenic breeds)
6. **Music Preference** - classical, jazz, rock, metal, pop, country, electronic, none (CRITICAL!)

**The Music Factor (CRITICAL!):**

This agent is built on a whimsical theory: **music preference is the MOST IMPORTANT factor** in cat breed selection!

Each music genre aligns with specific breed temperaments through "vibrational frequency compatibility":

- **Classical** → Calm, regal breeds (Persian, Ragdoll) - harmonic resonance
- **Jazz** → Intelligent, unpredictable breeds (Siamese, Bengal) - improvisational energy
- **Rock/Metal** → High-energy, bold breeds (Maine Coon, Abyssinian) - intensity matching
- **Pop** → Social, adaptable breeds (Domestic Shorthair) - mainstream compatibility
- **Electronic** → Modern, quirky breeds (Sphynx, Devon Rex) - synthetic-natural balance
- **Country** → Traditional, loyal breeds (American Shorthair) - heartland values
- **None/Silence** → Independent, mysterious breeds (Russian Blue) - zen alignment

Music preference receives **30 points (30% weight)** in the matching algorithm - more than any other factor!

**Conversation Phases:**

The agent automatically transitions through three phases based on information gathered:

1. **Gathering** (<4 factors): Asks questions to collect missing factors, prioritizes music preference
2. **Ready-to-Recommend** (4-6 factors): Can provide initial recommendations, still gathering more info
3. **Refining** (6+ factors or recommendations made): Explores alternatives, answers detailed questions

**State Management:**

Each turn receives the updated profile from the previous turn via `sessionState.profile`. The profile accumulates information across the conversation:

```typescript
{
  livingSpace?: 'apartment' | 'small-house' | 'large-house' | 'farm',
  activityLevel?: 'couch-companion' | 'playful-moderate' | 'active-explorer' | 'high-energy-athlete',
  groomingTolerance?: 'minimal' | 'weekly' | 'daily',
  familyComposition?: 'single' | 'couple' | 'young-kids' | 'older-kids' | 'multi-pet',
  allergies?: boolean,
  musicPreference?: 'classical' | 'jazz' | 'rock' | 'metal' | 'pop' | 'country' | 'electronic' | 'none',
  conversationPhase: 'gathering' | 'ready-to-recommend' | 'refining'
}
```

**Breed Matching Algorithm:**

Scores breeds based on profile factors:
- Music preference: 30 points (2x weight - CRITICAL!)
- Activity level: 20 points
- Living space: 15 points
- Grooming tolerance: 15 points
- Family composition: 10 points
- Hard filters: Allergies require hypoallergenic, young kids require good-with-kids

Returns top 5 breeds with match scores (0-100) and reasoning.

**Knowledge Base:**

The agent uses a curated database of 12 breeds with comprehensive trait profiles:
- Persian, Ragdoll, Siamese, Bengal, Maine Coon, Abyssinian
- Sphynx, Devon Rex, Russian Blue, Domestic Shorthair, American Shorthair, Scottish Fold

Each breed profile includes: activity levels, grooming needs, apartment suitability, kid/pet compatibility, hypoallergenic status, **music alignment**, temperament, and size.

---

### Archetype 9: External Event Integrator

**Characteristics:** Emits events to external systems, blocks waiting for response, timeout handling

**Use Cases:** Human-in-the-loop approval, API callbacks, webhook handlers, external service integration

#### Human Approval Gate

Requests human approval for decisions (mockable for testing).

```typescript
import { requestHumanApproval } from '@vibe-agent-toolkit/vat-example-cat-agents';

const decision = await requestHumanApproval({
  title: 'Breeding Permit Review',
  description: 'Duke Marmalade III x Lady Whiskers',
  context: { applicationId: '12345', risk: 'low' }
});

console.log(decision);
// { status: 'approved', approver: 'human@example.com', timestamp: '...' }
// OR
// { status: 'rejected', reason: 'Genetic coefficient too high', timestamp: '...' }
```

**Mock Mode:** Default returns instant approval. Set `mockable: false` for real HITL integration (Slack, email, etc.).

**Timeout Handling:** Configurable timeout with fallback behavior (default: 24 hours for human timescale).

**Integration Agnostic:** Does not constrain HOW approval is requested (Slack, email, custom UI). Framework adapters implement integration details.

---

## Planned Agents (Coming Soon)

### Archetype 4: Agentic Researcher (ReAct)

**Target:** Breed history researcher with tool-calling and iterative reasoning.

**Use Case:** Research cat breed origins using web search + document analysis tools.

### Archetype 5: Function Workflow Orchestrator

**Target:** Breeding approval pipeline with deterministic multi-agent coordination.

**Use Case:** Validate genetics → Generate name → Request approval → Update registry.

### Archetype 6: LLM Intelligent Coordinator

**Target:** Smart submission router with LLM decision-making at checkpoints.

**Use Case:** Route breeding applications based on complexity (auto-approve simple, escalate complex).

### Archetype 7: Function Event Consumer

**Target:** Pedigree file processor triggered by file upload events.

**Use Case:** Process uploaded pedigree documents and update registry.

### Archetype 8: LLM Event Handler

**Target:** Intelligent triage handler with LLM classification.

**Use Case:** Classify incoming submissions and route to appropriate queues.

---

## Running Demos

### Photo Analysis Demo

Demonstrates the photo analyzer with actual test fixture images:

```bash
bun run demo:photos
```

**What it does:**
- Loads 4 cat photos + 2 not-cat photos (bear, robot) from `test/fixtures/photos/`
- Analyzes each photo using **MOCK MODE** (EXIF metadata + filename patterns)
- Displays extracted characteristics
- Shows clear warning that it's not analyzing actual pixels

**Mock Mode vs Real Vision API:**
- **MOCK MODE** (default): Extracts from EXIF metadata and filename patterns. Fast, free, deterministic. Does NOT analyze actual pixels.
- **REAL MODE** (future): Set `USE_REAL_VISION=true` to call actual vision API (Claude Vision, GPT-4 Vision). Slow, costs money, analyzes actual pixels.

### Runtime Adapter Demos

To see cat agents used across different frameworks:

```bash
# Vercel AI SDK demo
cd packages/runtime-vercel-ai-sdk
bun run demo

# LangChain demo
cd packages/runtime-langchain
bun run demo

# OpenAI SDK demo
cd packages/runtime-openai
bun run demo

# Claude Agent SDK demo
cd packages/runtime-claude-agent-sdk
bun run demo
```

These demos show the **same cat agents** working across different runtimes, demonstrating portability.

---

## Core Schemas

All agents use shared Zod schemas for type safety:

### CatCharacteristics

```typescript
{
  physical: {
    furColor: string,
    furPattern?: string,
    eyeColor?: string,
    breed?: string,
    size: 'tiny' | 'small' | 'medium' | 'large'
  },
  behavioral: {
    personality: string[],
    quirks?: string[]
  },
  description: string
}
```

### Haiku

```typescript
{
  line1: string,  // 5 syllables
  line2: string,  // 7 syllables
  line3: string   // 5 syllables
}
```

### NameSuggestion

```typescript
{
  name: string,
  reasoning: string,
  alternatives: string[]
}
```

### ValidationResult

```typescript
{
  status: 'valid' | 'invalid',
  reason: string,
  suggestedFixes?: string[]
}
```

---

## Architecture Highlights

### Multi-Modal Input Convergence

Photo Analyzer and Description Parser both produce `CatCharacteristics` schema. This enables pipelines that accept **either** images **or** text descriptions interchangeably.

```typescript
// Pipeline works with EITHER input type
const characteristics = isImage(input)
  ? await analyzePhoto(input)
  : await parseDescription(input);

const name = await generateCatName(characteristics);
const haiku = await generateHaiku(characteristics);
```

### Feedback Loop Testing

Name Generator → Name Validator creates a realistic feedback loop:
- Generator creates names without knowledge of rules
- Validator rejects ~60-70% of names (quirky rules)
- Forces retry/iteration patterns
- Tests multi-turn orchestration

### Framework Portability

All agents are **plain TypeScript functions** with no framework dependencies. Runtime adapters translate agents to framework-specific formats:

- **Vercel AI SDK**: Agents → Tools with `execute` functions
- **LangChain**: Agents → Tools with structured I/O
- **Claude Agent SDK**: Agents → Agent objects with tool handlers
- **n8n**: Agents → Custom nodes with visual wiring

**Same agents, different orchestration.**

---

## Development

```bash
# Install dependencies
bun install

# Build
bun run build

# Run tests
bun run test

# Type check
bun run typecheck

# Lint
bun run lint

# Run demos
bun run demo:photos
```

---

## Test Fixtures

### Processing Cat Photos

This package includes git-friendly test images with embedded EXIF metadata for realistic testing.

**Strategy:**
- Original images: 1-9MB each (too large for git)
- Processed images: 13-60KB each (git-friendly)
- Embedded EXIF metadata contains test expectations
- Mock mode reads EXIF instead of calling vision API

**Processing images:**

```bash
# From repo root
cd packages/dev-tools
bun run process-images ~/Downloads/cat-photos ../../vat-example-cat-agents/test/fixtures/photos/cats
```

See `@vibe-agent-toolkit/dev-tools` package for the `process-test-images.ts` utility.

**Fixture structure:**

```
test/fixtures/photos/
├── cats/          # Valid cat photos (4 images)
├── not-cats/      # Negative test cases (bear, robot)
└── cat-like/      # Ambiguous cases (future: stuffed animals, statues)
```

---

## Contributing

This is a reference implementation that evolves with the VAT framework. Each new archetype implementation helps validate the framework design.

**Current priorities:**
1. Complete remaining LLM analyzer agents (conversational assistant)
2. Implement agentic researcher (ReAct pattern with tools)
3. Add workflow orchestrator (multi-agent pipelines)
4. Demonstrate event-driven patterns (consumers and handlers)

See [CLAUDE.md](./CLAUDE.md) for technical navigation details when contributing.

---

## Documentation

- **[structure.md](./docs/structure.md)** - Package organization and conventions
- **[CLAUDE.md](./CLAUDE.md)** - Technical navigation for AI assistants

---

## License

MIT

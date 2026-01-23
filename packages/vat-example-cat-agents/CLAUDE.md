# Claude Code Navigation Guide

This file provides technical navigation details for AI assistants working on `vat-example-cat-agents`.

## Quick Reference

**Package Purpose:** Reference implementation demonstrating VAT agent patterns across 9 archetypes using cat breeding domain.

**Current Status:** 4 of 9 archetypes implemented (8 agents total)

**Key Principle:** Agents are plain TypeScript functions. No framework dependencies in agent code.

## Directory Navigation

```
packages/vat-example-cat-agents/
├── src/
│   ├── types/schemas.ts               # Shared Zod schemas (CatCharacteristics, Haiku, etc.)
│   │
│   ├── pure-function-tool/            # Archetype 1 (2 agents)
│   │   ├── haiku-validator.ts         # Validates 5-7-5 syllable structure + kigo/kireji
│   │   └── name-validator.ts          # Quirky characteristic-based validation
│   │
│   ├── one-shot-llm-analyzer/         # Archetype 2 (4 agents)
│   │   ├── photo-analyzer.ts          # Vision LLM → CatCharacteristics
│   │   ├── description-parser.ts      # Text → CatCharacteristics (same schema as photo)
│   │   ├── name-generator.ts          # CatCharacteristics → NameSuggestion
│   │   └── haiku-generator.ts         # CatCharacteristics → Haiku
│   │
│   ├── conversational-assistant/      # Archetype 3 (1 agent)
│   │   ├── breed-advisor.ts           # Multi-turn breed selection advisor
│   │   └── breed-knowledge.ts         # Breed database and matching algorithm
│   │
│   ├── external-event-integrator/     # Archetype 9 (1 agent)
│   │   └── human-approval.ts          # HITL approval gate (mockable)
│   │
│   ├── utils/
│   │   └── color-extraction.ts        # Helper: Extract colors from descriptions
│   │
│   └── index.ts                       # Public exports
│
├── test/
│   ├── pure-function-tool/            # Unit tests for validators
│   ├── one-shot-llm-analyzer/         # Tests for LLM analyzers
│   ├── external-event-integrator/     # Tests for HITL
│   ├── fixtures/
│   │   └── photos/                    # Test images with EXIF metadata
│   │       ├── cats/                  # 4 cat photos (~40KB each)
│   │       ├── not-cats/              # 2 negative cases (bear, robot)
│   │       └── cat-like/              # Future: ambiguous cases
│   └── test-helpers.ts                # Shared test utilities
│
├── examples/
│   ├── photo-analysis-demo.ts         # Demos photo analyzer with test fixtures
│   ├── runtime-adapter-demo.ts        # Shared runtime adapter demo
│   ├── llm-agent-demo.ts              # LLM agent usage patterns
│   └── demo-helpers.ts                # Terminal color output utilities
│
├── README.md                          # Human-facing documentation
├── CLAUDE.md                          # This file (AI navigation)
├── STRUCTURE.md                       # Package organization details
└── package.json
```

## Agent Organization by Archetype

### Implemented Archetypes

**Archetype 1: Pure Function Tool**
- Location: `src/pure-function-tool/`
- Characteristics: Stateless, deterministic, no external dependencies
- Agents:
  - `haiku-validator.ts` - Syllable counting + kigo/kireji detection
  - `name-validator.ts` - Characteristic-based quirky rules (60-70% rejection rate)

**Archetype 2: One-Shot LLM Analyzer**
- Location: `src/one-shot-llm-analyzer/`
- Characteristics: Single LLM call, stateless, classification/extraction
- Agents:
  - `photo-analyzer.ts` - Vision LLM (mockable via EXIF)
  - `description-parser.ts` - Text parsing (multi-modal convergence with photo)
  - `name-generator.ts` - Creative name generation
  - `haiku-generator.ts` - Haiku creation

**Archetype 3: Conversational Assistant**
- Location: `src/conversational-assistant/`
- Characteristics: Multi-turn conversation, session state, context accumulation
- Agents:
  - `breed-advisor.ts` - Breed selection advisor with music-based matching
  - `breed-knowledge.ts` - Breed database with 12 breeds and matching algorithm

**Archetype 9: External Event Integrator**
- Location: `src/external-event-integrator/`
- Characteristics: Emits events, blocks waiting, timeout handling
- Agents:
  - `human-approval.ts` - HITL approval (mockable)

### Missing Archetypes (Planned)

**Archetype 4: Agentic Researcher (ReAct)** ⏸️
- Needs: Tool calling, iterative reasoning
- Target: Breed history researcher with web search

**Archetype 5: Function Workflow Orchestrator** ⏸️
- Needs: Deterministic multi-agent coordination
- Target: Breeding approval pipeline
- NOTE: Previous implementation removed during AI SDK v6 migration

**Archetype 6: LLM Intelligent Coordinator** ⏸️
- Needs: LLM routing decisions in fixed workflow
- Target: Smart submission router

**Archetype 7: Function Event Consumer** ⏸️
- Needs: Event-triggered execution
- Target: Pedigree file processor

**Archetype 8: LLM Event Handler** ⏸️
- Needs: Event-triggered with LLM processing
- Target: Intelligent triage handler

## Code Patterns

### Agent File Structure

Each agent file exports both the function and metadata:

```typescript
// src/<archetype>/<agent-name>.ts

import { z } from 'zod';
import { InputSchema, OutputSchema } from '../types/schemas.js';

/**
 * Agent function implementation
 */
export async function agentFunction(input: z.infer<typeof InputSchema>): Promise<z.infer<typeof OutputSchema>> {
  // Implementation
}

/**
 * Agent metadata (for future VAT integration)
 */
export const AgentMetadata = {
  id: 'archetype/agent-name',
  name: 'Human Readable Name',
  description: 'What this agent does',
  archetype: 'archetype-name',
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
};
```

### Multi-Modal Convergence Pattern

Photo Analyzer and Description Parser both produce `CatCharacteristics`:

```typescript
// Both functions return the same schema
const fromImage = await analyzePhoto(imagePath);   // Vision LLM
const fromText = await parseDescription(text);     // Text parsing LLM

// Downstream agents accept either
const name = await generateCatName(fromImage);     // Works
const name = await generateCatName(fromText);      // Also works
```

### Mockable Pattern (Testing)

Agents that call expensive APIs support mock mode:

```typescript
// photo-analyzer.ts
export async function analyzePhoto(
  imagePath: string,
  options: { mockable?: boolean } = {}
): Promise<CatCharacteristics> {
  const { mockable = true } = options;

  if (mockable) {
    // Read from EXIF metadata (fast, free, deterministic)
    return extractFromExif(imagePath);
  }

  // Call real vision API (slow, costs money)
  return callVisionAPI(imagePath);
}
```

### Feedback Loop Pattern

Generator + Validator creates iteration pattern:

```typescript
// Generator has NO knowledge of validation rules
const suggestion = await generateCatName(characteristics);

// Validator rejects ~60-70% (quirky rules)
const validation = validateCatName(suggestion.name, characteristics);

if (validation.status === 'invalid') {
  // Retry with different approach
  // Tests multi-turn orchestration
}
```

## Shared Schemas

All agents use schemas from `src/types/schemas.ts`:

### Core Schemas

- **CatCharacteristics** - Physical + behavioral traits
- **Haiku** - Three-line poem structure
- **NameSuggestion** - Name + reasoning + alternatives
- **NameValidationResult** - Approval/rejection with reason
- **HaikuValidationResult** - Syllable counts + errors + kigo/kireji

### Schema Relationships

```
Photo/Text Input
      ↓
CatCharacteristics ────┬─→ Name Generator → NameSuggestion → Name Validator
                       │
                       └─→ Haiku Generator → Haiku → Haiku Validator
```

## Test Fixtures Strategy

### Images with EXIF Metadata

**Problem:** Vision APIs are slow and expensive for testing.

**Solution:** Embed test expectations in EXIF metadata.

**Process:**
1. Download cat photos from Unsplash (~1-9MB each)
2. Run `process-test-images.ts` utility:
   - Resizes to 512px wide
   - Compresses to ~50KB
   - Extracts metadata from filename patterns
   - Writes JSON to EXIF Description field
3. Commit processed images to git (~40KB each)

**Mock Mode:**
- Reads EXIF metadata instead of calling vision API
- Fast, free, deterministic
- Perfect for CI/CD

**Real Mode:**
- Set `mockable: false`
- Calls actual vision API
- Slow, costs money, non-deterministic
- Use sparingly for integration tests

### Filename Patterns

The `process-test-images.ts` utility auto-detects from filenames:

- **Colors:** `orange`, `black`, `white`, `gray`, `calico`
- **Patterns:** `tabby`, `solid`, `patched`, `striped`
- **Sizes:** `tiny`, `small`, `large` (default: `medium`)
- **Breeds:** `persian`, `maine-coon`, `siamese`, `domestic-shorthair`
- **Personality:** `playful`, `lazy`, `grumpy`, `affectionate`, `curious`, `regal`
- **Quirks:** `three-leg`, `cross-eye`, `scar`

**Example:** `orange-tabby-playful.jpg` → Orange tabby with playful personality

## Running Tests

```bash
# All tests
bun run test

# Watch mode
bun run test:watch

# Coverage
bun run test:coverage

# Specific archetype
bun run test src/pure-function-tool
```

## Running Demos

```bash
# Photo analysis demo (uses test fixtures)
bun run demo:photos

# Runtime adapter demos (in other packages)
cd packages/runtime-vercel-ai-sdk && bun run demo
cd packages/runtime-langchain && bun run demo
```

## Adding New Agents

### Step 1: Choose Archetype

Determine which of the 9 archetypes fits your agent.

### Step 2: Create Agent File

```bash
# Create in appropriate archetype directory
touch src/<archetype>/<agent-name>.ts
```

### Step 3: Implement Agent

Follow the agent file structure pattern (see Code Patterns above).

### Step 4: Add Tests

```bash
# Create test file
touch test/<archetype>/<agent-name>.test.ts
```

### Step 5: Export from Index

```typescript
// src/index.ts
export * from './<archetype>/<agent-name>.js';
```

### Step 6: Update README

Add agent documentation to README.md under appropriate archetype section.

## Common Tasks

### Add Test Fixture Images

```bash
# 1. Download images to temp directory
# 2. Process images
cd packages/dev-tools
bun run process-images ~/Downloads/cat-photos ../../vat-example-cat-agents/test/fixtures/photos/cats

# 3. Review output (should be <100KB per image)
# 4. Commit processed images
```

### Add New Schema

```typescript
// src/types/schemas.ts
export const NewSchema = z.object({
  // Define schema
}).describe('Schema description');

export type NewType = z.infer<typeof NewSchema>;
```

### Mock LLM Calls in Tests

```typescript
// test/<archetype>/<agent>.test.ts
import { vi } from 'vitest';

// Mock the LLM call
vi.mock('../src/one-shot-llm-analyzer/photo-analyzer', () => ({
  analyzePhoto: vi.fn().mockResolvedValue({
    physical: { furColor: 'Orange', size: 'medium' },
    behavioral: { personality: ['Playful'] },
    description: 'Test description',
  }),
}));
```

## Architecture Decisions

### Why Plain TypeScript Functions?

- **Framework agnostic** - No vendor lock-in
- **Easy to test** - Pure functions, no magic
- **Portable** - Runtime adapters translate to any framework
- **Simple** - No framework abstractions to learn

### Why Mock Mode?

- **Speed** - Instant vs seconds/minutes for real API
- **Cost** - Free vs $0.01-0.10 per image
- **Deterministic** - Same input = same output
- **CI/CD friendly** - No API keys, no rate limits

### Why Cat Domain?

- **Universal** - Everyone understands cats
- **Complex enough** - Genetics, breeding, compliance
- **Fun** - Humor makes exploration enjoyable
- **Realistic** - Tests real-world patterns (HITL, workflows, etc.)

### Why Quirky Validation Rules?

- **Forces iteration** - 60-70% rejection rate tests feedback loops
- **Tests orchestration** - Generator doesn't know rules
- **Prevents cheating** - LLM can't rely on training (rules are arbitrary)
- **Demonstrates patterns** - Real-world validation is often quirky

## Related Documentation

- **[README.md](./README.md)** - Human-facing package documentation
- **[STRUCTURE.md](./STRUCTURE.md)** - Detailed package organization
- **[Project CLAUDE.md](../../CLAUDE.md)** - Root-level project guidance

## Contributing Workflow

1. Review the 9 agent archetypes (see Missing Archetypes section above)
2. Choose an unimplemented archetype
3. Create agent file(s) in appropriate directory
4. Add tests with good coverage
5. Update README.md with usage examples
6. Export from src/index.ts
7. Run `bun run validate` to ensure everything passes
8. Commit with conventional commits format

## Questions?

For high-level understanding: Read README.md
For technical navigation: Read this file (CLAUDE.md)
For package structure details: Read STRUCTURE.md
For archetype theory: See the Missing Archetypes section above

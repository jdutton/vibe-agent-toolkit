# vibe-agent-toolkit Architecture

## Package Structure & Evolution

### Phase 1: Foundation (Start Here)

#### `@vibe-agent-toolkit/utils`
**Purpose**: Core shared utilities with no dependencies on other packages

**Responsibilities**:
- Utilities added as needed by other packages
- **Schema utilities** (JSON Schema validation, conversion, runtime checking)
- Cross-platform helpers (process spawning, file system operations, etc.)
- Common type guards and assertions

**Note**: Add utilities as problems arise, not speculatively. Example: vibe-validate has cross-platform process spawning utilities.

**Dependencies**: None (may have external npm dependencies, but no internal package dependencies)
**Status**: ✅ Created

---

#### `@vibe-agent-toolkit/cli`
**Purpose**: Command-line interface for toolkit features

**Responsibilities**:
- CLI commands for validating resources, checking links, building skills, etc.
- Orchestrates other packages (resources, rag, agent-skills)
- User-facing error messages and output formatting
- Configuration file loading and management

**Example commands**:
```bash
vibe-agent validate docs/          # Validate resources
vibe-agent check-links docs/       # Check link integrity
vibe-agent build-skill ./skill/    # Build Claude skill
vibe-agent embed docs/ --output db.json  # Generate embeddings
```

**Dependencies**: All other packages (orchestrator)
**Status**: 📋 Planned

**Note**: Can be used as a library or CLI. Entry point for end users.

---

#### `@vibe-agent-toolkit/resources`
**Purpose**: Parse and validate markdown/HTML resources

**Responsibilities**:
- Parse markdown (frontmatter, headings, links, code blocks)
- Parse HTML (metadata, headings, links)
- **Link integrity validation** (broken links, missing anchors, relative paths)
- Document structure validation
- Extract metadata and structure
- **Defines resource schemas** (metadata format, document structure)

**Explicitly NOT responsible for**:
- Chunking (that's RAG concern)
- Embeddings (that's RAG concern)
- Claude-specific conventions (that's agent-skills concern)

**Dependencies**: `utils`, markdown/HTML parsing libraries
**Status**: 📋 Planned

**Key insight**: Link integrity is general-purpose, useful for any markdown project (docs/, README files, etc.), not Claude-specific.

---

### Phase 2: Specialized Concerns (Build Next)

#### `@vibe-agent-toolkit/rag`
**Purpose**: Document chunking, embedding, and retrieval

**Responsibilities**:
- **Chunking strategies** (semantic, fixed-size, by-heading, recursive)
- Embedding generation (via LLM APIs)
- Vector storage abstraction (support multiple backends)
- Similarity search and retrieval
- Context building for LLM prompts
- **Defines RAG schemas** (chunk metadata, retrieval results, embedding configs)

**Boundary with resources**:
- Resources provides: "Here's what's in this document (parsed structure)"
- RAG provides: "Here's how to chunk, embed, and retrieve relevant context"

**Dependencies**: `utils`, `resources`, vector DB clients, LLM SDKs
**Status**: 📋 Planned

---

#### `@vibe-agent-toolkit/agent-skills`
**Purpose**: Agent skill packaging, validation, and testing

**Responsibilities**:
- **Skill format validation** (Agent Skill conventions and structure)
- **Skill testing framework** (test skills work with Claude API)
- **Skill packaging/bundling** (package for distribution to Claude)
- Agent-specific link conventions and organization patterns
- Skill metadata requirements
- **Defines agent-skill schemas** (skill manifest, configuration, metadata)

**Reuses from resources**: Link integrity checking, document parsing (general capabilities)
**Adds on top**: Claude-specific rules, testing harness, packaging workflows

**Dependencies**: `utils`, `resources`
**Status**: 📋 Planned

---

### Phase 3: Future Packages (Build When Needed)

#### `@vibe-agent-toolkit/agents` (Future)
**Purpose**: Agent runtime and execution framework
- Agent lifecycle management
- Tool/function calling abstractions
- State management and persistence
- Execution tracing and debugging

#### `@vibe-agent-toolkit/llm-providers` (Future)
**Purpose**: Multi-LLM abstraction layer
- Unified interface across Claude, OpenAI, Gemini, etc.
- Provider-specific optimizations
- Retry logic and error handling
- Cost tracking and monitoring

#### `@vibe-agent-toolkit/deploy` (Future)
**Purpose**: Deployment tooling for agents
- Package agents for various targets (Claude Desktop, API, serverless, etc.)
- Environment configuration management
- Pre-deployment validation

---

## Schema Strategy

### Schemas as First-Class Citizens

Schemas are critical for:
- Agent input/output validation
- Resource metadata validation
- Configuration file validation (YAML, JSON)
- Runtime type safety
- Interoperability between packages

### Schema Distribution

**Schemas live with their packages**:
- `resources/` defines resource schemas (metadata, document structure)
- `agent-skills/` defines skill schemas (manifest, configuration)
- `rag/` defines RAG schemas (chunk metadata, retrieval configs)

**Schema utilities live in `utils`**:
- JSON Schema validation
- Schema-to-TypeScript type conversion
- Runtime validation helpers
- Schema composition and extension

**Format**: Use JSON Schema (supports both JSON and YAML validation)

### Example Structure
```
packages/resources/
  src/
    schemas/
      metadata.schema.json      # Resource metadata JSON Schema
      document.schema.json       # Document structure schema
    types.ts                     # TypeScript types (derived from schemas)
    validator.ts                 # Uses utils schema validation
```

---

## Result Envelopes & Railway-Oriented Programming

### Overview

All VAT agents return standardized result envelopes following Railway-Oriented Programming (ROP) principles. This provides consistent error handling, type-safe result processing, and clear orchestration patterns.

### Core Concepts

**Result Types** (`@vibe-agent-toolkit/agent-schema`):
- `AgentResult<T, E>` - Success/error discriminated union for single-execution agents
- `StatefulAgentResult<T, E, M>` - Adds "in-progress" state for multi-turn conversational agents
- `LLMError` - Standard error types for LLM-related failures
- `ExternalEventError` - Standard error types for external system integration

**Output Envelopes**:
- `OneShotAgentOutput<TData, TError>` - For pure functions and one-shot LLM analyzers
- `ConversationalAgentOutput<TData, TError, TState>` - For multi-turn conversational agents

**Result Helpers** (`@vibe-agent-toolkit/agent-runtime`):
- `mapResult()` - Transform success data
- `andThen()` - Chain operations (only if success)
- `match()` - Pattern match on result status
- `unwrap()` - Extract data (throws on error)

### Benefits

1. **Type Safety**: TypeScript discriminated unions ensure compile-time correctness
2. **Consistent Error Handling**: Standard error types across all agents
3. **Composability**: Result helpers enable clean agent chaining
4. **Observability**: Machine-readable status enables monitoring and debugging
5. **Testability**: Test helpers simplify assertion patterns

### Example

```typescript
// Agent returns envelope
const result = await haikuValidator.execute({ text, syllables, kigo, kireji });

// Type-safe pattern matching
const message = match(result, {
  success: (data) => `Valid haiku: ${data.valid}`,
  error: (err) => `Validation failed: ${err}`,
});

// Or extract directly (throws on error)
const data = unwrap(result);
```

### Optional Observability Fields

Result envelopes support optional fields for production observability and intelligent orchestration:

#### Confidence (0-1 scale)

Indicates certainty in the result, enabling intelligent orchestration decisions:

```typescript
{
  status: 'success',
  data: { breed: 'Maine Coon' },
  confidence: 0.65  // 65% confident → maybe verify with another agent
}
```

**Use cases:**
- Orchestration decisions (retry if confidence < threshold)
- Chain validation (verify uncertain results)
- User transparency (show uncertainty to user)
- Stopping criteria (iterate until confidence > 0.9)

#### Warnings (non-fatal issues)

Success with caveats - graceful degradation:

```typescript
{
  status: 'success',
  data: { breed: 'Persian' },
  warnings: [
    'Image quality was poor, confidence may be lower',
    'Breed database last updated 6 months ago'
  ]
}
```

#### Execution Metadata (observability)

Performance and cost tracking for production systems:

```typescript
interface ExecutionMetadata {
  durationMs?: number;      // Performance monitoring
  tokensUsed?: number;      // LLM cost tracking
  cost?: number;            // Estimated cost in USD
  model?: string;           // Which model (for A/B testing)
  provider?: string;        // 'openai' | 'anthropic' | etc
  retryCount?: number;      // Set by orchestrator's retry wrapper
}
```

**Example:**
```typescript
{
  status: 'success',
  data: { characteristics: {...} },
  execution: {
    durationMs: 1234,
    tokensUsed: 450,
    cost: 0.0045,
    model: 'gpt-4o-mini',
    provider: 'openai',
    retryCount: 0  // No retries needed
  }
}
```

**Use cases:**
- Performance optimization (identify slow agents)
- Cost attribution (multi-tenant systems)
- Usage analytics (tokens per request)
- Debugging (view retry behavior)

### Error Classification & Retryability

Error types implicitly convey retryability - orchestrators encode retry policy based on error type:

**Retryable errors** (transient failures):
- `llm-rate-limit` - Exponential backoff
- `llm-timeout` - Quick retry
- `llm-unavailable` - Long wait

**Non-retryable errors** (permanent failures):
- `llm-refusal` - Model refused to comply
- `llm-invalid-output` - Output parsing failed
- `invalid-input` - Bad user input

**Separation of concerns:** Agents classify errors, orchestrators decide retry policy.

### Learn More

See [Orchestration Guide](../orchestration.md) for detailed patterns and examples.

---

## Architectural Principles

### 1. Clear Package Boundaries
Each package has a single, well-defined purpose. When a concern grows complex enough or serves multiple packages, consider extracting it.

### 2. Progressive Dependencies
```
utils (no package deps)
  ↓
resources (→ utils)
  ↓
├─ rag (→ utils, resources)
├─ agent-skills (→ utils, resources)
└─ cli (→ all packages, orchestrator)
```

### 3. Start Minimal, Evolve As Needed
- Don't build Phase 2 until Phase 1 proves its worth
- Don't build Phase 3 until real use cases emerge
- Prefer extracting packages from working code over speculative design

### 4. Schemas Co-located, Utilities Shared
- Each package owns its schemas (domain knowledge)
- Utils provides schema validation (technical capability)
- Enables strong contracts between packages

### 5. Link Integrity is General, Not Claude-Specific
- Useful for any markdown: docs/, README, tutorials, etc.
- Lives in `resources` as general capability
- `agent-skills` can add skill-specific conventions on top

---

### Audit System

**Location:** `packages/cli/src/commands/audit/`

**Purpose:** Comprehensive validation of Claude plugins, marketplaces, registries, and skills

**Architecture:**
- **Auto-detection**: Detects resource type based on file structure
  - Plugin directories: `.claude-plugin/plugin.json` ([official spec](https://code.claude.com/docs/en/plugins-reference))
  - Marketplace directories: `.claude-plugin/marketplace.json`
  - Registry files: `installed_plugins.json`, `known_marketplaces.json`
  - Skills: `SKILL.md` files
  - VAT agents: `agent.yaml` + `SKILL.md`
- **Validators**: Reuses validators from `agent-skills` package
  - Plugin validator: Schema validation for plugin manifests
  - Marketplace validator: Schema validation for marketplace manifests
  - Registry validator: Schema validation + checksum staleness detection
  - Skill validator: Frontmatter, links, naming conventions, length checks
- **Hierarchical Output**: Groups results into marketplace → plugin → skill structure
  - Used for `--user` flag to show plugin relationships
  - Flat output for single resource audits
- **Cache Detection**: Uses ResourceRegistry checksums to detect staleness
  - Compares cache checksums with installed plugin checksums
  - Identifies outdated cached plugins

**Key Components:**
- `audit.ts` - Main audit command with auto-detection
- `hierarchical-output.ts` - Builds hierarchical YAML structure for user-level audits
- `cache-detector.ts` - Compares cache and installed checksums (future enhancement)

**Integration:**
- Uses validators from `@vibe-agent-toolkit/agent-skills`
  - `validate()` - Unified validator for plugins/marketplaces/registries
  - `validateSkill()` - Skill-specific validator
  - `detectResourceFormat()` - Resource type detection
- Uses ResourceRegistry from `@vibe-agent-toolkit/resources`
  - Checksum-based staleness detection
  - Plugin relationship tracking
- Uses `detectFormat()` from `@vibe-agent-toolkit/discovery`
  - Detects VAT agents and Agent Skills
- Outputs YAML via `utils/output.ts`

**Exit Codes:**
- `0` - Success: All validations passed
- `1` - Errors found: Validation errors requiring fixes
- `2` - System error: Config invalid, path not found, etc.

**User-Level Audit:**
When using `--user` flag:
- Scans `~/.claude/plugins/` (cross-platform)
- Recursive scan for all resources
- Hierarchical output showing relationships
- Cache staleness detection for plugins

**Design Principles:**
- **CLI is "dumb"**: All validation logic lives in `agent-skills`
- **Reusable validators**: Same validators used by build, import, and audit
- **Structured output**: YAML to stdout, errors to stderr
- **CI/CD friendly**: Clear exit codes and parseable output

---

## Current Status

- ✅ **utils**: Foundation created (add utilities as needed)
- 📋 **cli**: Command-line interface (build after resources)
- 📋 **resources**: Next to build
- 📋 **rag**: Phase 2
- 📋 **agent-skills**: Phase 2

---

## Next Steps

1. **Add utilities as needed**:
   - Don't pre-populate with string/array functions we don't need
   - Add schema validation when resources package needs it
   - Add cross-platform helpers when CLI needs them
   - Let real problems drive utility creation

2. **Build minimal resources package**:
   - Basic markdown parser (frontmatter, headings, links)
   - Link integrity checker
   - Resource schemas (JSON Schema)
   - No complex validation yet, no chunking

3. **Build CLI package**:
   - Commands for validating docs/, checking links
   - Demonstrates resources package in action
   - User-facing entry point

4. **Evaluate before Phase 2**:
   - Is resources API ergonomic?
   - Is CLI intuitive?
   - What's missing?
   - Then build RAG or agent-skills based on priority

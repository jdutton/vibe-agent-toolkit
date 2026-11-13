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
- **Inventory substrate**: All structural enumeration goes through the inventory layer (see [Skill Packaging — Inventory Layer](./skill-packaging.md#inventory-layer)). Vendor-neutral interfaces live in `packages/agent-skills/src/inventory/`; concrete Claude extractors live in `packages/claude-marketplace/src/inventory/`. Detectors are pure consumers of inventory data — they never walk the filesystem directly. `vat inventory <path>` publishes the same model as its report's `data.inventory`.
- **Auto-detection**: Detects resource type based on file structure
  - Plugin directories: `.claude-plugin/plugin.json` ([official spec](https://code.claude.com/docs/en/plugins-reference))
  - Marketplace directories: `.claude-plugin/marketplace.json`
  - Registry files: `installed_plugins.json`, `known_marketplaces.json`
  - Skills: `SKILL.md` files
- **Validators**: Reuses validators from `agent-skills` and `claude-marketplace` packages
  - Plugin validator (`claude-marketplace`): Schema validation for plugin manifests
  - Marketplace validator: Schema validation for marketplace manifests
  - Registry validator: Schema validation + checksum staleness detection
  - Skill validator: Frontmatter, links, naming conventions, length checks
  - Inventory detectors: `COMPONENT_DECLARED_BUT_MISSING`, `COMPONENT_PRESENT_BUT_UNDECLARED`, `REFERENCE_TARGET_MISSING`, `MARKETPLACE_PLUGIN_SOURCE_MISSING` (set algebra over the inventory)
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
- Uses validators from `@vibe-agent-toolkit/agent-skills` and `@vibe-agent-toolkit/claude-marketplace`
  - `validate()` - Unified validator for plugins/marketplaces/registries (`agent-skills`)
  - `validatePlugin()` - Claude plugin manifest validation (`claude-marketplace`)
  - `validateSkill()` - Skill-specific validator (`agent-skills`)
  - `detectResourceFormat()` - Resource type detection (`agent-skills`)
  - Inventory extractors and detectors — see [Skill Packaging — Inventory Layer](./skill-packaging.md#inventory-layer)
- Uses ResourceRegistry from `@vibe-agent-toolkit/resources`
  - Checksum-based staleness detection
  - Plugin relationship tracking
- Uses `detectFormat()` from `@vibe-agent-toolkit/discovery`
  - Detects Agent Skills
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
- **Reusable validators**: Same validators used by build and audit
- **Structured output**: YAML to stdout, errors to stderr
- **CI/CD friendly**: Clear exit codes and parseable output

### `__internal` — the test-facing seam

A module that exports helpers only so its unit tests can reach them collects them under one
`export const __internal = { … } as const` at its foot and stops exporting them individually; tests
`import { __internal }` and destructure. Types stay exported (an object cannot carry them). Two
lines are held by `packages/dev-tools/test/internal-seam.test.ts`: no barrel re-exports `__internal`
(by name or by `export *` of a seam module), and nothing under `src/` imports it — a src consumer
means the name is API and belongs as an ordinary export. Worked example:
`packages/agent-skills/src/skill-test/run-harness.ts` (63 exports → 18 + one seam). "Is this API?"
is then a grep, not a JSDoc: on the barrel = API; in `__internal` = test-only; neither = look
harder. Adopting the seam is by review, not by gate: `bun run unused-exports` counts only exports
that nothing in `src/**` or any vitest entry file reaches, so an export a spec imports directly is
"used" to it and never surfaces there.

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

---

## Related references

- [Skill Packaging Shapes](./skill-packaging.md) — the four recognized artifact shapes (standalone skill, skill-claude-plugin, claude-plugin, claude-marketplace) with layouts and applicable validation.
- [CLI Architecture](./cli.md) — command structure, output conventions, why the CLI layer stays "dumb," and CLI-specific testing patterns.
- [Resource Scanning and Object Caching](./resource-scanning-and-caching.md) — how VAT discovers and reads resource bytes: the git-tracked vs. non-git scanning taxonomy, the two-lane cost model, symlink handling, the one content-decoding seam (§3.5), and the object-level content cache.
- [Content Keying and Git](./content-keying-and-git.md) — why a git blob OID and VAT's `contentKey` hash different preimages and are each sound for different facts, the portability inversion (the OID is the cross-machine key, not ours), the measured `git cat-file --filters` framing trap under `--batch`, Git LFS as a declared limitation, and why the git crawl lane needs no file read at all.
- [Command Population Matrix](./command-population-matrix.md) — what each command's file population SHOULD be, per command and per git-vs-non-git corpus: the intended visibility of untracked and gitignored files, the content and blob stages, and the declarations the implementation is audited against.
- [Command Population — Open Questions](./command-population-open-questions.md) — the backlog behind that matrix: every population question nothing has declared an answer to, and every claim a document makes that the code does not support.
- [Resource Projection](./resource-projection.md) — the shipped parse-cache output shape, the proposed blob-keyed and path-dependent schema targeted for stage 3, tree-shape caching, and the parse cache's threat model.
- [Fact Extractors](./fact-extractors.md) — the accepted, not-yet-built decision record for the fact store and the extractor contract: the queryable-repository goal, ranked priorities, invariants I0–I11 each with its enforcer kind, settled decisions with their rejected alternatives, and how the record is amended when implementation proves a clause wrong.
- [Fact Extractors — Hazard Register](./fact-extractors-hazard-register.md) — the living register of hazards the fact store enforces or accepts, each with its status and its enforcer kind or bound; a change that builds part of the design adds or updates its rows.
- [Fact Extractors — Parse Limits](./fact-extractors-limits.md) — the lab record behind every parse-pool limit, the headroom rule, the bounded-pool cost on a small corpus, and how long a cold whole-tree check takes.
- [Zones](./zones.md) — the proposed lens model the projection is read through: storage vs. viewer zones, visibility as extent, per-zone reference resolution, resource identity and realizations, and the contributor seam that lets higher packages contribute facts `resources` must not interpret.
- [Parsers and Load Boundaries](./parsers-and-load-boundaries.md) — half shipped, half intended, and the document says which per section. ✅ Built: the three parse capabilities (spans-and-kinds, structure, faithful edit) as interfaces, the `ParseFacts` conformance suite the parse cache's own seam made possible, and `markdown-it` run through it as a test-only second implementation — which places five spans covering three of the seven span-bearing constructs in the probe, all of them block ones, and none of the four inline ones. 🔷 Intended: the rule that no parser, store or runtime may sit in a barrel's static module graph — with the measured cold cost of every barrel that currently violates it, which of the two load instruments answers which question, the current per-surface state, and the parse5 blocker. ⛔ The capability split buys swappability, never speed.

# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.9] - 2026-02-07

- `--user` flag for `vat skills validate` to validate installed user skills
- Shared utilities: claude-paths, skill-discovery, user-context-scanner, config-loader
- Case-insensitive skill discovery (finds malformed SKILL.md variations)

### Changed
- **BREAKING**: `vat skills list` now defaults to project skills (use `--user` for installed skills)
- Refactored `vat skills validate` to use shared utilities and respect resource config boundaries
- Refactored `vat skills list` to use shared utilities

### Fixed
- **RAG Metadata Filtering**: Now works correctly regardless of which Zod version (v3 or v4) you have installed
  - Previously: Metadata filters returned 0 results if your Zod version differed from the library's
  - Now: Automatically detects and works with both Zod v3.25.0+ and v4.0.0+
  - No code changes required - filtering just works
- **RAG Line Number Tracking**: Chunks now preserve exact line ranges from source documents
  - Previously all chunks from the same section had identical line numbers
  - Fixed off-by-one error in line position calculation (1-based to 0-based conversion)
  - Properly flattens nested heading hierarchy during section extraction
  - Handles large paragraphs by splitting into line-level chunks
  - Enables accurate IDE navigation and source citations
- **BREAKING CHANGE**: RAG database column names are now lowercase (SQL standard)
  - Existing LanceDB indexes must be rebuilt - run `await provider.clear()` then re-index
  - Your code doesn't change - still use camelCase in queries: `{ metadata: { contentType: 'docs' } }`
  - Why: Prevents case-sensitivity issues, no quotes needed in queries, follows SQL conventions
  - See migration guide: `packages/rag-lancedb/README.md#upgrading-from-v018-to-v019`
- Eliminated path duplication across audit, install, and other commands
- `vat audit --user` now finds standalone skills in ~/.claude/skills

### Added
- **RAG Similarity Scores**: Search results now include confidence scores (0-1, higher is better)
  - Filter results by confidence threshold
  - Compare result relevance
  - Build smarter retrieval logic
- **RAG Progress Tracking**: See real-time progress when building large indexes
  - Shows resources indexed, chunks created, time elapsed/remaining
  - Add progress bars to your CLI tools
  - Monitor long-running index builds
- **Accurate Line Numbers**: Chunks now track exact line ranges in source files
  - Jump directly to source in your IDE
  - Show precise code citations
  - Build better documentation tools

### Internal
- Deleted obsolete skill-finder.ts (replaced by skill-discovery.ts)
- Preserved audit.ts custom scanning logic (architectural decision for independence)

## [0.1.8] - 2026-02-06

### Fixed
- **RAG Metadata Filtering at Scale**: Fixed metadata filtering returning empty results on production-scale indexes (>1000 chunks)
  - Root cause: LanceDB struct column access (`metadata['field']`) doesn't scale
  - Solution: Store metadata as top-level columns with direct access (`` `field` ``)
  - All metadata fields now stored as top-level LanceDB columns instead of nested struct
  - Filter builder updated to use direct column access for efficient queries
  - Added system test validating metadata filtering with flattened schema
  - Fixes issue reported by manuscript-tools (753 docs, 4,321 chunks)

### Changed
- **BREAKING CHANGE**: Existing LanceDB indexes must be rebuilt
  - Metadata storage format changed from nested struct to top-level columns
  - Run `await ragProvider.clear()` then re-index resources
  - API remains backward compatible - no code changes required beyond index rebuild
  - See migration guide in `packages/rag-lancedb/README.md`

## [0.1.7] - 2026-02-05

### Added
- **RAG Extensible Metadata Schema Support**: Custom metadata fields with full type safety
  - Generic provider interfaces with `TMetadata` type parameter for compile-time type safety
  - Zod schema introspection for automatic serialization/deserialization
  - Support for arrays (CSV), objects (JSON), dates (timestamps), and primitives
  - Type-safe query filtering on custom metadata fields
  - `DefaultRAGMetadata` schema with standard fields (tags, title, description, category)
  - See `packages/rag-lancedb/README.md` for usage examples

## [0.1.6] - 2026-02-04

### Fixed
- Umbrella package now works with `npx vibe-agent-toolkit` by adding ESM type declaration
- Version output now shows project root for local installs instead of "unknown"

## [0.1.5] - 2026-02-04

### Fixed
- CLI now works correctly with `npx` commands in CI environments without global installation
- Link validation detects case mismatches in filenames, preventing failures on case-sensitive filesystems (Linux)

## [0.1.4] - 2026-02-03

### Added
- **Multi-Collection Resource Validation System**: Comprehensive resource type system with frontmatter validation
  - Multi-collection support via `vibe-agent-toolkit.config.yaml` with pattern resolution
  - Per-collection frontmatter validation with JSON Schema
  - Validation modes: strict vs permissive
  - Collection filtering via `--collection <id>` flag in scan/validate commands
  - Format options: `--format yaml|json|text` for structured or human-readable output
  - Package-based schema references (e.g., `@vibe-agent-toolkit/agent-skills/schemas/skill-frontmatter.json`)
  - Enhanced validation error messages with actual/expected values
  - Enhanced `vat doctor` command validates config file schema and checks schema file existence
- **Agent Skills Package Rename**: `@vibe-agent-toolkit/runtime-claude-skills` → `@vibe-agent-toolkit/agent-skills`
  - Exported JSON schemas: `skill-frontmatter.json` and `vat-skill-frontmatter.json`

### Changed
- **Output Format Improvements**: Enhanced validation and scan output
  - Added error summary by type
  - Added per-collection error tracking (filesWithErrors, errorCount)
  - Simplified scan output with `--verbose` flag for file details
  - Errors grouped by file in structured output (YAML/JSON)

## [0.1.3] - 2026-02-01

### Added
- **Frontmatter Validation**: Parse and validate YAML frontmatter in markdown files
  - CLI flag `--frontmatter-schema` for `vat resources validate` to validate against JSON Schema
  - Reports YAML syntax errors and schema validation failures
  - `ResourceMetadata` includes parsed frontmatter data when present

## [0.1.2] - 2026-01-30

### Added
- **Session Management System**: Pluggable session persistence for stateful agents
  - `RuntimeSession<TState>` type with id, history, state, and metadata
  - `SessionStore<TState>` interface for pluggable persistence strategies
  - `MemorySessionStore` - in-memory sessions with TTL support and sliding window expiration
  - `FileSessionStore` - file-based persistence in `~/.vat-sessions/` (runtime-agnostic)
  - CLI transport integration with `--session-store` and `--session-id` flags
  - Session management commands: `/clear` (or `/restart`), `/state`
  - Commands shown upfront in CLI welcome message for better UX
  - Conversational demo supports session resumption across restarts
  - Session helpers: `validateSessionId`, `createInitialSession`, `updateSessionAccess`, `isSessionExpired`
  - Reusable test helpers to eliminate duplication across store implementations
- **Audit Command Enhancements**: Comprehensive validation of Claude skills
  - Transitive link validation - recursively follows and validates all linked markdown files
  - Unreferenced file detection with `--check-unreferenced` flag
  - BFS traversal to discover entire skill structure
  - Comprehensive statistics for all files in skill
  - Handles circular references gracefully
- **MCP Gateway**: Expose VAT agents through Model Context Protocol (`@vibe-agent-toolkit/gateway-mcp`)
  - Stdio transport for Claude Desktop integration
  - Stateless agent support (Pure Function Tools, One-Shot LLM Analyzers)
  - Multi-agent server support (expose multiple agents through single gateway)
  - Runtime-agnostic architecture with adapter pattern
  - Observability hooks (console logger, OpenTelemetry-aligned interfaces)
  - Error classification (retryable vs non-retryable)
  - Complete documentation and examples (haiku-validator, photo-analyzer, combined server)
  - Integration and system tests
- **Agent Runtime Architecture**: Core VAT agent archetype system
  - Pure function agents: Deterministic, synchronous tools
  - LLM analyzer agents: AI-powered analysis with structured I/O
  - Function orchestrator, event consumer, agentic researcher, conversational assistant archetypes
  - Provider-agnostic LLM integration via context.callLLM()
  - Shared validation and execution wrappers
- **Example Cat Agents**: Comprehensive agent examples for testing
  - Haiku generator/validator, name generator/validator
  - Photo analyzer, description parser
  - Human approval workflow
- **Runtime Adapters**: Convert VAT agents to framework-specific formats
  - `@vibe-agent-toolkit/runtime-vercel-ai-sdk`: Vercel AI SDK tools and functions
  - `@vibe-agent-toolkit/runtime-langchain`: LangChain DynamicStructuredTool
  - `@vibe-agent-toolkit/runtime-openai`: OpenAI function calling tools
  - `@vibe-agent-toolkit/runtime-claude-agent-sdk`: Claude Agent SDK MCP tools
  - All support both pure function and LLM analyzer archetypes
  - Multi-provider demos (Anthropic Claude, OpenAI GPT)
- **Shared Test Factories**: Zero-duplication test infrastructure in dev-tools
  - `createPureFunctionTestSuite()` and `createLLMAnalyzerTestSuite()` factories
  - Consistent testing across all runtime adapters
  - Runtime-specific behavior through config interfaces
- **Common Demo Infrastructure**: Runtime-agnostic demo framework
  - Single demo implementation works with any runtime adapter
  - Demonstrates agent portability across frameworks
  - Multi-provider comparison support
- **Documentation**: Guide for adding new runtime adapters
  - Package structure and configuration patterns
  - Adapter implementation best practices
  - Testing with shared factories
  - Validation checklist and common pitfalls
- **Result Constructors Re-exported**: Convenience exports from `@vibe-agent-toolkit/agent-runtime`
  - `createSuccess`, `createError`, `createInProgress`
  - Error constants: `LLM_REFUSAL`, `LLM_INVALID_OUTPUT`, `LLM_TIMEOUT`, etc.
  - All result types and metadata types re-exported for single-package convenience

### Changed
- Upgraded vibe-validate from 0.18.2-rc.1 to 0.18.4-rc.1 (fixes caching bug)
- Migrated from deprecated `vectordb@0.4.20` to `@lancedb/lancedb@0.23.0`
  - Resolves Bun compatibility issues with Apache Arrow
  - Changed nullable number fields to use -1 sentinel values instead of null
  - API changes: `search().execute()` → `vectorSearch().toArray()`, `filter().execute()` → `query().where().toArray()`
- Updated OpenAI SDK from 4.67.0 to 6.16.0 (resolves node-domexception deprecation warnings)
- **BREAKING: Pure Function Agent API Simplified** - Consolidated to single `definePureFunction` API
  - **Removed**: `createPureFunctionAgent` and `createSafePureFunctionAgent` (use `definePureFunction` instead)
  - **API Change**: Agents now return output directly (unwrapped) instead of `OneShotAgentOutput` envelopes
  - **API Change**: Pure function agents are now synchronous (`execute(input): TOutput`) instead of async
  - **API Change**: Invalid input throws exceptions instead of returning error envelopes
  - **API Change**: Handler function receives validated input, returns output directly (no manual wrapping)
  - **Archetype renamed**: `pure-function-tool` → `pure-function` for consistency
  - **Migration Path**: Replace `createPureFunctionAgent((input) => createSuccess(output), manifest)` with `definePureFunction(config, (input) => output)`
  - **Runtime adapters updated**: All four runtime packages handle new unwrapped API
  - **Documentation updated**: `docs/agent-authoring.md` shows only `definePureFunction` pattern

## [0.1.1] - 2026-01-12

### Added
- **`vat doctor` Diagnostic Command**: System health checks and troubleshooting
  - Validates Node.js, Bun, Git, TypeScript installations
  - Checks database connectivity (LanceDB)
  - Validates configuration files
  - Verifies installation integrity
  - Exit codes: 0 (all checks passed), 1 (issues found), 2 (system errors)
- **Resource Collection System**: Advanced resource querying with checksums
  - Content checksumming for change detection
  - Advanced filtering and querying capabilities
  - Test isolation infrastructure for improved reliability
- **Plugin & Marketplace Audit System** (`vat audit`): Comprehensive plugin ecosystem validation
  - Validates `plugin.json` manifests (name, version, description, metadata)
  - Validates `marketplace.json` with bundled skills, git repos, LSP servers
  - Registry tracking for installed plugins and known marketplaces
  - Cache staleness detection - detects stale cached skills vs installed plugins
  - Compares checksums between cache and source
  - Identifies cache-only and installed-only resources
  - Hierarchical output with cache status indicators (stale/fresh/orphaned)
  - `--verbose` flag for detailed diagnostic output
  - Filter plugin/marketplace results from skill-only scans
  - Performance optimizations for large plugin collections

## [0.1.0] - 2026-01-04

### Added
- **Publishing System**: Automated npm publishing with rollback safety
  - `validate-version`: Ensures all packages have unified version
  - `publish-with-rollback`: Publishes 11 packages in dependency order with automatic rollback/deprecation on failure
  - `extract-changelog`: Extracts version-specific changelog for GitHub releases
  - GitHub Actions workflow triggered by version tags (v*)
  - Smart npm dist-tag handling: RC versions → @next, stable versions → @latest
  - Manifest tracking for publish progress and rollback capability
  - Cross-platform test helpers with security validation
- **Agent Runtime**: Execute agents with `vat agent run <name> "input"` using Anthropic API
- **Agent Discovery**: List all agents in your project with `vat agent list`
- **Agent Validation**: Validate manifests and resources with `vat agent validate <name>`
- **Claude Skills Audit**: Comprehensive validation of Claude Skills with `vat agent audit [path] --recursive`
  - Validates frontmatter fields (name, description, license, compatibility)
  - Enforces naming conventions (lowercase, hyphens, reserved words)
  - Checks link integrity (broken links, Windows paths)
  - Detects console-incompatible tool usage (Write, Edit, Bash)
  - Exit codes: 0 (success), 1 (validation errors), 2 (system errors)
- **Claude Skills Import**: Convert SKILL.md to agent.yaml with `vat agent import <skillPath> [options]`
  - Extracts frontmatter metadata to agent manifest
  - Validates before conversion
  - Supports custom output paths with `--output`
  - Force overwrite with `--force`
- **Claude Skills Packaging**: Build agents as Claude Skills with `vat agent build <name>`
- **Installation Management**: Install/uninstall Claude Skills locally with `vat agent install/uninstall <name>`
- **Installation Scopes**: Control installation location with `--scope user|project`
- **Dev Mode**: Symlink-based development workflow with `--dev` flag
- **Gitignore Support**: File crawler and link validator now respect `.gitignore` patterns
- **RAG System**: Document indexing and semantic search with LanceDB
- New package: `@vibe-agent-toolkit/agent-config` - agent manifest loading and validation
- New package: `@vibe-agent-toolkit/runtime-claude-skills` - Claude Skills builder, installer, validator, and import/export
- New package: `@vibe-agent-toolkit/discovery` - format detection and file scanning utilities
- New documentation: [Claude Skills Best Practices Guide](./docs/guides/claude-skills-best-practices.md)
- New documentation: [Audit Command Reference](./docs/cli/audit.md)
- New documentation: [Import Command Reference](./docs/cli/import.md)
- **Resources System**: Markdown resource scanning and validation of link integrity

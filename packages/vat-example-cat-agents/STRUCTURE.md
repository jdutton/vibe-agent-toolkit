# Package Structure

This document explains the organization of the `vat-example-cat-agents` package.

## Directory Structure

```
packages/vat-example-cat-agents/
├── src/                           # Source code (agents, utilities)
│   ├── types/                     # Shared Zod schemas
│   ├── pure-function-tool/        # Archetype: Pure function agents
│   ├── one-shot-llm-analyzer/     # Archetype: LLM analyzer agents
│   ├── external-event-integrator/ # Archetype: External event integrators
│   ├── utils/                     # Shared utilities
│   └── index.ts                   # Public exports
│
├── test/                          # Tests
│   ├── pure-function-tool/        # Unit tests for pure functions
│   ├── one-shot-llm-analyzer/     # Tests for LLM analyzers
│   ├── external-event-integrator/ # Tests for event integrators
│   ├── fixtures/                  # Test data
│   │   └── photos/                # Image fixtures for photo analyzer
│   │       ├── cats/              # Cat photos (processed, git-friendly)
│   │       ├── not-cats/          # Non-cat photos (bear, robot)
│   │       └── cat-like/          # Ambiguous cases (future)
│   └── test-helpers.ts            # Shared test utilities
│
├── examples/                      # Demos and examples
│   ├── photo-analysis-demo.ts     # Photo analyzer demo with test fixtures
│   ├── runtime-adapter-demo.ts    # Shared runtime adapter demo
│   ├── llm-agent-demo.ts          # LLM agent usage demo
│   └── demo-helpers.ts            # Shared demo utilities
│
├── README.md                      # Package documentation
├── STRUCTURE.md                   # This file
└── package.json                   # Package metadata
```

## Directory Purposes

### `src/` - Source Code
Contains all agent implementations organized by archetype:
- **types/**: Shared Zod schemas (CatCharacteristics, Haiku, etc.)
- **pure-function-tool/**: Deterministic, stateless agents (validators)
- **one-shot-llm-analyzer/**: Single LLM call agents (photo analyzer, parsers)
- **external-event-integrator/**: Agents that emit events and wait for responses (HITL)
- **utils/**: Shared helper functions
- **index.ts**: Public API exports

### `test/` - Tests
Mirrors `src/` structure with corresponding test files:
- Unit tests for each agent
- Integration tests where needed
- Test fixtures organized by type

### `test/fixtures/photos/` - Image Test Fixtures
Git-friendly processed images for photo analyzer testing:
- **cats/**: Actual cat photos (4 images, ~40KB each)
- **not-cats/**: Negative test cases (bear, robot)
- **cat-like/**: Ambiguous cases (stuffed animals, statues - future)

**Processing:**
- Original images: 1-9MB each (19.7MB total)
- Processed images: 13-60KB each (215KB total)
- Resized to 512px wide with EXIF metadata
- See `@vibe-agent-toolkit/dev-tools` package for `process-test-images.ts` utility

### `examples/` - Demos and Examples
Executable demos showing how to use the package:
- **photo-analysis-demo.ts**: Demonstrates photo analyzer with actual test images
  - Run: `bun run demo:photos`
  - Clearly shows MOCK mode vs REAL vision API mode
- **runtime-adapter-demo.ts**: Shared demo infrastructure used by all runtime adapters
  - Demonstrates cat agents (haiku validator, name validator/generator) working across frameworks
  - Called by runtime adapter wrapper scripts
- **llm-agent-demo.ts**: Focused demo showing LLM analyzer agent patterns
- **demo-helpers.ts**: Shared utilities for colored output and formatting

**Note:** Runtime packages used to have their own `/examples` directories, but all demos are now centralized here to prevent sprawl.

## Key Conventions

### Agent Organization
- Group by **archetype** (technical pattern), not by feature
- Each archetype directory contains related agents
- Agent files export both function and Agent object

### Test Organization
- Tests mirror source structure
- Test helpers shared in `test-helpers.ts`
- Fixtures organized by type in `test/fixtures/`

### Demo Organization
- **Package-specific demos**: In `examples/` directory
- **Framework adapter demos**: In `packages/runtime-*/examples/`
- Demos are executable and self-documenting

### Script Organization
- Build-time utilities in `scripts/`
- Not imported by source code
- May have additional dependencies (sharp, etc.)

## Package Scripts

```bash
# Development
bun run build          # Compile TypeScript
bun run test           # Run all tests
bun run typecheck      # Type check without build
bun run lint           # Lint source code

# Demos
bun run demo:photos    # Photo analysis demo

# Utilities
bun run process-images <input> <output>  # Process test images
```

## Adding New Content

### Adding a New Agent
1. Create agent file in appropriate archetype directory: `src/<archetype>/`
2. Create test file: `test/<archetype>/`
3. Export from `src/index.ts`
4. Update README with usage example

### Adding Test Fixtures
For images:
1. Place source images in a temporary directory
2. Run from repo root: `cd packages/dev-tools && bun run process-images <input> ../../vat-example-cat-agents/test/fixtures/photos/<category>`
3. Review processed images
4. Commit processed images (should be <100KB each)

For other fixtures:
- Add to `test/fixtures/` with appropriate subdirectory
- Compress if >50KB (see Test Fixtures Convention in CLAUDE.md)

### Adding a Demo
1. Create demo file: `examples/<name>-demo.ts`
2. Add script to `package.json`: `"demo:<name>": "bun examples/<name>-demo.ts"`
3. Document in README under "Running Demos" section
4. Use clear output to show what's happening

### Adding Build Utilities
1. Add utility to `@vibe-agent-toolkit/dev-tools` package instead of creating `/scripts` directories
2. See `packages/dev-tools/src/` for examples
3. Build utilities should be cross-platform (use TypeScript, not shell scripts)

## Published Package

The published npm package includes only:
- `dist/` - Compiled JavaScript + TypeScript definitions
- `README.md` - Documentation
- `package.json` - Metadata

**Not included:**
- Source TypeScript files (`src/`)
- Tests (`test/`)
- Examples (`examples/`)
- Scripts (`scripts/`)
- Build configuration files

Users install the package to use the compiled agents as a library. Developers clone the repo to contribute or extend the agents.

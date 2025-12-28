# CLI Architecture

**Command:** `vat` (Vibe Agent Toolkit)
**Status:** In Development

## Overview

The `vat` CLI provides command-line access to vibe-agent-toolkit capabilities for both humans and AI agents. The architecture is based on proven patterns from vibe-validate, emphasizing:

- **Human and Agent Friendly**: YAML output readable by both
- **Scoped Commands**: Namespaced by package (e.g., `vat resources`, `vat rag`)
- **No Backward Compatibility Initially**: Free to evolve until explicitly stated
- **Schema-Based**: Zod schemas with JSON Schema exports
- **Cross-Platform**: Works on Windows, macOS, Linux

## Package Structure

### Umbrella Package: `vibe-agent-toolkit`

User-facing package that provides the `vat` command.

**Installation:**
```bash
npm install -g vibe-agent-toolkit
```

**Responsibility:** Lightweight delegation to `@vibe-agent-toolkit/cli`

### Implementation Package: `@vibe-agent-toolkit/cli`

Contains all CLI logic and command implementations.

**Directory Structure:**
```
packages/cli/
├── src/
│   ├── bin.ts                   # Main entry (Commander setup)
│   ├── bin/
│   │   └── vat.ts              # Smart wrapper (context detection)
│   ├── commands/
│   │   ├── resources/          # Resources command group
│   │   ├── rag/                # Future: RAG commands
│   │   ├── skills/             # Future: Skills commands
│   │   └── agents/             # Future: Agent commands
│   ├── utils/
│   │   ├── logger.ts           # stderr logging
│   │   ├── project-root.ts     # Root detection
│   │   ├── config-loader.ts    # Config merging
│   │   └── output.ts           # YAML/stream management
│   └── index.ts                # Public API exports
└── dist/                        # Compiled output
```

**Dependencies:**
- `@vibe-agent-toolkit/resources` - for resource commands
- `@vibe-agent-toolkit/utils` - shared utilities
- Future: `rag`, `claude-skills`, etc.

**Technology:**
- Commander.js for command structure
- TypeScript compiled to ESM
- Zod schemas for validation
- Cross-platform Node.js APIs

## Context Detection

### Hybrid Approach

Provides explicit control when needed, automatic detection otherwise.

**Priority order:**
1. **Explicit override:** `VAT_ROOT_DIR` environment variable
2. **Dev mode:** Detect if running inside vibe-agent-toolkit repo
3. **Local install:** Walk up from project root to find `node_modules/@vibe-agent-toolkit/cli`
4. **Global install:** Use globally installed version

### Implementation

Context detection in `packages/cli/src/bin/vat.ts` spawns the actual CLI with `VAT_CONTEXT` environment variable set to `dev`, `local`, or `global`.

**Version Display:**

```bash
# Dev mode
vat --version → 0.1.0-dev (/Users/jeff/Workspaces/vibe-agent-toolkit)

# Local install
vat --version → 0.1.0 (local: /path/to/project)

# Global install
vat --version → 0.1.0
```

## Command Structure

### Namespace Pattern

Commands are scoped by package name for scalability:

```bash
vat resources scan [path]       # Resource discovery
vat resources validate [path]   # Resource validation
vat rag ...                     # Future: RAG commands
vat skills ...                  # Future: Skill commands
vat agents ...                  # Future: Agent commands
vat validate                    # Future: Uber command for CI/CD
```

### Command Groups

Each package gets its own command group:
- `resources` - Markdown/HTML parsing and validation
- `rag` - Document chunking, embedding, retrieval
- `skills` - Claude skill packaging and testing
- `agents` - Agent validation and management

### Project Root Detection

Walk up directory tree until finding:
- `.git` directory, OR
- `vibe-agent-toolkit.config.yaml`

Either indicates project root.

## Configuration

### Two-Level Hierarchy

#### Project-Level Config

**File:** `vibe-agent-toolkit.config.yaml` (at project root)

**Purpose:** Defaults for entire project (collection of agents)

**Example:**
```yaml
version: 1
resources:
  include:
    - "docs/**/*.md"
    - "agents/**/README.md"
  exclude:
    - "node_modules/**"
    - "**/test/fixtures/**"
  validation:
    checkLinks: true
    checkAnchors: true
    allowExternal: true
```

#### Agent-Level Config

**File:** TBD (likely `agent.yaml`)

**Purpose:** Override project defaults for specific agent

**Pattern:** Agent config inherits from project config, overriding specific values (DRY)

## Output Strategy

### YAML by Default

All commands output YAML on stdout (readable by humans and agents):

```yaml
---
status: success
filesScanned: 12
duration: 234ms
---
```

Future: `--format json` flag for JSON output

### Dual Output for Errors

Commands that find errors produce both formats:

#### Test Format (stderr)

```
docs/README.md:15:25: Link target not found: ./missing.md
docs/guide.md:42:10: Broken anchor: #non-existent-section
```

**Format:** `file:line:column: message`

**Purpose:**
- vibe-validate can extract immediately
- Works with existing error extractors
- Standard across test frameworks

#### YAML Structure (stdout)

```yaml
---
status: failed
errorsFound: 2
errors:
  - file: docs/README.md
    line: 15
    column: 25
    type: broken-link
    message: Link target not found: ./missing.md
  - file: docs/guide.md
    line: 42
    column: 10
    type: broken-anchor
    message: Broken anchor: #non-existent-section
---
```

**Purpose:**
- Structured data for agents
- Rich metadata (error types, context)
- Machine-parseable

### Stream Management

**Critical pattern to prevent YAML corruption:**

```typescript
// 1. Write complete YAML to stdout
process.stdout.write('---\n');
process.stdout.write(yamlOutput);
process.stdout.write('---\n');

// 2. Flush stdout explicitly
await new Promise<void>((resolve) => {
  if (process.stdout.writableNeedDrain) {
    process.stdout.once('drain', resolve);
  } else {
    resolve();
  }
});

// 3. NOW write to stderr
process.stderr.write(errorOutput);
```

**Why:** Prevents corruption when `2>&1` is used in shell commands

### Logging Guidelines

- **stderr only:** Human-facing logs, warnings, debug info
- **stdout only:** YAML/JSON structured output
- **Never mix streams**

## Documentation & Help

### Verbose Help Pattern

Comprehensive markdown output for documentation:

```bash
vat --help --verbose              # All commands, full docs
vat resources --help --verbose    # Resources commands only
```

**Output includes:**
- Command purpose and description
- What it does (step-by-step)
- Options and flags
- Exit codes (0 = success, 1 = validation errors, 2 = system errors)
- Files created/modified
- Examples with bash code blocks
- Error guidance

### Help Registry

Dynamic loading pattern to avoid startup overhead:

```typescript
type VerboseHelpLoader = () => Promise<() => void>;

const verboseHelpRegistry: Record<string, VerboseHelpLoader> = {
  'resources': async () => {
    const { showResourcesVerboseHelp } =
      await import('./commands/resources/help.js');
    return showResourcesVerboseHelp;
  },
};
```

Each command group exports its verbose help function.

### Auto-Generated Documentation

**Tool:** `packages/dev-tools/src/generate-cli-docs.ts`

**Process:**
1. Ensure CLI is built
2. Execute: `node packages/cli/dist/bin.js --help --verbose`
3. Capture markdown output
4. Write to: `docs/cli-reference.md`
5. Skip write if unchanged

**Usage:**
```bash
bun run generate-cli-docs
```

Guarantees documentation stays synchronized with actual CLI behavior.

## Resources Commands

### `vat resources scan [path]`

**Purpose:** Intelligent discovery of markdown resources

**Behavior:**
- Scans directory for markdown files (vat-aware discovery)
- Shows what files would be validated
- Displays stats: file count, link count, etc.
- Helps decide inclusions/exclusions before validation
- Always exits 0 (informational only)
- Defaults to project root if no path provided

**Example output:**
```yaml
---
status: success
filesScanned: 12
linksFound: 47
anchorsFound: 23
files:
  - path: docs/README.md
    links: 5
    anchors: 3
duration: 234ms
---
```

### `vat resources validate [path]`

**Purpose:** Strict validation with error reporting

**Behavior:**
- Validates discovered resources (link integrity, anchors, structure)
- Exits 0 if valid, non-zero if errors found
- Defaults to project root if no path provided
- Dual output: test format (stderr) + YAML (stdout)
- CI/CD gate

**Success output:**
```yaml
---
status: success
filesScanned: 12
linksChecked: 47
anchorsChecked: 23
duration: 456ms
---
```

**Error output:**

*stderr:*
```
docs/README.md:15:25: Link target not found: ./missing.md
```

*stdout:*
```yaml
---
status: failed
filesScanned: 12
errorsFound: 1
errors:
  - file: docs/README.md
    line: 15
    column: 25
    type: broken-link
    message: Link target not found: ./missing.md
---
```

## Build Process

### CLI Package Build

```json
{
  "scripts": {
    "build": "tsc && node ../dev-tools/dist/prepare-bin.js"
  }
}
```

**Steps:**
1. TypeScript compilation: `tsc` generates `dist/`
2. Binary preparation: Copy `dist/bin/vat.js` → `dist/bin/vat`, chmod +x

### Dev Tools

**`packages/dev-tools/src/prepare-bin.ts`**
- Makes CLI binaries executable
- Cross-platform (fs.copyFileSync, fs.chmodSync)

**`packages/dev-tools/src/generate-cli-docs.ts`**
- Syncs `--help --verbose` → `docs/cli-reference.md`
- Run manually after CLI changes

## Design Patterns from vibe-validate

### What We Mirror

✅ Two-tier wrapper (umbrella → CLI package)
✅ Smart context detection (dev/local/global)
✅ Commander.js structure
✅ YAML-first output on stdout
✅ Logs/errors on stderr
✅ Explicit stdout flushing before stderr
✅ `--help --verbose` → markdown documentation
✅ Dynamic help registry (async loaders)
✅ Auto-generated cli-reference.md
✅ Cross-platform build tools (Node.js APIs)
✅ Test-format error output (file:line:column: message)

### What We Change

🔄 Single command name (`vat` only)
🔄 Scoped commands by package (`vat resources`)
🔄 Config file: `vibe-agent-toolkit.config.yaml` (verbose, discoverable)
🔄 Explicit context override: `VAT_ROOT_DIR` env var (hybrid approach)
🔄 Version display includes context path in dev mode

## Cross-Platform Requirements

- Use `path.join()` and `path.resolve()` for all paths
- Use Node.js APIs (fs, child_process) instead of shell commands
- Test on Windows, macOS, Linux in CI
- Handle line endings properly (CRLF vs LF)

## Error Handling

- Exit code 0: Success
- Exit code 1: Validation errors (expected failures)
- Exit code 2: System errors (unexpected failures)
- Always flush stdout before writing to stderr
- Test format errors must include file:line:column

## References

- [vibe-validate CLI](https://github.com/jdutton/vibe-validate) - Pattern source
- [Commander.js](https://github.com/tj/commander.js) - CLI framework
- [Package Architecture](./README.md) - Overall package structure

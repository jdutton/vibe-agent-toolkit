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
- Future: `rag`, `agent-skills`, etc.

**Technology:**
- Commander.js for command structure
- TypeScript compiled to ESM
- Zod schemas for validation
- Cross-platform Node.js APIs

## Why the CLI Layer Stays Dumb

The CLI package sits at the top of the dependency chain — no other package can depend on it.
Putting logic in the CLI that other packages need creates an impossible dependency situation:

- Other packages can't depend on CLI (circular dependency)
- Logic gets duplicated across packages (DRY violation)
- Changes require coordinating multiple packages

The rule itself (what CLI should/shouldn't contain) lives in
[`packages/cli/CLAUDE.md`](../../packages/cli/CLAUDE.md#the-cli-must-remain-dumb) — this section
is the rationale and worked example behind it.

### The Right Place for Logic

| Logic Type | Wrong Place | Right Place | Why |
|------------|-------------|-------------|-----|
| Find agent's package root | CLI | agent-skills or utils | Other runtimes (langchain, etc.) will need this |
| Determine default output path | CLI | agent-skills | Each runtime knows where its bundles should go |
| Validate agent manifest | CLI | agent-config | Validation used by all consumers |
| Parse YAML | CLI | utils or agent-config | Common across many packages |
| Format user messages | CLI | ✅ CLI is fine | This is CLI-specific UX |

### Example: Agent Build Command

**Before (WRONG)** - Logic in CLI:
```typescript
// packages/cli/src/commands/agent/build.ts
function findAgentPackageRoot(agentPath: string): string {
  // 50 lines of path-walking logic...
  // ❌ This belongs elsewhere!
}

function determineOutputPath(target: string, agentPath: string): string {
  const packageRoot = findAgentPackageRoot(agentPath);
  return path.join(packageRoot, 'dist', 'vat-bundles', target);
}
```

**After (CORRECT)** - Logic in runtime package:
```typescript
// packages/cli/src/commands/agent/build.ts
const buildOptions = options.output
  ? { agentPath, target, outputPath: options.output }
  : { agentPath, target };
// ✅ CLI just passes options, runtime figures out the rest
result = await buildAgentSkill(buildOptions);
```

```typescript
// packages/agent-skills/src/builder.ts
function getDefaultOutputPath(manifestPath: string, target: string): string {
  const agentPackageRoot = findAgentPackageRoot(manifestPath);
  return path.join(agentPackageRoot, 'dist', 'vat-bundles', target);
}
// ✅ Logic lives where it can be reused by other runtimes
```

### Self-Hosting Consideration

Remember: **Other agent repos won't have packages/cli/**. If an agent package needs to build itself, it can depend on `@vibe-agent-toolkit/agent-skills` directly. The CLI is just one convenient way to invoke the build - not the only way.

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
                 binary: /Users/jeff/Workspaces/vibe-agent-toolkit/packages/cli/dist/bin.js

# Local install
vat --version → 0.1.0 (local: /path/to/project)
                 binary: /path/to/project/node_modules/@vibe-agent-toolkit/cli/dist/bin.js

# Global install
vat --version → 0.1.0
                 binary: /usr/local/lib/node_modules/vibe-agent-toolkit/…/dist/bin.js
```

The `binary:` line is unconditional and derived from the entry module itself, not from the cwd.
The context label above it *is* cwd-derived, so the same build invoked by absolute path from
another repo reports `global` and would otherwise print a version indistinguishable from the
released one — which is precisely the situation every adopter delta test runs in.

## Command Structure

### Namespace Pattern

Commands are scoped by package name for scalability:

```bash
vat resources scan [path]       # Resource discovery
vat resources validate [path]   # Resource validation
vat rag ...                     # Future: RAG commands
vat skills ...                  # Future: Skill commands
vat agents ...                  # Future: Agent commands
vat validate                    # Run all configured source validators (resources + skills)
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

### Command File Structure

```typescript
// commands/mycommand.ts
export interface MyCommandOptions {
  debug?: boolean;
  // ... other options
}

export async function myCommand(
  pathArg: string | undefined,
  options: MyCommandOptions
): Promise<void> {
  const logger = createLogger(options.debug ? { debug: true } : {});
  const startTime = Date.now();

  try {
    // 1. Validate inputs
    // 2. Process
    // 3. Output results (YAML to stdout)
    // 4. Exit with appropriate code

    process.exit(0);
  } catch (error) {
    handleCommandError(error, logger, startTime, 'MyCommand');
  }
}
```

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
  # Optional per-code severity overrides (error | warning | info | ignore).
  validation:
    severity:
      EXTERNAL_URL_DEAD: ignore
      FRONTMATTER_SCHEMA_ERROR: error
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
durationSecs: 0.234
---
```

Future: `--format json` flag for JSON output

### Dual Output for Errors

Commands that find errors produce both formats:

#### Test Format (stderr)

```
docs/README.md:15:25: error: Link target not found: ./missing.md
docs/guide.md:42:10: error: Broken anchor: #non-existent-section
fragment.component.html:1:1: info: Malformed HTML: missing-doctype
```

**Format:** `file:line:column: severity: message`

Only `error` findings fail the run, so the severity is what tells a reader
which lines they have to act on.

**Purpose:**
- vibe-validate can extract immediately
- Works with existing error extractors
- Standard across test frameworks

#### YAML Structure (stdout)

```yaml
---
# status is the worst ACTIONABLE severity: success | warning | error.
# Info-only findings report `success` — read issueCounts for what was seen.
status: error
errorsFound: 2
issueCounts: { errors: 2, warnings: 0, info: 0 }
issues:
  - file: docs/README.md
    issues:
      - line: 15
        column: 25
        code: LINK_BROKEN_FILE
        severity: error
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

### Markdown-Based Documentation

**Location:** `packages/cli/docs/*.md`

**Architecture:**
- Markdown files are the single source of truth for verbose help
- Loaded at runtime by `help-loader.ts` utility
- Included in published npm package via `files` array
- No code generation or duplication needed

**Files:**
- `packages/cli/docs/index.md` - Root verbose help (`vat --help --verbose`)
- `packages/cli/docs/resources.md` - Resources verbose help (`vat resources --help --verbose`)

**Benefits:**
- Documentation never drifts from CLI behavior (single source)
- Easy to edit without rebuilding
- Browsable on GitHub and npm
- No build-time documentation generation needed

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
root: /abs/path/to/project
filesScanned: 12
linksFound: 47
anchorsFound: 23
files:
  - path: docs/README.md
    links: 5
    anchors: 3
    checksum: e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
durationSecs: 0.234
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
docs/README.md:15:25: error: Link target not found: ./missing.md
```

*stdout:*
```yaml
---
status: error
filesScanned: 12
errorsFound: 1
filesWithErrors: 1
issueCounts: { errors: 1, warnings: 0, info: 0 }
issueSummary: { LINK_BROKEN_FILE: 1 }
issues:
  - file: docs/README.md
    issues:
      - line: 15
        column: 25
        code: LINK_BROKEN_FILE
        severity: error
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

**`packages/cli/src/utils/help-loader.ts`**
- Loads markdown documentation from `packages/cli/docs/` at runtime
- Single source of truth for CLI help
- No build-time generation needed

## Design Patterns from vibe-validate

### What We Mirror

✅ Two-tier wrapper (umbrella → CLI package)
✅ Smart context detection (dev/local/global)
✅ Commander.js structure
✅ YAML-first output on stdout
✅ Logs/errors on stderr
✅ Explicit stdout flushing before stderr
✅ `--help --verbose` → markdown documentation
✅ Runtime markdown loading (no build-time generation)
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

Use the `handleCommandError` helper for consistent error handling:

```typescript
try {
  // Command implementation
} catch (error) {
  handleCommandError(error, logger, startTime, 'CommandName');
  // handleCommandError calls process.exit() internally
}
```

This ensures a consistent error format, duration logging, and the exit codes above (1 for
expected errors, 2 for unexpected).

## Testing Patterns

### System Tests

Create system tests in `test/system/` for end-to-end CLI testing:

```typescript
describe('MyCommand (system test)', () => {
  let tempDir: string;

  beforeAll(() => {
    tempDir = createTestTempDir('vat-mycommand-test-');
  });

  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('should handle basic usage', () => {
    const { result, parsed } = executeCommandAndParse(binPath, projectDir);

    expect(result.status).toBe(0);
    expect(parsed.status).toBe('success');
  });

  it('should handle errors correctly', () => {
    // Test error scenarios with exit code 1 or 2
  });
});
```

Help-text test patterns (verifying `--help` output) are covered by
[`.claude/rules/cli-help-text.md`](../../.claude/rules/cli-help-text.md), which fires whenever
you touch a command file.

## References

- [vibe-validate CLI](https://github.com/jdutton/vibe-validate) - Pattern source
- [Commander.js](https://github.com/tj/commander.js) - CLI framework
- [Package Architecture](./README.md) - Overall package structure

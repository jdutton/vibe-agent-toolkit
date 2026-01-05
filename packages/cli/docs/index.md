# vat - Vibe Agent Toolkit CLI

> Agent-friendly toolkit for building, testing, and deploying portable AI agents

## Usage

```bash
vat [options] <command>
```

## Commands

### `resources validate`

Markdown resource scanning and link validation (run before commit)

**What it does:**

1. Scans markdown files for links and anchors
2. Validates internal file links (relative paths)
3. Validates anchor links within files (#heading)
4. Validates cross-file anchor links (file.md#heading)
5. Reports broken links to stderr

**When to use:** Before committing changes that touch markdown files

**Exit codes:**

- `0` - All links valid
- `1` - Broken links found (see stderr for details)
- `2` - System error (invalid config, directory not found)

**Creates/modifies:** None (read-only validation)

**Examples:**

```bash
vat resources validate docs/              # Validate docs directory
vat resources validate                    # Use config patterns
vat resources validate --debug            # Show detailed progress
```

---

### `resources scan`

Discover markdown resources in directory and report statistics

**What it does:**

1. Recursively finds markdown files
2. Counts links and anchors
3. Outputs statistics as YAML to stdout

**When to use:** Understanding markdown structure before processing

**Exit codes:**

- `0` - Scan completed successfully

**Creates/modifies:** None (read-only scan)

**Output format:** YAML to stdout

```yaml
status: success
filesScanned: 42
linksFound: 156
anchorsFound: 89
duration: 234
```

**Examples:**

```bash
vat resources scan .                      # Scan current directory
vat resources scan docs/                  # Scan specific directory
```

---

### `doctor`

Diagnose vat setup and environment health

**What it does:**

1. Checks Node.js version (>=20 required)
2. Checks Git installation and repository
3. Validates configuration file exists and is valid
4. Checks vat version and available updates
5. Verifies CLI build status (in VAT source tree)

**When to use:** Before starting development, after updates, or debugging issues

**Exit codes:**

- `0` - All checks passed
- `1` - One or more checks failed

**Creates/modifies:** None (read-only diagnostics)

**Examples:**

```bash
vat doctor                                # Run diagnostic checks
vat doctor --verbose                      # Show all checks (including passing)
```

**More details:** `vat doctor --help` or see `packages/cli/docs/doctor.md`

---

### `agent build`

Build agent for deployment to target runtime

**What it does:**

1. Resolves agent dependencies
2. Bundles agent code for target runtime
3. Generates runtime-specific manifest
4. Creates deployment artifacts

**When to use:** Preparing agent for production deployment

**Exit codes:**

- `0` - Build succeeded
- `1` - Build failed (see stderr for details)
- `2` - Configuration error

**Creates/modifies:**

- `dist/vat-bundles/{target}/` - Bundled agent artifacts
- Runtime-specific manifest files

**Examples:**

```bash
vat agent build ./my-agent                # Build for default target
vat agent build ./my-agent --target claude-skills
vat agent build ./my-agent --output ./dist
```

---

### `agent run`

Execute agent locally for testing

**What it does:**

1. Loads agent from path
2. Executes agent with provided input
3. Outputs agent results

**When to use:** Testing agent behavior before deployment

**Exit codes:**

- `0` - Execution succeeded
- `1` - Execution failed

**Creates/modifies:** Depends on agent behavior

**Examples:**

```bash
vat agent run ./my-agent --input "test query"
vat agent run ./my-agent --debug
```

---

### `rag index`

Create vector embeddings for semantic search over documentation

**What it does:**

1. Scans markdown files in specified path
2. Chunks documents for embedding
3. Generates vector embeddings
4. Stores in vector database for fast retrieval

**When to use:** Setting up semantic search capabilities

**Exit codes:**

- `0` - Indexing succeeded
- `1` - Indexing failed

**Creates/modifies:**

- Vector database files for semantic search
- Index metadata

**Examples:**

```bash
vat rag index docs/                       # Index documentation
vat rag index docs/ --chunk-size 512
```

---

### `rag search`

Search indexed documentation semantically

**What it does:**

1. Queries vector database by semantic meaning
2. Returns ranked results by similarity
3. Outputs results to stdout

**When to use:** Finding relevant documentation by meaning (not keywords)

**Exit codes:**

- `0` - Search succeeded
- `1` - Search failed (no index, query error)

**Creates/modifies:** None (read-only query)

**Examples:**

```bash
vat rag search "how to validate markdown links"
vat rag search "agent deployment" --limit 5
```

---

## Global Options

- `--version` - Show version number (with `-dev` suffix when running from development repo)
- `--help` - Show help for any command
- `--help --verbose` - Show comprehensive help (this output)
- `--debug` - Enable debug logging

## Environment Variables

### VAT_DEBUG
Enable detailed wrapper diagnostics showing context detection and resolution:

```bash
VAT_DEBUG=1 vat --version
# Output includes:
#   - Current working directory
#   - Detected project root
#   - Context (dev/local/global)
#   - Binary path being used
#   - Version information
```

### VAT_ROOT_DIR
Override automatic context detection to force dev mode:

```bash
VAT_ROOT_DIR=/path/to/vibe-agent-toolkit vat --version
```

## Context Detection

The `vat` wrapper automatically detects your execution context:

**Dev mode** - Running from within vibe-agent-toolkit repository:
- Shows version with `-dev` suffix: `0.1.0-rc.9-dev (/path/to/repo)`
- Uses development build directly (no packaging)
- Works from any subdirectory within the repo

**Local install** - Project has vibe-agent-toolkit in node_modules:
- Uses locally installed version
- Shown in version output: `0.1.0-rc.9 (local: /path/to/project)`

**Global install** - Fallback when no local install found:
- Uses globally installed version
- Shows clean version: `0.1.0-rc.9`

When running global `vat` from within the toolkit repository, it automatically
switches to dev mode and shows the `-dev` suffix.

## Configuration

Place `vibe-agent-toolkit.config.yaml` at project root:

```yaml
version: 1
resources:
  include:
    - "docs/**/*.md"
    - "README.md"
  exclude:
    - "node_modules/**"
    - "**/archive/**"
```

## Exit Code Summary

- `0` - Success (validation passed, scan completed, build succeeded)
- `1` - Expected failures (validation errors, broken links, build failures)
- `2` - System errors (invalid config, directory not found, missing dependencies)

## Output Formats

**Structured output (YAML)** - Commands like `scan` output YAML to stdout for parsing:
```bash
vat resources scan . | yq '.filesScanned'
```

**Error output (stderr)** - Validation errors use test format:
```
file:line:col: severity: message
```

## Common Workflows

**Before committing documentation:**
```bash
vat resources validate docs/ && git commit -m "Update docs"
```

**Building and testing agent:**
```bash
vat agent build ./my-agent
vat agent run ./my-agent --input "test"
```

**Setting up semantic search:**
```bash
vat rag index docs/
vat rag search "markdown validation"
```

## More Information

- **Agent guidance:** `docs/cli/CLAUDE.md` (strategic patterns for AI agents)
- **Documentation:** https://github.com/jdutton/vibe-agent-toolkit
- **Issues:** https://github.com/jdutton/vibe-agent-toolkit/issues

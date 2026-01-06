# @vibe-agent-toolkit/cli

Command-line interface for the Vibe Agent Toolkit.

## Installation

Install the umbrella package globally:

```bash
npm install -g vibe-agent-toolkit
```

Or install CLI package directly in a project:

```bash
npm install @vibe-agent-toolkit/cli
```

## Usage

### Basic Commands

```bash
# Show version (with context)
vat --version

# Show help
vat --help

# Show comprehensive help
vat --help --verbose
```

### Resources Commands

```bash
# Scan markdown resources
vat resources scan docs/

# Validate link integrity
vat resources validate docs/

# Show resources help
vat resources --help --verbose
```

### RAG Commands

Index and query markdown documents using vector search:

```bash
# Index markdown files into RAG database
vat rag index docs/

# Search the database
vat rag query "authentication methods"

# View database statistics
vat rag stats

# Clear database (rebuild required after)
vat rag clear
```

**Database Options:**
- Default: `.rag-db` in project root
- Custom: `--db <path>` flag on any command

**Embedding Model:**
- Uses transformers.js with `all-MiniLM-L6-v2` (local, fast, free)
- 384-dimensional embeddings
- No API key required

### Doctor Command

Diagnose vat setup and environment health.

**Usage:**
```bash
# Check environment and configuration
vat doctor

# Show all checks (including passing ones)
vat doctor --verbose
```

**What it checks:**
- Node.js version (>=20 required)
- Git installation and repository
- Configuration file exists and is valid
- VAT version (checks for updates)
- CLI build status (in VAT source tree only)

**Exit codes:**
- `0` - All checks passed
- `1` - One or more checks failed

**Example output:**
```
🩺 vat doctor

Running diagnostic checks...

✅ Node.js version
   v22.0.0 (meets requirement: >=20.0.0)

✅ Git installed
   git version 2.43.0

✅ Git repository
   Current directory is a git repository

✅ Configuration file
   Found: vibe-agent-toolkit.config.yaml

✅ Configuration valid
   Configuration is valid

✅ vat version
   Current: 0.1.0 — up to date

📊 Results: 6/6 checks passed

✨ All checks passed! Your vat setup looks healthy.
```

**Troubleshooting:**

If checks fail, doctor provides specific suggestions:

```
❌ Node.js version
   v18.0.0 is too old. Node.js 20+ required.
   💡 Upgrade Node.js: https://nodejs.org/ or use nvm
```

### Configuration

Create `vibe-agent-toolkit.config.yaml` at project root:

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

### Development Mode

Set `VAT_ROOT_DIR` to run from source:

```bash
export VAT_ROOT_DIR=/path/to/vibe-agent-toolkit
vat --version  # Shows: 0.1.0-dev (/path/to/vibe-agent-toolkit)
```

## Documentation

- [CLI Reference](./docs/) - Complete command documentation (markdown source)
- Run `vat --help --verbose` for the same documentation at runtime
- [Architecture](../../docs/architecture/README.md) - Package structure

## Development

```bash
# Build
bun run build

# Test (do NOT use 'bun test' directly)
bun run test:unit
bun run test:integration
bun run test:system

# Prepare binaries after build
bun run prepare-cli-bin
```

## License

MIT © Jeff Dutton

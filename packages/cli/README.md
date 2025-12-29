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

- [CLI Reference](../../docs/cli-reference.md) - Complete command documentation
- [Architecture](../../docs/architecture/README.md) - Package structure

## Development

```bash
# Build
bun run build

# Test
bun test
bun test:integration
bun test:system

# Prepare binaries after build
bun run prepare-cli-bin
```

## License

MIT © Jeff Dutton

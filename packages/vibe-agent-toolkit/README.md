# vibe-agent-toolkit

> Modular toolkit for building, testing, and deploying portable AI agents

## Installation

```bash
npm install -g vibe-agent-toolkit
```

## Quick Start

```bash
# Show version and help
vat --version
vat --help

# Scan markdown resources
vat resources scan docs/

# Validate link integrity
vat resources validate docs/
```

## Features

- **Resource Management**: Intelligent markdown scanning and validation
- **Link Integrity**: Verify internal links, anchors, and external URLs
- **CLI-First**: Human-readable YAML output, machine-parseable structure
- **Configurable**: Project-level configuration via YAML
- **Cross-Platform**: Works on Windows, macOS, Linux

## Documentation

- [CLI Reference](../cli/docs/) - Complete command documentation (or run `vat --help --verbose`)
- [Architecture](../../docs/architecture/README.md) - Package structure
- [Getting Started](../../docs/getting-started.md) - Detailed guide

## Development

This is the umbrella package that provides the `vat` command. Implementation is in `@vibe-agent-toolkit/cli`.

## License

MIT © Jeff Dutton

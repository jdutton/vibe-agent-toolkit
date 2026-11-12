# vibe-agent-toolkit

> Toolkit for skills, plugins, marketplaces and knowledge resources

VAT audits Claude skills, plugins, marketplaces and settings; builds, verifies and publishes skills
and plugins; validates markdown knowledge resources against schemas and link integrity; and
indexes and queries them for RAG and through the resource projection. It is not an agent runtime.

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

- **Audit**: `vat audit` on plugins, marketplaces, skills and settings, including Claude-surface compatibility
- **Skills and plugins**: validate, build, verify, test and publish skills, plugins and marketplaces
- **Knowledge resources**: markdown collections with frontmatter schemas and link integrity
- **RAG and projection**: index and query markdown (`vat rag`), and ask SQL questions of the resource projection (`vat resources query`)
- **CLI-First**: Human-readable YAML output, machine-parseable structure
- **Configurable**: Project-level configuration via YAML
- **Cross-Platform**: Works on Windows, macOS, Linux

## Documentation

- [CLI Reference](../cli/docs/index.md) - Complete command documentation (or run `vat --help --verbose`)
- [Architecture](../../docs/architecture/README.md) - Package structure
- [Getting Started](../../docs/getting-started.md) - Detailed guide

## Development

This is the umbrella package that provides the `vat` command. Implementation is in `@vibe-agent-toolkit/cli`.

## License

MIT © Jeff Dutton

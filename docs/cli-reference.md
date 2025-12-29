# CLI Reference

> **Complete command-line reference for vat**
>
> **This document is auto-synced with `vat --help --verbose` output**
>
> The content below is the exact output from running `vat --help --verbose`.
> Last updated: 2025-12-29

<!-- Content below auto-generated -->

# vat - Vibe Agent Toolkit CLI

## Overview

The `vat` command-line tool provides access to toolkit capabilities for building,
testing, and deploying portable AI agents.

## Usage

```bash
vat [command] [options]
```

## Commands

### resources
Markdown resource scanning and validation

- `vat resources --help --verbose` - Show detailed resources help
- `vat resources scan [path]` - Discover markdown resources
- `vat resources validate [path]` - Validate link integrity

## Options

- `--version` - Show version number
- `--help` - Show help
- `--help --verbose` - Show comprehensive help (this output)
- `--debug` - Enable debug logging

## Exit Codes

- `0` - Success
- `1` - Validation errors (expected failures)
- `2` - System errors (unexpected failures)

## Examples

```bash
# Show version
vat --version

# Scan markdown resources
vat resources scan docs/

# Validate all links
vat resources validate docs/
```

## Configuration

Place `vibe-agent-toolkit.config.yaml` at project root:

```yaml
version: 1
resources:
  include:
    - "docs/**/*.md"
  exclude:
    - "node_modules/**"
```

## More Information

- Documentation: https://github.com/jdutton/vibe-agent-toolkit
- Issues: https://github.com/jdutton/vibe-agent-toolkit/issues

# vat - Vibe Agent Toolkit CLI

## Overview

The `vat` command-line tool provides markdown resource validation and scanning
for AI agent projects.

## Usage

```bash
vat [options] <command>
```

## Global Options

- `--version` - Show version number
- `--help` - Show help for any command
- `--help --verbose` - Show comprehensive help (this output)
- `--debug` - Enable debug logging

## Commands

### resources
Markdown resource scanning and validation

- `vat resources scan [path]` - Discover markdown files and report statistics
- `vat resources validate [path]` - Validate internal links and anchors
- `vat resources --help --verbose` - Show detailed command help

## Exit Codes

- `0` - Success
- `1` - Validation errors (broken links, missing anchors)
- `2` - System errors (invalid config, directory not found)

## Examples

```bash
# Validate markdown in docs directory
vat resources validate docs/

# Scan for markdown files
vat resources scan .

# Use in CI with exit code checking
vat resources validate docs/ && echo "Docs valid"
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

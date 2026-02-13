# Audit Command Reference

## Overview

The `vat audit` command provides comprehensive validation for Claude plugins, marketplaces, registries, and Agent Skills. It automatically detects resource types and applies appropriate validation rules, outputting structured YAML reports for programmatic parsing.

## Key Features

- **Auto-detection**: Automatically identifies resource type based on file structure
- **Comprehensive validation**: Schema validation, link integrity, naming conventions
- **Hierarchical output**: Groups results by marketplace → plugin → skill relationships
- **Cache staleness detection**: Identifies outdated cached plugins
- **Cross-platform support**: Works on Windows, macOS, and Linux
- **CI/CD friendly**: Structured YAML output and exit codes for automation

## Usage

```bash
vat audit [path] [options]
```

### Arguments

- `[path]` - Path to audit (optional, default: current directory)
  - Can be: directory, registry file, SKILL.md file, or resource directory

### Options

- `--user` - Audit user-level Claude plugins installation (`~/.claude/plugins`)
- `-r, --recursive` - Scan directories recursively for all resource types
- `--debug` - Enable debug logging (outputs to stderr)

## Supported Resource Types

### 1. Plugin Directories

Plugin directories contain a `.claude-plugin/plugin.json` manifest:

```
my-plugin/
├── .claude-plugin/
│   └── plugin.json      # Plugin manifest
└── skills/
    └── skill1.md
```

**Validation checks**:
- `plugin.json` exists and is valid JSON
- Schema validation against plugin manifest schema
- Referenced skills exist

### 2. Marketplace Directories

Marketplace directories contain a `.claude-plugin/marketplace.json` manifest:

```
my-marketplace/
├── .claude-plugin/
│   └── marketplace.json  # Marketplace manifest
└── plugins/
    └── plugin1/
```

**Validation checks**:
- `marketplace.json` exists and is valid JSON
- Schema validation against marketplace manifest schema
- Plugin references are valid

### 3. Registry Files

Registry files track installed plugins and known marketplaces:

- `installed_plugins.json` - Installed plugins registry
- `known_marketplaces.json` - Known marketplaces registry

**Validation checks**:
- File exists and is valid JSON
- Schema validation against registry schema
- Checksums match installed versions (cache staleness)

### 4. Agent Skills (SKILL.md files)

Individual Agent Skill markdown files with frontmatter:

```markdown
---
name: my-skill
description: Skill description
---

Skill content here...
```

**Validation checks** (see Error Codes section below for details):
- Frontmatter presence and validity
- Required fields (`name`, `description`)
- Name and description constraints
- Link integrity (broken links, missing anchors)
- Path style (no Windows backslashes)
- Length limits (warning at 5000+ lines)
- Console-incompatible tool usage (warning)

### 5. VAT Agents

VAT agent directories contain an `agent.yaml` manifest and `SKILL.md`:

```
my-agent/
├── agent.yaml
└── SKILL.md
```

**Validation checks**:
- Validates the `SKILL.md` file with VAT-specific context

## User-Level Audit

The `--user` flag audits your installed Claude plugins:

```bash
vat audit --user
```

**What it checks**:
- All plugins in `~/.claude/plugins/`
- All marketplaces and their plugins
- Cache staleness (checksums vs installed versions)
- All skills within plugins

**Output format**:
- Hierarchical structure: marketplace → plugin → skill
- Cache status for each plugin
- Issue counts at each level

**Example output**:
```yaml
status: success
summary:
  filesScanned: 42
  success: 40
  warnings: 2
  errors: 0
  marketplaces: 2
  standalonePlugins: 3
  standaloneSkills: 5
hierarchical:
  marketplaces:
    - name: anthropic-agent-skills
      status: success
      plugins:
        - name: document-skills
          status: warning
          cacheStatus: fresh
          skills:
            - path: .../pdf.md
              status: warning
              issues:
                - code: SKILL_TOO_LONG
                  message: Skill exceeds recommended length
```

## Exit Codes

- **0** - Success: All validations passed
- **1** - Errors found: Validation errors that must be fixed
- **2** - System error: Config invalid, path not found, etc.

## Validation Checks

### Errors (Must Fix)

Errors prevent the resource from being used correctly:

- **Missing manifests/frontmatter**: Resource structure is invalid
- **Schema validation failures**: Manifest/frontmatter doesn't match expected format
- **Broken links**: Links to non-existent files (Skills only)
- **Reserved words in names**: Using reserved words like "help", "exit" (Skills only)
- **XML tags in frontmatter**: XML-like tags in name/description (Skills only)
- **Windows-style backslashes**: Path separators should be forward slashes (Skills only)

### Warnings (Should Fix)

Warnings indicate potential issues but don't prevent usage:

- **Skill exceeds recommended length**: Over 5000 lines (Skills only)
- **Console-incompatible tools**: References tools that don't work in console (Skills only)

## Error Codes Reference

### Plugin Errors

| Code | Severity | Description | Fix |
|------|----------|-------------|-----|
| `PLUGIN_MISSING_MANIFEST` | error | `.claude-plugin/plugin.json` not found | Create plugin manifest |
| `PLUGIN_INVALID_JSON` | error | Manifest is not valid JSON | Fix JSON syntax |
| `PLUGIN_INVALID_SCHEMA` | error | Manifest fails schema validation | Fix manifest structure |

### Marketplace Errors

| Code | Severity | Description | Fix |
|------|----------|-------------|-----|
| `MARKETPLACE_MISSING_MANIFEST` | error | `.claude-plugin/marketplace.json` not found | Create marketplace manifest |
| `MARKETPLACE_INVALID_JSON` | error | Manifest is not valid JSON | Fix JSON syntax |
| `MARKETPLACE_INVALID_SCHEMA` | error | Manifest fails schema validation | Fix manifest structure |

### Registry Errors

| Code | Severity | Description | Fix |
|------|----------|-------------|-----|
| `REGISTRY_MISSING_FILE` | error | Registry file not found | Create registry file |
| `REGISTRY_INVALID_JSON` | error | Registry is not valid JSON | Fix JSON syntax |
| `REGISTRY_INVALID_SCHEMA` | error | Registry fails schema validation | Fix registry structure |

### Skill Errors

| Code | Severity | Description | Fix |
|------|----------|-------------|-----|
| `SKILL_MISSING_FRONTMATTER` | error | No YAML frontmatter found | Add frontmatter with `---` delimiters |
| `SKILL_MISSING_NAME` | error | `name` field missing from frontmatter | Add `name` field |
| `SKILL_MISSING_DESCRIPTION` | error | `description` field missing from frontmatter | Add `description` field |
| `SKILL_NAME_INVALID` | error | Name contains invalid characters | Use only letters, numbers, hyphens, underscores |
| `SKILL_DESCRIPTION_TOO_LONG` | error | Description exceeds 500 characters | Shorten description |
| `SKILL_NAME_RESERVED_WORD` | error | Name is a reserved word | Choose a different name |
| `SKILL_NAME_XML_TAGS` | error | Name contains XML-like tags | Remove XML tags from name |
| `SKILL_DESCRIPTION_XML_TAGS` | error | Description contains XML-like tags | Remove XML tags from description |
| `SKILL_DESCRIPTION_EMPTY` | error | Description is empty or whitespace | Provide meaningful description |
| `SKILL_MISCONFIGURED_LOCATION` | error | Standalone skill in `~/.claude/plugins/` won't be recognized | Move to `~/.claude/skills/` for standalone skills, or add `.claude-plugin/plugin.json` for a proper plugin |
| `PATH_STYLE_WINDOWS` | error | Windows-style backslashes in paths | Use forward slashes (/) instead |
| `LINK_INTEGRITY_BROKEN` | error | Link to non-existent file | Fix or remove broken link |

### Skill Warnings

| Code | Severity | Description | Fix |
|------|----------|-------------|-----|
| `SKILL_TOO_LONG` | warning | Skill exceeds 5000 lines | Consider splitting into multiple skills |
| `SKILL_CONSOLE_INCOMPATIBLE` | warning | References console-incompatible tools | Use console-compatible alternatives |

### Format Detection Errors

| Code | Severity | Description | Fix |
|------|----------|-------------|-----|
| `UNKNOWN_FORMAT` | error | Cannot determine resource type | Ensure path contains valid resource structure |

## Output Format

### Standard Output (stdout)

Structured YAML report for programmatic parsing:

```yaml
status: success | warning | error
summary:
  filesScanned: number
  success: number      # Files with no issues
  warnings: number     # Files with warnings only
  errors: number       # Files with errors
issues:
  errors: number       # Total error count across all files
  warnings: number     # Total warning count across all files
  info: number         # Total info count across all files
duration: "123ms"
files:
  - path: /path/to/resource
    status: success | warning | error
    type: plugin | marketplace | registry | skill
    issues: []
```

### Standard Error (stderr)

Human-readable error messages and logs:

```
ERROR: Audit failed: 2 file(s) with errors
ERROR: /path/to/skill.md:
ERROR:   [SKILL_MISSING_NAME] name field is required in frontmatter
ERROR:     at: line 1
ERROR:     fix: Add 'name: skill-name' to frontmatter
```

## Examples

### Basic Usage

Audit current directory:

```bash
vat audit
```

Audit specific directory:

```bash
vat audit ./my-plugin
```

Audit specific registry file:

```bash
vat audit ~/.claude/plugins/installed_plugins.json
```

Audit specific skill:

```bash
vat audit ./skills/my-skill.md
```

### User-Level Audit

Audit all installed Claude plugins:

```bash
vat audit --user
```

This scans:
- `~/.claude/plugins/marketplaces/*/`
- `~/.claude/plugins/cache/*/`
- All registry files
- All skills within plugins

### Recursive Scanning

Scan directory tree for all resources:

```bash
vat audit ./resources --recursive
```

Finds and validates:
- Plugin directories (`.claude-plugin/plugin.json`)
- Marketplace directories (`.claude-plugin/marketplace.json`)
- Registry files (`installed_plugins.json`, `known_marketplaces.json`)
- Skill files (`SKILL.md`)

### CI/CD Integration

Use in CI pipeline:

```bash
#!/bin/bash
set -e

# Audit all resources
vat audit --recursive > audit-report.yaml

# Check exit code
if [ $? -eq 1 ]; then
  echo "Audit failed with validation errors"
  cat audit-report.yaml
  exit 1
elif [ $? -eq 2 ]; then
  echo "Audit failed with system error"
  exit 2
fi

echo "Audit passed"
```

GitHub Actions example:

```yaml
name: Validate Skills
on: [push, pull_request]

jobs:
  audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v1
      - run: npm install -g vibe-agent-toolkit
      - run: vat audit --recursive
```

## Troubleshooting

### "User plugins directory not found"

**Problem**: `--user` flag but no `~/.claude/plugins/` directory

**Solution**: Install Claude Desktop and plugins first, or audit specific path instead

### "Cannot determine resource type"

**Problem**: Path doesn't match any known resource structure

**Solutions**:
- Ensure plugin has `.claude-plugin/plugin.json` or `.claude-plugin/marketplace.json`
- Ensure registry files are named `installed_plugins.json` or `known_marketplaces.json`
- Ensure skill files are named `SKILL.md`
- Use `--recursive` to scan subdirectories

### "Permission denied" on Windows

**Problem**: Cannot access `%USERPROFILE%\.claude\plugins`

**Solution**: Run as administrator or check file permissions

### Large output in CI

**Problem**: Too much YAML output for CI logs

**Solution**: Redirect stdout to file, only show stderr:

```bash
vat audit --recursive > audit.yaml 2>&1
if [ $? -ne 0 ]; then
  echo "Audit failed, see audit.yaml"
  exit 1
fi
```

## Cross-Platform Considerations

### Path Separators

Always use forward slashes (`/`) in:
- Link paths in SKILL.md files
- Config file paths
- Command-line arguments

Windows users: Use forward slashes even on Windows - they work correctly in Node.js.

### Home Directory

`--user` flag automatically resolves:
- macOS/Linux: `~/.claude/plugins`
- Windows: `%USERPROFILE%\.claude\plugins`

### Line Endings

SKILL.md files can use any line ending (LF, CRLF) - the parser handles both.

## Related Commands

- `vat agent audit <path>` - Legacy skill-only audit (deprecated)
- `vat doctor` - Check environment and installation health
- `vat resources validate` - Validate markdown resources (links, anchors)

## See Also

- [CLI Reference](./index.md) - Complete CLI documentation
- [Agent Command](./agent.md) - Agent build and import commands
- [Resources Command](./resources.md) - Markdown resource validation
- [Doctor Command](./doctor.md) - Environment diagnostics

# vat agent audit

Audit Agent Skills for quality, compatibility, and best practices.

## Synopsis

```bash
vat agent audit [path] [options]
```

## Description

The `audit` command validates Agent Skills (SKILL.md files) for:
- **Frontmatter compliance** - Required fields, naming conventions, character limits
- **Link integrity** - Broken links, invalid paths, missing files
- **Console compatibility** - Tool usage that won't work in console mode
- **Best practices** - Naming conventions, description guidelines, skill length

The command outputs structured YAML to stdout and human-readable messages to stderr.

## Arguments

### path

Optional path to audit. Can be:
- **SKILL.md file** - Validates single skill
- **VAT agent directory** - Validates agent's SKILL.md
- **Directory** - Scans for SKILL.md files (with `--recursive`)
- **Omitted** - Uses current directory

## Options

### -r, --recursive

Scan subdirectories recursively for SKILL.md files.

```bash
vat agent audit docs/ --recursive
```

### --debug

Enable debug logging for troubleshooting.

```bash
vat agent audit --debug
```

## Output Format

The command outputs YAML to stdout with this structure:

```yaml
status: success|warning|error
summary:
  filesScanned: 1
  success: 1
  warnings: 0
  errors: 0
issues:
  errors: 0
  warnings: 0
  info: 0
files:
  - path: /path/to/SKILL.md
    type: agent-skill|vat-agent
    status: success|warning|error
    summary: "0 errors, 0 warnings, 0 info"
    issues: []
    metadata:
      name: my-skill
      description: "Skill description"
      lineCount: 245
duration: "42ms"
```

Human-readable errors and warnings are written to stderr.

## Exit Codes

- **0** - All skills passed validation (success or warnings only)
- **1** - Validation errors found (blocking issues)
- **2** - System error (file not found, invalid config, etc.)

## Validation Rules

### Critical Errors (Exit Code 1)

#### Frontmatter Errors

**SKILL_MISSING_FRONTMATTER**
- SKILL.md must have YAML frontmatter
- Fix: Add frontmatter block with required fields

**SKILL_MISSING_NAME**
- Required field "name" is missing
- Fix: Add `name` field to frontmatter

**SKILL_MISSING_DESCRIPTION**
- Required field "description" is missing
- Fix: Add `description` field to frontmatter

**SKILL_NAME_INVALID**
- Name must be lowercase alphanumeric with hyphens
- Pattern: `^[a-z0-9]+(-[a-z0-9]+)*$`
- Max length: 64 characters
- Fix: Change to format like "my-skill" or "data-processor"

**SKILL_NAME_RESERVED_WORD**
- Name contains reserved word "anthropic" or "claude"
- Fix: Remove reserved word from name

**SKILL_NAME_XML_TAGS**
- Name contains XML tag characters (< or >)
- Fix: Remove < and > characters from name

**SKILL_DESCRIPTION_EMPTY**
- Description field is empty or whitespace-only
- Fix: Add meaningful description explaining what skill does

**SKILL_DESCRIPTION_TOO_LONG**
- Description exceeds 1024 characters
- Fix: Reduce description length (aim for 2-3 sentences)

**SKILL_DESCRIPTION_XML_TAGS**
- Description contains XML tag characters (< or >)
- Fix: Remove < and > characters from description

#### Link Errors

**LINK_INTEGRITY_BROKEN**
- Link points to non-existent file
- Fix: Create missing file or correct link path

**PATH_STYLE_WINDOWS**
- Link uses Windows-style backslashes (\)
- Fix: Change backslashes to forward slashes (/)

### Warnings (Exit Code 0)

**SKILL_TOO_LONG**
- Skill exceeds 5000 lines
- Fix: Break into smaller skills or use reference files
- Rationale: Very long skills are harder to maintain and may hit token limits

**SKILL_CONSOLE_INCOMPATIBLE**
- Skill references tools not available in console mode
- Incompatible tools: Write, Edit, Bash, NotebookEdit
- Fix: Add note that skill requires IDE/CLI mode
- Rationale: Console users should know skill won't work fully

## Examples

### Audit Single Skill

```bash
vat agent audit my-skill/SKILL.md
```

### Audit VAT Agent

```bash
vat agent audit my-agent/
```

### Audit All Skills in Directory

```bash
vat agent audit skills/ --recursive
```

### Use in CI/CD

```bash
# Fail build if any errors found
vat agent audit agents/ --recursive
if [ $? -eq 1 ]; then
  echo "Validation errors found"
  exit 1
fi
```

**GitHub Actions example:**

```yaml
- name: Audit Agent Skills
  run: |
    npm install -g vibe-agent-toolkit
    vat agent audit agents/ --recursive
```

### Parse Output with jq

```bash
# Count total errors
vat agent audit skills/ -r | jq '.issues.errors'

# List files with errors
vat agent audit skills/ -r | jq '.files[] | select(.status == "error") | .path'

# Get validation summary
vat agent audit skills/ -r | jq '.summary'
```

## Common Issues and Fixes

### Issue: Name validation fails

```
[SKILL_NAME_INVALID] String must contain at most 64 character(s)
```

**Fix:** Shorten skill name to 64 characters or less:

```yaml
# Before
name: my-very-long-skill-name-that-exceeds-the-maximum-allowed-length

# After
name: my-long-skill-name
```

### Issue: Description too long

```
[SKILL_DESCRIPTION_TOO_LONG] Description exceeds 1024 characters (actual: 1456)
```

**Fix:** Reduce description to 2-3 concise sentences. Move details to skill body:

```yaml
# Before
description: |
  This skill does many things including A, B, C, D, E, F, G...
  [1456 characters of detail]

# After
description: Process data using advanced algorithms. Supports multiple formats and validation modes.
```

### Issue: Broken links

```
[LINK_INTEGRITY_BROKEN] Link target does not exist: ../reference/api.md
```

**Fix:** Create missing file or correct the link:

```markdown
<!-- Before -->
[API Reference](../reference/api.md)

<!-- After -->
[API Reference](./api-reference.md)
```

### Issue: Windows-style paths

```
[PATH_STYLE_WINDOWS] Link uses Windows-style backslashes
```

**Fix:** Use forward slashes for cross-platform compatibility:

```markdown
<!-- Before -->
[Guide](docs\guide.md)

<!-- After -->
[Guide](docs/guide.md)
```

### Issue: Console incompatibility

```
[SKILL_CONSOLE_INCOMPATIBLE] Skill references "Bash" tool which is not available in console mode
```

**Fix:** Add compatibility note to skill description or frontmatter:

```yaml
description: Automate git workflows using Bash commands. Requires IDE or CLI mode.
compatibility: Requires file system access (IDE/CLI mode only)
```

## Best Practices

### Description Guidelines

1. **Use third person** - "Processes data" not "I process data"
2. **Be specific** - Explain what and when, not how
3. **Keep it short** - Aim for 2-3 sentences (under 200 chars ideal)
4. **Explain when to use** - Help Claude understand triggering conditions

Good examples:
```yaml
description: Validates YAML configuration files against JSON schemas. Use when checking config syntax or ensuring required fields are present.

description: Generates TypeScript types from API responses. Useful when building typed API clients or updating interface definitions.
```

### Naming Conventions

1. **Lowercase only** - Use `data-processor` not `Data-Processor`
2. **Hyphen-separated** - Use `file-converter` not `file_converter`
3. **Descriptive** - Use `json-validator` not `jv`
4. **No reserved words** - Avoid "claude", "anthropic"

### Link Integrity

1. **Use relative paths** - `./docs/guide.md` not absolute paths
2. **Cross-platform** - Always use forward slashes (/)
3. **Validate regularly** - Run audit before commits
4. **Anchor links** - Supported but external URLs are not validated

## Related Commands

- [`vat agent import`](./import.md) - Convert SKILL.md to agent.yaml
- `vat resources validate` - Validate markdown link integrity

## Reference

- [Agent Skills Specification](https://agentskills.io/specification)
- [Agent Skills Best Practices](../guides/agent-skills-best-practices.md)
- [agent-skills Package](../../packages/agent-skills/README.md)

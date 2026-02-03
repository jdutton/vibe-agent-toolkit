# vat agent import

Convert Claude Skills (SKILL.md) to VAT agent format (agent.yaml).

## Synopsis

```bash
vat agent import <skillPath> [options]
```

## Description

The `import` command converts a Claude Skill in SKILL.md format to a VAT agent manifest (agent.yaml). This enables:
- **Testing** - Use VAT's testing framework with imported skills
- **Packaging** - Bundle skills as VAT agents
- **Deployment** - Deploy skills through VAT's deployment pipeline
- **Version Control** - Track skill metadata in agent.yaml

The command validates the SKILL.md frontmatter before conversion and creates an agent.yaml file with metadata extracted from the skill.

## Arguments

### skillPath

**Required.** Path to SKILL.md file to import.

```bash
vat agent import my-skill/SKILL.md
```

## Options

### -o, --output <path>

Specify custom output path for agent.yaml.

Default: Same directory as SKILL.md

```bash
vat agent import my-skill/SKILL.md --output my-agent/agent.yaml
```

### -f, --force

Overwrite existing agent.yaml if it exists.

Default: Fail if agent.yaml exists

```bash
vat agent import my-skill/SKILL.md --force
```

### --debug

Enable debug logging for troubleshooting.

```bash
vat agent import my-skill/SKILL.md --debug
```

## Output Format

Success output (YAML to stdout):

```yaml
status: success
agentPath: /path/to/agent.yaml
duration: "15ms"
```

Error output (YAML to stdout):

```yaml
status: error
error: "Error message"
duration: "10ms"
```

Human-readable messages are written to stderr.

## Exit Codes

- **0** - Import successful
- **1** - Import failed (validation errors, file exists, etc.)
- **2** - System error (unexpected failure)

## What Gets Converted

### Frontmatter Fields

The import process extracts these fields from SKILL.md frontmatter:

| SKILL.md Field | agent.yaml Field | Required | Notes |
|----------------|------------------|----------|-------|
| `name` | `metadata.name` | Yes | Skill identifier |
| `description` | `metadata.description` | Yes | What skill does |
| `metadata.version` | `metadata.version` | No | Defaults to "0.1.0" |
| `metadata.tags` | `metadata.tags` | No | Skill categorization |
| `license` | `metadata.license` | No | License identifier |
| `compatibility` | `spec.compatibility` | No | Environment requirements |

### Validation Before Import

The import command validates SKILL.md before conversion:

- **Required fields** - name and description must be present
- **Name format** - lowercase alphanumeric with hyphens
- **Description length** - 1024 characters max
- **No XML tags** - < and > not allowed in name or description
- **No reserved words** - "anthropic" and "claude" not allowed in name

See [`vat agent audit`](./audit.md) for complete validation rules.

### Generated agent.yaml Structure

```yaml
metadata:
  name: my-skill
  description: Process data using advanced algorithms.
  version: 1.2.0
  tags:
    - data-processing
    - validation
spec:
  runtime: claude-skills
  compatibility: Requires file system access
```

## Examples

### Basic Import

Import skill to default location (same directory as SKILL.md):

```bash
vat agent import my-skill/SKILL.md
```

Output:
```
Successfully imported Claude Skill to: /path/to/my-skill/agent.yaml
```

### Custom Output Path

Specify where to create agent.yaml:

```bash
vat agent import my-skill/SKILL.md --output my-agent/agent.yaml
```

### Overwrite Existing

Force overwrite if agent.yaml already exists:

```bash
vat agent import my-skill/SKILL.md --force
```

### Validate Before Import

Run audit first to catch errors:

```bash
# Audit skill first
vat agent audit my-skill/SKILL.md

# Import if validation passes
vat agent import my-skill/SKILL.md
```

### Batch Import with Shell Script

```bash
#!/bin/bash
# Import all skills in a directory

for skill in skills/*/SKILL.md; do
  echo "Importing $skill..."
  vat agent import "$skill" --force
done
```

### Use in CI/CD

```yaml
# GitHub Actions
- name: Import Claude Skills
  run: |
    npm install -g vibe-agent-toolkit
    for skill in skills/*/SKILL.md; do
      vat agent import "$skill" --force
    done
```

## Common Use Cases

### 1. Converting Existing Skills

You have Claude Skills in SKILL.md format and want to use VAT's tooling:

```bash
# Import skill
vat agent import existing-skill/SKILL.md

# Now you can use VAT commands
cd existing-skill
vat test
vat package
```

### 2. Dual Format Maintenance

Maintain both SKILL.md (for Claude console) and agent.yaml (for VAT):

```bash
# Edit SKILL.md
vim my-skill/SKILL.md

# Re-import to sync agent.yaml
vat agent import my-skill/SKILL.md --force
```

### 3. Migration Pipeline

Migrate a collection of skills to VAT format:

```bash
# Audit all skills first
vat agent audit skills/ --recursive

# Import valid skills
for skill in skills/*/SKILL.md; do
  vat agent import "$skill" --force
done
```

## Error Handling

### Missing SKILL.md

```
status: error
error: "SKILL.md does not exist: /path/to/SKILL.md"
```

**Fix:** Verify file path is correct

### Invalid Frontmatter

```
status: error
error: "Invalid SKILL.md frontmatter - name: Name is required"
```

**Fix:** Add missing required fields to frontmatter

### Validation Errors

```
status: error
error: "Invalid SKILL.md frontmatter - name: String must contain at most 64 character(s)"
```

**Fix:** See [`vat agent audit`](./audit.md) for validation rules and fixes

### File Already Exists

```
status: error
error: "agent.yaml already exists at /path/to/agent.yaml. Use --force to overwrite."
```

**Fix:** Use `--force` flag to overwrite or specify different output path

## Integration with VAT Workflow

### Typical Workflow

1. **Create or edit SKILL.md** - Write skill in Claude Skills format
2. **Audit** - Validate skill quality and compatibility
3. **Import** - Convert to VAT agent format
4. **Test** - Run VAT agent tests
5. **Package** - Bundle as VAT agent
6. **Deploy** - Deploy through VAT pipeline

```bash
# Step 1: Edit skill
vim my-skill/SKILL.md

# Step 2: Audit
vat agent audit my-skill/SKILL.md

# Step 3: Import
vat agent import my-skill/SKILL.md

# Step 4-6: Use VAT tooling
cd my-skill
vat test
vat package
vat deploy
```

### SKILL.md as Source of Truth

Keep SKILL.md as the source of truth and regenerate agent.yaml:

```bash
# Makefile example
.PHONY: sync-manifests
sync-manifests:
	@for skill in skills/*/SKILL.md; do \
		echo "Syncing $$skill..."; \
		vat agent import "$$skill" --force; \
	done
```

## Limitations

### What Is NOT Converted

- **Skill body content** - Only frontmatter is converted
- **Reference files** - Links to other files are not processed
- **Custom metadata** - Non-standard frontmatter fields (except in metadata object)

### What You Need to Add Manually

After import, you may need to add to agent.yaml:

- **Dependencies** - External packages or tools required
- **Test configuration** - Test suites and fixtures
- **Build configuration** - Package and deployment settings
- **Resources** - Additional files to include

See [VAT Agent Specification](../architecture/README.md) for complete agent.yaml schema.

## Best Practices

### 1. Validate Before Import

Always audit skills before importing to catch errors early:

```bash
vat agent audit my-skill/SKILL.md && vat agent import my-skill/SKILL.md
```

### 2. Version Control Both Formats

Commit both SKILL.md and agent.yaml to git:

```
my-skill/
  SKILL.md       # Source of truth
  agent.yaml     # Generated from SKILL.md
  resources/     # Additional files
```

### 3. Automate Sync

Use pre-commit hooks or CI to keep agent.yaml in sync:

```bash
# .husky/pre-commit
vat agent import my-skill/SKILL.md --force
git add my-skill/agent.yaml
```

### 4. Document Import Process

Add to your skill's README:

```markdown
## Updating agent.yaml

After editing SKILL.md, regenerate agent.yaml:

```bash
vat agent import SKILL.md --force
```

## Related Commands

- [`vat agent audit`](./audit.md) - Validate Claude Skills before import

## Reference

- [Agent Skills Specification](https://agentskills.io/specification)
- [VAT Agent Format](../architecture/README.md)
- [agent-skills Package](../../packages/agent-skills/README.md)

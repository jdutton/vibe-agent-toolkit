# Agent Skills Best Practices

Best practices for creating high-quality, reusable Agent Skills based on the [Agent Skills Specification](https://agentskills.io/specification) and VAT audit validation rules.

## Overview

This guide covers best practices for creating Agent Skills that:
- Work reliably across different environments (console, IDE, CLI)
- Follow naming and documentation conventions
- Maintain link integrity and file references
- Are discoverable and maintainable

## Naming Conventions

### Skill Name

The skill `name` field in frontmatter must follow strict conventions:

**Rules:**
- **Lowercase only** - No uppercase letters
- **Alphanumeric + hyphens** - Only `a-z`, `0-9`, and `-`
- **No consecutive hyphens** - Use `data-processor` not `data--processor`
- **Cannot start/end with hyphen** - Use `json-parser` not `-json-parser-`
- **Max 64 characters** - Keep it concise
- **No reserved words** - Avoid "claude" and "anthropic"
- **No XML characters** - No `<` or `>` symbols

**Good Examples:**
```yaml
name: json-validator
name: api-client
name: data-processor
name: file-converter
```

**Bad Examples:**
```yaml
name: JSON-Validator      # Uppercase
name: json_validator      # Underscore
name: json--validator     # Consecutive hyphens
name: -json-validator     # Starts with hyphen
name: claude-helper       # Reserved word
name: <json-validator>    # XML characters
```

### Why These Rules?

- **URL-safe** - Skills may be referenced in URLs or file systems
- **Cross-platform** - Works on all operating systems
- **Parseable** - Easy to extract and validate
- **Consistent** - Predictable naming across all skills

## Description Guidelines

### Writing Effective Descriptions

The `description` field is critical for Claude to understand when to use your skill.

**Rules:**
- **Max 1024 characters** - Be concise (aim for 2-3 sentences)
- **Third person** - "Processes data" not "I process data"
- **Explain what and when** - What does it do, when should it be used?
- **No XML characters** - No `<` or `>` symbols
- **Not empty** - Whitespace-only descriptions fail validation

**Good Examples:**
```yaml
description: Validates JSON files against JSON Schema specifications. Use when checking configuration files, API responses, or ensuring data structure compliance.

description: Generates TypeScript type definitions from API responses or JSON samples. Useful when building typed API clients or updating interface definitions.

description: Processes CSV files for data analysis, transformation, and validation. Supports filtering, aggregation, and export to multiple formats.
```

**Bad Examples:**
```yaml
# Too vague
description: Does stuff with JSON

# First person
description: I validate JSON files against schemas

# Too long (imagine 1500 characters here)
description: This skill is a comprehensive JSON validation solution that provides...

# Contains XML
description: Validates <json> files

# Empty
description: ""
```

### Description Template

Use this template as a starting point:

```
[Action verb] [what it operates on] for [purpose]. Use when [triggering conditions or use cases].
```

Examples:
- "**Analyzes** log files for **error detection and pattern matching**. Use when **troubleshooting application issues or monitoring system health**."
- "**Converts** markdown documents to **multiple output formats** (PDF, HTML, DOCX). Use when **generating documentation or creating presentations from markdown sources**."

## Console Compatibility

Claude Skills can run in different environments with different capabilities.

### Console vs IDE/CLI Mode

| Feature | Console | IDE/CLI |
|---------|---------|---------|
| Read files | Yes | Yes |
| Write files | No | Yes |
| Edit files | No | Yes |
| Execute bash | No | Yes |
| Notebook editing | No | Yes |

### Console-Incompatible Tools

These tools are NOT available in console mode:

- **Write** - Creating new files
- **Edit** - Modifying existing files
- **Bash** - Executing shell commands
- **NotebookEdit** - Modifying Jupyter notebooks

### Best Practices for Console Compatibility

**1. Document compatibility requirements**

If your skill requires file system access:

```yaml
description: Automates git workflows using Bash commands. Requires IDE or CLI mode.
compatibility: Requires file system access (IDE/CLI mode only)
```

**2. Use progressive disclosure**

Structure skills so console users can still benefit:

```markdown
# Git Workflow Automation

## Analysis (Console-Compatible)

You can analyze git history, review commits, and explain changes without file system access.

## Automation (Requires IDE/CLI)

For automated operations like committing, pushing, and merging, you'll need IDE or CLI mode.
```

**3. Provide alternatives**

When possible, offer console-compatible alternatives:

```markdown
## Analyzing Code

Console mode: I can read and analyze code you share with me.
IDE/CLI mode: I can also read files directly from your file system.
```

### Checklist: Is My Skill Console-Compatible?

- [ ] Skill does NOT use Write tool
- [ ] Skill does NOT use Edit tool
- [ ] Skill does NOT use Bash tool
- [ ] Skill does NOT use NotebookEdit tool
- [ ] All operations work with read-only access
- [ ] OR skill documentation clearly states IDE/CLI requirement

## Link Integrity

Broken links create poor user experience and failed skill execution.

### Link Best Practices

**1. Use relative paths**

```markdown
<!-- Good -->
[API Reference](./api-reference.md)
[Guide](../guides/getting-started.md)

<!-- Bad -->
[API Reference](/absolute/path/to/api-reference.md)
[Guide](C:\Users\jeff\Documents\guide.md)
```

**2. Use forward slashes**

Always use forward slashes (`/`), never backslashes (`\`):

```markdown
<!-- Good -->
[Windows Guide](./guides/windows-setup.md)

<!-- Bad -->
[Windows Guide](.\guides\windows-setup.md)
```

**3. Verify links exist**

Before committing, run:

```bash
vat agent audit my-skill/SKILL.md
```

**4. Avoid external URLs in skill instructions**

External URLs can break or change. If you must reference external content:
- Use well-established, stable URLs (official docs, RFCs, etc.)
- Consider copying relevant content into skill or reference files
- Document that external links are informational only

**5. Use anchor links for navigation**

```markdown
[See Configuration](#configuration)
[Jump to Examples](#examples)

## Configuration
...

## Examples
...
```

### What Gets Validated

VAT's audit tool checks:
- ✅ Local file links (relative paths)
- ✅ Anchor links within files
- ✅ Cross-file anchor links
- ℹ️ External URLs are noted but NOT validated (by design)

## File Organization

### Skill Structure

Recommended structure for Claude Skills:

```
my-skill/
├── SKILL.md              # Main skill file
├── agent.yaml            # VAT agent manifest (after import)
├── reference/            # Reference documentation
│   ├── api-spec.md
│   └── examples.md
├── test/                 # Test cases (optional)
│   └── test-cases.md
└── README.md             # User-facing docs (optional)
```

### Skill Length

**Keep skills under 5000 lines** for:
- Faster loading in Claude's context
- Easier maintenance
- Better token efficiency
- Reduced cognitive load

**If your skill exceeds 5000 lines:**

1. **Break into multiple skills** - Split by feature or domain
2. **Use reference files** - Move detailed specs to separate files
3. **Provide summaries** - Link to full docs instead of embedding

Example:

```markdown
<!-- SKILL.md -->
# API Client Skill

For detailed API specifications, see [reference/api-spec.md](./reference/api-spec.md).
For examples, see [reference/examples.md](./reference/examples.md).
```

## Progressive Disclosure

Structure skills to progressively reveal complexity.

### Layered Information Architecture

**Level 1: Overview** (always present)
- What the skill does
- When to use it
- Basic examples

**Level 2: Common Use Cases** (for frequent scenarios)
- Step-by-step guides
- Common patterns
- Troubleshooting tips

**Level 3: Advanced Details** (for edge cases)
- Detailed API references
- Configuration options
- Complex scenarios

### Example Structure

```markdown
# Data Processing Skill

## Overview
Process CSV and JSON data files for analysis and transformation.

## Common Use Cases

### Filtering Data
[Simple example...]

### Aggregating Results
[Simple example...]

## Advanced

### Custom Transformations
[Complex example with all options...]

### Performance Tuning
[Edge cases and optimization...]
```

## Validation Before Sharing

Always validate skills before sharing or deploying:

```bash
# Validate single skill
vat agent audit my-skill/SKILL.md

# Validate all skills
vat agent audit skills/ --recursive

# Import to VAT format
vat agent import my-skill/SKILL.md
```

### Pre-Commit Workflow

Add to your `.husky/pre-commit` hook:

```bash
#!/bin/sh
vat agent audit skills/ --recursive
if [ $? -eq 1 ]; then
  echo "Skill validation failed. Fix errors before committing."
  exit 1
fi
```

### CI/CD Integration

Add to GitHub Actions workflow:

```yaml
- name: Validate Claude Skills
  run: |
    npm install -g vibe-agent-toolkit
    vat agent audit skills/ --recursive
```

## Common Pitfalls

### 1. Using First Person in Descriptions

❌ Bad:
```yaml
description: I help you process JSON files
```

✅ Good:
```yaml
description: Processes JSON files for validation and transformation
```

### 2. Overly Long Descriptions

❌ Bad: 1500 character description explaining every detail

✅ Good: 2-3 sentences with link to detailed docs

### 3. Hard-Coding Paths

❌ Bad:
```markdown
See /Users/jeff/projects/docs/api.md
```

✅ Good:
```markdown
See [API Documentation](./reference/api.md)
```

### 4. Assuming File System Access

❌ Bad: "This skill writes results to disk"

✅ Good: "This skill can write results to disk in IDE/CLI mode, or display them in console mode"

### 5. Not Testing Links

❌ Bad: Committing without checking links

✅ Good: Running `vat agent audit` before every commit

### 6. Using Reserved Words

❌ Bad:
```yaml
name: claude-helper
```

✅ Good:
```yaml
name: ai-assistant-helper
```

## Discoverability

Help users find and understand your skill:

### 1. Descriptive Names

```yaml
# Good: Immediately clear what it does
name: json-schema-validator

# Bad: Unclear or too generic
name: validator
```

### 2. Searchable Descriptions

Include keywords users might search for:

```yaml
description: Validates YAML configuration files against JSON schemas. Supports YAML, YML, and JSON formats. Use when checking config syntax, ensuring required fields, or validating API contracts.
```

### 3. Tags (VAT-Specific)

If using VAT agent format, add tags:

```yaml
metadata:
  tags:
    - validation
    - yaml
    - json-schema
    - configuration
```

## Maintainability

### Version Your Skills

Use semantic versioning in VAT agents:

```yaml
metadata:
  version: 1.2.0
```

### Document Changes

Keep a CHANGELOG.md for significant skills:

```markdown
# Changelog

## [1.2.0] - 2025-01-03
### Added
- Support for YAML validation
- Custom error messages

### Fixed
- Handle malformed JSON gracefully
```

### Regular Audits

Schedule periodic validation:

```bash
# Weekly skill audit
vat agent audit skills/ --recursive > audit-report.yaml
```

## Testing Skills

### Manual Testing Checklist

Before releasing a skill:

- [ ] Test with real-world inputs
- [ ] Verify all links work
- [ ] Test in console mode (if applicable)
- [ ] Test in IDE mode (if applicable)
- [ ] Run audit validation
- [ ] Have someone else try it

### Automated Testing (VAT)

If using VAT agents, add test cases:

```markdown
# test/test-cases.md

## Test: JSON Validation

**Input:**
```json
{"name": "test"}
```

**Expected Output:**
Valid JSON structure
```

## Security Considerations

### Avoid Embedding Secrets

Never put secrets in skill files:

❌ Bad:
```yaml
api_key: sk-1234567890abcdef
```

✅ Good:
```markdown
The user should provide their API key when using this skill.
```

### Validate User Input

If your skill processes user input, document validation requirements:

```markdown
## Input Validation

This skill expects:
- File paths must be relative (not absolute)
- No special characters in filenames
- Max file size: 10MB
```

## Official Specification

Always refer to the official [Agent Skills Specification](https://agentskills.io/specification) for:
- Complete frontmatter schema
- Official field definitions
- Specification updates
- Additional guidance

This guide is based on the specification but adds VAT-specific best practices and validation rules.

## Related Documentation

- [Audit Command](../cli/audit.md) - Validation rules and error codes
- [Import Command](../cli/import.md) - Converting skills to VAT format
- [agent-skills Package](../../packages/agent-skills/README.md) - Validation API

## Getting Help

If you have questions about skill development:
- Review audit error messages - they include fix suggestions
- Check the specification at agentskills.io
- Open an issue on GitHub
- Review example skills in the repository

## Summary Checklist

Before sharing your skill:

- [ ] Name follows lowercase-hyphen convention
- [ ] Description is concise (under 200 chars ideal)
- [ ] Description uses third person
- [ ] All links use relative paths with forward slashes
- [ ] Console compatibility is documented (if limited)
- [ ] No reserved words (claude, anthropic)
- [ ] No XML characters in name or description
- [ ] Skill length under 5000 lines
- [ ] Audit validation passes (`vat agent audit`)
- [ ] Tested in target environment (console/IDE)

Following these best practices will ensure your Claude Skills are high-quality, maintainable, and work reliably across all environments.

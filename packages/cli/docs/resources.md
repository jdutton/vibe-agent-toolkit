# vat resources - Markdown Resource Commands

## Overview

The `vat resources` commands provide intelligent discovery and validation of markdown resources,
including link integrity checking and anchor validation.

## Commands

### vat resources scan [path]

**Purpose:** Discover markdown resources in a directory

**What it does:**
1. Scans directory for markdown files (respects config include/exclude)
2. Parses each file to extract links and headings
3. Shows statistics about discovered resources
4. Exits 0 always (informational only)

**Options:**
- `[path]` - Directory to scan (defaults to current directory)
- `--debug` - Enable debug logging

**Exit Codes:**
- `0` - Always (scan is informational)
- `2` - System error (file access, parsing error)

**Output:** YAML on stdout, logs on stderr

**Example:**
```bash
vat resources scan docs/

# Output:
# ---
# status: success
# filesScanned: 12
# linksFound: 47
# anchorsFound: 23
# files:
#   - path: docs/README.md
#     links: 5
#     anchors: 3
# duration: 234ms
# ---
```

### vat resources validate [path]

**Purpose:** Validate markdown resources with strict error reporting

**What it does:**
1. Scans directory for markdown resources
2. Validates all links (internal, anchors, external if configured)
3. Reports errors in dual format (YAML + test format)
4. Exits 0 if valid, 1 if errors found

**Options:**
- `[path]` - Directory to validate (defaults to current directory)
- `--debug` - Enable debug logging

**Exit Codes:**
- `0` - Validation passed
- `1` - Validation errors found
- `2` - System error

**Output:**
- YAML on stdout (structured results)
- Test-format errors on stderr (file:line:column: message)

**Example (success):**
```bash
vat resources validate docs/

# Output:
# ---
# status: success
# filesScanned: 12
# linksChecked: 47
# anchorsChecked: 23
# duration: 456ms
# ---
```

**Example (errors):**
```bash
vat resources validate docs/

# stderr:
# docs/README.md:15:25: Link target not found: ./missing.md
# docs/guide.md:42:10: Broken anchor: #non-existent-section

# stdout:
# ---
# status: failed
# errorsFound: 2
# errors:
#   - file: docs/README.md
#     line: 15
#     column: 25
#     type: broken-link
#     message: Link target not found: ./missing.md
# duration: 456ms
# ---
```

## Configuration

Place `vibe-agent-toolkit.config.yaml` at project root:

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

## Integration with vibe-validate

The test-format error output (stderr) integrates seamlessly with vibe-validate:

```yaml
# vibe-validate.config.yaml
validators:
  markdown:
    run: vat resources validate docs/
    extract:
      - type: test-format
```

## More Information

- GitHub: https://github.com/jdutton/vibe-agent-toolkit
- Issues: https://github.com/jdutton/vibe-agent-toolkit/issues

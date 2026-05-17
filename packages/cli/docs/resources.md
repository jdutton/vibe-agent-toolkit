# vat resources - Markdown Resource Commands

## Overview

The `vat resources` commands provide intelligent discovery and validation of markdown resources,
including link integrity checking and anchor validation.

## Commands

### vat resources scan [path]

**Purpose:** Discover markdown resources in a directory

**What it does:**
1. Recursively scans for markdown files
2. Parses each file to extract links and headings
3. Shows statistics about discovered resources
4. Exits 0 always (informational only)

**Path Argument:**
- `[path]` specifies the **base directory** to start crawling from
- Recursively finds all `*.md` files under that directory (default pattern: `**/*.md`)
- When path is specified, **config patterns are ignored** (to avoid pattern conflicts)
- To use config patterns, run without path argument: `vat resources scan`

**Options:**
- `[path]` - Base directory to crawl (defaults to current directory)
- `--debug` - Enable debug logging

**Exit Codes:**
- `0` - Always (scan is informational)
- `2` - System error (file access, parsing error)

**Output:** YAML on stdout, logs on stderr

**Example:**
```bash
# Recursively scan all *.md files under docs/
vat resources scan docs/
# Equivalent to: find all files matching docs/**/*.md pattern

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

**Requirements:**

- **`projectRoot`**: optional with **loud-cwd fallback**. When invoked with an
  explicit `[path]`, that path is the effective base. Without a path, VAT walks
  up from `cwd` for `vibe-agent-toolkit.config.yaml` then `.git/`; if neither is
  found, the command falls back to `cwd` and emits a single stderr warning
  identifying the fallback. The scan still completes — the warning is the
  contract that prevents silent surprise.
- **Config**: optional. Uses built-in include/exclude defaults if no config file
  is present.

See [Roots and Config — Canonical Concepts](../../../docs/concepts/roots-and-config.md)
for the loud-cwd fallback policy and the projectRoot discovery ladder.

### vat resources validate [path]

**Purpose:** Validate markdown resources with strict error reporting

**What it does:**
1. Recursively scans for markdown resources
2. Validates all links (internal, anchors, external if configured)
3. Reports errors in dual format (YAML + test format)
4. Exits 0 if valid, 1 if errors found

**Path Argument:**
- `[path]` specifies the **base directory** to start crawling from
- Recursively finds all `*.md` files under that directory (default pattern: `**/*.md`)
- When path is specified, **config patterns are ignored** (to avoid pattern conflicts)
- To use config patterns, run without path argument: `vat resources validate`

**Options:**
- `[path]` - Base directory to crawl (defaults to current directory)
- `--debug` - Enable debug logging
- `--no-check-frontmatter-links` - Skip frontmatter URI-reference link validation across all collections (default: enabled)

**Exit Codes:**
- `0` - Validation passed
- `1` - Validation errors found
- `2` - System error

**Output:**
- YAML on stdout (structured results)
- Test-format errors on stderr (file:line:column: message)

**Example (success):**
```bash
# Recursively validate all *.md files under docs/
vat resources validate docs/
# Equivalent to: find all files matching docs/**/*.md pattern

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

**Requirements:**

- **`projectRoot`**: optional with **loud-cwd fallback**. With an explicit
  `[path]` the path is used as the base directory; without it VAT walks for a
  `vibe-agent-toolkit.config.yaml` then `.git/` ancestor, and falls back to
  `cwd` with a stderr warning if neither is found.
- **Config**: optional. Defaults are applied when no config file is present;
  `--frontmatter-schema` is independent of config.

**Leading-`/` URI-reference resolution.** Markdown body links and frontmatter
URI-references whose path component starts with `/` (e.g.
`[See](/docs/foo.md)`, `parent_spec: /docs/foo.md`) are RFC 3986 §4.2
absolute-path references and are resolved against the discovered `projectRoot`.
Once cwd-fallback has fired, the effective `projectRoot` is `cwd` and leading-`/`
links resolve against `cwd` — consistent with the loud-cwd contract. The
`absolute_no_root` failure mode fires only when `projectRoot` is genuinely
undefined (e.g. a programmatic embedder that did not supply one); leading-`/`
links that escape `projectRoot` via path traversal surface as
`absolute_escapes_root`. Both surface as `broken_file` issues.

See [Roots and Config — Canonical Concepts](../../../docs/concepts/roots-and-config.md)
for the projectRoot ladder, the loud-cwd fallback policy, and the rationale
behind RFC-3986-compliant leading-`/` resolution.

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

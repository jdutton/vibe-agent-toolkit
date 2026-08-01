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
- `[path]` restricts the scan to that subtree of the project
- Recursively finds all `*.md` / `*.html` files under that directory
- The path **replaces** the config's `resources.include` patterns
- The config's `resources.exclude` patterns **still apply** — a path run never
  scans build output, vendored trees, or test fixtures the project excluded
- To scan the project's full configured set, run without a path argument:
  `vat resources scan`

**Options:**
- `[path]` - Base directory to crawl (defaults to current directory)
- `--debug` - Enable debug logging
- `--verbose` - Add a `files:` list with per-file link/anchor counts and checksums
- `--collection <id>` - Only report files in the named collection (config mode — no path argument)

**Exit Codes:**
- `0` - Always (scan is informational)
- `2` - System error (file access, parsing error)

**Output:** YAML on stdout, logs on stderr

`root` is stated once and is the only absolute path in the document; every
`path` beneath it is relative to it.

**Example:**
```bash
# Recursively scan all *.md files under docs/
vat resources scan docs/ --verbose
# Equivalent to: find all files matching docs/**/*.md pattern

# Output:
# ---
# status: success
# root: /home/you/my-project
# filesScanned: 12
# linksFound: 47
# anchorsFound: 23
# durationSecs: 0.234
# files:
#   - path: docs/README.md
#     links: 5
#     anchors: 3
#     checksum: 47dd7b50af765df240fe2514f029fc697c907fc37a3267e22060f2f9f611975c
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
- `[path]` restricts the scan to that subtree of the project
- Recursively finds all `*.md` / `*.html` files under that directory
- The path **replaces** the config's `resources.include` patterns
- The config's `resources.exclude` patterns **still apply** — a path run never
  scans build output, vendored trees, or test fixtures the project excluded
- To scan the project's full configured set, run without a path argument:
  `vat resources validate`

**Options:**
- `[path]` - Base directory to crawl (defaults to current directory)
- `--debug` - Enable debug logging
- `-v, --verbose` - Show all scanned resources, including those without issues. By
  default `issues` carries one counts-only row per file with findings
  (`{file, errors?, warnings?, info?, codes}`); `--verbose` replaces each row with
  its per-issue detail. Every other output field is identical in both modes.
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
# durationSecs: 0.456
# ---
```

**Example (errors):**
```bash
vat resources validate docs/

# stderr:  (file:line:column: severity: message — only `error` fails the run)
# docs/README.md:15:25: error: Link target not found: ./missing.md
# docs/guide.md:42:10: error: Broken anchor: #non-existent-section

# stdout:
# ---
# status: error
# errorsFound: 2
# filesWithErrors: 2
# issueCounts: { errors: 2, warnings: 0, info: 0 }
# issueSummary: { LINK_BROKEN_FILE: 1, LINK_BROKEN_ANCHOR: 1 }
# issues:
#   - file: docs/README.md
#     issues:
#       - line: 15
#         column: 25
#         code: LINK_BROKEN_FILE
#         severity: error
#         message: Link target not found: ./missing.md
# durationSecs: 0.456
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
  # Optional: per-code severity overrides (keys are validation codes,
  # values are error | warning | info | ignore). External-URL findings
  # default to `warning` (non-fatal), so a dead external link won't fail
  # the build unless you raise its severity here.
  validation:
    severity:
      EXTERNAL_URL_DEAD: ignore        # don't fail the build on dead external links
      FRONTMATTER_SCHEMA_ERROR: error
```

**Dot-directories are scanned.** `**` traverses path segments beginning with a
dot, so the default `**/*.md` reaches `.claude/`, `.github/` and the like — as do
your own patterns. Visibility is decided by git and by `exclude`, never by a
leading dot. To keep a dotted tree out of the scan, exclude it by name:

```yaml
resources:
  exclude:
    - ".claude/worktrees/**"
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

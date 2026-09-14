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
vat audit [git-url-or-path] [options]
```

### Arguments

- `[git-url-or-path]` - Path or git URL to audit (optional, default: current directory)
  - Local path: directory, registry file, SKILL.md file, or resource directory
  - Git URL: HTTPS, SSH, GitHub shorthand, or GitHub web URL (see "Auditing a remote git repo" below)

### Options

- `--user` - Audit user-level Claude plugins installation (`~/.claude/plugins`)
- `--no-recursive` - Scan the top level only (recursive scanning is the default; there is no `--recursive` flag)
- `--compat` - Run compatibility analysis for each plugin; adds a `compatibility:` block to its entry (see [Compatibility and settings blocks](#compatibility-and-settings-blocks))
- `--settings [file]` - Check each plugin against Claude settings (auto-discovered, or the given file); adds a `settings:` block. Requires `--compat`
- `--debug` - Enable debug logging (outputs to stderr)

### Gitignore-aware scanning

When scanning inside a git repository, `vat audit` skips paths that match
the project's `.gitignore` rules. This automatically excludes build
artifacts (`dist/`), dependencies (`node_modules/`), and any other
project-specific ignored directories without maintaining a hardcoded list.

To opt back into scanning gitignored paths (for example, to audit a
bundled marketplace plugin in `dist/`), use `--include-artifacts`.

User-supplied `--exclude` patterns are always applied on top of gitignore
filtering. Outside a git repository, no automatic exclusions apply.

Examples:

    vat audit .                              # Gitignored paths skipped
    vat audit --include-artifacts .          # Scan everything
    vat audit --exclude "vendor/**" .        # Gitignore + extra exclusion
    vat audit --include-artifacts --exclude "**/node_modules/**" .
                                             # Override gitignore, re-exclude node_modules

## Supported Resource Types

### 1. Plugin Directories

Plugin directories contain a `.claude-plugin/plugin.json` manifest:

```
my-plugin/
├── .claude-plugin/
│   └── plugin.json      # Plugin manifest
├── commands/            # slash commands (optional)
├── agents/              # subagents (optional)
├── hooks/
│   └── hooks.json       # hook registry (optional)
├── .mcp.json            # MCP server config (optional)
└── skills/
    └── skill1.md
```

**Validation checks**:
- `plugin.json` exists and is valid JSON
- Schema validation against plugin manifest schema
- Referenced skills exist
- `hooks/hooks.json` and `.mcp.json` parse as valid JSON when present (emits `PLUGIN_INVALID_JSON`)

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

### Multi-dir Workflows

`--user` is singular — one Claude config dir per invocation. The target
directory is resolved from `$CLAUDE_CONFIG_DIR` if set, otherwise defaults
to `~/.claude`. For users with multiple Claude config dirs (for example,
`~/.claude` for work and `~/.claude-personal` for personal projects), loop
in the shell:

```bash
for dir in ~/.claude ~/.claude-personal; do
  CLAUDE_CONFIG_DIR="$dir" vat audit --user --verbose
done
```

This pattern matches Claude Code's own `CLAUDE_CONFIG_DIR` convention and
scales naturally to community smell-scanning (see the VAT skill-smell
detection strategy doc, workstream B).

**Example output**:
```yaml
status: success
summary:
  filesScanned: 42
  filesPassed: 40
  filesWithWarnings: 2
  filesWithErrors: 0
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

## `status` and the exit code

The YAML `status` describes the findings — the worst actionable severity across
them — and the exit code follows it, exactly as in every other command of this
CLI. `vat audit` used to be the one exception ("advisory": exit 0 over
`status: error`), which a CI author reading the shared contract got wrong on
exactly this verb.

A run that audited **zero files** is refused, not passed. An existing directory
with nothing auditable in it — plugins that moved, a wrong subdirectory, an
excluded tree, files no lane recognises — used to publish `status: success`
beside `filesScanned: 0`, which is the same document a clean tree produces. It
now publishes `status: error` with one non-overridable `RESOURCE_CHECK_BROKEN`
finding under a top-level `issues:` key (the claim is about the run, so it is
not a `files[]` row and does not count toward `filesScanned`), and exits `1`.

What still sets audit apart from `vat skills validate` is not the exit code but
what it shows: audit ignores `validation.allow` (every finding is reported and
counted) and reads `validation.severity` from three scopes. `validation.severity`
is therefore the dial that decides what gates — set a code to `warning` and it
stops moving the exit code; set it to `ignore` and it disappears from the report.

## Exit Codes

The three-way contract every command shares:

- **0** - The audit completed with nothing at error severity. Warnings and informational findings are in the report, not the exit code.
- **1** - The audit completed and reports `status: error`: at least one error-severity finding, or zero files audited. A directory or file INSIDE the tree that the scan could not read — permission denied, a vanished mount — is `SCAN_PATH_UNREADABLE` (warning): the run is degraded, not failed, every readable sibling is still validated, and the refused path is reported under `summary.pathsUnreadable` rather than counted in `filesScanned` — so a root with nothing readable audited zero files and is refused like an empty tree. A governing `vibe-agent-toolkit.config.yaml` that cannot be loaded, or whose `skills.include` reaches a directory the crawl cannot list, is warned about once on stderr and filed as `SCAN_PATH_UNREADABLE` on the config file or the directory; the skills it governs are validated config-free rather than dropped. Degrading beats destroying, and the report says where it degraded.
- **2** - The audit could not run at all, so there is no report to read: the path does not exist or is a file no audit lane recognises (the same ending `vat resources validate` and `vat skill review` give that argument), `--user` with no Claude config directory installed, a git URL that could not be cloned, an unknown flag, or an internal failure (a validator defect). An invalid config and a permission problem inside the tree are **not** exit 2 — they are findings, above.

## Validation Configuration

Audit honors `validation.severity` from `vibe-agent-toolkit.config.yaml`: setting a code to `ignore` hides it from the report, and every other level is applied as written — a code raised to `error` is reported as an error, a code lowered to `warning` as a warning. It changes **which findings are reported and at what severity**, and through them the exit code — a code at `error` gates, one lowered to `warning` does not (see [`status` and the exit code](#status-and-the-exit-code)). Audit does **not** apply `validation.allow` (per-path allow entries); for that, use `vat skills validate` or `vat skills build`.

Three scopes are read, least specific first — a more specific one naming the same code wins:

```yaml
# In vibe-agent-toolkit.config.yaml
resources:
  validation:
    severity:
      LINK_MISSING_TARGET: ignore       # project-wide; the same dial
                                        # `vat resources validate` reads
skills:
  defaults:
    validation:
      severity:
        LINK_TO_NAVIGATION_FILE: ignore # project-wide: skills, plugins and
                                        # marketplaces alike
        LINK_DROPPED_BY_DEPTH: error    # elevated in the report
  config:
    my-skill:
      validation:
        severity:
          LINK_DROPPED_BY_DEPTH: info   # just this skill
```

See `docs/validation-codes.md` for the full code reference.

## Validation Checks

### Errors (Must Fix)

Errors prevent the resource from being used correctly:

- **Missing manifests/frontmatter**: Resource structure is invalid
- **Schema validation failures**: Manifest/frontmatter doesn't match expected format
- **Broken links**: Links to non-existent files (Skills only)
- **Reserved words in names**: `anthropic` or `claude` in a skill name (`RESERVED_WORD_IN_NAME`, a warning — Claude Code rejects non-certified skills using them)
- **XML tags in frontmatter**: XML-like tags in name/description (Skills only)

### Warnings (Should Fix)

Warnings indicate potential issues but don't prevent usage:

- **Skill exceeds recommended length**: Over 5000 lines (Skills only)
- **Capability observations**: Skill requires a runtime capability that isn't available on every surface — `CAPABILITY_BROWSER_AUTH`, `CAPABILITY_LOCAL_SHELL`, `CAPABILITY_EXTERNAL_CLI` (info); with `--compat`, the per-target verdicts `COMPAT_TARGET_INCOMPATIBLE` / `COMPAT_TARGET_NEEDS_REVIEW` (warning) and `COMPAT_TARGET_UNDECLARED` (info). See `docs/validation-codes.md`.

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
| `SKILL_DESCRIPTION_TOO_LONG` | error | Description exceeds 1024 characters (the frontmatter schema limit; `SKILL_DESCRIPTION_OVER_CLAUDE_CODE_LIMIT` warns earlier at 250, where the Claude Code `/skills` listing truncates) | Shorten description |
| `RESERVED_WORD_IN_NAME` | warning | Name contains `anthropic` or `claude`; Claude Code rejects non-certified skills using these words | Rename the skill to avoid these words |
| `SKILL_NAME_XML_TAGS` | error | Name contains XML-like tags | Remove XML tags from name |
| `SKILL_DESCRIPTION_XML_TAGS` | error | Description contains XML-like tags | Remove XML tags from description |
| `SKILL_DESCRIPTION_EMPTY` | error | Description is empty or whitespace | Provide meaningful description |
| `SKILL_MISCONFIGURED_LOCATION` | error | Standalone skill in `~/.claude/plugins/` won't be recognized | Move to `~/.claude/skills/` for standalone skills, or add `.claude-plugin/plugin.json` for a proper plugin |
| `LINK_INTEGRITY_BROKEN` | error | Link to non-existent file | Fix or remove broken link |

### Skill Warnings

| Code | Severity | Description | Fix |
|------|----------|-------------|-----|
| `SKILL_TOO_LONG` | warning | Skill exceeds 5000 lines | Consider splitting into multiple skills |
| `CAPABILITY_BROWSER_AUTH` | info | Skill needs browser login (MSAL, SSO, OAuth) | See `docs/validation-codes.md#capability_browser_auth` |
| `CAPABILITY_LOCAL_SHELL` | info | Skill needs local shell/environment tools (Bash, Edit, Write, NotebookEdit) | See `docs/validation-codes.md#capability_local_shell` |
| `CAPABILITY_EXTERNAL_CLI` | info | Skill invokes an unbundled CLI (az, aws, gcloud, etc.) | See `docs/validation-codes.md#capability_external_cli` |
| `COMPAT_TARGET_INCOMPATIBLE` | warning | With `--compat`: a declared target cannot run the skill | See `docs/validation-codes.md#compat_target_incompatible` |
| `COMPAT_TARGET_NEEDS_REVIEW` | warning | With `--compat`: a declared target may not run the skill | See `docs/validation-codes.md#compat_target_needs_review` |
| `COMPAT_TARGET_UNDECLARED` | info | With `--compat`: the skill declares no `targets` | See `docs/validation-codes.md#compat_target_undeclared` |

### Format Detection Errors

| Code | Severity | Description | Fix |
|------|----------|-------------|-----|
| `UNKNOWN_FORMAT` | error | Cannot determine resource type | Ensure path contains valid resource structure |

## Output Format

### Standard Output (stdout)

Structured YAML report for programmatic parsing:

```yaml
root: /abs/path/to/scan/root   # The ONE absolute path in the document
status: success | warning | error
summary:
  filesScanned: number        # Files the audit READ — never a path it could not
  filesPassed: number         # Files with no ACTIONABLE issues (info-only counts as passed)
  filesWithWarnings: number   # Files whose worst actionable severity is warning
  filesWithErrors: number     # Files carrying at least one error
  pathsUnreadable: number     # `files[]` rows that are a refused path (SCAN_PATH_UNREADABLE),
                              #   outside every count above: files.length === filesScanned + pathsUnreadable
issueCounts:                  # FINDINGS, not files — same field name and meaning
  errors: number              #   as the `issueCounts` on each entry below,
  warnings: number            #   plus the run-level `issues` when present
  info: number
issues:                       # Only when the RUN itself is refused — a run over
  - code: RESOURCE_CHECK_BROKEN   # zero files. Not a file, so not in `files[]`.
    severity: error
    message: ...
duration: "123ms"
files:
  - path: plugins/my-plugin            # relative to `root`
    status: success | warning | error
    type: plugin | marketplace | registry | skill
    issues:
      - location: plugins/my-plugin/.claude-plugin/plugin.json   # relative to `root`
```

#### One stated root, and everything relative to it

`root` is the invocation scan root and the only absolute path a report contains.
Every `path` and every issue `location` beneath it is forward-slashed and
relative to that root, so:

- `join(root, path)` and `join(root, location)` name real files — a consumer
  never has to guess, or reimplement, the base a value was written against.
- A `location` identifies a file uniquely across the whole document, even when a
  run spans several projects that share internal layout (two `plugins/plugin-a`
  directories under different parents cannot collapse to one string).
- Nothing but `root` can leak the developer's or CI runner's home directory.

The scan root is an ANCHOR, not a validation-policy boundary. Per-skill
packaging rules still come from each skill's nearest-ancestor
`vibe-agent-toolkit.config.yaml` (configs do not compose); that discovery has no
say in how a path is spelled.

`--user` scans three sibling directories (`plugins/`, `skills/`,
`marketplaces/`), so its `root` is their shared Claude config dir
(`$CLAUDE_CONFIG_DIR`, else `~/.claude`). A URL audit omits `root`: the clone
lives in a random tempdir that nothing downstream can resolve, so the provenance
header states the base instead and paths are relative to the cloned repo.

#### Compatibility and settings blocks

Under `--compat`, every `claude-plugin` entry carries a `compatibility:` block;
under `--compat --settings`, a `settings:` block beside it. **Both blocks are
always present for every plugin the run was asked about** — a lane that could
not run says so in its block rather than leaving it out, because a plugin the
check could not answer for must never look like one the operator never asked
about.

```yaml
files:
  - path: plugins/my-plugin
    type: claude-plugin
    compatibility:               # the analyzer's verdicts…
      plugin: my-plugin
      declaredTargets: [claude-code]
      observations: [...]
      verdicts: [...]
      unchecked: []              # files the analysis could not read; verdicts were computed without them
    settings:
      compatible: false          # true ONLY when conflicts and unchecked are both empty
      conflicts:
        - type: tool-blocked
          detail: Tool "Bash" in skills/deploy/SKILL.md blocked by org policy (permissions.deny)
          blockedBy: permissions.deny
          value: Bash
          settingsFile: /etc/claude-code/managed-settings.json
          settingsLevel: managed
      unchecked:                 # present only when non-empty
        - path: skills/locked/SKILL.md           # relative to `root`
          reason: "EACCES: permission denied, open 'skills/locked/SKILL.md'"
  - path: plugins/other-plugin
    type: claude-plugin
    compatibility:               # …or the reason there are none
      analyzed: false
      reason: "EACCES: permission denied, scandir 'plugins/other-plugin/skills/locked'"
    settings:
      compatible: false
      conflicts: []
      unchecked:
        - path: plugins/other-plugin/skills/locked
          reason: "EACCES: permission denied, scandir 'plugins/other-plugin/skills/locked'"
```

`settings.unchecked` lists every path the settings check enumerated but could
not compare: a `SKILL.md` it could not read or whose frontmatter is not a YAML
mapping (the same file the validator reports as `SKILL_MISSING_FRONTMATTER`), or
a directory it could not list — in which case any skill beneath it is unseen
and unnamed. The check follows symlinks the way the validator lane does, so a
plugin whose `skills/` points at a shared tree is checked, not skipped.
`compatible` is `false` whenever anything is listed here: zero conflicts over a
skill that was never read is not compatibility. The two compat lanes are
independent — a plugin-wide analyzer failure (no valid `plugin.json`, or a root
that cannot be listed) does not stop the settings check. A single file the
analyzer cannot read, list or parse is listed under `compatibility.unchecked`
(root-relative, with the OS or parser reason) and every other file is still
analyzed; the verdicts are computed WITHOUT the unchecked files, so an empty
`verdicts` beside a non-empty `unchecked` is a verdict over fewer files than
the plugin ships.

Both outcomes are also said on stderr without `--debug`: a
`Compatibility analysis could not run for <plugin>: <reason>` line, and totals
for conflicts found and paths the settings check could not compare.

### Standard Error (stderr)

Human-readable error messages and logs. Paths are root-relative here too:

```
ERROR: Audit failed: 2 file(s) with errors
ERROR: skills/my-skill/SKILL.md:
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
vat audit ./resources
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

# Audit all resources: exit 1 on an error-severity finding, 2 if the audit could not run
if ! vat audit > audit-report.yaml; then
  echo "Audit found errors (or could not run) — see the report"
  cat audit-report.yaml
  exit 1
fi

echo "Audit clean — no error-severity findings"
```

To gate with `validation.allow` honoured (audit ignores it), use `vat skills validate` instead:

```bash
#!/bin/bash
set -e

vat skills validate   # exits 1 on validation errors
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
      - run: vat audit
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
- Scanning is recursive by default; make sure you did not pass `--no-recursive`

### "Permission denied" on Windows

**Problem**: Cannot access `%USERPROFILE%\.claude\plugins`

**Solution**: Run as administrator or check file permissions

### Large output in CI

**Problem**: Too much YAML output for CI logs

**Solution**: Redirect stdout to file, only show stderr:

```bash
vat audit > audit.yaml 2>&1
if [ $? -ne 0 ]; then
  echo "Audit failed, see audit.yaml"
  exit 1
fi
```

## Auditing a remote git repo

`vat audit` accepts a git URL in addition to a local path. When given a URL, VAT performs a shallow clone into a temporary directory, runs the audit against the cloned tree, and always cleans up the tempdir on exit.

### Accepted URL forms

| Form | Example |
|---|---|
| HTTPS git URL | `https://github.com/foo/bar.git` |
| HTTPS with ref | `https://github.com/foo/bar.git#v1.2.3` |
| HTTPS with ref + subpath | `https://github.com/foo/bar.git#main:plugins/baz` |
| GitHub web URL | `https://github.com/foo/bar/tree/main/plugins/baz` |
| GitHub shorthand | `foo/bar` |
| GitHub shorthand with ref | `foo/bar#main` |
| GitHub shorthand with ref + subpath | `foo/bar#main:plugins/baz` |
| SSH (scp form) | `git@github.com:foo/bar.git` |
| SSH (URL form) | `ssh://git@github.com/foo/bar.git` |

The `#ref[:subpath]` fragment form works on every URL form above.

### Output

Output begins with a provenance header showing the URL, ref, and resolved commit SHA, then the normal audit output with paths relative to the cloned repo root. Each header line is emitted as a YAML comment so the rest of the output remains pipe-parseable (`vat audit <url> | yq` works without preprocessing):

```
# Audited: https://github.com/foo/bar.git @ main (commit abc123de)
# Subpath: plugins/baz
---
status: success
files:
  - path: plugins/baz/SKILL.md
    ...
```

### Authentication

Authentication is entirely passthrough to your local `git` configuration. SSH URLs use your SSH agent / keys; HTTPS URLs use whatever credential helper your `git` is configured with. VAT itself does not read tokens, environment variables, or credential files.

To audit a private repo: ensure `git clone <url>` works on your machine, then `vat audit <url>` will work too.

### Debugging

Pass `--debug` to preserve the cloned tempdir for inspection (its location is printed to stderr at exit). You are responsible for cleanup when using this flag.

### Limitations

- `--depth 1` cloning cannot resolve arbitrary deep commit SHAs. Use a branch or tag name for the ref.
- GitHub web URLs are parsed only for `github.com`. For GitLab/Bitbucket/Gitea, use the `.git` URL form directly.
- Cache-skip-on-unchanged-SHA is not implemented in v1; every URL audit pays the clone cost.

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

## Requirements

`vat audit` has an unusual policy because it operates on per-skill
governing context rather than a single top-level `projectRoot`:

- **`projectRoot`**: per-skill walk-up. There is no single `projectRoot` for an
  audit run. Each `SKILL.md` discovered during scanning walks up to its own
  nearest `vibe-agent-toolkit.config.yaml`-or-`.git/` ancestor and uses that as
  *its* `projectRoot`. Skills with no governing config or git ancestor are
  reported as ungoverned (an audit finding, not a fatal error). This lets `vat
  audit` work on external community trees, downloaded plugin bundles, and
  monorepos with multiple sub-package configs.
- **Config**: accept defaults. Per-skill `validation.severity` overrides come
  from whichever `vibe-agent-toolkit.config.yaml` each skill walks up to;
  `validation.allow` is not applied by audit (see the config section above).
  The exit code follows the report's `status`, like every other command.

The per-skill walk-up is cached via a module-level two-layer cache and pre-warmed
during top-down descent for efficiency on large trees.

See [Roots and Config — Canonical Concepts](../../../docs/concepts/roots-and-config.md)
for the `projectRoot` ladder and the audit walk-up model. See
[`docs/skill-quality-and-compatibility.md`](../../../docs/skill-quality-and-compatibility.md)
for VAT's audit stance.

## Related Commands

- `vat doctor` - Check environment and installation health
- `vat resources validate` - Validate markdown resources (links, anchors)

## See Also

- [CLI Reference](./index.md) - Complete CLI documentation
- [Agent Command](./agent.md) - Agent build and import commands
- [Resources Command](./resources.md) - Markdown resource validation
- [Doctor Command](./doctor.md) - Environment diagnostics

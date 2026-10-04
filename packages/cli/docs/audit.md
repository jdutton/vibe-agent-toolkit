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
- `--settings [file]` - Check each plugin against Claude settings (auto-discovered, or the given file); adds a `settings:` block. Requires `--compat`: without it, or with `--user`, the run is refused (`USAGE_INVALID`, exit 2). A named file that does not exist is `USAGE_INVALID`; one the OS refuses, or that does not parse or fails the settings schema, is `INPUT_UNREADABLE` — the settings check never runs silently unchecked
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
- The same report envelope as every other audit (see [Output Format](#output-format)),
  with `data.hierarchical` grouping the skills: marketplace → plugin → skill
- Cache status for each cached plugin skill
- Each skill's findings distributed by severity (`summary`); the findings
  themselves are the envelope's, each naming its file in `location`

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
status: findings
examined: 42
findings:
  - code: SKILL_TOO_LONG
    severity: warning
    message: Skill exceeds recommended length
    location: plugins/marketplaces/anthropic-agent-skills/document-skills/skills/pdf/SKILL.md
summary: { errors: 0, warnings: 1, info: 0 }
gate: { strict: false }
durationMs: 812
data:
  root: /Users/me/.claude
  provenance: null
  counts: { filesPassed: 41, filesWithWarnings: 1, filesWithErrors: 0, pathsUnreadable: 0 }
  files: [...]
  hierarchical:
    marketplaces:
      - name: anthropic-agent-skills
        plugins:
          - name: document-skills
            skills:
              - name: pdf
                path: plugins/marketplaces/anthropic-agent-skills/document-skills/skills/pdf/SKILL.md
                status: findings
                summary: { errors: 0, warnings: 1, info: 0 }
    cachedPlugins: []
    standalonePlugins: []
    standaloneSkills: []
```

A standalone `SKILL.md` directly under `plugins/` (which Claude Code will not
load) carries `SKILL_MISCONFIGURED_LOCATION` at `error` — among the envelope's
findings, counted in its `summary`, and gating the exit code like any other
error.

## `status` and the exit code

One rule, the same in every report verb of this CLI:

- `status` is literal. `ok`: the audit finished and found nothing. `findings`:
  it finished and found at least one thing, at any severity. `error`: it **did
  not finish** — the reason is `error.code` (a refusal such as `USAGE_INVALID`
  or `INPUT_UNREADABLE`) and `error.message`.
- The exit code is derived from the published report: `2` when `status` is
  `error`; `1` when `summary.errors > 0`; otherwise `0`. `gate.strict` is
  always `false` — audit has no `--strict`, so warnings never move the exit
  code.

`status: error` used to mean "an error-severity finding exists" in this command
alone. An error-severity finding is now `status: findings` with
`summary.errors > 0` and exit `1`; `status: error` is reserved for a run that
did not finish.

A run that audited **zero files** is not a pass. An existing directory with
nothing auditable in it — plugins that moved, a wrong subdirectory, an excluded
tree, files no lane recognises — used to publish the same document a clean tree
produces. It now carries one non-overridable `RESOURCE_CHECK_BROKEN` finding at
`error` (with no `location`: the claim is about the run, not a file), beside
`examined: 0`, and exits `1`.

What still sets audit apart from `vat skills validate` is not the exit code but
what it shows: audit ignores `validation.allow` (every finding is reported and
counted) and reads `validation.severity` from three scopes. `validation.severity`
is therefore the dial that decides what gates — set a code to `warning` and it
stops moving the exit code; set it to `ignore` and it disappears from the report.

## Exit Codes

The three-way contract every command shares:

- **0** - The audit finished and no finding is at error severity. Warnings and informational findings are in the report, not the exit code.
- **1** - The audit finished with at least one error-severity finding (`status: findings`, `summary.errors > 0`), including a run that audited zero files. A directory or file INSIDE the tree that the scan could not read — permission denied, a vanished mount — is `SCAN_PATH_UNREADABLE` (warning): the run is degraded, not failed, every readable sibling is still validated, and the refused path is counted in `data.counts.pathsUnreadable`, never in `examined` — so a root with nothing readable audited zero files and is refused like an empty tree. A governing `vibe-agent-toolkit.config.yaml` that cannot be loaded, or whose `skills.include` reaches a directory the crawl cannot list, is warned about once on stderr and filed as `SCAN_PATH_UNREADABLE` on the config file or the directory; the skills it governs are validated config-free rather than dropped. Degrading beats destroying, and the report says where it degraded.
- **2** - The audit did not finish: `status: error`, with the refusal in `error.code`. `USAGE_INVALID` — the path does not exist, is a file no audit lane recognises (the same ending `vat resources validate` and `vat skill review` give that argument), a git URL that does not parse, or `--user` with no Claude config directory installed. `INPUT_UNREADABLE` — a root directory the OS will not list, or a git URL that could not be cloned (or whose ref or subpath it does not hold). `INTERNAL_ERROR` — a defect in VAT, with its stack on stderr. An invalid config and a permission problem inside the tree are **not** exit 2 — they are findings, above.

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
- **XML tags in frontmatter**: XML-like tags in the description (Skills only)

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
| `SKILL_DESCRIPTION_XML_TAGS` | error | Description contains markup — VAT's reading of the vendor's "cannot contain XML tags" | Remove the tag, or backtick a literal placeholder (backticks do not exempt real markup) |
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

The report envelope every report verb publishes, as YAML. Its JSON Schema is
`packages/cli/schemas/audit.json`:

```yaml
status: ok | findings | error      # literal: findings iff the list is non-empty; error = did not finish
examined: number                   # FILES the audit read — never a path it could not
findings:                          # every file's findings, flattened
  - code: SKILL_TOO_LONG
    severity: error | warning | info
    message: ...
    location: plugins/my-plugin/skills/x/SKILL.md   # the file to open, relative to `data.root`
    line: 12                                        # when the producer knows it
summary: { errors, warnings, info } # FINDINGS by severity — the one meaning of `summary`
gate: { strict: false }            # audit has no --strict: warnings never gate
durationMs: number
error: { code, message }           # only when status is error (a refusal code)
data:
  root: /abs/path/to/scan/root     # the ONE absolute path in the document; null for a URL audit
  provenance: null                 # a URL audit's source: { url, ref, commit, subpath? }
  counts:                          # FILES by their worst actionable severity
    filesPassed: number            # no ACTIONABLE finding (info-only counts as passed)
    filesWithWarnings: number
    filesWithErrors: number
    pathsUnreadable: number        # `files[]` rows that are a refused path (SCAN_PATH_UNREADABLE),
                                   #   outside every count above: files.length === examined + pathsUnreadable
  files:
    - path: plugins/my-plugin      # relative to `root`
      type: agent-skill | vat-agent | claude-plugin | marketplace | registry | unknown
      status: ok | findings        # literal: findings iff this file carries any finding
      summary: { errors, warnings, info }  # this file's findings by severity
  hierarchical: null               # `--user` only: the marketplace → plugin → skill view
```

The one finding without a `location` is the run's own `RESOURCE_CHECK_BROKEN`
over zero files: it is about the run, not a file. Every other finding names its
file; one a validator reported without a location inherits its file row's
`path`.

#### One stated root, and everything relative to it

`data.root` is the invocation scan root and the only absolute path a report
contains. Every `path` and every finding `location` beneath it is
forward-slashed and relative to that root, so:

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
(`$CLAUDE_CONFIG_DIR`, else `~/.claude`). A URL audit's `root` is `null`, and
only a URL audit's: the clone lives in a random tempdir that nothing downstream
can resolve, so `data.provenance` states the base instead and paths are relative
to the cloned repo. The schema enforces both halves — `root` is `null` exactly
when `provenance` is not.

#### Compatibility and settings blocks

Under `--compat`, every `claude-plugin` entry of `data.files` carries a `compatibility:` block;
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

### "No user-level Claude directories found"

**Problem**: `--user` flag but no `plugins/`, `skills/` or `marketplaces/` under the Claude config dir — a `USAGE_INVALID` refusal, exit 2

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

The report names its source in `data.provenance` — the URL, the ref, the resolved commit SHA and any subpath — and `data.root` is `null`: every path is relative to the cloned repo (or the subpath). stderr carries the same provenance as a human line (`Audited: <url> @ <ref> (commit abc123de)`), and stdout is the report alone:

```yaml
status: ok
examined: 1
findings: []
data:
  root: null
  provenance:
    url: https://github.com/foo/bar.git
    ref: main
    commit: abc123de…
    subpath: plugins/baz
  files:
    - path: SKILL.md
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

## `vat audit settings`

Shows what Claude is allowed to do from the current directory — the managed,
user and project settings layers merged, each value with the chain of values it
overrode — or validates one settings file (`--file`), or probes every settings
path (`--show-paths`). Every mode reads the user layer from the same place:
`settings.json` under `$CLAUDE_CONFIG_DIR`, else `~/.claude`. It publishes the
same report envelope as `vat audit`
(schema: `packages/cli/schemas/audit-settings.json`):

- `data.mode` says which mode ran: `effective` (default: `layers`,
  `effectiveSettings`, `conflicts`), `file` (`file`, `detectedType`,
  `typeConfidence`, `fields`) or `paths` (`paths`).
- `findings` carry the `SETTINGS_*` codes (see
  [`docs/validation-codes.md`](../../../docs/validation-codes.md#claude-settings-codes)) —
  non-overridable: no `validation.severity` or `validation.allow` key applies to them,
  and both refuse one — and `SCAN_PATH_UNREADABLE` for a settings path the probe could
  not check. Each finding's `location` is the settings file; `field` is the dotted key
  path inside it when there is one, and is absent for a finding about the document as a
  whole (JSON that does not parse, a violation at its root).
- `data.root` is the directory the command ran in — the one absolute path in the
  document, as `vat audit`'s `data.root` is. Every other path (a finding's
  `location`, `layers[].file`, a rule's `source` / `ruleSource` /
  `shadowedBySource`, a probed `paths[].path`, `file`) is forward-slashed and
  relative to it, so a user or managed settings file reads `../…` rather than
  leaking `$HOME`. A file on another Windows drive has no relative spelling: it is
  the one path published absolutely, and a finding about it names it at the start
  of its `message` (a `location` must be relative) — said, never dropped.
- `examined` counts the settings documents read: the layers loaded, the one
  `--file`, or the paths whose existence was determined. Zero — no settings
  file readable from here — is not a clean answer: it carries
  `RESOURCE_CHECK_BROKEN` and exits `1`.
- Exit codes follow the one rule: `1` for an error-severity finding (an invalid
  settings file, a legacy managed-settings path) or nothing read; `2` when it did
  not finish (`USAGE_INVALID` for a `--file` that does not exist or an unknown
  `--type`, `INPUT_UNREADABLE` for a `--file` the OS will not let it read — a
  file nothing could be read from is a refusal, never a finding about it).

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
  The exit code is derived from the published report by the one rule every
  report verb shares (see [`status` and the exit code](#status-and-the-exit-code)).

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

## Example reports

Each block below is a real document from the built CLI, trimmed where noted; `packages/cli/test/integration/tagged-report-examples.integration.test.ts` validates every `vat-report=<verb>` block against that verb's registered schema.

### `audit`

A built marketplace with one finding, cut to the first file entry: `status: findings`, exit `1` only on an error. Produced by `vat audit dist/.claude/plugins/marketplaces/mp1`.

```yaml vat-report=audit
status: findings
examined: 4
findings:
  - severity: info
    code: PLUGIN_MISSING_LICENSE
    message: plugin.json is missing the recommended `license` field.
    location: plugins/sample/.claude-plugin/plugin.json
    fix: Add a "license" SPDX identifier (e.g. "MIT") to plugin.json so redistribution terms are explicit.
    reference: "#plugin_missing_license"
summary:
  errors: 0
  warnings: 0
  info: 1
gate:
  strict: false
durationMs: 16689
data:
  root: /work/project/dist/.claude/plugins/marketplaces/mp1
  provenance: null
  counts:
    filesPassed: 4
    filesWithWarnings: 0
    filesWithErrors: 0
    pathsUnreadable: 0
  files:
    - path: .
      type: marketplace
      status: ok
      summary:
        errors: 0
        warnings: 0
        info: 0
    - path: plugins/sample
      type: claude-plugin
      status: findings
      summary:
        errors: 0
        warnings: 0
        info: 1
  hierarchical: null
```

### `inventory`

The inventory of a project directory. Produced by `vat inventory .`.

```yaml vat-report=inventory
status: ok
examined: 1
findings: []
summary:
  errors: 0
  warnings: 0
  info: 0
gate:
  strict: false
durationMs: 75
data:
  inventory:
    kind: plugin
    vendor: claude-code
    path: /work/project
    shape: claude-plugin
    manifest: {}
    declared:
      skills: null
      commands: null
      agents: null
      hooks: null
      mcpServers: null
      outputStyles: null
      lspServers: null
    discovered:
      skills: []
      commands: []
      agents: []
    references: []
    unexpected:
      skillManifests:
        - /work/project/dist/skills/test-skill-1/SKILL.md
      pluginManifests: []
    parseErrors: []
```

### `audit settings`

The effective settings of a project with one allow and one deny rule. Produced by `vat audit settings`.

```yaml vat-report=audit settings
status: ok
examined: 1
findings: []
summary:
  errors: 0
  warnings: 0
  info: 0
gate:
  strict: false
data:
  mode: effective
  root: /work/project
  layers:
    - level: project
      file: .claude/settings.json
  effectiveSettings:
    permissions:
      deny:
        - rule: Read(./.env)
          source: .claude/settings.json
          level: project
      allow:
        - rule: Read(./docs/**)
          source: .claude/settings.json
          level: project
  conflicts: []
```

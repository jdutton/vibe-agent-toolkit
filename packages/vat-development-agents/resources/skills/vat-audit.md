---
name: vat-audit
description: Use when running vat audit to validate Claude plugins, agent skills, or marketplaces. Covers the audit command, --compat flag for surface compatibility analysis, --exclude for noise filtering, and interpreting audit output.
---

# VAT Audit: Validating Plugins, Skills & Marketplaces

## Running the Audit

```bash
# Audit current directory (recursive by default)
vat audit

# Audit a specific directory
vat audit ./plugins/

# Audit your entire Claude installation
vat audit --user

# Exclude noisy directories
vat audit --exclude "dist/**" --exclude "node_modules/**"

# Verbose: show all resources, not just those with issues
vat audit --verbose

# Compatibility analysis: which Claude surfaces each plugin supports
vat audit ./plugins/ --compat
```

## What Gets Detected (Automatic)

Running `vat audit <path>` recursively walks the directory and auto-detects:

| Found | Detected as |
|---|---|
| `.claude-plugin/plugin.json` in a dir | Claude Plugin |
| `.claude-plugin/marketplace.json` in a dir | Claude Marketplace |
| `SKILL.md` file | Agent Skill |
| `agent.yaml` + `SKILL.md` | VAT Agent |
| `installed_plugins.json` | Registry file |

Recursion is the default — you do not need `--recursive`.

## Auditing a remote git repo

`vat audit` accepts a git URL in addition to a local path. VAT shallow-clones into a temp directory, audits the clone, and **always cleans up on exit** — including on errors and SIGINT.

```bash
# Audit a public repo (HTTPS)
vat audit https://github.com/foo/bar.git

# GitHub shorthand
vat audit foo/bar

# Pin to a branch or tag
vat audit foo/bar#main
vat audit https://github.com/foo/bar.git#v1.2.3

# Narrow to a monorepo subpath
vat audit foo/bar#main:plugins/baz

# A GitHub web URL also works
vat audit https://github.com/foo/bar/tree/main/plugins/baz
```

Output is preceded by a provenance header — `# Audited: <url> @ <ref> (commit <sha>)` — emitted as YAML comments so `vat audit <url> | yq` parses cleanly. Audited paths are repo-relative, never tempdir-relative.

**Authentication is pure passthrough to your local `git`.** SSH URLs use your SSH agent / keys; HTTPS URLs use whatever credential helper your `git` is configured with. VAT itself reads no tokens. If `git clone <url>` works on your machine, `vat audit <url>` works.

**Inspection.** Pass `--debug` to preserve the cloned tempdir for post-mortem inspection (its location is printed to stderr at exit). You are responsible for cleanup when using this flag.

For the full URL form table and edge cases, see `packages/cli/docs/audit.md` (the "Auditing a remote git repo" section).

## Audit vs configured VAT projects

Audit is the general-purpose command — you may point it at any path, configured or not. When it encounters a SKILL.md inside a configured VAT project, it walks UP to that skill's nearest-ancestor `vibe-agent-toolkit.config.yaml` and respects the skill's per-skill packaging rules (`excludeReferencesFromBundle`, `linkFollowDepth`, `files`) to avoid false flags — but it never composes configs across project boundaries. Per-skill rules from one project do not bleed into skills in another project. For gated, configured-project-level validation, use the lifecycle commands (`vat skills validate`, `vat verify`) and run them from within the project directory.

## Compatibility Analysis (`--compat`, `--settings [file]`)

```bash
vat audit ./plugins/ --compat
vat audit ./plugins/ --compat --settings                                    # auto-discover the effective settings
vat audit ./plugins/ --compat --settings /etc/claude-code/managed-settings.json
```

Every `claude-plugin` entry gets a `compatibility:` block; with `--settings`
(requires `--compat`), a `settings:` block beside it. Both are ALWAYS present for a plugin the run was
asked about — a lane that could not run says so in its block:

```yaml
files:
  - path: plugins/mission-control
    type: claude-plugin
    compatibility:
      plugin: mission-control
      declaredTargets: [claude-code, claude-chat]
      observations:
        - code: CAPABILITY_LOCAL_SHELL
          summary: Plugin requires a local shell environment.
          supportingEvidence: [ALLOWED_TOOLS_LOCAL_SHELL]
      verdicts:
        - code: COMPAT_TARGET_INCOMPATIBLE
          observationCode: CAPABILITY_LOCAL_SHELL
          target: claude-chat
          summary: Target 'claude-chat' has no local shell but skill requires one.
      unchecked:                       # files the analysis could not read — the verdicts above were computed WITHOUT them
        - path: plugins/mission-control/skills/locked/SKILL.md
          reason: "EACCES: permission denied, open 'plugins/mission-control/skills/locked/SKILL.md'"
      summary: { totalFiles: 4, skillFiles: 2, scriptFiles: 1, hookFiles: 0, mcpConfigs: 0 }   # what was ANALYZED
    settings:
      compatible: false                # true ONLY when conflicts and unchecked are both empty
      conflicts:
        - type: tool-blocked
          detail: Tool "Bash" in skills/deploy/SKILL.md blocked by org policy (permissions.deny)
          blockedBy: permissions.deny
          value: Bash
          settingsFile: /etc/claude-code/managed-settings.json
          settingsLevel: managed
      unchecked:                       # present only when non-empty
        - path: plugins/mission-control/skills/locked/SKILL.md
          reason: "EACCES: permission denied, open 'plugins/mission-control/skills/locked/SKILL.md'"
  - path: plugins/other-plugin
    type: claude-plugin
    compatibility:                     # a plugin-wide failure: no valid plugin.json, or a root that cannot be listed
      analyzed: false
      reason: "plugin.json missing required \"name\" field in plugins/other-plugin/.claude-plugin/plugin.json"
```

Read `verdicts` for the per-target answer (`COMPAT_TARGET_INCOMPATIBLE`,
`COMPAT_TARGET_UNDECLARED`), and `unchecked` before trusting it: an empty
`verdicts` over a non-empty `unchecked` is not "compatible", it is a verdict
over fewer files than the plugin ships. Both lanes follow symlinked skill
directories and files, and the two lanes are independent — a file the analyzer
could not read does not stop the settings check. Every path is relative to the
document's `root`; the plugin-wide `analyzed: false` and the settings-lane
totals are also said on stderr without `--debug`.

Use this before a release to determine which surfaces each plugin supports.

## Exit Codes

The three-way contract every `vat` command shares — the exit code follows the report's `status`:

- `0` — the audit completed with nothing at error severity. Warnings and informational findings are
  in the report, not the exit code.
- `1` — the audit completed and reports `status: error`: at least one error-severity finding, or
  zero files audited. A path inside the tree the scan could not read is `SCAN_PATH_UNREADABLE`
  (warning) — the run degrades, and the refused path is `summary.pathsUnreadable`, not a scanned
  file; a run that audited zero files is one non-overridable `RESOURCE_CHECK_BROKEN`.
- `2` — the run itself could not happen: the root path does not exist or is a file no lane
  recognises, bad usage, a URL that failed to clone, an internal crash. There is no report.

Audit reports every finding: it ignores `validation.allow` and reads `validation.severity` from three
scopes, so `severity` is the dial that decides what gates. For a check that honors `validation.allow`,
use `vat skills validate` or `vat skills build` instead.

## CI Usage

```yaml
# vibe-validate.config.yaml
steps:
  - name: Plugin and skill validation
    command: vat audit plugins/ --exclude "**/__pycache__/**"
```

## Interpreting Output

```yaml
root: /abs/path/you/pointed/audit/at   # the ONE absolute path in the document
status: warning
summary:
  filesScanned: 23
  filesPassed: 21
  filesWithWarnings: 2
  filesWithErrors: 0
  pathsUnreadable: 0                      # refused paths, outside filesScanned
issueCounts: { errors: 0, warnings: 2, info: 0 }   # every issue, split by severity
files:
  - path: plugins/my-plugin                                          # relative to root
    issues:
      - location: plugins/my-plugin/.claude-plugin/plugin.json       # relative to root
```

**`root` is the coordinate system for the whole document.** Every `path` and every issue `location` is forward-slashed and relative to it, so `join(root, location)` is the file to open and a `location` identifies a file uniquely even when a run spans several projects with the same internal layout. `root` is the *invocation scan root*, deliberately not each skill's governing-config root — per-skill packaging rules still come from the nearest-ancestor `vibe-agent-toolkit.config.yaml`, but that discovery has no say in how a path is spelled. `--user` states the shared Claude config dir; a URL audit omits `root` and the provenance header names the base instead.

Severity taxonomy in audit output:
- **Errors:** Missing required frontmatter, broken links, invalid plugin.json schema, link integrity violations
- **Warnings:** Skill too long, description too short, best practice violations

A code at `error` severity moves the exit code to `1`; `warning` and `info` do not.

**Hiding codes from audit output.** Audit ignores `validation.allow` by design (it is the read-only report), but it does honor `validation.severity`. Set a code to `ignore` in `vibe-agent-toolkit.config.yaml` to suppress it from the audit output:

```yaml
skills:
  config:
    my-skill:
      validation:
        severity:
          LINK_TO_NAVIGATION_FILE: ignore   # hidden from audit output
```

**Per-instance allow entries.** For per-path suppression with an audit trail, use `validation.allow` and run `vat skills validate` or `vat skills build` — those commands apply `allow` and gate the build. See `docs/validation-codes.md` for the full code reference and the VAT agent-authoring skill for configuration patterns.

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

## Compatibility Analysis (`--compat`)

```bash
vat audit ./plugins/ --compat
```

Output per plugin:
```yaml
plugin: mission-control
compatibility:
  claude-code:
    compatible: true
    evidence: []
  cowork:
    compatible: true
    evidence: []
  claude-desktop:
    compatible: false
    evidence:
      - type: python-script
        file: hooks-handlers/handler.py
        detail: Python execution not available in claude-desktop
```

Use this before a release to determine which surfaces each plugin supports.

## Exit Codes

`vat audit` is **advisory** — it reports every issue it detects but never blocks on validation severity:

- `0` — always, when the audit completes, regardless of errors or warnings in the report.
- `2` — system error (path not found, permission denied, etc.) — the audit could not run.

For gated checks that exit `1` on validation errors, use `vat skills validate` or `vat skills build` instead. Those commands apply `validation.severity` and honor `validation.allow` from config.

## CI Usage

```yaml
# vibe-validate.config.yaml
steps:
  - name: Plugin and skill validation
    command: vat audit plugins/ --exclude "**/__pycache__/**"
```

## Interpreting Output

```yaml
status: warning
summary:
  filesScanned: 23
  success: 21
  warnings: 2
  errors: 0
```

Severity taxonomy in audit output:
- **Errors:** Missing required frontmatter, broken links, invalid plugin.json schema, link integrity violations
- **Warnings:** Skill too long, description too short, best practice violations

Audit always exits `0` regardless — surface-level severity drives display grouping only.

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

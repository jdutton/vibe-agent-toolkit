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

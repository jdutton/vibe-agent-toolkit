---
name: vibe-agent-toolkit-audit
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

- `0` — clean (or `--user` mode: always 0, informational)
- `1` — validation errors found
- `2` — system error (path not found, permission denied)

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

Warnings (exit 0) vs errors (exit 1):
- **Errors:** Missing required frontmatter, broken links, invalid plugin.json schema
- **Warnings:** Skill too long, description too short, best practice violations

Suppress specific warnings with `ignoreValidationErrors` in `package.json`:
```json
{
  "vat": {
    "skills": [{
      "ignoreValidationErrors": {
        "SKILL_LENGTH_EXCEEDS_RECOMMENDED": "Complex domain requires full detail"
      }
    }]
  }
}
```

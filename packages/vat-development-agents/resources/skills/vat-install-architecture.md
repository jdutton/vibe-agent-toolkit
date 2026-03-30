---
name: install
description: Architecture reference for VAT skill/plugin install and uninstall — what is currently supported, what is not, and the full design vision across install methods (file-based, cloud, MDM, enterprise CI). Read this before designing or advising on any install/uninstall feature.
---

# VAT Skill Install & Uninstall: Architecture and Vision

## The Problem Space

Skills and plugins need to reach users' Claude installations through several distinct
delivery channels. Each channel has different operators (developers, IT, Anthropic),
different trust levels, and different UX requirements. VAT today only covers one of
these channels.

This document defines the full landscape, what VAT currently supports, what it does
not, and the architectural direction for each gap.

---

## Install Method Landscape

| Method | Operator | Current State | Notes |
|--------|----------|---------------|-------|
| **File-based: Code CLI** | Developer / IT | ✅ Supported | `~/.claude/plugins/` — only supported method |
| **File-based: Claude Desktop** | Developer / IT | ❌ Not supported | Different config path; same file structure expected |
| **npm postinstall** | IT / end-user | ✅ Supported | Requires `vibe-agent-toolkit` as runtime dep |
| **Managed settings file** | IT / Enterprise | ✅ Partial | `vat verify` validates; deployment is out of scope |
| **MDM-driven npm install** | IT | ✅ Works (via postinstall) | Jamf/SCCM/Intune runs `npm install -g` |
| **Anthropic Cloud / claude.ai org** | Org admin | ❌ Not supported | No API available; future Anthropic feature |
| **GitHub CI enterprise push** | IT / DevOps | ❌ Not supported | VAT design vision — see below |
| **Shared network registry** | IT | ❌ Not supported | Internal npm registry approach |

---

## What VAT Currently Supports

### File-based install: Claude Code CLI only

`vat skills install` and `vat skills uninstall` operate exclusively on:
```
~/.claude/
├── plugins/
│   ├── marketplaces/<marketplace>/plugins/<plugin>/   ← plugin files
│   ├── cache/<marketplace>/<plugin>/<version>/        ← version cache
│   ├── known_marketplaces.json
│   └── installed_plugins.json
├── skills/                                            ← legacy skills (no plugin system)
└── settings.json                                      ← enabledPlugins, permissions
```

This is the **Claude Code CLI** configuration directory. It is the only path VAT
resolves. Claude Desktop uses a different path (see below) and is out of scope.

### Install sources (all resolve to the file-based method above)

```bash
# npm package (downloads, extracts, copies plugin tree)
vat skills install npm:@myorg/my-skills

# Local directory (copies plugin tree from local path)
vat skills install ./path/to/package

# ZIP file
vat skills install ./my-skills.zip

# npm postinstall hook (triggered by npm install -g)
# package.json: "postinstall": "node ./node_modules/vibe-agent-toolkit/dist/bin/vat.js skills install --npm-postinstall"
```

### Uninstall (current state)

`vat skills uninstall` removes skills from `~/.claude/skills/` only. It does NOT
remove plugin-system installs (the `~/.claude/plugins/` tree).

**A full `vat plugins uninstall` command does not yet exist.** See design notes below.

---

## What VAT Does NOT Support (and Why)

### Claude Desktop file-based installs

Claude Desktop on macOS uses `~/Library/Application Support/Claude/` rather than
`~/.claude/`. On Windows it uses `%APPDATA%\Claude\`.

**Why not supported today**: VAT's `getClaudeUserPaths()` is hardcoded to `~/.claude/`.
Extending it requires detecting which applications are installed and resolving both
paths. This is well-understood work with no architectural unknowns.

**Architectural note**: When implemented, both paths should be handled by a single
`getClaudeInstallTargets()` function returning multiple targets. CLI commands gain a
`--target code-cli|desktop|all` flag. Default is `code-cli` until Desktop path
handling is verified stable.

### Anthropic Cloud / claude.ai organization-level skills

Anthropic operates a cloud-based skill system for claude.ai. Organization admins can
manage skills for all users through the admin console. VAT has no integration with
this system today because Anthropic has not published a public API for programmatic
management.

**Architectural note**: When Anthropic publishes an org management API, VAT should
add `vat skills publish --target claude-ai` as a first-class install method. The
`dist/` artifacts from `vat build` are format-compatible with this target. The gap
is authentication and the API itself.

### GitHub CI enterprise push (vision)

The goal: a GitHub Actions workflow in a skills repository automatically deploys
skills to all users in an enterprise whenever a new version is merged to main.

This is a multi-layer problem with several viable approaches:

#### Approach A: MDM-integrated npm publish (recommended near-term)
```
GitHub Actions on release →
  npm publish @myorg/my-skills →
    MDM policy (Jamf/SCCM/Intune) detects new package version →
      Runs: npm install -g @myorg/my-skills
        → postinstall hook installs plugin to user's ~/.claude/
```
VAT already supports this end-to-end. The MDM layer is outside VAT's scope and is
configured by IT using standard MDM software management policies. The VAT piece is
complete; IT must configure the npm-to-MDM trigger.

#### Approach B: Managed settings deployment (near-term, no MDM required)
```
GitHub Actions on release →
  vat build &&
  Generates managed-settings.json with plugin enablement →
    Deploys managed-settings.json to shared network path or cloud storage →
      Claude Code reads managed-settings.json at startup
```
`vat verify` validates `managed-settings.json` today. The deployment step is IT's
responsibility. This approach requires no per-machine npm install; Claude Code reads
the settings file directly if it is placed at the expected path or if the path is
configured.

**Gap**: VAT does not yet have a `vat claude deploy` command that handles the push
step. Adding this would require IT to configure cloud storage credentials once.

#### Approach C: Anthropic org API (long-term, requires Anthropic)
```
GitHub Actions on release →
  vat skills publish --target claude-ai --org myorg →
    Anthropic API activates skills for all org users in claude.ai
```
Blocked on Anthropic publishing an org management API. VAT's `dist/` output format
is already designed for this target.

---

## `vat plugins uninstall` — Design Intent

A `vat plugins uninstall <plugin>@<marketplace>` command should exist but does not yet.

### What it must reverse

Uninstalling a plugin installed via the file-based method requires reversing 5 artifacts:

1. Delete `~/.claude/plugins/marketplaces/<marketplace>/plugins/<plugin>/`
2. Delete `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/`
3. Remove `<plugin>@<marketplace>` from `installed_plugins.json`
4. Remove `<marketplace>` from `known_marketplaces.json` if no plugins remain
5. Remove `enabledPlugins[<plugin>@<marketplace>]` from `settings.json`

### Design decisions

- **Idempotent**: exit 0 if plugin not found — safe for IT automation scripts
- **Not-VAT-installed case**: if plugin directory exists but no registry entries, delete
  the directory and clean settings.json; emit a warning that the plugin was not
  installed via VAT
- **`--dry-run`**: show what would be deleted without deleting (follow `vat skills uninstall` pattern)
- **`--target`**: code-cli | desktop | all (default: code-cli until Desktop is implemented)
- **`vat plugins list`**: companion command to show installed plugins — needed for
  discoverability before uninstalling

### Implementation location

Per the CLI "dumb orchestration" principle:
- Logic: `packages/claude-marketplace/src/install/plugin-uninstall.ts` (new file alongside plugin-registry.ts)
- CLI: `packages/cli/src/commands/plugins/uninstall.ts` (thin wrapper)
- New command group: `vat plugins` with subcommands `list` and `uninstall`

---

## Guidance for Adopters

### For end-user / IT-managed deployments (recommended)

Add `vibe-agent-toolkit` as a **runtime dependency** (not devDependencies) and use
the local node_modules binary in postinstall. Never assume `vat` is globally installed.

```json
{
  "dependencies": { "vibe-agent-toolkit": "latest" },
  "scripts": {
    "postinstall": "node ./node_modules/vibe-agent-toolkit/dist/bin/vat.js skills install --npm-postinstall || exit 0"
  }
}
```

IT runs: `npm install -g @myorg/my-skills` — no other tools required on the user's machine.

For private GitHub Packages registries, IT pre-configures `.npmrc` with a read-only
token for the `@myorg` scope. End users do not need to know about registries or tokens.

### For developer self-install

```bash
npx vibe-agent-toolkit skills install npm:@myorg/my-skills
```

### For enterprise CI (near-term best option)

Use Approach A (MDM-integrated npm publish) or Approach B (managed-settings deployment).
Both work today with no additional VAT features.

---

## What Is Out of Scope for VAT

VAT is a **packaging and local install tool**. The following are permanently out of scope:

- MDM software management configuration (Jamf, SCCM, Intune policies)
- Internal npm registry setup and authentication management
- Anthropic cloud API authentication or org provisioning
- Per-user credential management for private registries
- Claude Desktop configuration (until Desktop and Code CLI paths converge)

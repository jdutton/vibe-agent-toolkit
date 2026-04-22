# Marketplace Distribution

**Guide for building, validating, and publishing Claude plugin marketplaces.**

## Overview

A Claude plugin marketplace is a Git repository containing `.claude-plugin/marketplace.json` and plugin directories. Marketplaces are the distribution unit for Claude Code (via `/plugin marketplace add`) and Cowork (via GitHub App sync). VAT supports three modes of marketplace management.

## Three Marketplace Modes

| Mode | Description | VAT commands |
|------|-------------|-------------|
| **Built** | Source repo with skills → `vat build` → publish to `claude-marketplace` branch | `vat build`, `vat validate`, `vat claude marketplace publish` |
| **Separate repo** | Source repo → `vat build` → publish to a different Git repo | Same as Built (remote configured in YAML) |
| **Manual/native** | The repo IS the marketplace — no build step | `vat validate` (with config) or `vat claude marketplace validate` (without config) |

## Distribution Surfaces

Custom skills and plugins **do not sync across Claude surfaces**. Each surface is independent:

| Surface | Source | Scope | Marketplace format? |
|---------|--------|-------|---------------------|
| **Claude Code** | Git repo with `marketplace.json` | Self-service install | Yes |
| **Cowork (claude.ai)** | Admin UI → GitHub App sync from private repo | Org-wide, admin-controlled | Yes (same format) |
| **Skills API** | `POST /v1/skills` multipart upload | Workspace-wide | No (direct API upload) |
| **Claude Code (managed)** | `managed-settings.json` via MDM | Per-machine, IT-managed | Yes (marketplace ref in settings) |

Public and private GitHub marketplaces use the **same format**. The only difference is authentication (private repos require `GITHUB_TOKEN` or `GH_TOKEN` for auto-updates).

## Marketplace Structure

```
marketplace-repo/           # or claude-marketplace branch
├── .claude-plugin/
│   └── marketplace.json    # marketplace manifest (required)
├── plugins/
│   └── plugin-name/
│       ├── .claude-plugin/
│       │   └── plugin.json # plugin manifest (required)
│       ├── skills/
│       │   └── skill-name/
│       │       ├── SKILL.md
│       │       └── references/
│       ├── commands/       # slash commands (*.md)
│       ├── agents/         # agent definitions (*.md)
│       └── hooks/          # hooks.json
├── CHANGELOG.md            # marketplace changelog
├── README.md               # marketplace "storefront" for GitHub
└── LICENSE                  # required for distribution
```

## Versioning Strategy

**Marketplace version is the distribution version.** One version for the whole marketplace.

| Artifact | Versioned? | Required? | Source |
|----------|-----------|-----------|--------|
| Marketplace | Yes | Yes (error if missing) | `package.json` or config |
| Plugin | Yes | Yes (error if missing) | Defaults to marketplace version |
| Skill | No | N/A | Tracked by marketplace version |

Skills are not independently versioned by VAT. The SKILL.md frontmatter spec has no version field. Skill changes are tracked at the marketplace level.

Plugin version defaults to the marketplace version when not explicitly set. The top-level version defaults to `package.json` when available.

## Branch Convention

**Default publish branch: `claude-marketplace`** — analogous to GitHub Pages' `gh-pages`.

- Source code and SDLC on `main` (tests, lint, CI, PRs)
- Built marketplace artifacts on `claude-marketplace` (clean, generated)
- Extensible: `claude-marketplace-beta`, `claude-marketplace-next` for staging channels
- Configurable via `publish.branch` in config or `--branch` flag

**Default-branch-only surfaces:** Both Cowork (claude.ai) and Claude Enterprise GitHub sync read from the repository's **default branch only** — they cannot target a specific branch. This means the branch-based publish pattern (`claude-marketplace` / `claude-marketplace-next`) does not work for these surfaces.

**Workaround: dedicated marketplace repo.** Create a separate repository where the default branch (`main`) IS the marketplace. Configure `publish.remote` to point to this repo:

```yaml
publish:
  remote: https://github.com/org/my-marketplace-repo.git
  branch: main
```

This keeps your source code and SDLC on the original repo while the marketplace repo contains only the published artifacts.

**Enterprise lockdown:** `managed-settings.json` supports `ref` on marketplace sources:

```json
{
  "strictKnownMarketplaces": [
    { "source": "github", "repo": "acme/plugins", "ref": "claude-marketplace" }
  ]
}
```

## Configuration

In `vibe-agent-toolkit.config.yaml`:

```yaml
version: 1

claude:
  marketplaces:
    my-marketplace:
      owner:
        name: Your Name or Org
      publish:
        branch: claude-marketplace          # default
        remote: origin                      # git remote name, or full URL for cross-repo publish
        changelog: docs/marketplace-changelog.md
        readme: docs/marketplace-readme.md
        license: mit                        # SPDX identifier or file path
        sourceRepo: false                   # optional linkback in commit metadata
      plugins:
        - name: my-plugin
          description: What this plugin does
```

### License field

The `license` field accepts:
- **SPDX identifier string** (e.g., `mit`, `apache-2.0`, `gpl-3.0`) — generates standard license text with owner name and current year
- **File path** (e.g., `./LICENSE` or `docs/LICENSE-ENTERPRISE`) — copies the file as-is

Strings are validated against known SPDX identifiers. Paths are distinguished by containing `/` or `.` characters.

## Changelog

Each marketplace maintains its own `CHANGELOG.md` following [Keep a Changelog](https://keepachangelog.com/) format. The marketplace release cadence may differ from source package releases.

- Author maintains the changelog source file in the repo (path configured in YAML)
- On publish, it's copied to `CHANGELOG.md` in the published tree
- The `[Unreleased]` section is required for publish — the command refuses if empty
- On publish, `[Unreleased]` is stamped with version + date
- The changelog delta becomes the Git commit message body

Categories: `Added`, `Changed`, `Removed`, `Fixed`, `Security`.

## Publish Flow

```bash
# 1. Build marketplace artifacts
vat build

# 2. Validate everything
vat validate

# 3. Publish to claude-marketplace branch
vat claude marketplace publish

# Or dry-run first
vat claude marketplace publish --dry-run
```

**What publish does:**

1. Verifies `vat build` output exists
2. Checks marketplace changelog has `[Unreleased]` content
3. Composes the publish tree (marketplace artifacts + CHANGELOG.md + README.md + LICENSE)
4. Creates a single squashed commit: `publish v{version}` with changelog delta as body
5. Pushes to the configured branch/remote

**Flags:**
- `--dry-run` — compose and show diff, don't push
- `--branch <name>` — override configured branch
- `--force` — force-push (first publish or recovery only)

**Commit history:** Each publish adds one commit. The `claude-marketplace` branch accumulates a clean release timeline — `git log` shows the version history of the marketplace.

## CI/CD: Cross-Repo Publishing

When publishing to a **separate repository** (via `publish.remote`), the default `GITHUB_TOKEN` in GitHub Actions is scoped to the source repo and cannot push to the target. You need a Personal Access Token (PAT) or fine-grained token with write access to the marketplace repo.

**Setup:**

1. Create a PAT with `contents: write` permission on the marketplace repo
2. Store it as a repository secret (e.g., `MARKETPLACE_GITHUB_PUSH_TOKEN`)
3. Expose it as `GH_TOKEN` in your workflow — `vat claude marketplace publish` uses `GH_TOKEN` (or `GITHUB_TOKEN`) to authenticate pushes

```yaml
# .github/workflows/marketplace-publish.yml
- name: Publish marketplace
  env:
    GH_TOKEN: ${{ secrets.MARKETPLACE_GITHUB_PUSH_TOKEN }}
  run: |
    vat build
    vat claude marketplace publish --branch main
```

**Why a separate token?** GitHub Actions' built-in `GITHUB_TOKEN` has repo-scoped permissions and cannot push to other repositories. This is a standard pattern for any cross-repo CI operation.

## Validation

### With config (`vat validate`)

When marketplace config exists, `vat validate` orchestrates in dependency order:

1. `resources validate` — links, frontmatter, schemas
2. `skills validate` — SKILL.md structure, frontmatter
3. `marketplace validate` — marketplace.json, plugin.json, structure

Each layer fails fast — bad links block skill validation, bad skills block marketplace validation.

### Without config (`vat claude marketplace validate`)

Standalone validation for manual/native marketplaces. Uses the same discovery logic as `vat audit` but with **strict expectations** — this must be a valid marketplace:

| Check | `vat audit` (liberal) | `marketplace validate` (strict) |
|-------|----------------------|--------------------------------|
| Missing version | Warning | Error |
| Missing LICENSE | Ignored | Error |
| Bad plugin.json | Warning | Error |
| Missing README | Ignored | Warning |
| Missing CHANGELOG | Ignored | Warning |
| Bad SKILL.md | Warning | Error |

```bash
# Validate a marketplace directory or repo
vat claude marketplace validate .
vat claude marketplace validate path/to/marketplace
```

## Examples

### Built mode: monorepo publishes to same repo

```yaml
# vibe-agent-toolkit.config.yaml
claude:
  marketplaces:
    vat-skills:
      owner:
        name: vibe-agent-toolkit contributors
      publish:
        changelog: docs/marketplace-changelog.md
        readme: docs/marketplace-readme.md
        license: mit
      plugins:
        - name: vibe-agent-toolkit
          description: Development agents and skills
```

```bash
vat build && vat validate && vat claude marketplace publish
```

Consumers install via:
```
/plugin marketplace add owner/repo#claude-marketplace
```

### Separate repo: private source, public marketplace

```yaml
# vibe-agent-toolkit.config.yaml in private source repo
claude:
  marketplaces:
    acme-skills:
      owner:
        name: Acme Corp
      publish:
        remote: git@github.com:acme/acme-skills-marketplace.git
        changelog: docs/marketplace-changelog.md
        readme: docs/marketplace-readme.md
        license: apache-2.0
      plugins:
        - name: acme-tools
          description: Acme engineering tools
```

### Manual/native: repo IS the marketplace

No `vat build`, no publish. Author maintains `marketplace.json` and plugin directories directly. Validate with:

```bash
# With vibe-agent-toolkit.config.yaml
vat validate

# Without config
vat claude marketplace validate .
```

## Testing Your Marketplace

After publishing, test the marketplace locally before sharing with users. This flow validates the full consumer experience — clone, install, and skill loading.

### Test flow

```bash
# 1. Add the marketplace (uses the published branch)
claude plugin marketplace add owner/repo#claude-marketplace

# 2. Install the plugin from the marketplace
claude plugin install my-plugin@my-marketplace

# 3. Validate the installed plugin
claude plugin validate ~/.claude/plugins/cache/my-marketplace/my-plugin/<version>

# 4. List plugins and verify status
claude plugin list

# 5. Start a new Claude Code session — skills should appear in /skill-name
```

### What to verify

- **Marketplace add** succeeds and `known_marketplaces.json` shows the correct source
- **Plugin install** resolves the correct version from plugin.json
- **All skills** are present in the cache directory
- **`claude plugin validate`** passes on the installed plugin
- **`claude plugin list`** shows the plugin as enabled
- **Skills load** in a new session (check the system reminder for skill names)

### Updating after changes

After publishing a new version:

```bash
# Update the marketplace cache
claude plugin marketplace update my-marketplace

# Update the installed plugin
claude plugin update my-plugin@my-marketplace
```

### Known issues

**Name collision on marketplace add (Claude Code v2.1.81):** If a marketplace with the same `name` field already exists (e.g., previously registered via npm), `claude plugin marketplace add` reports success but silently reuses the old source in `known_marketplaces.json`. The workaround is to remove the old marketplace first, then add:

```bash
claude plugin marketplace remove my-marketplace
claude plugin marketplace add owner/repo#branch
```

Verify by checking `~/.claude/plugins/known_marketplaces.json` to confirm the source switched to `github`.

**`claude plugin validate` rejects `$schema` key (Claude Code v2.1.81):** The marketplace validator treats `$schema` as an unrecognized key, even though Anthropic's own official marketplace uses it. This does not affect runtime behavior — the marketplace installs and works correctly. This is a Claude Code validation bug, not a marketplace authoring issue.


## Full-plugin authoring

`vat claude plugin build` ships any Claude Code plugin asset — not just skills. Drop the plugin under `plugins/<name>/` in the same native layout Claude Code expects, declare it in `vibe-agent-toolkit.config.yaml`, and `vat claude plugin build` assembles the output from that plugin's own directory.

A plugin ships only what its own `plugins/<name>/` directory contains. The top-level `skills:` pool is an independent build target (it produces `dist/skills/` for standalone skill distribution) and does not feed plugin bundles.

### Layout

```
plugins/<name>/
  .claude-plugin/
    plugin.json       # author-supplied metadata; VAT merges on top
  commands/           # slash commands (*.md)
  hooks/
    hooks.json        # hook registry (JSON; parse-only validated)
  agents/             # subagent definitions (*.md)
  .mcp.json           # MCP server config (JSON; parse-only validated)
  scripts/            # arbitrary scripts (tree-copied verbatim)
  skills/             # plugin-local skills (auto-discovered, non-gitignore-aware)
```

Everything under `plugins/<name>/` is tree-copied to `dist/.claude/plugins/marketplaces/<mp>/plugins/<name>/`, except:

- `skills/` — owned by the skill stream (see "Skill discovery" below)
- `.claude-plugin/` — owned by the `plugin.json` merge-write (see "plugin.json merge")

Tree-copy respects `.gitignore` (safe: `node_modules/`, build detritus never ship).

### Minimum content — empty-plugin guard

Every declared plugin must supply at least one of:

- a `plugins/<name>/` directory on disk (or an alternate `source:` override pointing at one), **or**
- a non-empty `files: [{ source, dest }, ...]` mapping.

A plugin with neither is rejected with the empty-plugin guard.

### `source` override

```yaml
claude:
  marketplaces:
    mp1:
      owner: { name: Example }
      plugins:
        - name: my-plugin
          source: custom/path/to/my-plugin   # default: plugins/my-plugin
```

### `files[]` — compiled artifacts outside the plugin dir

Use `files: [{ source, dest }]` to inject build artifacts (compiled hooks, generated configs) into the plugin output:

```yaml
plugins:
  - name: my-plugin
    files:
      - source: dist/hooks/compiled-hook.mjs   # relative to project root
        dest: hooks/compiled-hook.mjs         # relative to plugin output dir
```

`dest` cannot escape the plugin output dir, cannot resolve inside `skills/` (owned by skill stream), and cannot target `.claude-plugin/plugin.json` (owned by merge-write). Overwrites are allowed and logged at info level.

### `plugin.json` merge rules

VAT writes `.claude-plugin/plugin.json` last, merging the author's `.claude-plugin/plugin.json` (if present) with VAT-owned identity fields:

- **VAT wins** on `name`, `version`, `author` (shallow replace — mismatches produce warnings, never errors).
- **Author wins** on all other keys (`keywords`, `repository`, `homepage`, `license`, …).
- **Description chain:** `config.description ?? author.description ?? "${name} plugin"`.
- `version` falls back to the author's value when VAT has no version (no `package.json`).

### Skill discovery

`vat skills build` auto-discovers `plugins/<name>/skills/**/SKILL.md` for every declared plugin and routes outputs to `dist/plugins/<name>/skills/<skill>/`. Plugin-local skill discovery **bypasses `.gitignore`** (plugin-local skills are semantically mandatory to the plugin). A gitignored `SKILL.md` is still discovered but emits a warning so the adopter can audit their intent.

Skill names must be globally unique across all plugins (case-sensitive and case-insensitive).

### Ordering contract

`vat claude plugin build` runs per plugin in this order:

1. Discovery + validators (case-match, `hooks.json`/`.mcp.json` parse, empty-plugin guard)
2. Tree-copy (skips `skills/` and `.claude-plugin/`, respects `.gitignore`)
3. Plugin-local skill copy-in (from `dist/plugins/<name>/skills/`)
4. `files[]` mapping (may overwrite tree-copied files; logged at info)
5. `.claude-plugin/plugin.json` merge-write (always last, always wins)

**Run order:** `vat skills build && vat claude plugin build`. The plugin build reads pre-built plugin-local skills from `dist/plugins/<name>/skills/`.

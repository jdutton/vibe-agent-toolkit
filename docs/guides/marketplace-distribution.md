# Marketplace Distribution

**Guide for building, validating, and publishing Claude plugin marketplaces.**

## Overview

A Claude plugin marketplace is a Git repository containing `.claude-plugin/marketplace.json` and plugin directories. Marketplaces are the distribution unit for Claude Code (via `/plugin marketplace add`) and Cowork (via GitHub App sync). VAT supports three modes of marketplace management.

## Three Marketplace Modes

| Mode | Description | VAT commands |
|------|-------------|-------------|
| **Built** | Source repo with skills → `vat build` → publish to `claude-marketplace` branch | `vat validate` (source), `vat build`, `vat verify` (built artifacts), `vat claude marketplace publish` |
| **Separate repo** | Source repo → `vat build` → publish to a different Git repo | Same as Built (remote configured in YAML) |
| **Manual/native** | The repo IS the marketplace — no build step | `vat validate` (source) + `vat claude marketplace validate` (marketplace manifest) |

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
          skills: "*"                       # or list: ["skill-a", "skill-b"]
```

### License field

The `license` field accepts:
- **SPDX identifier string** — only `mit`, whose full text VAT carries verbatim, is generated for you (with owner name and current year). Every other recognized identifier (`apache-2.0`, `gpl-3.0`, `mpl-2.0`, `isc`, the BSD and LGPL variants, `unlicense`) is **refused** with a pointer to the file-path form, because VAT has no verified copy of those texts and a subtly-wrong license is worse than none. Use a file path for those.
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
# 1. Validate sources (no build needed)
vat validate

# 2. Build marketplace artifacts
vat build

# 3. Verify the built artifacts (adds marketplace + consistency checks)
vat verify

# 4. Publish to claude-marketplace branch
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

There are two layers: **source** validation (no build required) and **built-artifact** validation (after `vat build`).

### Source-level (`vat validate`)

`vat validate` runs every source validator the config declares — and only those — discovered from `vibe-agent-toolkit.config.yaml`:

1. `resources validate` — links, frontmatter, schemas (when `resources:` configured)
2. `skills validate` — SKILL.md structure, frontmatter (when `skills:` configured)

It is source-level only and **never requires a build**, so it is safe for pre-commit and CI-before-build. A surface with no config block is simply skipped (no error, no noise).

> **Decision (revisitable):** `vat validate` deliberately excludes marketplace-artifact validation. The marketplace check runs against the built `dist/` tree, which would couple `vat validate` to a prior `vat build` and overlap `vat verify`. Marketplace validation lives in `vat verify` (built mode) and `vat claude marketplace validate` (standalone). See issue #128.

### Built-artifact (`vat verify`)

After `vat build`, run `vat verify` to validate the assembled distribution — it adds `marketplace validate` (marketplace.json, plugin.json, LICENSE, structure) plus distribution-consistency checks on top of the resources/skills validators.

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
          skills: "*"
```

```bash
vat validate && vat build && vat verify && vat claude marketplace publish
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
        license: ./LICENSE
      plugins:
        - name: acme-tools
          description: Acme engineering tools
          skills: "*"
```

### Manual/native: repo IS the marketplace

No `vat build`, no publish. Author maintains `marketplace.json` and plugin directories directly. Validate with:

```bash
# Source validation (links, SKILL.md) — with vibe-agent-toolkit.config.yaml
vat validate

# Marketplace manifest validation (marketplace.json, plugin.json, LICENSE)
# Required here too: vat validate does not check the manifest (see Validation above)
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

`vat claude plugin build` ships any Claude Code plugin asset — not just skills. Drop the plugin under `plugins/<name>/` in the same native layout Claude Code expects, declare it in `vibe-agent-toolkit.config.yaml`, and `vat claude plugin build` assembles the output from that plugin's own directory. Pool skills (from the top-level `skills:` discovery) are still imported into the plugin via the `skills:` selector — the plugin directory and the pool skills are both sources, composed into one bundle.

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
  skills/             # plugin-local SKILL.md files — tree-copied verbatim
```

Everything under `plugins/<name>/` is tree-copied to `dist/.claude/plugins/marketplaces/<mp>/plugins/<name>/`, except:

- `.claude-plugin/` — owned by the `plugin.json` merge-write (see "plugin.json merge")

Tree-copy respects `.gitignore` (safe: `node_modules/`, build detritus never ship). `plugins/<name>/skills/` is just a regular tree-copied directory — drop raw `SKILL.md` files there and they ship as-is.

### Minimum content — empty-plugin guard

Every declared plugin must supply at least one of:

- a `plugins/<name>/` directory on disk (or an alternate `source:` override pointing at one), **or**
- a non-empty `files: [{ source, dest }, ...]` mapping, **or**
- a non-empty `skills:` selector that matches at least one pool skill.

A plugin with none of these is rejected with the empty-plugin guard.

### `source` override

```yaml
claude:
  marketplaces:
    mp1:
      owner: { name: Example }
      plugins:
        - name: my-plugin
          skills: []
          source: custom/path/to/my-plugin   # default: plugins/my-plugin
```

### `files[]` — compiled artifacts outside the plugin dir

Use `files: [{ source, dest }]` to inject build artifacts (compiled hooks, generated configs) into the plugin output:

```yaml
plugins:
  - name: my-plugin
    skills: []
    files:
      - source: dist/hooks/compiled-hook.mjs   # relative to project root
        dest: hooks/compiled-hook.mjs         # relative to plugin output dir
```

`dest` cannot escape the plugin output dir and cannot target `.claude-plugin/plugin.json` (owned by merge-write). Overwrites are allowed and logged at info level.

### What the verbatim tree-copy leaves behind

The plugin `source:` directory is copied verbatim, except:

- **gitignored files** — the copy honors git visibility.
- **`.claude-plugin/`** — owned by the `plugin.json` merge-write.
- **`skills/<dir>` entries another phase produces** — skills are packaged, never copied wholesale.
- **agent-instruction files at any depth** — `CLAUDE.md`, `CLAUDE.local.md`, `AGENTS.md`, `GEMINI.md`,
  matched **case-insensitively** (`Claude.md`, `claude.md`, `CLAUDE.MD` are all dropped).
  These are guidance about *your* repository; in a published bundle they leak how your team works,
  and a project-locally installed skill can have its `CLAUDE.md` read as live instructions — a
  lookup that a case-insensitive filesystem satisfies with any spelling.
- **anything you name in `exclude:`** (below).

`README.md` and other navigation files **are** copied — a plugin-root README is the plugin's front
page. (Skill *bundles* exclude them; plugin roots do not.)

### `exclude[]` — project-specific junk

```yaml
plugins:
  - name: my-plugin
    skills: "*"
    exclude:
      - "scratch/**"
      - "docs/internal"     # a bare directory name covers its whole subtree
```

Patterns are relative to the plugin source dir and are additive to the built-in exclusions above.
A pattern may be a glob (`scratch/**`) or a directory name with or without a trailing slash
(`scratch`, `scratch/`) — all three spellings drop the whole subtree, in a git repo or out of one.
**A pattern that matches nothing is reported as a build warning**, so a typo'd path never
silently ships the junk it was meant to drop.

Use this for content the defaults cannot know about; it is the extension point, not the primary
mechanism.

### `plugin.json` merge rules

VAT writes `.claude-plugin/plugin.json` last, merging the author's `.claude-plugin/plugin.json` (if present) with the identity fields the marketplace config owns:

- **Config wins** on `name` and `version` (mismatches produce warnings, never errors).
- **Author wins** on all other top-level keys (`keywords`, `repository`, `homepage`, `license`, …).
- **Description chain:** `config.description ?? author.description ?? "${name} plugin"`.
- `version` falls back to the author's value when the config has no version (no `package.json`).

#### Who owns which `author` subfield

`author` is merged **per subfield**, not replaced wholesale. The line is drawn by what the config can express: a marketplace's `owner` has `name` and `email`, and nothing else.

| `author` subfield | Owner | Behavior |
|---|---|---|
| `name` | Config (`marketplaces.<mp>.owner.name`) | Always overwritten from config. |
| `email` | Config (`marketplaces.<mp>.owner.email`) | Always overwritten from config. Omitting `owner.email` publishes an author with **no** email — that is a deliberate config statement, so an `email` in `plugin.json` is still dropped (with a warning). |
| `url` and any other subfield | Plugin author (`plugin.json`) | Passed through untouched. |

Ownership is by **schema, not by presence**: a subfield config can express is config-owned even when this project left it out, and a subfield config *cannot* express is never config-owned. Claude's plugin manifest supports `author.url` and VAT's config has no field for it, so overwriting `author` wholesale destroyed the adopter's URL with no way to restore it — data loss, not a precedence policy. The same reasoning applies to any future author subfield Claude adds: it passes through until VAT's config gains a field for it.

Warnings fire only on subfields the config owns *and* the author disagreed on, so reordering keys in `plugin.json` cannot manufacture one. An `author` that is **not an object** (npm's `"Name <email> (url)"` string form, for instance) has no subfields to merge and is replaced wholesale, with a warning naming the published value.

The `plugins[].author` entries in the generated `marketplace.json` publish this **same merged object**, so a plugin's manifest and its marketplace listing can never disagree about who authored it. (The marketplace-level `owner` field is a different thing and does come straight from config — it says who publishes the marketplace, not who wrote a plugin.) There is deliberately no per-plugin `author` in the marketplace config: the marketplace owner is the publisher of everything in it, and per-plugin `author.url` already reaches both manifests via passthrough.

### Ordering contract

`vat claude plugin build` runs per plugin in this order:

1. Discovery + validators (case-match, `hooks.json`/`.mcp.json` parse, empty-plugin guard)
2. Tree-copy `plugins/<name>/` verbatim (skips `.claude-plugin/`, respects `.gitignore`)
3. Pool-skill import via the plugin's `skills:` selector (from `dist/skills/`)
4. `files[]` mapping (may overwrite tree-copied files; logged at info)
5. `.claude-plugin/plugin.json` merge-write (always last, always wins)

**Run order:** `vat skills build && vat claude plugin build`. The plugin build reads pre-built pool skills from `dist/skills/` and raw plugin-local skills directly from `plugins/<name>/skills/`.

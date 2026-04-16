# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **`vat verify --consistency-check`** — post-build verification that skill distribution config in `vibe-agent-toolkit.config.yaml` and `package.json` are consistent. Detects skills missing from `package.json`, orphaned entries, and publish opt-out mismatches. Runs automatically as part of `vat verify`.
- **Post-build integrity checks for packaged skills** — `packageSkill()` now runs `PACKAGED_UNREFERENCED_FILE` and `PACKAGED_BROKEN_LINK` checks after copying files and rewriting links. Both are best-practice (overridable) errors surfaced via `PackageSkillResult.postBuildIssues`; the CLI logs them at info level (non-blocking). Suppress via `packagingOptions.ignoreValidationErrors`. Link extraction skips fenced code blocks and inline code spans so template strings aren't false-flagged.
- **Skill quality checklist** — new `skill-quality-checklist.md` resource bundled with the agent-authoring skill. 21-item checklist covering general skill authoring (description triggering, length limits, third-person voice, time-sensitive content, references one-level-deep, TOCs on long files) plus CLI-backed skill specifics (env guards, auth checks, cross-platform commands, `files` config). Reviewed against external best practices (Anthropic docs, anthropics/skills, superpowers conventions, Claude Code release notes through 2026-04-15).

### Fixed
- **Skill bundler strips links to non-markdown bundled files** — links to YAML, JSON, and script files routed to `templates/`, `assets/`, or `scripts/` were rewritten to empty `()` because non-markdown assets weren't added to the output registry. Now all files in the path map are added to the output registry with their mapped output paths, including the duplicate-ID edge case for paired markdown/non-markdown files (e.g. `config.md` + `config.yaml`).
- **Skill bundler strips depth-boundary links to already-bundled resources** — when resource D linked to resource C and C was already bundled via a shorter path from SKILL.md, the link from D→C was stripped because depth-exceeded exclusions were unconditionally added to `excludedIds`. Bundle membership now wins: `excludedIds` filters out resources already in `bundledResources`.
- **Discovery scanner no longer traverses git worktrees** — `.worktrees/` and `.claude/worktrees/` added to `PERFORMANCE_POISON` exclusions, preventing the crawler from physically walking into worktree copies of the repo during scans.
- **System tests no longer flaky from vitest worker timeout** — refactored `skills-list.system.test.ts` to run CLI spawns once in `beforeAll` instead of 5 redundant full-project scans. Same coverage, 70% faster (90s → 27s), eliminates the `onTaskUpdate` timeout.

## [0.1.28] - 2026-04-14

### Fixed
- **Skill bundler no longer silently bundles gitignored files** — when a SKILL.md links to files inside a gitignored directory (e.g., `data/`), those files are now excluded from the bundle instead of being silently packaged and published. This includes files reached through symlinks in gitignored directories (e.g., OneDrive/shared drive mounts). Previously required manual `excludeReferencesFromBundle` workarounds; now handled automatically.

## [0.1.27] - 2026-04-11

### Breaking
- **Removed top-level `vat install` command.** Install of flat skills now uses `vat skills install <source> --target <target> --scope <user|project>`. Install of Claude plugins uses `vat claude plugin install <source>`.

### Added
- `vat skills install <source> --target <target> --scope <user|project>` — cross-platform flat skill installer. Supports 7 targets (claude, codex, copilot, gemini, cursor, windsurf, agents) and 2 scopes (user, project). Sources: local directory, `.zip`, `.tgz`, or `npm:@scope/package`. Pre-verifies all skills before touching the filesystem (all-or-nothing).
- `vat skills list npm:@scope/package` — inspect what skills are in an npm package without installing.
- `bun run pre-release` — pre-tag validation command that confirms CHANGELOG is stamped, no stale tags exist on remote, marketplace dry-run passes, and version section has content. Prevents failed CI publishes from unready state.
- `bun run bump-version` now auto-stamps CHANGELOG.md for stable versions — moves `[Unreleased]` content under a new `## [X.Y.Z] - date` heading. Safety guards: fails if `[Unreleased]` is empty, refuses to stamp if version already exists in CHANGELOG (prevents corruption from backward bumps or re-stamps). Skips for RC/prerelease versions.
- **Content-type routing** — auto-discovered files now route to `scripts/`, `templates/`, `assets/`, or `resources/` based on file extension instead of all going to `resources/`.
- **Skill files config** — declare `files` entries in `vibe-agent-toolkit.config.yaml` for build artifacts, unlinked files, or routing overrides. Supports default + per-skill merge with dest-based override. See `docs/guides/skill-files-and-routing.md`.
- **Deferred verification** — validation chain recognizes declared build artifacts at source time (deferred), enforces hard gates at build time (source must exist) and verify time (dest must exist in output).
- **`vat verify` files check** — post-build verification now confirms all `files[].dest` paths exist in the built output.

### Fixed
- **CHANGELOG check in pre-publish no longer skipped during `bun run validate`** — the CHANGELOG stamp check was incorrectly gated behind `--skip-git-checks` (a git check flag), but it's a content check. Now runs unconditionally.

### Changed
- Published VAT skills updated to describe the new `vat skills install` command surface.

## [0.1.26] - 2026-04-10

### Added
- **Cross-skill SKILL.md bundling prevention** — VAT now detects when a skill links to another skill's `SKILL.md` and excludes it from the bundle. A `SKILL.md` is a skill definition marker, not a resource — bundling one inside another skill creates duplicate definitions that break marketplace sync and confuse skill consumers. Two layers of protection: link-follow filtering (prevents the bad state) and post-build validation (safety net). The exclusion appears in build output as `skill-definition` reason.
- **ESLint rule: `no-fs-promises-cp`** — Prevents usage of async `cp()` from `node:fs/promises` in favor of `cpSync()` from `node:fs`. Node 22's async `cp({ recursive: true })` silently drops files in nested directories. The rule auto-fixes and explains the issue so developers can make an informed eslint-disable decision if async is truly needed.

### Fixed
- **Marketplace publish drops non-markdown files on Node 22** — `composePublishTree` used async `cp()` from `node:fs/promises` which silently drops `.mjs` files in nested directories on Node 22. Replaced with `cpSync` which works correctly across all Node versions. Added a system test that verifies `.mjs` scripts survive the full compose→publish pipeline.
- **Marketplace publish `--debug` flag not reaching logger** — `--debug` was defined on the publish command but consumed by a parent command in the Commander hierarchy. Options are now read via `optsWithGlobals()` so `--debug` works correctly.
- **Marketplace publish debug logging** — `vat claude marketplace publish --debug` now logs the full file list at each stage of the publish pipeline (cpSync output, git tracked files, git ignored files, early-exit tree). Diagnoses files disappearing between build output and published commit.

## [0.1.25] - 2026-04-09

### Security
- **Marketplace publish no longer logs git remote credentials.** `vat claude marketplace publish` previously echoed the full remote URL — including any credentials embedded by the user's config OR injected at runtime from `GH_TOKEN`/`GITHUB_TOKEN` — to stdout via its `Remote:` and `Pushed to …` log lines. In CI, GitHub Actions auto-masked the secret, but local runs (including adopter dry-runs) emitted the raw token to the terminal. All URL logging now passes through a `redactUrlCredentials()` helper that strips userinfo before logging. Git commands still receive the tokenized URL for authentication — only the logged copy is redacted.

### Changed
- **BREAKING: Marketplace publish no longer rewrites `CHANGELOG.md`.** `vat claude marketplace publish` now mirrors the source `CHANGELOG.md` byte-for-byte into the publish tree and extracts release notes for the commit body only. Accepts both Keep a Changelog workflows: a pre-stamped `[X.Y.Z]` section matching `package.json` (preferred) or a non-empty `[Unreleased]` section (fallback). Fails if neither is present. Workflow A adopters whose `main` branch CHANGELOG continues to carry `[Unreleased]` at publish time will see that heading on the publish branch too — stamp `CHANGELOG.md` on `main` before tagging if you want a stamped heading in the published file. Side benefit: corrections/typo-fixes to `CHANGELOG.md` on `main` now propagate to the publish branch on the next publish.

### Fixed
- **`toAbsolutePath()` and `getRelativePath()` now return forward-slash paths on Windows** — previously these returned backslash paths, bypassing cross-platform normalization.

## [0.1.24] - 2026-04-06

### Feature
- **Safe path normalization** — added `safePath.join()`, `safePath.resolve()`, `safePath.relative()` wrappers in `@vibe-agent-toolkit/utils` that always return forward-slash paths. New ESLint rules (`no-path-join`, `no-path-resolve`, `no-path-relative`) enforce their use over raw `node:path` functions, with auto-fix support. Adopters can copy these rules from `packages/dev-tools/eslint-local-rules/` into their own projects. Closes #38.
- **Cross-platform ESLint rule parity with vibe-validate** — ported `no-path-resolve-dirname` (enforces `normalizePath()` over `path.resolve(__dirname)` in tests for Windows 8.3 short name safety) and `no-test-scoped-functions` (enforces module-scope helper functions in test files, SonarQube S1515). VAT now ships 15 custom ESLint rules for cross-platform safety.

## [0.1.23] - 2026-04-02

### Feature
- **Marketplace publishing** — distribute Claude plugin marketplaces via Git branches. `vat claude marketplace publish` composes built artifacts with changelog, readme, and license into a squashed commit on a configurable branch. Consumers install with `/plugin marketplace add owner/repo#branch`. Includes standalone strict validation (`vat claude marketplace validate`) and automatic marketplace verification in `vat verify`.

### Docs
- **Marketplace testing guide** — added "Testing Your Marketplace" section to marketplace-distribution.md with full local test flow (`marketplace add` → `install` → `validate` → verify skills), known issues (name collision, `$schema` validation), and update workflow.
- **Marketplace README** — rewrote marketplace branch README as a developer-facing landing page with two-step install, skill descriptions, and architecture link.
- **Main README** — added "Claude Plugin Marketplace" section with install commands and links to marketplace branch and distribution guide.
- **Distribution skill** — added local marketplace testing subsection with commands and known-issue notes.

### Changed
- **Publish workflow** — added marketplace publish step to CI; stable tags push to `claude-marketplace` branch, RC tags push to `claude-marketplace-next`.
- **Pre-publish checks** — added marketplace dry-run validation (Check 12) to catch build/changelog issues before any npm mutations.

## [0.1.22] - 2026-04-01

### Added
- `vat claude org info` — org identity from Admin API (`/v1/organizations/me`).
- `vat claude org users list/get` — list and retrieve org members.
- `vat claude org invites list` — list pending and accepted invitations.
- `vat claude org workspaces list/get` — list and retrieve API workspaces.
- `vat claude org workspaces members list` — list workspace members.
- `vat claude org api-keys list` — inventory of org API keys with status and workspace scope.
- `vat claude org usage` — daily token usage report (model/workspace/key breakdown); autopaginates by advancing `starting_at`.
- `vat claude org cost` — USD cost report; `amount` field is string decimal. Valid `group_by[]` values: `description`, `workspace`.
- `vat claude org code-analytics` — Claude Code productivity metrics; `starting_at` is date-only `YYYY-MM-DD`.
- `vat claude org skills list` — workspace-scoped skills from `/v1/skills` (beta); skill IDs are slugs not UUIDs.
- `vat claude org skills install <source>` — upload a built skill directory or ZIP to the organization via Skills API (`POST /v1/skills`). Reads `display_title` from SKILL.md frontmatter; `--title` to override. Supports `--from-npm <pkg>@<version>` to download and upload all skills from an npm package (with optional `--skill <name>` filter).
- `vat claude org skills delete <skill-id>` — delete a skill from the organization via Skills API (`DELETE /v1/skills/{id}`).
- `OrgApiClient.uploadSkill()` / `OrgApiClient.deleteSkill()` — programmatic multipart upload and delete for Skills API.
- `buildMultipartFormData()` — zero-dependency multipart/form-data builder exported from `@vibe-agent-toolkit/claude-marketplace`.
- `vat claude org skills versions list <skill-id>` — list all versions of a skill.
- `vat claude org skills versions delete <skill-id> <version>` — delete a specific skill version (required before deleting the skill itself).
- `OrgApiClient.deleteSkillVersion()` — programmatic version deletion for Skills API.
- All other mutating org commands (`users update/remove`, `invites create/delete`, `workspaces create/archive`, `api-keys update`) return structured `not-yet-implemented` stubs.
- All `vat claude org` commands require `ANTHROPIC_ADMIN_API_KEY`; `org skills` commands require `ANTHROPIC_API_KEY`.
- `vibe-agent-toolkit:org-admin` skill — documents OrgApiClient programmatic API, CLI commands, report pagination quirks, and common recipes (cost summaries, API key audits, invite tracking).

### Fixed
- **Plugin version in plugin.json** — `vat claude plugin build` now includes `version` from package.json in generated plugin.json. Without it, Claude Code caches plugins under an `unknown/` directory, causing stale skill resolution across version upgrades.
- **`PLUGIN_MISSING_VERSION` audit check** — `vat audit` now warns when a plugin's plugin.json is missing the `version` field, explaining the stale cache impact.
- **Semver pre-release in plugin.json schema** — version field now accepts pre-release suffixes (e.g., `1.0.0-rc.3`) in addition to strict semver.
- **System test isolation** — `fakeHomeEnv()` now overrides `CLAUDE_CONFIG_DIR` to prevent shell-level environment variables from leaking into spawned test processes. Fixes false test failures when `CLAUDE_CONFIG_DIR` is set in the developer's shell.
- **`unknown_link` false positives** — `vat resources validate` no longer reports `unknown_link` errors for changelog headings (`## [Unreleased]`, `## [0.1.0] - 2026-01-01`) or bare filenames with extensions (`config.schema.json`, `image.png`). Unresolved `linkReference` nodes are now skipped, and bare filenames are classified as `local_file`.
- **Collection matching in dot-directories** — picomatch `**` globs now match paths containing dot-directory segments (e.g., `.claude/worktrees/`). Previously, collection validation silently returned 0 matches when the project path included a dotfile directory.
## [0.1.21] - 2026-03-31

### Breaking Changes
- **`vat skills install` removed** — replaced by `vat claude plugin install`. Update postinstall scripts to use `vat claude plugin install --npm-postinstall || exit 0` and add `vibe-agent-toolkit` to your package's `dependencies` (runtime, not devDependencies) so that `vat` is available via `./node_modules/.bin/` during postinstall.
- **`vat skills uninstall` removed** — replaced by `vat claude plugin uninstall`.
- **`vat claude build` replaced** — superseded by `vat claude plugin build` (same function, new location under the plugin command group). `vat build` now runs both `skills` and `claude` phases automatically; no separate step needed.
- **`vat claude verify` removed** — use `vat verify` (config-driven top-level command).
- **`vat-development-agents` plugin renamed to `vibe-agent-toolkit`** — the installed plugin name changes. Skill short names also updated: `agent-authoring` → `authoring`, `skills-distribution` → `distribution`, `install-architecture` → `install`. Installed skill IDs are now `vibe-agent-toolkit:authoring`, `vibe-agent-toolkit:distribution`, etc.

### Added
- `vat claude plugin install` — installs skill packages into Claude Code. Accepts `--target code|api.anthropic.com|claude.ai` (`code` is default; `claude.ai` returns a structured not-available stub). Correct postinstall pattern uses the local `node_modules` binary, never assumes a global `vat`.
- `vat claude plugin build` — generates `dist/.claude/plugins/marketplaces/` from `dist/skills/` and `vibe-agent-toolkit.config.yaml`. Cleans stale output before each build. Replaces `vat claude build`; now runs automatically as the `claude` phase of `vat build`.
- `vat claude plugin list` — lists installed plugins from the plugin registry and legacy skills directory.
- `vat claude plugin uninstall` — removes a plugin and all 5 install artifacts (marketplace dir, cache dir, `installed_plugins.json`, `known_marketplaces.json`, `settings.json`). Idempotent; `--all` finds plugins by npm package name; `--dry-run` previews without changes.
- **`vat build` now runs `skills → claude` phases** — full pipeline in one command; `claude` phase skipped automatically if no `claude.marketplaces` config is present.
- **`vat claude plugin install --dev` uses plugin tree symlinks** — skills appear as `{plugin}:{skill}` in Claude Code (e.g. `vibe-agent-toolkit:authoring`) instead of flat names. Requires `vat build` first. Gracefully rejects on Windows with a clear error.
- `vat-development-agents` self-adoption: postinstall now uses `vat claude plugin install --npm-postinstall` via `.bin/vat` (no path guessing, no global `vat` assumption).
- **`CLAUDE_CONFIG_DIR` env var support** — `getClaudeUserPaths()` now respects `CLAUDE_CONFIG_DIR` to override the default `~/.claude` location. Enables multiple Claude installations and non-standard config paths.

### Fixed
-**`vat skills build` cleans `dist/skills/` before rebuilding** — stale skill directories from renamed or removed skills no longer accumulate between builds.
- **`@next` dist-tag now updated on stable npm releases** — `publish.yml` now runs `determine-publish-tags.ts` to compute `update_next` and passes it to `publish-with-rollback.ts` via `UPDATE_NEXT` env; `publish-with-rollback.ts` now has a Phase 2 that applies `npm dist-tag add <pkg>@<version> next` to all packages when `UPDATE_NEXT=true`, with rollback on failure

## [0.1.20] - 2026-03-26

### Fixed
- **Plugin reinstall now removes stale skills** — reinstalling a plugin package that has fewer skills than the previous version no longer leaves orphaned skill directories in the Claude installation; the marketplace directory is fully replaced on each install rather than merged additively

## [0.1.19] - 2026-03-23

### Fixed
- **Audit: resolve URL-encoded paths in skill link traversal** — `vat audit` now correctly resolves `%20`, `%26`, and other percent-encoded characters in markdown link paths during skill link traversal; previously reported false `LINK_INTEGRITY_BROKEN` errors for files in directories with spaces or special characters (e.g., SharePoint-synced folders)

### Changed
- **Shared `resolveLocalHref` utility** — extracted common href → filesystem path resolution (anchor stripping, URL-decoding, relative path resolution) into `@vibe-agent-toolkit/resources` so both the audit and validate code paths use a single implementation

## [0.1.18] - 2026-03-20

### Added
- **`success` boolean on `SafeExecResult`** — convenience field (`success: exitCode === 0`) for cleaner conditional checks in callers of `safeExecSync()` and `safeExec()`

## [0.1.17] - 2026-03-20

### Fixed
- **Link validator: resolve percent-encoded paths** (fixes #59) — `%20` and other URL-encoded characters in markdown link paths are now decoded before filesystem resolution; bare relative paths with slashes (e.g., `files/doc.pdf`) are correctly classified as `local_file` instead of `unknown`
- **Windows Node.js v24+ compatibility** — fixed `ERR_UNSUPPORTED_ESM_URL_SCHEME` when running `vat` on Windows with Node.js v24, where bare absolute paths require `file://` URLs for dynamic imports

### Breaking Changes
- **Redesigned skill config and plugin distribution** (PR #55) — `vat.skills[]` in package.json is now an array of skill name strings (not objects); all config lives in `vibe-agent-toolkit.config.yaml`
  - `dist/.claude/` directory structure now mirrors `~/.claude/plugins/` directly — plugin install is a recursive copy, no manifest parsing needed
  - New `PluginJsonSchema` (strict: `name`, `description`, `author` only)
  - Removed `MarketplaceSchema`, `marketplace-validator.ts`, and all related code

### Added
- **marketplace.json build, validate, and audit** (PR #57) — full marketplace manifest lifecycle
  - `MarketplaceManifestSchema` in agent-skills with passthrough for all official source types (string, github, url, npm, pip)
  - `validateMarketplace()` validator mirroring the plugin-validator pattern
  - `vat claude build` now generates `.claude-plugin/marketplace.json` with relative source paths
  - `vat claude verify` validates marketplace.json against the schema
  - Unified validator routes marketplace type to `validateMarketplace()` (replaces placeholder UNKNOWN_FORMAT error)
  - `vat audit --user` now correctly validates marketplace directories
  - Plugin `description` is now optional in VAT project config (adopter compatibility)
  - Added marketplace-level `skills` selector to config schema
- **Transitive link traversal for `vat audit`** (PR #56) — follows all local file links from SKILL.md via BFS with cycle detection
  - Reports broken links (`LINK_INTEGRITY_BROKEN` error), boundary escapes (`OUTSIDE_PROJECT_BOUNDARY` warning), and unreferenced markdown files (`SKILL_UNREFERENCED_FILE` info with `--warn-unreferenced-files`)
  - Excludes CLAUDE.md, README.md, and other navigation files from unreferenced file detection
- **Implicit reference detection** — `extractImplicitReferences()` scans for non-markdown-link file references (backtick-quoted, bold, DOT graphviz, bare prose, `@`-prefix)
  - New `SKILL_IMPLICIT_REFERENCE` issue code for files referenced implicitly but not via `[text](path)` links
  - Reduces false-positive unreferenced file warnings from 18 to 9 when auditing real installed plugins
- **Settings schemas synced with official Claude Code docs** — `vat audit settings` now recognizes ~30 additional fields including sandbox filesystem/network controls, permission modes (`askEdits`, `readOnly`), and managed-only lockdown settings; fixes `autoUpdatesChannel` enum to match the official values (`stable`, `latest`)

## [0.1.15] - 2026-03-02

### Added
- **`vat build` and `vat verify` top-level commands** — orchestrate the full build and verification pipeline in dependency order
  - `vat build`: skills → claude plugins (future: cursor, etc.)
  - `vat verify`: resources → skills → claude artifacts
  - `--only <phase>` flag to run a single phase; `--marketplace <name>` to target a specific marketplace
- **`vat claude build`** — generates Claude plugin marketplace artifacts from pre-built skills
  - Reads `claude:` section from `vibe-agent-toolkit.config.yaml`; resolves skill selectors (exact names and globs)
  - Copies pre-built `dist/skills/<name>/` into `dist/plugins/<plugin>/skills/` (no re-bundling)
  - Generates `dist/plugins/<plugin>/.claude-plugin/plugin.json` and `dist/.claude-plugin/marketplace.json`
  - Sanitizes colon-namespaced skill names (e.g. `plugin:skill`) to double-underscore for Windows filesystem safety
- **`vat claude verify`** — validates Claude marketplace and plugin artifacts against schemas
  - Validates `marketplace.json` against `MarketplaceSchema`, `plugin.json` against `ClaudePluginSchema`
  - Validates `managed-settings.json` against `ManagedSettingsSchema` when `claude.managedSettings` is configured
  - Supports both source-layout (`file:`) and build-to-dist patterns
- **`claude:` config section in `vibe-agent-toolkit.config.yaml`** — configure Claude plugin distribution
  - `claude.marketplaces` — named map of marketplace definitions (inline or `file:` source-layout)
  - `claude.managedSettings` — path to managed-settings.json for schema validation
  - Marketplace config: `owner`, `skills` selector (exact or glob), `plugins` grouping, `output` paths
- **Claude plugin registry installer** (`packages/claude-marketplace`) — writes directly to Claude Code's plugin registry
  - Five-step install: copies plugin files to `~/.claude/plugins/marketplaces/` and `cache/`, updates `known_marketplaces.json`, `installed_plugins.json`, and `settings.json enabledPlugins`
  - Called automatically by `vat skills install --npm-postinstall` when `dist/.claude-plugin/marketplace.json` exists
- **`vat skills install` now routes through Claude plugin system** when package ships a plugin
  - If `dist/.claude-plugin/marketplace.json` exists: installs via plugin registry (namespaced, version-tracked)
  - If marketplace.json is absent: emits guidance to run `vat build` and exits 0 (no raw skill install)
  - `--user-install-without-plugin` flag: explicit opt-in to force `~/.claude/skills/` install
- **`vat --cwd <dir>` root flag** — change working directory before any command runs
  - Enables CI pipelines to run `vat build --cwd packages/my-agents` from the monorepo root
- **Marketplace settings schema fields** in `ClaudeSettingsSchema` and `ManagedSettingsSchema`
  - `extraKnownMarketplaces`, `enabledPlugins` added to settings/settings.local
  - `strictKnownMarketplaces` added to managed-settings only
  - `vat audit settings` output gains `marketplaces:` section showing registered marketplaces and enabled plugins
- **`plugin:skill` colon notation in skill names** - Skill names may now include a plugin namespace prefix (e.g., `vibe-agent-toolkit:audit`)
  - Format: `plugin-name:skill-name`; the prefix is the plugin/package namespace, the suffix is the skill's local name
  - Supported in both SKILL.md `name:` frontmatter and `package.json` `vat.skills[].name`
- **`vibe-agent-toolkit` skill package split** - Replaced the 1310-line monolith with an umbrella + 4 focused action skills
  - Umbrella `vibe-agent-toolkit` (~179 lines): concepts, archetypes overview, routing table, CLI quick reference
  - `vibe-agent-toolkit:resources` — resource collections, per-directory schema validation, `vat resources` commands
  - `vibe-agent-toolkit:distribution` — packaging, `--target claude-web`, `vat install`, npm and private distribution
  - `vibe-agent-toolkit:agent-authoring` — SKILL.md authoring, 4 archetypes with examples, packaging options reference
  - `vibe-agent-toolkit:audit` — `vat audit` flags, auto-detection table, `--compat` output, CI usage patterns
- **`vat audit --exclude <glob>`** - Filter paths from recursive scans (repeatable flag)
  - Example: `vat audit plugins/ --exclude "dist/**" --exclude "node_modules/**"`
  - Prunes directory traversal early for performance; does not just filter output
- **Unified `vat install` command** - Single command for installing any VAT resource type
  - Auto-detects resource type from source: `SKILL.md` → agent-skill, `.claude-plugin/plugin.json` → claude-plugin, `.claude-plugin/marketplace.json` → claude-marketplace
  - Routes to the correct `~/.claude/` subdirectory automatically
  - Flags: `--type` (explicit override), `--force`, `--dry-run`; YAML output includes `sourceType` field
  - `vat skills install` remains as an alias constrained to agent skills only
- **`vat audit --compat`** - Per-surface compatibility analysis for plugins and skills
  - Reports compatibility with `claude-code`, `cowork`, and `claude-desktop` surfaces with supporting evidence
  - Detects Python scripts, bash hooks, sqlite dependencies, and other surface-specific constraints
  - Works in both path mode and `--user` mode; combinable with recursive scanning for full marketplace matrices
- **`vat skills package --target <target>`** - Target-specific packaging for Claude.ai web upload
  - `--target claude-web` produces a ZIP with `references/` instead of `resources/`, matching the Claude.ai web upload spec
  - `--target claude-code` (default) preserves existing behavior unchanged
  - ZIP size validation for `claude-web`: warn at 4MB, error at 8MB

### Changed
- **`vat audit` is recursive by default** (**BREAKING**) - `vat audit <path>` now walks the full directory tree automatically
  - `--recursive` / `-r` flag removed; use `--no-recursive` to scan the top-level directory only
  - `--user` behavior unchanged: scans `~/.claude/` directories, exit code remains 0 (informational)
- **`CLAUDE.md` documentation additions** - Resource collections and licensing conventions added to the contributor guide
  - Resource collections: per-directory schema validation config, `permissive` vs `strict` modes, `vat resources validate` usage
  - Licensing conventions: table for open source / proprietary / not-yet-licensed packages with enterprise LICENSE template

## [0.1.14] - 2026-02-11

### Added
- **Content transform pipeline** - Shared `transformContent()` engine in `@vibe-agent-toolkit/resources` for rewriting markdown links before persistence
  - `LinkRewriteRule[]` configuration with match criteria (type, glob pattern, excludeResourceIds) and Handlebars templates
  - Template variables: `{{link.text}}`, `{{link.href}}`, `{{link.fragment}}`, `{{link.resource.*}}` (id, filePath, extension, mimeType, sizeBytes, estimatedTokenCount, frontmatter.*)
  - Consumer context variables for skill/project-specific data (e.g., `{{skill.name}}`, `{{kb.baseUrl}}`)
  - `ResourceLookup` interface decouples transform from full ResourceRegistry
  - First-match-wins rule ordering; unmatched links preserved as-is
- **Full document storage** (`rag_documents` table) - Optional `storeDocuments: true` config on LanceDB RAG provider
  - Stores complete document content alongside vector chunks for retrieval after search
  - `getDocument(resourceId)` returns full content, metadata, token count, chunk count, and indexing timestamp
  - Content transforms applied to stored documents
  - Incremental updates: changed content updates the document record
  - Cascading deletes: `deleteResource()` removes both chunks and document record
  - `DocumentResult` interface added to `@vibe-agent-toolkit/rag` provider interfaces
- **Content transform support in RAG indexing** - `contentTransform` option on LanceDB provider rewrites links before chunking
  - Content hash computed on transformed output for accurate change detection
  - Re-indexes automatically when transform rules change
- **OnnxEmbeddingProvider** - Local ONNX-based embedding generation (#45)
  - Makes `@lancedb/vectordb` and `onnxruntime-node` optional peer dependencies
  - Falls back gracefully when native dependencies unavailable

### Fixed
- **tokenCount in enrichChunks** - `tokenCount` field now populated on enriched chunks; chunk position metadata (`chunkIndex`, `totalChunks`, `isFirstChunk`, `isLastChunk`) added (#46)
- **Custom metadata overwriting core chunk fields** - `chunkToLanceRow()` now spreads metadata before core fields so `chunkIndex`, `totalChunks`, and other core columns cannot be overwritten by user-defined metadata schemas with colliding names
- **Path-relative resource IDs** - `ResourceRegistry` generates IDs relative to `baseDir` (e.g., `docs-guide` instead of `guide`), preventing collisions for same-named files in different directories

## [0.1.13] - 2026-02-10

### Added
- **Skills development install** (`vat skills install --dev`) - Symlink-based installation reads `vat.skills[]` from `package.json` and symlinks built skills into `~/.claude/skills/`
  - After rebuild, skills update immediately (no re-install needed)
  - `--build` flag auto-runs `vat skills build` before symlinking
  - `--name` flag to install a specific skill from multi-skill packages
  - `--force` to overwrite existing installations
  - `--dry-run` to preview without creating symlinks
- **Skills uninstall** (`vat skills uninstall <name>`) - Remove installed skills (directories or symlinks)
  - `--all` flag reads `package.json` and removes all declared skills
  - `--dry-run` to preview without removing
  - Reports `wasSymlink` in YAML output for each removed skill
- **MCP test client harness** - Reusable `MCPTestClient` class for reliable MCP server testing
  - Waits for server readiness signal before sending requests (eliminates race conditions)
  - Auto-incrementing request IDs with ID-based promise resolution
  - Graceful shutdown with SIGTERM/SIGKILL fallback

### Fixed
- **npm install installs ALL skills** - `vat skills install <npm-package>` now installs all skills from multi-skill packages instead of only the first one
- **Broken symlink detection** - `vat skills install --force` now correctly detects and removes broken symlinks using `lstatSync` instead of `existsSync`
- **MCP test reliability** - Replaced timing-based test approach with readiness-signal pattern; tests now complete in ~600ms instead of flaking at 2-3.5s

## [0.1.12] - 2026-02-10

### Added
- **External URL validation with caching** (#41)
  - Optional external URL validation via `--check-external-urls` flag
  - Filesystem-based cache with TTLs (24h alive, 1h dead)
  - Per-collection configuration for timeout, retry, ignore patterns
  - New issue types: `external_url_dead`, `external_url_timeout`, `external_url_error`
  - Cache stored in `.vat-cache/external-urls.json`
  - Uses `markdown-link-check` library for robust HTTP checking
- **Link Depth Control for Skills** - Control how deep to follow markdown links during skill packaging
  - `linkFollowDepth` in `packagingOptions`: `0` (skill only), `1` (direct links), `2` (default), `N`, or `"full"` (unlimited)
  - Prevents transitive link explosion in large knowledge bases (e.g., 493 files → ~10 files with depth 1)
- **Rule-Based Link Exclusion** - Selectively exclude files from bundles with per-pattern link rewriting
  - `excludeReferencesFromBundle` with ordered rules: each rule specifies glob patterns and optional Handlebars template
  - `defaultTemplate` for depth-boundary links that don't match explicit rules (default: `"{{link.text}}"`)
  - Template variables: `{{link.text}}`, `{{link.href}}`, `{{link.fragment}}`, `{{link.type}}`, `{{link.resource.id}}`, `{{link.resource.fileName}}`, `{{link.resource.relativePath}}`, `{{skill.name}}`
  - No dead links in output: every non-bundled link target is rewritten per its matched template
- **Resource Naming Strategies for Skills** - Flexible control over packaged resource file naming
  - Three strategies: `basename` (default, simple), `resource-id` (flatten to kebab-case), `preserve-path` (maintain directory structure)
  - Universal `stripPrefix` option removes path prefixes before applying naming strategy
  - Filename collision detection prevents duplicate names in flat output
  - Configure via `packagingOptions` in skill metadata (package.json `vat.skills[]`)
- **Non-Markdown Asset Bundling** - JSON schemas, images, and other non-markdown files linked from bundled markdown are now included in skill packages
- **Handlebars Template Utility** - Shared template rendering in `@vibe-agent-toolkit/utils` with compiled template caching
- **Directory Link Detection** - Links targeting directories now produce actionable validation errors suggesting README.md/index.md alternatives (previously crashed with ENOTSUP)
- **Expanded Validation Metadata** - `directFileCount`, `excludedReferenceCount`, and `excludedReferences` in validation results
  - `--verbose` flag on `vat skills validate` shows excluded reference details with reason (`depth-exceeded` / `pattern-matched`) and matched pattern
- **Packaging Options Documentation** - Comprehensive reference in VAT SKILL.md covering linkFollowDepth, resourceNaming, excludeReferencesFromBundle, and ignoreValidationErrors

### Changed
- **Default link follow depth is now 2** (was unlimited). Use `linkFollowDepth: "full"` to restore unlimited behavior.
- `LINK_TARGETS_DIRECTORY` validation is now overridable (transitively-bundled docs may contain directory links the skill author cannot control)

### Improved
- **Navigation file errors** now include full resolved paths and line numbers (not just basename)
- **Depth terminology** clarified as "link-chain hops" instead of misleading "levels deep"

### Internal
- **npm link reliability** - Topological sort, `--install-strategy=shallow`, and retry logic for workspace package linking

## [0.1.11] - 2026-02-09

**Note:** Version 0.1.10 was deprecated due to incomplete publish (phantom package in publish list caused partial release).

### Performance
- **Discovery Scan: 540x Faster** - File discovery now completes in ~0.5 seconds instead of 5+ minutes
  - Added `PERFORMANCE_POISON` patterns to exclude `.git`, `node_modules`, and `coverage` directories
  - Batch git-ignore checking reduces 794 subprocess calls to 1 (`git check-ignore --stdin`)
  - Skills list command that previously timed out now completes in seconds
- **Skills Validation: 12x Faster** - Validation improved from 13.5s to 1.13s
  - Introduced `GitTracker` to cache git-ignore checks across validations
  - Eliminates 174 redundant git subprocess calls during link validation
  - Pre-populates cache from `git ls-files` for instant lookups

### Fixed
- **LanceDB Database Size** - `getStats()` now accurately reports database disk usage
  - Previously always showed "0.00 MB" regardless of actual size
  - Implements recursive directory traversal to calculate true size in bytes
  - Helps users monitor disk usage and verify successful index builds
- **Phantom Package Validation** - Pre-publish check now catches packages declared but not existing
  - Previously only checked for undeclared packages (exist but not in lists)
  - Now validates both directions: undeclared packages AND phantom packages
  - Prevents publish failures from stale package list entries
  - Root cause of 0.1.10 publish failure

### Changed
- **Test Suite Reorganization**: Separated integration tests from unit tests for faster development feedback
  - Moved 15 integration tests (testing file I/O, git, databases, ML models) to separate test phase
  - Unit test execution time improved from 121s to 27-41s (63% faster)
  - Integration tests run separately in ~34-38s
  - Coverage thresholds adjusted to reflect unit test reality: 70% for project coverage, 80% for new code (patches)
  - Clearer separation enables faster development iteration and better CI parallelization

### Internal
- **Turborepo Integration**: Build orchestration with intelligent caching and parallel execution
- **Circular Dependency Resolution**: Removed circular dependencies between packages for cleaner architecture
- **Shared Test Infrastructure**: `@vibe-agent-toolkit/test-agents` package for consistent testing across runtime adapters
- **Test Parallelism**: Adaptive test parallelism with `availableParallelism()` for 2x dev speedup

## [0.1.9] - 2026-02-07

- **Resource Compiler** (`@vibe-agent-toolkit/resource-compiler`) - Compile markdown to TypeScript with full IDE support
  - Direct `.md` imports in TypeScript with type safety
  - H2 headings become typed fragment properties for granular access
  - Frontmatter parsing to typed objects
  - IDE autocomplete, go-to-definition, and hover tooltips
  - `vat-compile-resources` CLI: compile markdown to JS/TS modules
  - TypeScript Language Service Plugin for seamless `.md` imports
  - Build integration: copy generated resources to dist during build
  - Dog-fooded in vat-example-cat-agents package

- **VAT Distribution Standard** - Package-based skill distribution with build and install infrastructure
  - `vat skills build` command: Builds skills from source into `dist/skills/` during package build
  - `vat skills install` command: Smart installation from npm packages, local directories, or zip files
  - Package.json `vat` metadata convention for declaring skills, agents, pure functions, and runtimes
  - Automatic skill installation via npm postinstall hooks
  - Two distributable skills:
    - `vibe-agent-toolkit`: User adoption guide for VAT CLI and agent creation (from vat-development-agents)
    - `vat-example-cat-agents`: Orchestration guide for 8 example cat agents (from vat-example-cat-agents)
  - See [Distributing VAT Skills Guide](./docs/guides/distributing-vat-skills.md) for usage

- **Audit Misconfiguration Detection** - `vat audit` now detects misconfigured standalone skills
  - Identifies standalone SKILL.md files in ~/.claude/plugins/ that won't be recognized by Claude Code
  - Error code: SKILL_MISCONFIGURED_LOCATION with actionable fix suggestions
  - Helps users correct common installation mistakes

- `--user` flag for `vat skills validate` to validate installed user skills
- Shared utilities: claude-paths, skill-discovery, user-context-scanner, config-loader
- Case-insensitive skill discovery (finds malformed SKILL.md variations)

### Changed
- **BREAKING**: `vat skills list` now defaults to project skills (use `--user` for installed skills)
- **Plugin Schema Updated to Official Claude Code Spec** - Updated ClaudePluginSchema to match official documentation
  - Made `description` and `version` optional (only `name` required if manifest exists)
  - Added component path fields: `commands`, `skills`, `agents`, `hooks`, `mcpServers`, `outputStyles`, `lspServers`
  - Renamed types for clarity: `PluginSchema` → `ClaudePluginSchema`, `Plugin` → `ClaudePlugin`
  - Updated plugin-validator to handle optional version field with exactOptionalPropertyTypes
  - Tests updated to validate actual errors instead of missing optional fields
- **CLI Dependency Cleanup** - Removed example agent packages from automatic installation
  - Removed `@vibe-agent-toolkit/vat-example-cat-agents` from CLI dependencies
  - Added `@vibe-agent-toolkit/vat-development-agents` to CLI dependencies
  - Added comment warning against adding example packages to CLI dependencies
  - Example agents now opt-in via separate `npm install -g @vibe-agent-toolkit/vat-example-cat-agents`
- **Skill Naming Consistency** - Skill names now match package names
  - `vat-example-cat-agents` skill renamed from `cat-agents-skill` for consistency
- Refactored `vat skills validate` to use shared utilities and respect resource config boundaries
- Refactored `vat skills list` to use shared utilities

### Fixed
- **RAG Metadata Filtering**: Now works correctly regardless of which Zod version (v3 or v4) you have installed
  - Previously: Metadata filters returned 0 results if your Zod version differed from the library's
  - Now: Automatically detects and works with both Zod v3.25.0+ and v4.0.0+
  - No code changes required - filtering just works
- **RAG Line Number Tracking**: Chunks now preserve exact line ranges from source documents
  - Previously all chunks from the same section had identical line numbers
  - Fixed off-by-one error in line position calculation (1-based to 0-based conversion)
  - Properly flattens nested heading hierarchy during section extraction
  - Handles large paragraphs by splitting into line-level chunks
  - Enables accurate IDE navigation and source citations
- **BREAKING CHANGE**: RAG database column names are now lowercase (SQL standard)
  - Existing LanceDB indexes must be rebuilt - run `await provider.clear()` then re-index
  - Your code doesn't change - still use camelCase in queries: `{ metadata: { contentType: 'docs' } }`
  - Why: Prevents case-sensitivity issues, no quotes needed in queries, follows SQL conventions
  - See migration guide: `packages/rag-lancedb/README.md#upgrading-from-v018-to-v019`
- Eliminated path duplication across audit, install, and other commands
- `vat audit --user` now finds standalone skills in ~/.claude/skills

### Added
- **RAG Similarity Scores**: Search results now include confidence scores (0-1, higher is better)
  - Filter results by confidence threshold
  - Compare result relevance
  - Build smarter retrieval logic
- **RAG Progress Tracking**: See real-time progress when building large indexes
  - Shows resources indexed, chunks created, time elapsed/remaining
  - Add progress bars to your CLI tools
  - Monitor long-running index builds
- **Accurate Line Numbers**: Chunks now track exact line ranges in source files
  - Jump directly to source in your IDE
  - Show precise code citations
  - Build better documentation tools

### Internal
- Deleted obsolete skill-finder.ts (replaced by skill-discovery.ts)
- Removed registry tracking from skills install command (architectural simplification)
- Preserved audit.ts custom scanning logic (architectural decision for independence)

## [0.1.8] - 2026-02-06

### Fixed
- **RAG Metadata Filtering at Scale**: Fixed metadata filtering returning empty results on production-scale indexes (>1000 chunks)
  - Root cause: LanceDB struct column access (`metadata['field']`) doesn't scale
  - Solution: Store metadata as top-level columns with direct access (`` `field` ``)
  - All metadata fields now stored as top-level LanceDB columns instead of nested struct
  - Filter builder updated to use direct column access for efficient queries
  - Added system test validating metadata filtering with flattened schema
  - Fixes issue reported by an adopter project (753 docs, 4,321 chunks)

### Changed
- **BREAKING CHANGE**: Existing LanceDB indexes must be rebuilt
  - Metadata storage format changed from nested struct to top-level columns
  - Run `await ragProvider.clear()` then re-index resources
  - API remains backward compatible - no code changes required beyond index rebuild
  - See migration guide in `packages/rag-lancedb/README.md`

## [0.1.7] - 2026-02-05

### Added
- **RAG Extensible Metadata Schema Support**: Custom metadata fields with full type safety
  - Generic provider interfaces with `TMetadata` type parameter for compile-time type safety
  - Zod schema introspection for automatic serialization/deserialization
  - Support for arrays (CSV), objects (JSON), dates (timestamps), and primitives
  - Type-safe query filtering on custom metadata fields
  - `DefaultRAGMetadata` schema with standard fields (tags, title, description, category)
  - See `packages/rag-lancedb/README.md` for usage examples

## [0.1.6] - 2026-02-04

### Fixed
- Umbrella package now works with `npx vibe-agent-toolkit` by adding ESM type declaration
- Version output now shows project root for local installs instead of "unknown"

## [0.1.5] - 2026-02-04

### Fixed
- CLI now works correctly with `npx` commands in CI environments without global installation
- Link validation detects case mismatches in filenames, preventing failures on case-sensitive filesystems (Linux)

## [0.1.4] - 2026-02-03

### Added
- **Multi-Collection Resource Validation System**: Comprehensive resource type system with frontmatter validation
  - Multi-collection support via `vibe-agent-toolkit.config.yaml` with pattern resolution
  - Per-collection frontmatter validation with JSON Schema
  - Validation modes: strict vs permissive
  - Collection filtering via `--collection <id>` flag in scan/validate commands
  - Format options: `--format yaml|json|text` for structured or human-readable output
  - Package-based schema references (e.g., `@vibe-agent-toolkit/agent-skills/schemas/skill-frontmatter.json`)
  - Enhanced validation error messages with actual/expected values
  - Enhanced `vat doctor` command validates config file schema and checks schema file existence
- **Agent Skills Package Rename**: `@vibe-agent-toolkit/runtime-claude-skills` → `@vibe-agent-toolkit/agent-skills`
  - Exported JSON schemas: `skill-frontmatter.json` and `vat-skill-frontmatter.json`

### Changed
- **Output Format Improvements**: Enhanced validation and scan output
  - Added error summary by type
  - Added per-collection error tracking (filesWithErrors, errorCount)
  - Simplified scan output with `--verbose` flag for file details
  - Errors grouped by file in structured output (YAML/JSON)

## [0.1.3] - 2026-02-01

### Added
- **Frontmatter Validation**: Parse and validate YAML frontmatter in markdown files
  - CLI flag `--frontmatter-schema` for `vat resources validate` to validate against JSON Schema
  - Reports YAML syntax errors and schema validation failures
  - `ResourceMetadata` includes parsed frontmatter data when present

## [0.1.2] - 2026-01-30

### Added
- **Session Management System**: Pluggable session persistence for stateful agents
  - `RuntimeSession<TState>` type with id, history, state, and metadata
  - `SessionStore<TState>` interface for pluggable persistence strategies
  - `MemorySessionStore` - in-memory sessions with TTL support and sliding window expiration
  - `FileSessionStore` - file-based persistence in `~/.vat-sessions/` (runtime-agnostic)
  - CLI transport integration with `--session-store` and `--session-id` flags
  - Session management commands: `/clear` (or `/restart`), `/state`
  - Commands shown upfront in CLI welcome message for better UX
  - Conversational demo supports session resumption across restarts
  - Session helpers: `validateSessionId`, `createInitialSession`, `updateSessionAccess`, `isSessionExpired`
  - Reusable test helpers to eliminate duplication across store implementations
- **Audit Command Enhancements**: Comprehensive validation of Claude skills
  - Transitive link validation - recursively follows and validates all linked markdown files
  - Unreferenced file detection with `--check-unreferenced` flag
  - BFS traversal to discover entire skill structure
  - Comprehensive statistics for all files in skill
  - Handles circular references gracefully
- **MCP Gateway**: Expose VAT agents through Model Context Protocol (`@vibe-agent-toolkit/gateway-mcp`)
  - Stdio transport for Claude Desktop integration
  - Stateless agent support (Pure Function Tools, One-Shot LLM Analyzers)
  - Multi-agent server support (expose multiple agents through single gateway)
  - Runtime-agnostic architecture with adapter pattern
  - Observability hooks (console logger, OpenTelemetry-aligned interfaces)
  - Error classification (retryable vs non-retryable)
  - Complete documentation and examples (haiku-validator, photo-analyzer, combined server)
  - Integration and system tests
- **Agent Runtime Architecture**: Core VAT agent archetype system
  - Pure function agents: Deterministic, synchronous tools
  - LLM analyzer agents: AI-powered analysis with structured I/O
  - Function orchestrator, event consumer, agentic researcher, conversational assistant archetypes
  - Provider-agnostic LLM integration via context.callLLM()
  - Shared validation and execution wrappers
- **Example Cat Agents**: Comprehensive agent examples for testing
  - Haiku generator/validator, name generator/validator
  - Photo analyzer, description parser
  - Human approval workflow
- **Runtime Adapters**: Convert VAT agents to framework-specific formats
  - `@vibe-agent-toolkit/runtime-vercel-ai-sdk`: Vercel AI SDK tools and functions
  - `@vibe-agent-toolkit/runtime-langchain`: LangChain DynamicStructuredTool
  - `@vibe-agent-toolkit/runtime-openai`: OpenAI function calling tools
  - `@vibe-agent-toolkit/runtime-claude-agent-sdk`: Claude Agent SDK MCP tools
  - All support both pure function and LLM analyzer archetypes
  - Multi-provider demos (Anthropic Claude, OpenAI GPT)
- **Shared Test Factories**: Zero-duplication test infrastructure in dev-tools
  - `createPureFunctionTestSuite()` and `createLLMAnalyzerTestSuite()` factories
  - Consistent testing across all runtime adapters
  - Runtime-specific behavior through config interfaces
- **Common Demo Infrastructure**: Runtime-agnostic demo framework
  - Single demo implementation works with any runtime adapter
  - Demonstrates agent portability across frameworks
  - Multi-provider comparison support
- **Documentation**: Guide for adding new runtime adapters
  - Package structure and configuration patterns
  - Adapter implementation best practices
  - Testing with shared factories
  - Validation checklist and common pitfalls
- **Result Constructors Re-exported**: Convenience exports from `@vibe-agent-toolkit/agent-runtime`
  - `createSuccess`, `createError`, `createInProgress`
  - Error constants: `LLM_REFUSAL`, `LLM_INVALID_OUTPUT`, `LLM_TIMEOUT`, etc.
  - All result types and metadata types re-exported for single-package convenience

### Changed
- Upgraded vibe-validate from 0.18.2-rc.1 to 0.18.4-rc.1 (fixes caching bug)
- Migrated from deprecated `vectordb@0.4.20` to `@lancedb/lancedb@0.23.0`
  - Resolves Bun compatibility issues with Apache Arrow
  - Changed nullable number fields to use -1 sentinel values instead of null
  - API changes: `search().execute()` → `vectorSearch().toArray()`, `filter().execute()` → `query().where().toArray()`
- Updated OpenAI SDK from 4.67.0 to 6.16.0 (resolves node-domexception deprecation warnings)
- **BREAKING: Pure Function Agent API Simplified** - Consolidated to single `definePureFunction` API
  - **Removed**: `createPureFunctionAgent` and `createSafePureFunctionAgent` (use `definePureFunction` instead)
  - **API Change**: Agents now return output directly (unwrapped) instead of `OneShotAgentOutput` envelopes
  - **API Change**: Pure function agents are now synchronous (`execute(input): TOutput`) instead of async
  - **API Change**: Invalid input throws exceptions instead of returning error envelopes
  - **API Change**: Handler function receives validated input, returns output directly (no manual wrapping)
  - **Archetype renamed**: `pure-function-tool` → `pure-function` for consistency
  - **Migration Path**: Replace `createPureFunctionAgent((input) => createSuccess(output), manifest)` with `definePureFunction(config, (input) => output)`
  - **Runtime adapters updated**: All four runtime packages handle new unwrapped API
  - **Documentation updated**: `docs/agent-authoring.md` shows only `definePureFunction` pattern

## [0.1.1] - 2026-01-12

### Added
- **`vat doctor` Diagnostic Command**: System health checks and troubleshooting
  - Validates Node.js, Bun, Git, TypeScript installations
  - Checks database connectivity (LanceDB)
  - Validates configuration files
  - Verifies installation integrity
  - Exit codes: 0 (all checks passed), 1 (issues found), 2 (system errors)
- **Resource Collection System**: Advanced resource querying with checksums
  - Content checksumming for change detection
  - Advanced filtering and querying capabilities
  - Test isolation infrastructure for improved reliability
- **Plugin & Marketplace Audit System** (`vat audit`): Comprehensive plugin ecosystem validation
  - Validates `plugin.json` manifests (name, version, description, metadata)
  - Validates `marketplace.json` with bundled skills, git repos, LSP servers
  - Registry tracking for installed plugins and known marketplaces
  - Cache staleness detection - detects stale cached skills vs installed plugins
  - Compares checksums between cache and source
  - Identifies cache-only and installed-only resources
  - Hierarchical output with cache status indicators (stale/fresh/orphaned)
  - `--verbose` flag for detailed diagnostic output
  - Filter plugin/marketplace results from skill-only scans
  - Performance optimizations for large plugin collections

## [0.1.0] - 2026-01-04

### Added
- **Publishing System**: Automated npm publishing with rollback safety
  - `validate-version`: Ensures all packages have unified version
  - `publish-with-rollback`: Publishes 11 packages in dependency order with automatic rollback/deprecation on failure
  - `extract-changelog`: Extracts version-specific changelog for GitHub releases
  - GitHub Actions workflow triggered by version tags (v*)
  - Smart npm dist-tag handling: RC versions → @next, stable versions → @latest
  - Manifest tracking for publish progress and rollback capability
  - Cross-platform test helpers with security validation
- **Agent Runtime**: Execute agents with `vat agent run <name> "input"` using Anthropic API
- **Agent Discovery**: List all agents in your project with `vat agent list`
- **Agent Validation**: Validate manifests and resources with `vat agent validate <name>`
- **Claude Skills Audit**: Comprehensive validation of Claude Skills with `vat agent audit [path] --recursive`
  - Validates frontmatter fields (name, description, license, compatibility)
  - Enforces naming conventions (lowercase, hyphens, reserved words)
  - Checks link integrity (broken links, Windows paths)
  - Detects console-incompatible tool usage (Write, Edit, Bash)
  - Exit codes: 0 (success), 1 (validation errors), 2 (system errors)
- **Claude Skills Import**: Convert SKILL.md to agent.yaml with `vat agent import <skillPath> [options]`
  - Extracts frontmatter metadata to agent manifest
  - Validates before conversion
  - Supports custom output paths with `--output`
  - Force overwrite with `--force`
- **Claude Skills Packaging**: Build agents as Claude Skills with `vat agent build <name>`
- **Installation Management**: Install/uninstall Claude Skills locally with `vat agent install/uninstall <name>`
- **Installation Scopes**: Control installation location with `--scope user|project`
- **Dev Mode**: Symlink-based development workflow with `--dev` flag
- **Gitignore Support**: File crawler and link validator now respect `.gitignore` patterns
- **RAG System**: Document indexing and semantic search with LanceDB
- New package: `@vibe-agent-toolkit/agent-config` - agent manifest loading and validation
- New package: `@vibe-agent-toolkit/runtime-claude-skills` - Claude Skills builder, installer, validator, and import/export
- New package: `@vibe-agent-toolkit/discovery` - format detection and file scanning utilities
- New documentation: [Agent Skills Best Practices Guide](./docs/guides/agent-skills-best-practices.md)
- New documentation: [Audit Command Reference](./docs/cli/audit.md)
- New documentation: [Import Command Reference](./docs/cli/import.md)
- **Resources System**: Markdown resource scanning and validation of link integrity

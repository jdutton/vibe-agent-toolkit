# Publishing & Version Management

## Unified Versioning

**CRITICAL**: All packages in this monorepo share the same version. When any package changes, all packages are bumped together. This ensures compatibility and simplifies dependency management.

Current packages (19 published, 1 private):
- @vibe-agent-toolkit/schema
- @vibe-agent-toolkit/utils
- @vibe-agent-toolkit/discovery
- @vibe-agent-toolkit/resources
- @vibe-agent-toolkit/rag
- @vibe-agent-toolkit/rag-lancedb
- @vibe-agent-toolkit/agent-config
- @vibe-agent-toolkit/agent-runtime
- @vibe-agent-toolkit/runtime-claude-agent-sdk
- @vibe-agent-toolkit/agent-skills
- @vibe-agent-toolkit/runtime-langchain
- @vibe-agent-toolkit/runtime-openai
- @vibe-agent-toolkit/runtime-vercel-ai-sdk
- @vibe-agent-toolkit/transports
- @vibe-agent-toolkit/cli
- @vibe-agent-toolkit/gateway-mcp
- @vibe-agent-toolkit/vat-development-agents
- @vibe-agent-toolkit/vat-example-cat-agents
- vibe-agent-toolkit (umbrella package)
- @vibe-agent-toolkit/dev-tools (PRIVATE - not published)

## Version Bump Workflow

**Always use the `bump-version` script:**

```bash
# Explicit version
bun run bump-version 0.2.0-rc.1

# Semantic increment
bun run bump-version patch    # 0.1.0 → 0.1.1
bun run bump-version minor    # 0.1.0 → 0.2.0
bun run bump-version major    # 0.1.0 → 1.0.0
```

The script updates all 19 publishable packages atomically.

## CHANGELOG.md Format

**CRITICAL - Read This Carefully:**

CHANGELOG.md uses a strict format. **RC/prerelease versions NEVER get their own section.**

```markdown
## [Unreleased]

### Added
- New feature descriptions here

### Changed
- Change descriptions here

### Fixed
- Bug fix descriptions here

## [0.1.0] - 2026-01-15

### Added
- Previous release features...
```

**Rules:**
- **RC versions (0.1.0-rc.1, 0.1.0-rc.2, etc.)**: Changes stay in `[Unreleased]` section
- **Stable versions (0.1.0, 0.2.0, etc.)**: Move `[Unreleased]` content to new `## [X.Y.Z] - YYYY-MM-DD` section
- **NEVER create sections like `## [0.1.0-rc.1]`** - these will break the release process

**For AI assistants:** Never ask about creating CHANGELOG sections for RC versions. They don't exist.

## Publishing Process (Automated)

**CRITICAL**: Publishing is automated via GitHub Actions. **DO NOT manually publish** unless automation fails.

**Normal Release Workflow:**

1. **Update CHANGELOG.md**
   - **RC releases**: Ensure changes are documented in `[Unreleased]` section
   - **Stable releases**: Move `[Unreleased]` content → `## [X.Y.Z] - YYYY-MM-DD`

2. **Bump version**:
   ```bash
   bun run bump-version 0.1.0-rc.1  # For RC
   bun run bump-version 0.1.0       # For stable
   ```

3. **Build and run the release-readiness check** (catches CHANGELOG, version, metadata and tag issues):
   ```bash
   bun run build
   bun run pre-release
   ```
   `pre-release` is `pre-publish` (full validation, CHANGELOG entry for the current version on a
   stable release, all packages built and version-synchronized, package metadata complete, no
   uncommitted or untracked files) plus the release-readiness checks: a marketplace publish
   dry-run, no tag of this version already on the remote, and on a stable release a non-empty
   stamped CHANGELOG section with nothing left under `[Unreleased]`.

   **Do NOT skip this step** - the CI publish workflow runs the same check against the pushed tag and will fail if it finds issues.

4. **Commit and tag**:
   ```bash
   git add -A && git commit -m "chore: Release vX.Y.Z"
   git tag vX.Y.Z
   git push origin main vX.Y.Z
   ```

5. **Monitor GitHub Actions**:
   - Visit: https://github.com/jdutton/vibe-agent-toolkit/actions
   - Workflow automatically publishes to npm

## Publishing Behavior

**RC versions** (e.g., `v0.1.0-rc.1`):
- Publish to `@next` tag
- NO GitHub release
- CHANGELOG stays in `[Unreleased]`
- Use for: risky changes, pre-release testing

**Stable versions** (e.g., `v0.1.0`):
- Publish to `@latest` tag
- Also update `@next` tag (if newest)
- Create GitHub release with changelog
- Move CHANGELOG `[Unreleased]` → `[Version]`

## Manual Publishing (Fallback Only)

**Use only if automated publishing fails:**

```bash
# Ensure versions are correct
bun run bump-version <version>

# Build all packages
bun run build

# Run pre-publish checks
bun run pre-publish-check

# Publish with rollback safety
bun run publish-with-rollback <version>
```

## CLI Wrapper Behavior

The `vat` command uses smart wrapper with context detection:

**Dev Mode** (in this repo — `bun run vat` runs `packages/cli/dist/bin/vat.js`):
- Dispatches to: `packages/cli/dist/bin.js` (the unpackaged dev build; `VAT_ROOT_DIR` points it at another checkout)
- Shows version: the package version with a `-dev` suffix and the repo path, e.g. `0.2.0-rc.7-dev (/path/to/repo)`

**Local Install** (project has @vibe-agent-toolkit/cli):
- Uses: `node_modules/@vibe-agent-toolkit/cli/dist/bin.js`
- Shows version: project's version

**Global Install** (fallback):
- Uses: globally installed version
- Shows version: global version

**Installation:**
```bash
npm install -g @vibe-agent-toolkit/cli    # Just CLI
npm install -g vibe-agent-toolkit          # Everything
```

## Package Publishing Order

Publish order is `publishedPackagesInDependencyOrder()` in
`packages/dev-tools/src/workspace-graph.ts`: every `private: false` package, ordered by its runtime
`workspace:` edges — dependencies first, the umbrella `vibe-agent-toolkit` package last. There is no
hand list; make a package `private: true` to hold it back from publishing.

The publish workflow asserts that the pushed tag equals the root `package.json` version before it
builds anything, then runs `bun run pre-publish -- --release-readiness --tag <version>` (in CI the
remote tag must exist and name the manifest version; locally, without `--tag`, it must be absent).

### Changelog fragments

Changes may land as fragments under `.changes/` instead of editing `CHANGELOG.md` directly — see
[`.changes/README.md`](../.changes/README.md) for the shape. A **stable** `bun run bump-version` folds
every fragment into the new version heading and deletes it; RC bumps leave fragments in place.

## Rollback Safety

Publishing uses rollback protection:
- Tracks progress in `.publish-manifest.json`
- On failure: attempts `npm unpublish --force`
- Fallback: `npm deprecate` with warning message
- Use RC testing to minimize stable release failures

## Building

```bash
# Build all packages
bun run build

# Clean build
bun run build:clean
```

## Licensing Conventions

Use the license field that matches the package's intended distribution:

| Package type | `"license"` value | Also set | Files to add |
|---|---|---|---|
| Open source (MIT, Apache, etc.) | `"MIT"` | — | `LICENSE` |
| Proprietary / enterprise internal | `"SEE LICENSE IN LICENSE"` | `"private": true` | `LICENSE` |
| Not yet licensed | `"UNLICENSED"` | `"private": true` | — |

`"UNLICENSED"` signals "the author forgot to add a license" to npm tooling — do not use it for an
intentionally proprietary package.

Standard enterprise proprietary `LICENSE` template (for `private: true` packages owned by an
organization):

```
Copyright (c) [YEAR] [Organization Name]. All rights reserved.

This software is proprietary to [Organization Name] and is made available
solely for use by authorized personnel and contractors under applicable
confidentiality obligations. Redistribution, modification, or use outside
this scope requires written consent from [Organization Name].
```

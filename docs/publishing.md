# Publishing & Version Management

## Unified Versioning

**CRITICAL**: All packages in this monorepo share the same version. When any package changes, all packages are bumped together. This ensures compatibility and simplifies dependency management.

Current packages (19 published, 1 private):
- @vibe-agent-toolkit/agent-schema
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

1. **Update CHANGELOG.md** (if needed)
   - **RC releases**: Ensure changes are documented in `[Unreleased]` section
   - **Stable releases**: Move `[Unreleased]` → `## [X.Y.Z] - YYYY-MM-DD`

2. **Bump version**:
   ```bash
   bun run bump-version 0.1.0-rc.1  # For RC
   bun run bump-version 0.1.0       # For stable
   ```

3. **Build and verify**:
   ```bash
   bun run build
   bun run validate-version
   ```

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

**Dev Mode** (in this repo):
- Uses: `packages/cli/dist/bin.js`
- Shows version: `0.1.0-rc.1-dev`

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

Packages are published in dependency order:

1. agent-schema, utils (parallel - no deps)
2. discovery, resources (parallel - depend on utils)
3. rag (depends on resources, utils)
4. rag-lancedb, agent-config (parallel)
5. agent-runtime (depends on utils)
6. runtime-claude-agent-sdk, agent-skills, runtime-langchain, runtime-openai, runtime-vercel-ai-sdk (parallel - runtime adapters)
7. transports (depends on agent-runtime)
8. cli
9. gateway-mcp (depends on agent-schema, utils, vat-example-cat-agents)
10. vat-development-agents
11. vat-example-cat-agents
12. vibe-agent-toolkit (umbrella - published last)

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

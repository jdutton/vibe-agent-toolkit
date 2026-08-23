# Cat Agents Skill Distribution Guide

This document outlines different ways to distribute and install the cat agents skill for use with Claude Code.

## Quick Summary

| Method | Best For | Complexity | Installation Time |
|--------|----------|------------|------------------|
| **Dev Mode** | Local development, testing | Low | Instant |
| **ZIP Download** | Quick trials, air-gapped systems | Low | < 1 minute |
| **npm Package** | Project dependencies, version control | Medium | < 30 seconds |
| **GitHub Release** | Open source distribution, CI/CD | Medium | < 1 minute |
| **Claude Marketplace** | End users, discovery | High | < 10 seconds |

## 1. Dev Mode (Recommended for Development)

**What it is:** Use the skill directly from the source repository without installation.

**How it works:**
- Claude Code reads skills from multiple locations
- Add your workspace path to Claude's skill search paths
- Changes appear immediately (no rebuild/reinstall needed)

**Setup:**

```bash
# Option A: Symlink into Claude's plugins directory
ln -s \
  /Users/jeff/Workspaces/vat2/packages/vat-example-cat-agents/resources/skills \
  ~/.claude/plugins/cat-agents-skill

# Option B: Add workspace to Claude's skill paths (config.json)
{
  "skillPaths": [
    "~/.claude/plugins",
    "/Users/jeff/Workspaces/vat2/packages/vat-example-cat-agents/resources/skills"
  ]
}
```

**Usage:**
```
# In Claude Code session
/cat-agents  # Triggers the skill immediately
```

**Pros:**
- ✅ Instant feedback during development
- ✅ No build/package step needed
- ✅ Edit files and test immediately
- ✅ Easy debugging with full source access

**Cons:**
- ❌ Requires local repository clone
- ❌ Not portable to other machines
- ❌ No version isolation

**Best for:** Developers working on the skill, contributors testing changes

---

## 2. ZIP Distribution (Simplest for Users)

**What it is:** Single compressed file containing the skill and all resources.

**How it works:**
- Package script bundles SKILL.md + all linked resources
- Creates a 35KB ZIP file
- User downloads, extracts, and places in Claude's plugins directory

**Create ZIP:**

```bash
# From workspace root
bun run test-package-cat-skill.ts

# Output: packages/vat-example-cat-agents/dist/skills/Cat Agents Skill.zip
```

**Install ZIP:**

```bash
# Download the ZIP file
curl -L -o cat-agents-skill.zip \
  https://github.com/jdutton/vibe-agent-toolkit/releases/download/v0.1.0/cat-agents-skill.zip

# Extract to Claude's plugins directory
unzip cat-agents-skill.zip -d ~/.claude/plugins/
```

**Directory structure after extraction:**
```
~/.claude/plugins/Cat Agents Skill/
├── SKILL.md                        # Main skill file (22KB)
├── agents/                         # Agent resources (36KB total)
│   ├── breed-advisor.md
│   ├── description-parser.md
│   ├── haiku-generator.md
│   ├── human-approval.md
│   ├── name-generator.md
│   └── photo-analyzer.md
└── skills/                         # Related skill docs (32KB total)
    ├── SKILL.md
    └── cat-breed-selection.md
```

**Pros:**
- ✅ Single file download
- ✅ No dependencies or build tools needed
- ✅ Works on all platforms (Windows, macOS, Linux)
- ✅ Small file size (~35KB)
- ✅ Can be distributed via email, USB, etc.

**Cons:**
- ❌ Manual installation process
- ❌ No automatic updates
- ❌ Version management is manual

**Best for:** End users trying the skill, offline/air-gapped environments

---

## 3. npm Package Distribution

**What it is:** Standard npm package that can be installed like any other dependency.

**How it works:**
- Publish skill to npm registry
- Users install via `npm install` or `bun install`
- Claude Code discovers skills in node_modules
- Version management through package.json

**Package the skill:**

```typescript
// Future: Add to skill-packager.ts
await packageSkill(skillPath, {
  formats: ['npm'],
  outputPath: './dist',
});
```

**Publish to npm:**

```bash
# Build and publish (future workflow)
cd packages/vat-example-cat-agents
bun run build:skill
npm publish ./dist/cat-agents-skill.tgz
```

**Install from npm:**

```bash
# Global installation
npm install -g @vibe-agent-toolkit/vat-example-cat-agents

# Project-local installation
npm install @vibe-agent-toolkit/vat-example-cat-agents
```

**package.json structure:**

```json
{
  "name": "@vibe-agent-toolkit/vat-example-cat-agents",
  "version": "0.1.0",
  "description": "Cat agents orchestration skill for Claude Code",
  "main": "SKILL.md",
  "files": [
    "SKILL.md",
    "agents/**/*.md",
    "skills/**/*.md"
  ],
  "keywords": [
    "agent-skill",
    "vat",
    "agents",
    "cat-breeding"
  ],
  "claudeSkill": {
    "entry": "SKILL.md",
    "version": "1.0.0"
  }
}
```

**Pros:**
- ✅ Familiar installation workflow for developers
- ✅ Automatic version management
- ✅ Dependency resolution
- ✅ Easy to update (`npm update`)
- ✅ Can include skill in project dependencies

**Cons:**
- ❌ Requires npm/bun installed
- ❌ Adds to node_modules size
- ❌ May require registry access

**Best for:** Developers integrating skills into projects, CI/CD pipelines

---

## 4. GitHub Releases (Open Source Distribution)

**What it is:** Attach skill ZIP to GitHub releases for download.

**How it works:**
- Tag version in git
- CI/CD workflow packages skill automatically
- ZIP attached to GitHub release
- Users download from releases page

**Create release:**

```bash
# Tag the version
git tag -a cat-skill-v0.1.0 -m "Release cat agents skill v0.1.0"
git push origin cat-skill-v0.1.0

# CI workflow automatically:
# 1. Checks out code
# 2. Packages skill: bun run package:cat-skill
# 3. Creates GitHub release
# 4. Attaches ZIP artifact
```

**GitHub Actions workflow example:**

```yaml
# .github/workflows/release-skill.yml
name: Release Cat Agents Skill

on:
  push:
    tags:
      - 'cat-skill-v*'

jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Setup Bun
        uses: oven-sh/setup-bun@v1

      - name: Install dependencies
        run: bun install

      - name: Build and package skill
        run: bun run package:cat-skill

      - name: Create GitHub Release
        uses: softprops/action-gh-release@v1
        with:
          files: packages/vat-example-cat-agents/dist/skills/*.zip
          body: |
            Cat Agents Skill ${{ github.ref_name }}

            Download and extract to ~/.claude/plugins/
```

**Download from release:**

```bash
# Latest release
curl -L -o cat-agents-skill.zip \
  https://github.com/jdutton/vibe-agent-toolkit/releases/latest/download/cat-agents-skill.zip

# Specific version
curl -L -o cat-agents-skill.zip \
  https://github.com/jdutton/vibe-agent-toolkit/releases/download/cat-skill-v0.1.0/cat-agents-skill.zip
```

**Pros:**
- ✅ Automated release process
- ✅ Version tracking with git tags
- ✅ Release notes and changelog
- ✅ Downloadable from web UI
- ✅ Integrates with existing GitHub workflow

**Cons:**
- ❌ Requires GitHub account for downloads (public repos exempt)
- ❌ Manual extraction still needed
- ❌ GitHub-specific (not platform-agnostic)

**Best for:** Open source projects, versioned releases, community distribution

---

## 5. Claude Marketplace (Future)

**What it is:** Centralized marketplace for discovering and installing Claude skills.

**How it works:**
- Submit skill to marketplace registry
- Users browse/search marketplace
- One-click install from Claude Code or claude.ai
- Automatic updates when new versions released

**Marketplace manifest:**

```json
{
  "name": "cat-agents-skill",
  "displayName": "Cat Agents Orchestration",
  "version": "0.1.0",
  "description": "Comprehensive orchestration for cat breeding agents",
  "author": "Vibe Agent Toolkit",
  "license": "MIT",
  "entry": "SKILL.md",
  "category": "agent-orchestration",
  "tags": ["agents", "orchestration", "cat-breeding", "example"],
  "minClaudeVersion": "1.0.0",
  "resources": {
    "agents": [
      "agents/breed-advisor.md",
      "agents/photo-analyzer.md",
      "agents/name-generator.md",
      "agents/haiku-generator.md",
      "agents/description-parser.md",
      "agents/human-approval.md"
    ],
    "docs": [
      "skills/cat-breed-selection.md"
    ]
  },
  "repository": "https://github.com/jdutton/vibe-agent-toolkit",
  "homepage": "https://github.com/jdutton/vibe-agent-toolkit/tree/main/packages/vat-example-cat-agents"
}
```

**Publish to marketplace:**

```bash
# Future: Marketplace CLI
claude-marketplace publish \
  --skill-path ./dist/skills/Cat\ Agents\ Skill \
  --manifest marketplace.json \
  --api-key $MARKETPLACE_API_KEY
```

**Install from marketplace:**

```bash
# CLI installation
claude-marketplace install cat-agents-skill

# Or via Claude Code UI
# /marketplace search cat agents
# /marketplace install cat-agents-skill
```

**Pros:**
- ✅ Centralized discovery
- ✅ One-click installation
- ✅ Automatic updates
- ✅ Ratings and reviews
- ✅ Security scanning
- ✅ Best user experience

**Cons:**
- ❌ Requires marketplace infrastructure (doesn't exist yet)
- ❌ Submission/approval process
- ❌ Platform lock-in

**Best for:** End users who want the easiest installation, skill discovery

**Status:** 🔮 Future feature - marketplace infrastructure needed

---

## 6. Direct File Copy (Internal/Private Distribution)

**What it is:** Copy skill files directly to Claude's plugins directory.

**How it works:**
- Manually copy SKILL.md and resources to destination
- Useful for internal/private skills
- No packaging or distribution infrastructure needed

**Manual installation:**

```bash
# Create destination directory
mkdir -p ~/.claude/plugins/cat-agents-skill

# Copy skill files
cp -r packages/vat-example-cat-agents/resources/skills/* \
     ~/.claude/plugins/cat-agents-skill/

# Copy agent resources
cp -r packages/vat-example-cat-agents/resources/agents \
     ~/.claude/plugins/cat-agents-skill/
```

**Script for batch installation:**

```bash
#!/bin/bash
# install-cat-skill.sh

SKILL_SOURCE="$1"
CLAUDE_HOME="${CLAUDE_HOME:-$HOME/.claude}"
PLUGIN_DIR="$CLAUDE_HOME/plugins/cat-agents-skill"

if [ ! -d "$SKILL_SOURCE" ]; then
  echo "Error: Source directory not found: $SKILL_SOURCE"
  exit 1
fi

echo "Installing cat agents skill..."
mkdir -p "$PLUGIN_DIR"
cp -r "$SKILL_SOURCE"/* "$PLUGIN_DIR/"
echo "✅ Installed to $PLUGIN_DIR"
```

**Pros:**
- ✅ No tooling required (just filesystem operations)
- ✅ Works in restricted environments
- ✅ Full control over installation location
- ✅ Can customize before installation

**Cons:**
- ❌ Most manual process
- ❌ Error-prone (wrong paths, missing files)
- ❌ No version tracking
- ❌ Difficult to update

**Best for:** Internal tools, custom deployments, testing

---

## Comparison Matrix

| Feature | Dev Mode | ZIP | npm | GitHub | Marketplace |
|---------|----------|-----|-----|--------|-------------|
| Installation Time | Instant | 1 min | 30 sec | 1 min | 10 sec |
| Requires Build Tools | No | No | Yes | No | No |
| Version Management | Manual | Manual | Auto | Tagged | Auto |
| Automatic Updates | No | No | Yes | No | Yes |
| Offline Support | Yes | Yes | Cached | No | No |
| Discovery | None | External | Registry | GitHub | Built-in |
| User Experience | Dev-only | Good | Good | Good | Excellent |
| Setup Complexity | Low | Low | Medium | Medium | Low |

---

## Recommended Distribution Strategy

### For Development
1. **Use Dev Mode** - symlink or skill path configuration
2. Edit files directly, test immediately
3. No packaging overhead

### For Beta Testing
1. **Create ZIP** - package with `bun run test-package-cat-skill.ts`
2. Share via email, Slack, or file share
3. Testers extract to `~/.claude/plugins/`

### For Public Release
1. **GitHub Release** (primary) - automated with CI/CD
2. **npm Package** (secondary) - for developers integrating into projects
3. Include installation instructions in README

### For Future (When Available)
1. **Claude Marketplace** - best end-user experience
2. ZIP/npm as fallback options

---

## Installation Instructions Template

Use this template in your README for user-facing documentation:

```markdown
## Installation

### Option 1: Download ZIP (Recommended)

1. Download the latest release:
   ```bash
   curl -L -o cat-agents-skill.zip \
     https://github.com/jdutton/vibe-agent-toolkit/releases/latest/download/cat-agents-skill.zip
   ```

2. Extract to Claude's plugins directory:
   ```bash
   unzip cat-agents-skill.zip -d ~/.claude/plugins/
   ```

3. Restart Claude Code or reload plugins:
   ```
   /reload-plugins
   ```

### Option 2: Install from npm

```bash
npm install -g @vibe-agent-toolkit/vat-example-cat-agents
```

### Option 3: Dev Mode (For Contributors)

```bash
git clone https://github.com/jdutton/vibe-agent-toolkit.git
cd vibe-agent-toolkit
ln -s "$(pwd)/packages/vat-example-cat-agents/resources/skills" \
      ~/.claude/plugins/cat-agents-skill
```

## Usage

Once installed, trigger the skill in Claude Code:

```
/cat-agents
```

Or invoke specific workflows:

```
"I need help selecting a cat breed"
"Analyze this cat photo for me"
"Generate a name for an orange tabby cat"
```
```

---

## Next Steps

1. **Test ZIP distribution** - verify extraction and installation on clean system
2. **Create npm package** - implement npm format in skill-packager
3. **Set up GitHub Actions** - automate release workflow
4. **Write installation guide** - user-friendly documentation
5. **Design marketplace manifest** - prepare for future marketplace

---

## Technical Notes

### File Size Considerations

Current packaged size: **35KB total**
- SKILL.md: 22KB
- Agent resources: 36KB
- Related docs: 32KB

Compression ratio: ~60% (ZIP is very efficient for text)

### Link Rewriting

The packaging process rewrites all relative links to maintain correctness after relocation:

**Before (in source):**
```markdown
See [breed advisor](../agents/breed-advisor.md) for details.
```

**After (in package):**
```markdown
See [breed advisor](agents/breed-advisor.md) for details.
```

This ensures all internal links work regardless of installation location.

### Version Management

Future enhancement: Add version metadata to SKILL.md frontmatter:

```yaml
---
name: cat-agents-skill
version: 0.1.0
min_claude_version: 1.0.0
---
```

Claude Code can then check compatibility and notify users of updates.

---

## Questions?

- **Packaging issues?** See packages/agent-skills/src/skill-packager.ts
- **Distribution questions?** Open an issue on GitHub
- **Want to contribute?** See CONTRIBUTING.md

## Related Documentation

- [Skill Packaging Implementation](../../agent-skills/src/skill-packager.ts)
- [Package README](../README.md)
- [Architecture Documentation](../CLAUDE.md)

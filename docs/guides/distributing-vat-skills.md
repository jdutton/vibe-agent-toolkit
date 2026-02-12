# Distributing VAT Skills

**Guide for package authors creating distributable VAT skills, agents, and tools.**

## Overview

The VAT Distribution Standard enables you to package and distribute:
- **Agent Skills** - SKILL.md files for Claude Code
- **VAT Agents** - agent.yaml based agents
- **Pure Functions** - Reusable tools exposed via MCP/CLI
- **Runtime Adapters** - Multi-platform runtime support

This guide shows you how to create distributable VAT packages that users can install with a single command.

## Quick Start

**1. Add VAT metadata to package.json:**

```json
{
  "name": "your-package",
  "version": "1.0.0",
  "vat": {
    "version": "1.0",
    "type": "agent-bundle",
    "skills": [
      {
        "name": "my-skill",
        "source": "./resources/skills/SKILL.md",
        "path": "./dist/skills/my-skill"
      }
    ]
  }
}
```

**2. Add build script:**

```json
{
  "scripts": {
    "build": "tsc && vat skills build"
  }
}
```

**3. Users install your skill:**

```bash
vat skills install npm:your-package
```

That's it! Your skill is now distributable.

## Package.json VAT Metadata

### The `vat` Field

All VAT metadata lives in the `vat` field of package.json. This is the single source of truth for what your package distributes.

**Complete example:**

```json
{
  "name": "@your-org/your-package",
  "version": "1.0.0",
  "vat": {
    "version": "1.0",
    "type": "agent-bundle",

    "skills": [
      {
        "name": "my-skill",
        "source": "./resources/skills/SKILL.md",
        "path": "./dist/skills/my-skill"
      }
    ],

    "agents": [
      {
        "name": "my-agent",
        "path": "./agents/my-agent",
        "type": "llm-analyzer"
      }
    ],

    "pureFunctions": [
      {
        "name": "my-validator",
        "path": "./dist/pure-functions/my-validator",
        "exports": {
          "mcp": "./dist/mcp-servers/my-validator.js",
          "cli": "your-package validate"
        }
      }
    ],

    "runtimes": [
      "vercel-ai-sdk",
      "langchain",
      "openai",
      "claude-agent-sdk"
    ]
  }
}
```

### Field Reference

#### `vat.version` (required)
- **Type:** string
- **Current:** "1.0"
- **Purpose:** VAT metadata schema version for future compatibility

#### `vat.type` (required)
- **Type:** string
- **Values:** `agent-bundle`, `skill`, `runtime`, `toolkit`
- **Purpose:** Identifies the package type

#### `vat.skills[]` (optional)
- **Purpose:** Declares Agent Skills for distribution
- **Fields:**
  - `name` - Skill name (installation directory name)
  - `source` - Source SKILL.md path (for rebuilding)
  - `path` - Built skill directory (relative to package root)

#### `vat.agents[]` (optional)
- **Purpose:** Declares VAT agents (agent.yaml based)
- **Fields:**
  - `name` - Agent name
  - `path` - Agent directory path
  - `type` - Archetype (optional, for documentation)

#### `vat.pureFunctions[]` (optional)
- **Purpose:** Declares pure function tools
- **Fields:**
  - `name` - Function name
  - `path` - Implementation path
  - `exports.mcp` - MCP server export path
  - `exports.cli` - CLI invocation pattern

#### `vat.runtimes[]` (optional)
- **Type:** string[]
- **Purpose:** Lists runtime adapters provided
- **Examples:** `["vercel-ai-sdk", "langchain", "openai", "claude-agent-sdk"]`

## Building Skills

### Directory Structure

**Recommended layout:**

```
your-package/
├── resources/
│   └── skills/
│       └── SKILL.md              # Source skill file
├── dist/
│   └── skills/
│       └── my-skill/             # Built skill (created by vat skills build)
│           ├── SKILL.md          # Processed skill file
│           ├── docs/             # Linked documentation
│           └── agents/           # Linked agent resources
├── agents/                       # Agent implementations
├── docs/                         # Documentation
└── package.json                  # VAT metadata
```

### Build Command

The `vat skills build` command:
1. Reads `vat.skills` from package.json
2. For each skill:
   - Validates source exists at `skill.source`
   - Collects all linked markdown files
   - Rewrites relative links for new location
   - Copies everything to `skill.path`

**Add to build script:**

```json
{
  "scripts": {
    "build": "tsc && vat skills build",
    "build:code": "tsc"
  }
}
```

**Run manually:**

```bash
# Build all skills
vat skills build

# Build specific skill
vat skills build --skill my-skill

# Preview without building
vat skills build --dry-run
```

### What Gets Packaged

The build process automatically includes:
- SKILL.md file (main skill)
- All markdown files linked from SKILL.md
- Recursively followed links (entire documentation tree)
- Relative links rewritten for new locations

**You don't need to manually list files** - the builder follows links automatically.

### Packaging Options

Skills with large linked documentation trees can control what gets bundled using `packagingOptions` in the skill metadata.

#### `linkFollowDepth`

Controls how deep the builder follows markdown links from SKILL.md:

| Value | Behavior |
|-------|----------|
| `0` | Skill file only (no links followed) |
| `1` | Direct links only |
| `2` | Direct + one transitive level **(default)** |
| `N` | N levels of transitive links |
| `"full"` | Complete transitive closure (use with caution) |

Non-markdown assets (images, JSON schemas) linked from bundled files are always bundled regardless of depth.

```json
{
  "vat": {
    "skills": [{
      "name": "my-skill",
      "source": "./SKILL.md",
      "path": "./dist/skills/my-skill",
      "packagingOptions": {
        "linkFollowDepth": 1
      }
    }]
  }
}
```

#### `excludeReferencesFromBundle`

Controls which files are excluded by glob pattern and how their links are rewritten. Non-bundled links are replaced with rendered Handlebars templates so there are no dead links in the output.

**Rules** are evaluated in order (first match wins). Each rule has glob patterns and an optional template:

```json
{
  "packagingOptions": {
    "linkFollowDepth": 1,
    "excludeReferencesFromBundle": {
      "rules": [
        {
          "patterns": ["**/concepts/**", "**/patterns/**"],
          "template": "Use mcp__search to find: {{link.text}}"
        },
        {
          "patterns": ["**/overview.md", "**/README.md"],
          "template": "{{link.text}}"
        }
      ],
      "defaultTemplate": "{{link.text}} (search knowledge base for details)"
    }
  }
}
```

**Template variables** available in all templates:

| Variable | Description | Example |
|----------|-------------|---------|
| `{{link.text}}` | Link display text from markdown | `"Setup Guide"` |
| `{{link.uri}}` | Original href from markdown | `"./docs/setup.md"` |
| `{{link.fileName}}` | Target filename only | `"setup.md"` |
| `{{link.filePath}}` | Path relative to skill root | `"docs/setup.md"` |
| `{{skill.name}}` | Skill name from frontmatter | `"my-skill"` |

**`defaultTemplate`** applies to non-bundled links that don't match any rule (e.g., depth-exceeded links). Default: `"{{link.text}}"` (strips the link, keeps the text).

**When no rules are configured**, depth-exceeded links are stripped to plain text using the default template.

### Files Array

Include built skills in npm package:

```json
{
  "files": [
    "dist"
  ]
}
```

**Don't include zips** - skills are distributed as directories for symlink support.

## Installation

### User Installation

Users install your skills with:

```bash
# From npm
vat skills install npm:your-package

# From local directory (development)
vat skills install ./path/to/your-package

# From zip file
vat skills install ./your-skill.zip
```

### Installation Locations

Skills install to:
- **User-level:** `~/.claude/plugins/<skill-name>`
- **Project-level:** `.claude/skills/<skill-name>` (future)

## Optional: Auto-Install on Global Install

You can optionally auto-install skills when users run `npm install -g your-package`.

**Add to package.json:**

```json
{
  "scripts": {
    "postinstall": "vat skills install --npm-postinstall || true"
  }
}
```

**Behavior:**
- Only runs for global installs (`npm_config_global === 'true'`)
- Skips local/dev installs (non-invasive)
- Fails gracefully if VAT CLI not installed
- Reads `vat.skills` from package.json

**Recommendation:** Start without auto-install. Add later if users request it.

## Publishing Workflow

### 1. Prepare Package

```bash
# Build skills
bun run build

# Verify skills built correctly
ls -la dist/skills/
```

### 2. Test Locally

```bash
# Dev-install: symlinks skills from package.json (rebuilds reflected instantly)
vat skills install --dev

# Or build + dev-install in one step:
vat skills install --build

# Verify
vat skills list --user
```

> **Why symlinks?** After `vat skills build`, the built output in `dist/skills/` has rewritten links.
> A symlink means rebuilds are immediately visible to Claude Code after `/reload-skills`.

### 3. Publish to npm

```bash
npm publish
```

### 4. Users Install

```bash
npm install -g your-package  # Optional: install CLI
vat skills install npm:your-package
```

## Examples

### Example 1: Simple Skill Package

**Package with single skill:**

```json
{
  "name": "my-cat-naming-skill",
  "version": "1.0.0",
  "vat": {
    "version": "1.0",
    "type": "skill",
    "skills": [
      {
        "name": "cat-naming",
        "source": "./SKILL.md",
        "path": "./dist/skills/cat-naming"
      }
    ]
  },
  "scripts": {
    "build": "vat skills build"
  },
  "files": ["dist"]
}
```

### Example 2: Multi-Skill Bundle

**Package with multiple skills:**

```json
{
  "name": "@your-org/agent-suite",
  "version": "1.0.0",
  "vat": {
    "version": "1.0",
    "type": "agent-bundle",
    "skills": [
      {
        "name": "orchestration-guide",
        "source": "./resources/skills/orchestration.md",
        "path": "./dist/skills/orchestration-guide"
      },
      {
        "name": "best-practices",
        "source": "./resources/skills/best-practices.md",
        "path": "./dist/skills/best-practices"
      }
    ]
  },
  "scripts": {
    "build": "tsc && vat skills build"
  },
  "files": ["dist"]
}
```

### Example 3: Skills + Agents

**Package with skills and agent implementations:**

```json
{
  "name": "@your-org/validation-agents",
  "version": "1.0.0",
  "vat": {
    "version": "1.0",
    "type": "agent-bundle",
    "skills": [
      {
        "name": "validation-guide",
        "source": "./resources/skills/SKILL.md",
        "path": "./dist/skills/validation-guide"
      }
    ],
    "agents": [
      {
        "name": "schema-validator",
        "path": "./agents/schema-validator",
        "type": "pure-function"
      },
      {
        "name": "data-analyzer",
        "path": "./agents/data-analyzer",
        "type": "llm-analyzer"
      }
    ]
  },
  "scripts": {
    "build": "tsc && vat skills build"
  },
  "files": ["dist", "agents"]
}
```

## Real-World Examples

### vat-example-cat-agents

**Location:** `packages/vat-example-cat-agents/`

**What it distributes:**
- `vat-cat-agents` skill - Orchestration guide for 8 example agents
- 8 agent implementations (photo analyzer, name generator, etc.)
- Multi-modal patterns and feedback loops

**package.json:**
```json
{
  "vat": {
    "version": "1.0",
    "type": "agent-bundle",
    "skills": [
      {
        "name": "vat-cat-agents",
        "source": "./resources/skills/SKILL.md",
        "path": "./dist/skills/vat-cat-agents"
      }
    ]
  },
  "scripts": {
    "build": "tsc && vat skills build"
  }
}
```

**Installation:**
```bash
vat skills install npm:@vibe-agent-toolkit/vat-example-cat-agents
```

### vat-development-agents

**Location:** `packages/vat-development-agents/`

**What it distributes:**
- `vibe-agent-toolkit` skill - User guide for VAT adoption
- agent-generator agent - Meta-agent for creating new agents
- resource-optimizer agent - Tool for optimizing agent resources

**package.json:**
```json
{
  "vat": {
    "version": "1.0",
    "type": "agent-bundle",
    "skills": [
      {
        "name": "vibe-agent-toolkit",
        "source": "./resources/skills/SKILL.md",
        "path": "./dist/skills/vibe-agent-toolkit"
      }
    ],
    "agents": [
      {
        "name": "agent-generator",
        "path": "./agents/agent-generator",
        "type": "meta-agent"
      }
    ]
  },
  "scripts": {
    "build": "tsc && vat skills build"
  }
}
```

**Installation:**
```bash
vat skills install npm:@vibe-agent-toolkit/vat-development-agents
```

## Troubleshooting

### Skills Not Appearing in Claude Code

**Solution:** Restart Claude Code or run `/reload-skills` command.

### Build Fails with "Source not found"

**Check:**
1. `vat.skills[].source` path is correct
2. Source file exists at specified path
3. Path is relative to package root

### Install Fails with "No skills found"

**Check:**
1. `vat` field exists in package.json
2. `vat.skills` array is defined
3. `vat.skills[].path` points to built directory
4. Package was built before installation

### Links Broken After Build

**Verify:**
1. Links in source SKILL.md use relative paths
2. Linked files exist in source tree
3. Run `vat skills build` to rebuild with correct links

### npm Publish Includes Wrong Files

**Update files array:**
```json
{
  "files": [
    "dist",
    "agents",
    "docs"
  ]
}
```

**Verify with:**
```bash
npm pack --dry-run
```

## Best Practices

### 1. Keep Source and Build Separate

**Recommended:**
```
resources/skills/SKILL.md  → dist/skills/my-skill/SKILL.md
```

**Why:** Separates source (for editing) from build artifacts (for distribution).

### 2. Use Relative Links

**In SKILL.md:**
```markdown
See [agent documentation](../../agents/my-agent/README.md)
```

**Why:** Build process rewrites these automatically for new locations.

### 3. Include Source for Rebuilding

**In files array:**
```json
{
  "files": [
    "dist",
    "resources/skills"
  ]
}
```

**Why:** Enables users to rebuild skills if needed.

### 4. Test Installation Locally

**Before publishing:**
```bash
vat skills install ./path/to/package
vat skills list --installed
```

**Why:** Catches packaging issues before publishing to npm.

### 5. Document Installation in README

**Include in package README:**
```markdown
## Installing the Skill

vat skills install npm:your-package
```

**Why:** Users need to know how to install your skill.

## Advanced Topics

### Multi-Architecture Distribution

**Not yet implemented** - future enhancement for:
- Pure functions exposed via MCP servers
- CLI commands for tools
- Runtime adapter distribution

**Tracked in:** `vat.pureFunctions[]` and `vat.runtimes[]`

### Project-Level Installation

**Not yet implemented** - future `--project` flag:
```bash
vat skills install npm:your-package --project
```

**Would install to:** `.claude/skills/<skill-name>`

### Uninstall

Remove installed skills (directories or symlinks):

```bash
# Remove a single skill
vat skills uninstall my-skill

# Remove all skills declared in package.json
vat skills uninstall --all

# Preview removal without deleting
vat skills uninstall --all --dry-run
```

### Update

To update a skill, rebuild and reinstall:

```bash
# For dev installs (symlinks): just rebuild
vat skills build
# Then /reload-skills in Claude Code

# For copied installs: rebuild and reinstall
vat skills build
vat skills install ./dist/skills/my-skill --force
```

## Development Workflow

During development, use symlink-based installation for fast iteration:

```bash
# 1. Build skills
vat skills build

# 2. Dev-install (creates symlinks to built output)
vat skills install --dev

# 3. After changes, rebuild (symlinks reflect updates immediately)
vat skills build
# Then /reload-skills in Claude Code

# 4. Clean up when done
vat skills uninstall --all
```

**Shortcut:** Combine build + install:
```bash
vat skills install --build        # Build then symlink all skills
vat skills install --build --name my-skill  # Build then symlink one skill
```

### Post-npm-install Reinstallation

If your project has its own CLI, you can re-run skill installation after `npm install`:

```bash
# In your project's CLI or package.json scripts:
vat skills install --dev --force

# Or from your project's postinstall script (only for global installs):
"postinstall": "vat skills install --npm-postinstall || exit 0"
```

The `--npm-postinstall` flag only activates during `npm install -g` (not `npm link` or local installs).
For local development, use `--dev` mode instead.

## References

- [vat-example-cat-agents](../../packages/vat-example-cat-agents/README.md) - Example implementation
- [vat-development-agents](../../packages/vat-development-agents/README.md) - Example implementation
- [Claude Code Skills Docs](https://code.claude.com/docs/en/skills) - Agent Skills format

## Getting Help

**Issues:**
- GitHub: [vibe-agent-toolkit/issues](https://github.com/jdutton/vibe-agent-toolkit/issues)

**Questions:**
- Discussions: [vibe-agent-toolkit/discussions](https://github.com/jdutton/vibe-agent-toolkit/discussions)

---

**Last Updated:** 2026-02-06

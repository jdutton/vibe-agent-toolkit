---
name: vibe-agent-toolkit:distribution
description: Use when packaging, publishing, or sideloading VAT skills. Covers vat skills package (including --target claude-web), vat install for sideloading, npm publishing, and private distribution patterns.
---

# VAT Distribution: Packaging & Sideloading

## Packaging a Skill

```bash
# Standard build (Claude Code skills dir format)
vat skills package ./SKILL.md -o ./dist/skills/

# Claude.ai web upload format (scripts/, references/, assets/)
vat skills package ./SKILL.md -o ./dist/ --target claude-web

# Dry run to preview what gets packaged
vat skills package ./SKILL.md -o ./dist/ --dry-run
```

## --target claude-web

Produces a ZIP compatible with `claude.ai/settings/capabilities` upload.

Directory structure:
```
my-skill.zip
└── my-skill/
    ├── SKILL.md             # skill definition (required)
    ├── scripts/             # executable code (.mjs, .py, .sh) — optional
    ├── references/          # markdown reference material — optional
    └── assets/              # static data, templates, config — optional
```

Configure which source paths map to each directory in `package.json`:

```json
{
  "vat": {
    "skills": [{
      "name": "my-skill",
      "packagingOptions": {
        "claudeWebTarget": {
          "scripts": ["./src/helpers/**/*.ts"],
          "assets": ["./assets/**"]
        }
      }
    }]
  }
}
```

TypeScript files in `scripts` are tree-shaken and compiled to standalone `.mjs` —
no build toolchain required at install time.

## Sideloading (Private Distribution)

When your project isn't on a public marketplace, use `vat install` to sideload:

```bash
# Sideload an agent skill
vat install ./my-skill-dir/              # → ~/.claude/skills/

# Sideload an entire Claude plugin
vat install ./my-plugin/                 # → ~/.claude/plugins/

# Force overwrite existing installation
vat install ./my-skill-dir/ --force
```

Type is auto-detected from directory structure:
- Has `SKILL.md` at root → `agent-skill`
- Has `.claude-plugin/plugin.json` → `claude-plugin`
- Has `.claude-plugin/marketplace.json` → `claude-marketplace`
- Use `--type <type>` to override detection

## npm Distribution

Add to `package.json`:

```json
{
  "name": "@myorg/my-skills",
  "version": "1.0.0",
  "private": false,
  "license": "MIT",
  "vat": {
    "skills": [...]
  },
  "scripts": {
    "postinstall": "vat skills install --npm-postinstall"
  }
}
```

When users run `npm install -g @myorg/my-skills`, the postinstall hook automatically
copies skills to `~/.claude/skills/`. No manual steps.

## Private Enterprise Distribution

For private repos (not published to npm):

1. Tag a release on GitHub/internal Git
2. Attach the skill ZIP as a release asset
3. Users download and sideload:
   ```bash
   vat install ./downloaded-skill.zip
   ```

Or use a private npm registry (GitHub Packages, Artifactory):
```bash
npm install -g @myorg/my-skills  # pulls from private registry, postinstall triggers
```

## Dev Mode (Symlinks)

During active development, use symlinks so rebuilds are instant:

```bash
vat skills install --dev          # symlinks dist/ → ~/.claude/skills/
vat skills install --build        # builds first, then symlinks
```

After each rebuild: `/reload-skills` in Claude Code.

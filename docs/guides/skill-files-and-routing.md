# Skill Files and Content-Type Routing

This guide covers two related features for skill packaging:

1. **Content-type routing** — auto-discovered files land in the right subdirectory based on file type
2. **`files` config** — declare build artifacts, unlinked files, or routing overrides

## Content-Type Routing

When VAT packages a skill, files linked from SKILL.md are auto-discovered and copied into the output. Previously, all non-markdown files went to `resources/`. Now they're routed by extension:

| File Type | Extensions | Output Subdirectory |
|-----------|-----------|-------------------|
| Markdown | `.md` | `resources/` |
| Scripts | `.mjs`, `.cjs`, `.js`, `.ts`, `.sh`, `.bash`, `.zsh`, `.ps1`, `.py`, `.rb`, `.pl` | `scripts/` |
| Templates | `.json`, `.yaml`, `.yml`, `.toml`, `.xml`, `.ini`, `.cfg`, `.conf`, `.hbs`, `.mustache`, `.ejs`, `.njk`, `.tmpl`, `.tpl`, `*.example` | `templates/` |
| Assets | `.png`, `.jpg`, `.svg`, `.gif`, `.webp`, `.ico`, `.bmp`, `.tiff`, `.avif`, `.webm`, `.pdf`, `.woff`, `.woff2`, `.ttf`, `.eot`, `.css` | `assets/` |
| Other | everything else | `resources/` |

### Example

If your SKILL.md links to a helper script:

```markdown
Run the [setup script](../../scripts/setup.sh) to configure your environment.
```

The packaged output will be:

```
my-skill/
├── SKILL.md          # Link rewritten to: scripts/setup.sh
└── scripts/
    └── setup.sh      # Routed here by .sh extension
```

### Interaction with Naming Strategies

The `resourceNaming` setting (`basename`, `resource-id`, `preserve-path`) still applies — it controls the **filename** within the subdirectory. Content-type routing controls **which subdirectory**.

## The `files` Configuration

Use `files` when auto-discovery isn't enough:

- **Build artifacts** — files produced by your build step that don't exist at validation time
- **Unlinked files** — files that should be in the output but aren't referenced via `[]()` links
- **Routing overrides** — files where the default content-type routing is wrong

### When NOT to Use `files`

Don't use `files` for committed files that are already linked from markdown. Auto-discovery handles those automatically with content-type routing. `files` is only for cases auto-discovery can't reach.

### Configuration

Add `files` to your `vibe-agent-toolkit.config.yaml`:

```yaml
skills:
  include: ["skills/**/SKILL.md"]

  # Shared across all skills
  defaults:
    files:
      - source: dist/bin/shared-cli.mjs    # relative to project root
        dest: scripts/shared-cli.mjs        # relative to skill output dir

  # Per-skill overrides
  config:
    my-tool:
      files:
        - source: dist/bin/tool-cli.mjs
          dest: scripts/tool-cli.mjs
```

### Path Semantics

- **`source`**: Path relative to the project root (where `vibe-agent-toolkit.config.yaml` lives). This is where the file exists (or will exist after your build step).
- **`dest`**: Path relative to the skill's output directory (sibling to SKILL.md in the packaged output). This is where the file will land and what your SKILL.md content should reference.

### Merge Behavior

Per-skill `files` entries are **additive** to defaults:

```yaml
skills:
  defaults:
    files:
      - source: dist/shared.mjs
        dest: scripts/shared.mjs        # All skills get this
  config:
    my-tool:
      files:
        - source: dist/tool.mjs
          dest: scripts/tool.mjs         # my-tool gets both shared + tool
```

If a per-skill entry has the same `dest` as a default, the **per-skill entry wins**:

```yaml
skills:
  defaults:
    files:
      - source: dist/v1.mjs
        dest: scripts/cli.mjs           # Default: v1
  config:
    my-tool:
      files:
        - source: dist/v2.mjs
          dest: scripts/cli.mjs          # Override: my-tool uses v2
```

An empty `files: []` on a per-skill config still inherits defaults.

### Common Patterns

#### Shared CLI Across Multiple Skills

```yaml
skills:
  defaults:
    files:
      - source: dist/bin/my-cli.mjs
        dest: scripts/my-cli.mjs
  config:
    skill-a: {}      # Gets the CLI from defaults
    skill-b: {}      # Gets the same CLI
```

Each skill's SKILL.md can reference it:

```markdown
Run `node scripts/my-cli.mjs --help` to see available commands.
```

#### Build Artifact (Generated File)

Your SKILL.md references a file that doesn't exist until your project builds:

```markdown
Use the [bundled CLI](scripts/cli.mjs) for all operations.
```

Config:
```yaml
skills:
  config:
    my-tool:
      files:
        - source: dist/bin/cli.mjs       # Created by your build step
          dest: scripts/cli.mjs           # Matches what SKILL.md references
```

The link in SKILL.md points to `scripts/cli.mjs` (the dest). VAT knows this is a declared build artifact and:
- Skips the broken-link error at validation time
- Copies the file from source to dest at build time
- Verifies it exists in the output at verify time

#### Routing Override

A `.json` file that should go to `scripts/` instead of the default `templates/`:

```yaml
skills:
  config:
    my-tool:
      files:
        - source: src/config/tool-config.json
          dest: scripts/tool-config.json    # Override: goes to scripts/
```

## How Links Are Matched

When VAT encounters a `[]()` link during packaging:

1. **Link target matches `files[].source`** — The file exists in source at a different location. VAT copies it from `source` to `dest` and rewrites the link to point to `dest`.

2. **Link target matches `files[].dest`** — The link already points to the correct location (typical for build artifacts). VAT leaves the link as-is and copies from `source` to `dest` at build time.

3. **Neither** — Normal auto-discovery with content-type routing applies.

## Validation Behavior

VAT validates files at multiple stages:

### Source-Time Validation (`vat skills validate`)

- Links to paths matching `files[].dest` or `files[].source` are recognized as **deferred** — reported as info, not errors
- Genuinely broken links (matching no files entry) are still errors
- Duplicate `dest` values within a skill's files config are errors

### Build-Time (`vat skills build`) — Hard Gate

- Every `files[].source` must exist on disk. If missing:
  ```
  files entry for skill 'my-tool': source 'dist/bin/cli.mjs' does not exist.
  Has your project's build step run?
  ```
- Build fails immediately — no "we'll check later"

### Post-Build Verification (`vat verify`) — Hard Gate

- Confirms every `files[].dest` exists in the built output
- Catches files that disappeared between build and publish

## Troubleshooting

### "My script isn't in the output"

1. Check that `files` config lists the source and dest
2. Verify your project's build step ran before `vat skills build`
3. Run `vat verify` to see if the file is flagged as missing

### "Link is reported as broken"

If the link target is a build artifact:
1. Add a `files` entry with `dest` matching the link target
2. Set `source` to where the file will be after your build step

### "File landed in wrong subdirectory"

Use a `files` entry as a routing override:
```yaml
files:
  - source: path/to/file.json
    dest: scripts/file.json      # Override default templates/ routing
```

### "Collision detected"

Two files are mapping to the same dest path. Options:
- Use `resource-id` naming strategy for unique filenames
- Use `files` to give explicit, non-colliding dest paths

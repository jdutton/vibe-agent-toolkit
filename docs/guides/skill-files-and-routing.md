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

### Glob Sources (Directory Fan-Out)

A `files:` entry whose `source` contains glob magic (`*`, `**`, `?`, or `[`) is a **glob entry**. Everything else is a single-file copy, as described above. There is no `recursive` flag — glob is VAT's existing idiom for multi-file selection (the same syntax used in `skills.include` and resource collection patterns), keeping `files:` consistent with the rest of the config.

#### Prefix-strip + tail-preserve mapping

For a glob entry, `dest` is a **directory** (for a single-file source, `dest` is a file, as before). VAT strips the *static base* of the pattern — the longest leading path with no glob magic — and re-roots each match's tail under `dest`.

Example:

```yaml
skills:
  config:
    report-tools:
      files:
        - source: dist/packs/**/*     # static base = dist/packs
          dest: packs/                 # dest is a directory
```

If the build produces `dist/packs/claims/large-loss.json` and `dist/packs/claims/summary.csv`, they land at:

```
packs/claims/large-loss.json
packs/claims/summary.csv
```

The `dist/packs` prefix is stripped; the `claims/...` tail is preserved under `packs/`. Matches are **not flattened** — directory structure below the static base is maintained in the output.

Sibling sources work: a static base like `../shared/dist` is supported; the glob runs with its `cwd` at the resolved static base.

#### Late binding

The glob is **never expanded at parse or validate time** — only at build/copy time (`vat skills build`). This means a `SKILL.md` link to a file that will land under a glob `dest` (e.g. `packs/claims/large-loss.json`) is treated as a deferred build artifact at validate time — reported as [`LINK_DEFERRED_ARTIFACT`](../validation-codes.md#link_deferred_artifact) (info), never a broken-link error — whether or not a build has run. `vat skills build` preserves and rewrites the link to the materialized dest. This is what lets you drop a `LINK_TO_GITIGNORED_FILE` / broken-link allowlist once you switch to a glob entry.

#### Never-packaged files (globs only)

A glob's matches are filtered against a built-in never-package list before anything is copied:

| Tier | Files | Never packaged into |
|---|---|---|
| Agent-instruction | `CLAUDE.md`, `CLAUDE.local.md`, `AGENTS.md`, `GEMINI.md` | any bundle — skill **and** plugin |
| Navigation | `README.md`, `index.md`, `toc.md`, `overview.md` | a **skill bundle** only |

**Matching is case-insensitive**, so one spelling per name is listed above and every
other spelling is covered: `Claude.md`, `claude.md` and `CLAUDE.MD` are all dropped
exactly as `CLAUDE.md` is, and `Readme.md` / `ReadMe.md` as `README.md` is. This is not
cosmetic — on a case-insensitive filesystem (macOS APFS, Windows NTFS) Claude Code's
lookup for a project-local `CLAUDE.md` resolves a `Claude.md` just the same, so a
case-sensitive list would leave the whole harm reachable by renaming one letter.

Navigation files are deliberately *not* excluded from the plugin tree-copy: a plugin-root
`README.md` is the plugin's front page, and most published plugins ship one.

**The rule: a glob honors this list; an explicit entry does not.**

```yaml
files:
  - source: extras/**/*        # a net — extras/README.md and extras/CLAUDE.md are dropped
    dest: extras
  - source: extras/README.md   # a declaration — this one ships
    dest: extras/README.md
```

Naming a path is an unambiguous instruction to ship that file, so an explicit entry always wins
and a deliberate scaffold or skill README needs no new config. That instruction is followed all the
way through: an explicitly-named dest is also exempt from
[`PACKAGED_AGENT_INSTRUCTION_FILE`](../validation-codes.md#packaged_agent_instruction_file) in
`vat build` and `vat verify`, so declaring the file does not then earn you a warning telling you to
delete it. (`vat audit <path>` still reports it — that lane resolves a subject by path and cannot
reach the config that declared it; `vat verify` is the authoritative answer.) A glob never named the file it
caught, so it does not inherit the intent an explicit declaration carries. (Same principle that
exempts a declared `files:` dest from [`PACKAGED_UNREFERENCED_FILE`](../validation-codes.md#packaged_unreferenced_file),
and that auto-excludes a declared `test.evals` path.) Link-following already refuses to bundle
both file classes; this keeps glob expansion from disagreeing with it.

**Entry order does not matter.** The explicit entry above may sit before or after the glob, and
that holds even when the glob carries `integrity: true` over the same dest subtree — integrity is
evaluated once every entry has copied, against the union of what all of them declared, so it stays
a statement about the bundle you actually ship.

Every dropped file is reported as a
[`FILES_GLOB_DROPPED_NEVER_PACKAGED`](../validation-codes.md#files_glob_dropped_never_packaged)
warning in the structured result, not only on stderr — a build that silently changed what ships
cannot report `warnings: 0`. The **pre-build** gates report it too: `vat skills validate` and
`vat audit` expand the same globs through the same code path as the copy, so you see the drop
before a build exists and the two lanes cannot disagree about what ships. (Pre-build, a glob whose
base has not been built yet simply has nothing to report — the zero-match *error* below belongs to
copy time, where the build has run.) If `SKILL.md` links to a dropped file (via its glob **dest** path,
which validate treats as a deferred artifact), the packaged link has no target and the build fails
with [`PACKAGED_BROKEN_LINK`](../validation-codes.md#packaged_broken_link) naming the never-package
rule as the cause — declare the file explicitly, or drop the link. That cause is only named when
the file really was dropped by a glob; an ordinary broken link to a `README.md` keeps the ordinary
remediation.

#### Build-time errors

A glob that matches **zero files** is a hard error at build time:

```
files: source 'dist/packs/**/*' (glob) matched no files under /repo/dist/packs — has your build run?
```

A glob whose matches are **all** never-packaged is a distinct hard error — it names the exclusion
rather than sending you hunting for a build failure that isn't there:

```
files: source 'extras/**/*' (glob) matched 2 file(s) under /repo/extras, but all of them are
never packaged into a skill bundle: CLAUDE.md, README.md. Declare an explicit source: entry
for a file you intend to ship, or point the glob at a directory that holds files which can be
packaged.
```

Widening the glob is *not* a fix: the filter is on basename and applies at any width, so a wider
pattern clears the error while still shipping none of these files.

A **non-glob** `source` that resolves to a directory is a hard error telling you to use a glob instead:

```
files entry for skill 'report-tools': source 'dist/packs' is a directory.
Use a glob to copy a directory tree: 'dist/packs/**/*'
```

### Verifying the Copy (`integrity`)

Add `integrity: true` to any `files:` entry to byte-verify the copy at build time:

```yaml
skills:
  config:
    report-tools:
      files:
        - source: dist/packs/**/*
          dest: packs/
          integrity: true
```

With `integrity: true`, `vat skills build` asserts, for every file copied, that the dest file is **byte-identical** to its matched source. For a glob entry it also asserts that the dest subtree contains **exactly** the matched set — no missing files, no extra files left over from a prior build. A mismatch fails the build and names the offending path.

Use `integrity` for entries where a faithful copy is a correctness invariant — for example, a generated data catalog where a truncated or stale copy would silently produce wrong results.

**Scope and limits.** `integrity` verifies a faithful **source → dest copy** within a single build. It does not cover:

- **Generated-vs-committed drift** — whether a committed artifact still matches what its generator would produce today. That invariant needs a separate build-and-compare step (a future `vat verify` extension), not `files: integrity`.
- **Cross-artifact / cross-bundle identity** — asserting that the same shared binary is byte-identical across two different packaged bundles (guarding against two divergent dependency versions). Those invariants must live in a dedicated verify step.

If you need those broader guarantees, wire them into your own CI pipeline. `files: integrity` is deliberately scoped to one thing: confirming the copy fidelity of a single entry.

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

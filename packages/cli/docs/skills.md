# vat skills - Claude Code Skills Commands

## Overview

The `vat skills` commands provide tools for packaging, distributing, installing, and managing Claude Code skills. These commands support the full skill lifecycle from development to distribution to installation.

## Validation Configuration

`vat skills build` and `vat skills validate` both honor a unified validation framework configured in `vibe-agent-toolkit.config.yaml`. Every overridable check emits an issue with a default severity; adopters override class-level behavior with `validation.severity` and allow specific instances with `validation.allow`.

```yaml
# vibe-agent-toolkit.config.yaml
skills:
  defaults:
    validation:
      severity:
        LINK_DROPPED_BY_DEPTH: warning      # default; raise to error for strict mode
  config:
    my-skill:
      validation:
        severity:
          LINK_TO_NAVIGATION_FILE: ignore   # this skill links to READMEs on purpose
          ALLOW_EXPIRED: error              # zero-tolerance expiry
        allow:
          LINK_TO_GITIGNORED_FILE:
            - paths: ["templates/runtime.json"]
              reason: "generated at install time, deliberately untracked"
              expires: "2026-09-30"
          SKILL_LENGTH_EXCEEDS_RECOMMENDED:
            - reason: "whole-skill concern; paths defaults to ['**/*']"
```

**Severity levels** (uniform across every overridable code):
- `error` — emit and block (exit 1).
- `warning` — emit, do not block.
- `ignore` — do not emit (check still runs; result is discarded).

**Key behaviors:**
- `paths` is optional on `allow` entries and defaults to `["**/*"]` (the whole skill).
- Expired `allow` entries still apply; a separate `ALLOW_EXPIRED` warning surfaces the stale date for re-review. Opt into strict expiry with `severity.ALLOW_EXPIRED: error`.
- Unused `allow` entries surface as `ALLOW_UNUSED` (analogous to ESLint's unused-disable).
- `vat audit` applies `severity` (a code set to `error` gates, `warning` does not, `ignore` hides it) and ignores `allow`; its exit code follows the report's `status`.

See `docs/validation-codes.md` for the full code reference with per-code descriptions and defaults.

## Commands

### vat skills validate [path]

**Purpose:** Validate the skills a project declares, before packaging — the gate `vat validate` and `vat verify` run as their `skills` phase.

**What it does:**
1. Reads `vibe-agent-toolkit.config.yaml` from `[path]` (default: current directory) and discovers every file its `skills.include` / `skills.exclude` globs match
2. Validates each with the packaging validator: frontmatter, links and link depth, size/complexity, `files:` config, compat observations — under the merged `skills.defaults` + `skills.config.<name>` validation config (`severity` + `allow`)
3. Publishes the report envelope (YAML) on stdout and a findings report on stderr
4. Exits on the code the published document derives — 0, 1 or 2, see below

**Arguments:**
- `[path]` — a directory that holds `vibe-agent-toolkit.config.yaml`. It scopes *which config is read*, not which files are scanned; the globs in that config do the scanning. A path that does not exist, is not a directory, or holds no config is refused as `USAGE_INVALID`, and one the OS will not list as `INPUT_UNREADABLE` (exit 2) — never silently rescoped to nothing. There is no `--user` mode and no "scan this directory" mode.

**Options:**
- `--skill <name>` — validate one discovered skill only (narrows what is reported on, not what counts as declared test input). A name no discovered skill has is refused as `USAGE_INVALID`
- `-v, --verbose` — stderr only: every finding in full, plus each skill's allow-suppressed records and the reference paths its bundle excludes. The published document is the same with or without it
- `-d, --debug` — debug logging

**Exit codes:**

The code is derived from the published document — the one rule every report verb shares.

| Exit | `status` | When |
|---|---|---|
| `0` | `ok` / `findings` | No `error`-severity finding (warnings and info do not fail; allowed findings are not published) |
| `1` | `findings` | An `error`-severity finding on any skill, **or** the run validated no skill: `skills.include` matched nothing (typo, renamed directory, an `exclude` that swallows every match) or the config has no `skills:` block. The writer adds one non-overridable `RESOURCE_CHECK_BROKEN` — a green over zero skills is not a verdict — and stderr names the globs that matched nothing |
| `2` | `error` | Could not run; `error.code` says why: `USAGE_INVALID` (`[path]` refused, unknown `--skill`, no `projectRoot`), `INPUT_UNREADABLE` (a directory the OS will not list), `CONFIG_INVALID` (config does not parse) |

Both orchestrators (`vat validate`, `vat verify`) skip the skills phase for a config with no `skills:` block, so only a direct run reports it.

**What a matched file must be.** Every file the globs match is validated as a skill and counted in `examined`. A matched file with no YAML frontmatter block — or one whose block does not parse — is refused with `SKILL_MISSING_FRONTMATTER` at `error` (non-overridable), located at the file's project-relative path. So a glob that drifts onto a `README.md`, or a `SKILL.md` that lost its fence, fails the run instead of passing under its H1 as a name. A frontmatter block without a `name` is legal (agentskills.io makes `name` optional) and is not refused on that ground.

**Output:**

The report envelope: every finding flat on `findings[]`, each `location` relative to `data.root` (the directory the config was read from); one `data.skills[]` row per skill validated, clean ones included, so `examined` and the rows always agree. `summary` counts findings by severity on the envelope and on each row, and the envelope's `summary` is exactly the rows plus the run-level findings (`ALLOW_UNUSED` entries no skill matched, and the zero-skill refusal). `allowed` counts the findings `validation.allow` suppressed for the skill; they are never published as findings.

```yaml
status: findings         # ok | findings | error — findings = at least one finding published
examined: 2              # skills validated
findings:
  - code: SKILL_MISSING_FRONTMATTER
    severity: error
    message: …
    location: skills/beta/SKILL.md
summary: { errors: 1, warnings: 0, info: 0 }
gate: { strict: false }
durationMs: 310
data:
  root: /abs/path/to/packages/my-pkg
  skills:
    - { name: alpha, status: ok, summary: { errors: 0, warnings: 0, info: 0 }, allowed: 0 }
    - { name: beta, status: findings, summary: { errors: 1, warnings: 0, info: 0 }, allowed: 0 }
```

`jq '.findings[] | select(.severity == "error")'` (after converting the YAML) lists what failed the run; `data.skills[]` is the per-skill tally. The schema is `packages/cli/schemas/skills-validate.json`.

stderr prints one line per skill with findings, with every `error` finding rendered in full beneath its row (location, message, fix) at every verbosity.

**Example:**
```bash
vat skills validate packages/my-pkg/   # read packages/my-pkg/vibe-agent-toolkit.config.yaml
```

**Requirements:**

- **`projectRoot`**: required. `vat skills validate` refuses to run if no
  `vibe-agent-toolkit.config.yaml` or `.git/` ancestor is found. Source-mode
  validation always runs against a real authoring boundary.
- **Config**: optional. Falls back to built-in defaults if no config file is
  present, but a `projectRoot` is still required to anchor link resolution and
  the gitignore-safety gate.

See [Roots and Config — Canonical Concepts](../../../docs/concepts/roots-and-config.md)
for the discovery ladder, the loud-cwd fallback policy, and the CLI-boundary
discovery rule that this command participates in.

---

### vat skills build

**Purpose:** Build every skill `vibe-agent-toolkit.config.yaml` declares into `dist/skills/<name>/`

**What it does:**
1. Discovers SKILL.md files through the `skills.include` / `skills.exclude` globs
2. Sets aside `publish: false` skills (in-place, or plugin-local — shipped with their plugin)
3. Validates each remaining skill's source, then packages the ones that pass
4. Promotes the staged bundles into `dist/skills/` only if the whole run is clean

**Typical Usage:**
```json
{
  "scripts": {
    "build": "tsc && vat skills build"
  }
}
```

**Options:**
- `--skill <name>` - Build specific skill only
- `--dry-run` - Preview build without creating files
- `-v, --verbose` - Show every finding on stderr (the stdout report carries all of them either way)
- `--debug` - Enable debug logging

**Exit Codes:**
- `0` - Built; findings, if any, are warnings or info (or a dry-run preview)
- `1` - An error-severity finding: a skill failed validation, had its content refused by the
  packager (`SKILL_PACKAGING_FAILED`), or emitted post-build errors; `--skill` named a `publish: false`
  skill (`SKILL_BUILD_TARGET_NOT_BUILDABLE`); or nothing was examined — no `skills:` block, or
  globs matching no SKILL.md (`RESOURCE_CHECK_BROKEN`)
- `2` - The build could not run (`error.code`): `USAGE_INVALID` (a bad `[path]`, an unknown
  `--skill`), `INPUT_UNREADABLE` (a file in the git repository the OS will not let git read — the
  message names it), `CONFIG_INVALID`, or `RUN_INCOMPLETE` (an output the OS will not let the build
  examine or write: a previous `dist/skills` it will not examine, the staging tree beside it
  could not be made or written, or the swap of `dist/skills` failed — `data.promotionError`
  names what is on disk and how to recover it; a refusal after discovery still reports the
  skills it `examined`).
  Any other throw from the packager stops the run under its own code (`INPUT_UNREADABLE` for a
  directory the OS will not list); one that carries no code is a defect in VAT
  (`INTERNAL_ERROR`). Either way `dist/skills` is left untouched

**Output Format** (the report contract — schema `packages/cli/schemas/skills-build.json`):
```yaml
status: findings           # ok | findings | error
gate: { strict: false }
summary: { errors: 0, warnings: 1, info: 0 }
examined: 3                # skills discovered after --skill, publish: false ones included
findings:                  # every finding, at every verbosity
  - code: LINK_DROPPED_BY_DEPTH
    severity: warning
    message: ...
    location: dist/skills/skill1/docs/deep.md
    fix: ...
data:
  dryRun: false
  validated: true          # false on a dry run: nothing was validated
  skillsBuilt: 2
  skillsFailed: 0          # the packager refused the skill's content
  skillsFailedValidation: 0
  skillsInPlace: [skill3]  # publish: false, never bundled here
  skillsPluginOnly: []     # publish: false, shipped with their plugin
  outputCommitted: true    # false ⇒ dist/skills was NOT replaced
  skills:
    - { name: skill1, source: skills/skill1/SKILL.md, output: dist/skills/skill1, status: findings }
    - { name: skill2, source: skills/skill2/SKILL.md, output: dist/skills/skill2, status: ok }
durationMs: 1234
```

Every path is relative to the directory holding `vibe-agent-toolkit.config.yaml`. A row's
`output` is where its bundle lands; it exists on disk only when `outputCommitted` is true. A row's
`status` is `ok` or `findings` once the run validated it, and `not-built` when the run validated
and built nothing — a dry run, or a refusal before the build (`validated: false`).

**Examples:**
```bash
# Build all skills from config
vat skills build

# Build specific skill
vat skills build --skill my-skill

# Preview without building
vat skills build --dry-run
```

**Requirements:**

- **`projectRoot`**: required. `vat skills build` refuses to run if no
  `vibe-agent-toolkit.config.yaml` or `.git/` ancestor is found. This guards
  against accidental builds outside a VAT project.
- **Config**: required file with `skills.*` fields populated. The build
  pipeline reads `skills.discovery` and `skills.config.*` directly — there are
  no useful defaults for these.

See [Roots and Config — Canonical Concepts](../../../docs/concepts/roots-and-config.md)
for terminology.

---

### vat skills package <skill-path>

**Purpose:** Package a SKILL.md file for distribution

**What it does:**
1. Validates the SKILL.md file
2. Recursively collects all linked markdown files
3. Rewrites relative links to maintain correctness after relocation
4. Creates distributable artifacts (directory, ZIP, npm, marketplace)

**Arguments:**
- `<skill-path>` - Path to the SKILL.md file, or the skill directory holding it (required)

**Required Options:**
- `-o, --output <path>` - Output directory for packaged skill (required)

**Optional Options:**
- `-f, --formats <formats>` - Comma-separated formats: directory,zip,npm,marketplace (default: directory,zip). An unknown or empty name is refused (`USAGE_INVALID`)
- `--no-rewrite-links` - Skip rewriting relative links in copied files
- `-b, --base-path <path>` - Base path for resolving relative links (default: dirname of SKILL.md)
- `--dry-run` - Preview packaging without creating files. It is the real run's own packaging pass
  stopped before the first write: the project crawl, the link walk and the `--output` check all
  run, so whatever the real run would refuse before writing is refused here too, with the same
  code — and the file list is the one the real run copies. Only the checks on the written bundle
  (and the ZIP's size) are not run
- `--force` - Replace a previous package: the `--output` directory (or file) is removed and
  rebuilt, and a `<output>.zip` / `<name>.marketplace.json` FILE beside it is overwritten. A
  directory standing where one of those archives goes is not removed: the write fails and the run
  ends `RUN_INCOMPLETE`. Without `--force`, an `--output` that already holds anything — a
  non-empty directory, a file, or one of those siblings — is refused (`USAGE_INVALID`, the message
  naming `--force`) and left exactly as it was: VAT never deletes what it did not produce. An empty
  directory is used as-is. An `--output` that is, or contains, the SKILL.md or any file it bundles
  is refused (`USAGE_INVALID`) even with `--force`: the package would be written over its own source.
  So is an `--output` under a directory the OS will not let VAT examine (`EACCES`), dry run or real,
  `--force` or not: VAT cannot tell whether it holds the source — unless that directory is inside
  the project and not gitignored, when the crawl refuses the run first (`INPUT_UNREADABLE`)
- `--debug` - Enable debug logging

**Exit Codes:** derived from the published report — `0` when no finding is an error (warnings
and info never block: the verb has no `--strict`), `1` when one is, `2` when the run was refused.

- `1` — the skill failed its validation gate (nothing is packaged), packaging refused the skill's
  content (`SKILL_PACKAGING_FAILED`, no bundle), or `--target claude-web` produced a ZIP over
  claude.ai's 8 MB upload limit (`SKILL_PACKAGE_TOO_LARGE`; the directory and the ZIP are on disk)
- `2` — `error.code` says why: `USAGE_INVALID` (a `<skill-path>` naming nothing, an invalid
  `--target`, an unknown or empty `--formats` value, no project root, an `--output` already holding something without `--force`),
  `INPUT_UNREADABLE` (a `<skill-path>` the OS will not stat or read, or a directory in the project
  the OS will not list — the crawl that finds what the skill links to names it; this verb takes no
  git snapshot, so an unreadable FILE elsewhere in the repository does not stop it),
  `RUN_INCOMPLETE` (an output the OS will not let the build write — a full disk, a read-only or
  unwritable output directory, a file in the way, a ZIP, npm `package.json` or marketplace
  manifest that could not be written, whose partial file is removed; never a finding against the
  skill), `INTERNAL_ERROR` (an unexpected failure, stack on stderr)

A bundled markdown file the OS will not read is a `SKILL_PACKAGING_FAILED` finding here (exit 1),
next to a `LINK_INTEGRITY_BROKEN` warning from the validator: `vat skills package` does not run
the packaging validation that reports it as `LINK_TARGET_UNREADABLE` in `vat skills build`. A
linked file that is not a regular file — a named pipe, socket or device — is refused unread by the
validator itself, as a `LINK_TARGET_UNREADABLE` error (exit 1), in both verbs.

**What Gets Packaged:**
- Root SKILL.md file
- All linked markdown files (recursively discovered)
- Links are rewritten to maintain correctness
- Directory structure is preserved

**Output Format:** the report envelope on stdout (schema `packages/cli/schemas/skills-package.json`);
progress and the rendered findings go to stderr. `examined` is the one skill; `findings[]` carries
every validation finding, located as the validator locates it. `data.outputPath` is relative to the
working directory, and `null` when no package was produced; on `--dry-run` it is where the
package would go. Each finding carries the validator's `fix` and `reference` (an anchor into
`docs/validation-codes.md`). A real run over a skill whose frontmatter carries `version`:

```yaml
status: findings
examined: 1
findings:
  - severity: warning
    code: SKILL_FRONTMATTER_EXTRA_FIELDS
    message: Frontmatter contains non-standard field "version"; use `metadata.*` for custom data.
    field: frontmatter
    fix: Move custom data under `metadata.<key>`, or remove the field. Per-project config belongs in
      vibe-agent-toolkit.config.yaml, not SKILL.md frontmatter.
    reference: "#skill_frontmatter_extra_fields"
    location: skills/my-skill/SKILL.md
summary:
  errors: 0
  warnings: 1
  info: 0
gate:
  strict: false
data:
  skill: my-skill
  version: 1.0.0
  outputPath: dist/my-skill
  dryRun: false
```

**Examples:**
```bash
# Package with default formats (directory + ZIP)
vat skills package resources/skills/SKILL.md -o dist/my-skill

# Re-package over the previous package (without --force an occupied -o is refused)
vat skills package resources/skills/SKILL.md -o dist/my-skill --force

# Preview without creating files
vat skills package SKILL.md -o /tmp/skill --dry-run

# Package as ZIP and npm formats only
vat skills package SKILL.md -o dist/my-skill -f zip,npm

# Package without rewriting links
vat skills package SKILL.md -o dist/my-skill --no-rewrite-links

# Package with custom base path
vat skills package SKILL.md -o dist/my-skill -b /custom/base
```

**Requirements:**

- **`projectRoot`**: required. Packaging is an explicit-adoption operation and
  is refused outside a discovered VAT project (no `vibe-agent-toolkit.config.yaml`
  or `.git/` ancestor).
- **Config**: required file with `skills.*` fields populated. Per-skill packaging
  options (`skills.config.<name>`) drive link rewriting, bundle inclusion, and
  validation overrides.

See [Roots and Config — Canonical Concepts](../../../docs/concepts/roots-and-config.md)
for terminology.

---

### vat skills install \<source\>

**Purpose:** Install a SKILL.md-based skill to one of 7 supported platform targets

**What it does:**
1. Resolves the source (local directory, ZIP, .tgz, or npm package)
2. Discovers one or more skill directories inside the source
3. Pre-validates every skill with `validateSkill()` — zero files written if validation fails
4. Reads each skill's declared name, which is the name it installs under
5. Builds an install plan, detecting conflicts before touching the filesystem
6. Copies skill(s) to the resolved platform directory (all-or-nothing semantics)
7. Emits a YAML summary on stdout

Both `--target` and `--scope` are **required** — there are no defaults.

**Installed name:** a skill installs under the `name` its `SKILL.md` frontmatter
declares — the same identity `vat skills build` and the plugin build key on — not
the name of the directory it came from. A ZIP or npm source has no meaningful
directory name to use. If two skills in one source declare the same name, the
whole install fails rather than one silently overwriting the other. Use `--name`
to override (single-skill sources only).

**Supported Sources:**
- **Local directory:** `./path/to/skill-dir` — must contain `SKILL.md` at root or in subdirectories
- **Local ZIP file:** `./path/to/skill.zip` — extracted to a temp directory, then installed
- **Local tarball:** `./path/to/skill.tgz` or `skill.tar.gz` — extracted as an npm package tarball
- **npm package:** `npm:@scope/package-name` — downloaded from the registry, `dist/skills/` is used

**Arguments:**
- `<source>` - Source to install from (required)

**Required Options:**
- `--target <target>` - Platform target (see Targets table below)
- `--scope <scope>` - Install scope: `user` or `project`

**Optional Options:**
- `-n, --name <name>` - Override skill name (single-skill sources only)
- `-f, --force` - Overwrite existing skill
- `--dry-run` - Preview install without writing files
- `--debug` - Enable debug logging

**Targets:**

| Target | User path | Project path |
|--------|-----------|--------------|
| `claude` | `~/.claude/skills/` | `.claude/skills/` |
| `codex` | `~/.agents/skills/` | `.agents/skills/` |
| `copilot` | `~/.copilot/skills/` | `.github/skills/` |
| `gemini` | `~/.gemini/skills/` | `.gemini/skills/` |
| `cursor` | `~/.cursor/skills/` | `.cursor/skills/` |
| `windsurf` | `~/.codeium/windsurf/skills/` | `.windsurf/skills/` |
| `agents` | `~/.agents/skills/` | `.agents/skills/` |

These paths were last reviewed against each platform's own published docs on
2026-07-30 (all fourteen unchanged) and are not verified at build or test time.
The tests derive their expectations from the table and assert invariants of it —
every target present, both scopes relative and forward-slash only, and that the
resolver composes base + relative path. No test can check that a path is where a
platform actually looks. If a vendor moves its convention, installs land
somewhere unread and every VAT check still passes. Re-check the vendor's
documentation before relying on a non-`claude` target.

**Visibility:** VAT's own inspection commands are Claude-scoped — `vat skills
list --user` and `vat audit --user` read `~/.claude` only. A skill installed to
any other target lands correctly but is invisible to them.

**Exit Codes:**
- `0` - Installed, or `--dry-run` complete
- `1` - A skill failed its pre-install validation: its error findings are published and nothing in the batch is installed
- `2` - Could not install, and nothing was installed (`data` is null). `error.code` says why: `USAGE_INVALID` for a bad `--target`/`--scope`/`--name`, a source holding no `SKILL.md`, two skills claiming one name, or something already at an install path without `--force`; `INPUT_UNREADABLE` for a source the OS (or the ZIP/tarball reader) will not read — an archive holding an entry that cannot be extracted (a file `a` beside a file `a/b`) included; `EXTERNAL_API_FAILED` when the npm registry will not hand over an `npm:` package; `RUN_INCOMPLETE` for an install path the OS will not let VAT examine or write (it is what the install writes), or a staging copy under `$TMPDIR` or beside the install path it could not create or write (full, read-only)

**Output** — the `Report` envelope (schema: `schemas/skills-install.json`); `examined` counts the skills in the install plan and `durationMs` is on the envelope:
```yaml
status: ok               # ok | findings | error
gate: { strict: false }
summary: { errors: 0, warnings: 0, info: 0 }
examined: 2
findings: []             # each skill's validation findings; TREE_CLEANUP_INCOMPLETE warnings for what it could not remove
data:
  source: /abs/path/to/source   # npm:<pkg> as typed
  target: claude
  scope: user
  dryRun: false          # true on --dry-run
  skills:                # installed; planned on --dry-run; [] when validation stopped the batch
    - name: my-skill
      installPath: /Users/you/.claude/skills/my-skill
    - name: other-skill
      installPath: /Users/you/.claude/skills/other-skill
      # alreadyInstalled: true   — --dry-run only: the plan replaces what is there (needs --force)
```

A run that could not install publishes the same envelope with `status: error` and
`error: { code, message }`; the message also goes to stderr.

**All-or-nothing semantics:** Skills are pre-verified before any filesystem writes, and the whole batch is one transaction: every skill is staged beside its install path and swapped in together, or nothing changes. A skill that fails validation, a conflict (without `--force`), a source file the OS will not read, or a copy that fails partway installs none of the batch. `--dry-run` prints the plan — one `[dry-run] create|replace skill <name> <path>` line per skill — and refuses exactly what the real run would.

**Examples:**
```bash
# Install from local built skill directory to user-scoped Claude
vat skills install ./dist/skills/my-skill --target claude --scope user

# Install from ZIP to project-scoped Copilot
vat skills install ./my-skill.zip --target copilot --scope project

# Install from tarball
vat skills install ./my-skill.tgz --target gemini --scope user

# Install from npm package
vat skills install npm:@vibe-agent-toolkit/vat-development-agents --target claude --scope user

# Override skill name (single-skill sources only)
vat skills install ./dist/skills/my-skill --target claude --scope user --name custom-name

# Force overwrite existing skill
vat skills install ./dist/skills/my-skill --target claude --scope user --force

# Preview installation without writing files
vat skills install npm:@my-org/package --target cursor --scope user --dry-run

# Install to project scope
vat skills install ./dist/skills/my-skill --target claude --scope project
```

**Post-Installation:**
After installation, you need to:
1. Restart Claude Code (or the target agent), or
2. Run `/reload-plugins` in Claude Code to load the new skill

**Requirements:**

- **`projectRoot`**: N/A. `vat skills install` is a user-level operation that
  installs into platform target directories (`~/.claude/skills/`,
  `.claude/skills/`, etc.) regardless of where it is invoked.
- **Config**: not used.

See [Roots and Config — Canonical Concepts](../../../docs/concepts/roots-and-config.md)
for terminology.

---

### vat skills list [path]

**Purpose:** List skills in project or user installation

**What it does:**
1. Discovers all SKILL.md files in the target location
2. Reports validation status for each skill
3. Shows skill metadata (name, description, path)

The reported `name` is the one the skill's frontmatter declares — matching what
`vat skills install` would install it as — falling back to the directory name
only when the `SKILL.md` declares none.

**Modes:**

**Project mode (default):**
- Lists skills in project directory
- Respects `vibe-agent-toolkit.config.yaml` boundaries
- Strict filename validation

**User mode (--user flag):**
- Lists skills in `~/.claude/plugins` and `~/.claude/skills`
- Shows user-installed skills
- Permissive filename validation

**Path mode (explicit path):**
- Lists skills at specific path
- Strict filename validation

**Arguments:**
- `[path]` - Directory to list skills from (default: current directory), or an `npm:` / `.tgz` source to preview without installing

**Options:**
- `--user` - List user-installed skills in ~/.claude
- `--verbose` - Show detailed information (full paths, warnings)
- `--debug` - Enable debug logging

**Exit Codes:**
- `0` - Listed — including a listing with a directory the scan could not read, which is a warning finding
- `2` - Could not list: a `[path]` that names no readable directory (`USAGE_INVALID`, or `INPUT_UNREADABLE` when the OS refuses it), a config that does not load, or an `npm:`/`.tgz` source that is not a skill package

**Validation Status:**
- ✅ `valid: true` - Filename is "SKILL.md" (uppercase)
- ⚠️ `valid: false` with `warning` - Non-standard filename detected (skill.md, Skill.md, etc.)

**Output** — the `Report` envelope (schema: `schemas/skills-list.json`). `examined` counts the
search roots scanned: the project directory or extracted package is one; `--user` scans two,
`~/.claude/plugins` and `~/.claude/skills`, and an absent one is scanned and empty:
```yaml
status: ok                     # ok | findings | error
gate: { strict: false }
summary: { errors: 0, warnings: 0, info: 0 }
examined: 1
findings: []
data:
  root: /abs/path/to/project   # the one absolute path; every skills[].path is relative to it
  context: project             # project | user | npm
  skills:
    - name: skill1
      path: resources/skills/SKILL.md
      valid: true
    - name: skill2
      path: skills/skill2.md
      valid: false
      warning: Non-standard filename (should be SKILL.md)
```

When the scan could not list a directory (a root-owned or quarantined directory under
`~/.claude/plugins`, say), each one is a `SCAN_PATH_UNREADABLE` warning finding, root-relative,
naming the errno — `status: findings` at exit 0, and the listing is a floor, not the answer:

```yaml
status: findings
summary: { errors: 0, warnings: 1, info: 0 }
findings:
  - code: SCAN_PATH_UNREADABLE
    severity: warning
    location: plugins/locked
    message: "<the code's description> (plugins/locked: listing was refused with EACCES; any skill beneath it is missing from this list)"
```

**Examples:**
```bash
# List project skills (default)
vat skills list

# List user-installed skills
vat skills list --user

# List skills at specific path
vat skills list packages/my-agent

# Show detailed information
vat skills list --verbose
```

**Requirements:**

- **`projectRoot`**: optional. `vat skills list` tolerates a missing
  `projectRoot`. With `--user` it scans user installation directories directly
  and skips project-root discovery entirely.
- **Config**: optional. Project mode honors config-defined include/exclude
  patterns when present; defaults are used otherwise.

See [Roots and Config — Canonical Concepts](../../../docs/concepts/roots-and-config.md)
for terminology.

---

## Distribution Workflow

The complete workflow for creating and distributing Claude Code skills:

### 1. Development
- Create `SKILL.md` with frontmatter
- Add resources and linked markdown files
- Test locally with Claude Code

### 2. Validation
```bash
# Validate skill correctness
vat skills validate resources/skills
```

### 3. Build (for npm packages)
```bash
# Add to package.json
{
  "vat": {
    "skills": [{
      "name": "my-skill",
      "source": "./resources/skills/SKILL.md",
      "path": "./dist/skills/my-skill"
    }]
  }
}

# Build during package build
bun run build  # Runs: tsc && vat skills build
```

### 4. Package (for standalone distribution)
```bash
# Create distributable ZIP
vat skills package resources/skills/SKILL.md -o dist/my-skill
```

### 5. Distribution
**Option A: npm package**
```bash
npm publish  # Skills installed via postinstall hook
```

**Option B: GitHub releases**
- Upload ZIP from step 4
- Users download and extract to `~/.claude/skills/`

**Option C: Direct install**
```bash
# From npm (--target and --scope required)
vat skills install npm:@my-org/my-skill-package --target claude --scope user

# From local ZIP
vat skills install my-skill.zip --target claude --scope user
```

### 6. Installation
Users install via:
```bash
# Manual install — both --target and --scope are required
vat skills install npm:@my-org/my-skill-package --target claude --scope user
vat skills install ./my-skill.zip --target claude --scope user

# Install to Cursor instead
vat skills install npm:@my-org/my-skill-package --target cursor --scope user

# Dry-run to preview before committing
vat skills install ./my-skill.zip --target claude --scope user --dry-run
```

### 7. Usage
```
# In Claude Code
User: /my-skill
# Skill executes
```

---

## When to Use Which Install Command

| Use case | Command |
|----------|---------|
| Install a SKILL.md-based skill (local dir, ZIP, .tgz, npm package) to any of 7 supported platforms | `vat skills install <source> --target <target> --scope <scope>` |
| Install a Claude plugin (`.claude-plugin/`, `plugin.json`, marketplace structure) | `vat claude plugin install <source>` |
| Upload a skill to your Anthropic org for Claude.ai (org admin only, requires ANTHROPIC_API_KEY) | `vat claude org skills install <source>` or `vat claude org skills install --from-npm <package>` |

**Key distinctions:**
- `vat skills install` — file-based, multi-platform, works entirely offline (except npm sources). Installs to local agent directories.
- `vat claude plugin install` — Claude-specific plugin format. Installs to `~/.claude/plugins/` and updates Claude's plugin registry.
- `vat claude org skills install` — cloud upload. Pushes skills to Anthropic's organization API so they are available to all org members in Claude.ai.

---

## Best Practices

### Skill Naming
- Use lowercase with hyphens: `my-skill`, not `MySkill` or `my_skill`
- Avoid reserved words: `help`, `exit`, `clear`, `history`
- No XML-like tags: `<skill>` or `</skill>`

### Skill Structure
- Always name the file exactly `SKILL.md` (uppercase)
- Include required frontmatter: `name`, `description`
- Keep descriptions under 500 characters
- Use forward slashes in paths (not backslashes)

### Distribution
- Validate before packaging: `vat skills validate`
- Test in dry-run mode first: `vat skills package --dry-run`
- Include version in frontmatter for tracking
- Document installation instructions in README

### Package Management
- Use `vat.skills` in package.json for npm distribution
- Build skills during package build: `tsc && vat skills build`
- Test installation locally before publishing
- Use semantic versioning for skill versions

### User Installation
- Always specify both `--target` and `--scope` — they are required with no defaults
- Use `--dry-run` to preview what will be installed before committing
- Use `--force` flag carefully (overwrites existing skills)
- Verify installation: `vat skills list --user`
- Remember to restart the target agent or run `/reload-plugins` in Claude Code

---

## Troubleshooting

### "Invalid target" / "Invalid scope"
**Problem:** `--target` or `--scope` value is not recognized.

**Solution:** Use one of the exact values listed in the Targets table. Both flags are required.

Valid targets: `claude`, `codex`, `copilot`, `gemini`, `cursor`, `windsurf`, `agents`
Valid scopes: `user`, `project`

```bash
# Correct
vat skills install ./my-skill --target claude --scope user
```

### "Skill validation failed during install"
**Problem:** The skill's `SKILL.md` has validation errors. No files were written.

**Solution:** Fix the errors reported, then retry. Run validate first to see all issues:
```bash
vat skills validate ./my-skill
vat skills install ./my-skill --target claude --scope user
```

### "Already installed" (conflict without --force)
**Problem:** A skill with the same name already exists at the install path.

**Solution:** Use `--force` to overwrite, or use `-n/--name` to install under a different name:
```bash
vat skills install my-skill.zip --target claude --scope user --force
# or install under a different name
vat skills install my-skill.zip --target claude --scope user --name my-skill-v2
```

### `vat skills build` exits 1 with `RESOURCE_CHECK_BROKEN`
**Problem:** The run examined no skill — the config has no `skills:` block, or its `include`
globs match no SKILL.md.

**Solution:** Declare `skills.include` globs in `vibe-agent-toolkit.config.yaml` that match the
SKILL.md files this project ships.

### `vat skills build` exits 1 with `SKILL_PACKAGING_FAILED`
**Problem:** A skill's packaging stopped before it produced a bundle — most often a
`skills.config.<name>.files` entry whose `source` does not exist (a build artifact not built yet)
or cannot be read.

**Solution:** Read the finding's `message` — it names the entry and the path, relative to the
project. Build the artifact first, or correct the `source` path in `vibe-agent-toolkit.config.yaml`.

### "Reserved word in name"
**Problem:** Skill name uses reserved word like "help" or "exit"

**Solution:** Choose different name:
```yaml
---
name: my-help  # Instead of "help"
---
```

### "Skill not recognized by Claude Code"
**Problem:** Installed skill doesn't appear in Claude Code

**Solution:**
1. Verify installation: `vat skills list --user`
2. Check location: Should be in `~/.claude/skills/` not `~/.claude/plugins/`
3. Restart Claude Code or run `/reload-plugins`

### "Windows-style backslashes"
**Problem:** Links use backslashes: `resources\SKILL.md`

**Solution:** Use forward slashes: `resources/SKILL.md`

---

## Related Commands

- `vat skill test` - Run a skill's eval suite (note the **singular** `skill`); its
  `test:` config surface is documented separately in [skill-test.md](./skill-test.md)
- `vat audit` - Comprehensive validation for plugins, marketplaces, and skills
- `vat resources validate` - Validate markdown resources (links, anchors)
- `vat doctor` - Check environment and installation health

---

## See Also

- [CLI Reference](./index.md) - Complete CLI documentation
- [Skill Test Command](./skill-test.md) - `vat skill test` eval harness and its config knobs
- [Audit Command](./audit.md) - Comprehensive validation
- [Resources Command](./resources.md) - Markdown resource validation

## Example reports

Each block below is a real document from the built CLI, trimmed where noted; `packages/cli/test/integration/tagged-report-examples.integration.test.ts` validates every `vat-report=<verb>` block against that verb's registered schema.

### `skills validate`

A two-skill project, both valid. Produced by `vat skills validate`.

```yaml vat-report=skills validate
status: ok
examined: 2
findings: []
summary:
  errors: 0
  warnings: 0
  info: 0
gate:
  strict: false
durationMs: 144
data:
  root: /work/project
  skills:
    - name: test-skill-1
      status: ok
      summary:
        errors: 0
        warnings: 0
        info: 0
      allowed: 0
    - name: test-skill-2
      status: ok
      summary:
        errors: 0
        warnings: 0
        info: 0
      allowed: 0
```

### `skills list`

The same project listed. Produced by `vat skills list`.

```yaml vat-report=skills list
status: ok
examined: 1
findings: []
summary:
  errors: 0
  warnings: 0
  info: 0
gate:
  strict: false
durationMs: 24
data:
  root: /work/project
  context: project
  skills:
    - path: packages/test-skill-2/resources/skills/SKILL.md
      name: test-skill-2
      valid: true
    - path: resources/skills/SKILL.md
      name: test-skill-1
      valid: true
```

### `skills build`

Both skills built into `dist/skills/`. Produced by `vat skills build`.

```yaml vat-report=skills build
status: ok
examined: 2
findings: []
summary:
  errors: 0
  warnings: 0
  info: 0
gate:
  strict: false
durationMs: 223
data:
  dryRun: false
  validated: true
  skillsBuilt: 2
  skillsFailed: 0
  skillsFailedValidation: 0
  skillsInPlace: []
  skillsPluginOnly: []
  outputCommitted: true
  skills:
    - name: test-skill-1
      source: resources/skills/SKILL.md
      output: dist/skills/test-skill-1
      status: ok
    - name: test-skill-2
      source: packages/test-skill-2/resources/skills/SKILL.md
      output: dist/skills/test-skill-2
      status: ok
```

A dry run of a two-skill project: nothing validated or built, so every row is `not-built` and
`dist/skills` is untouched. Produced by `vat skills build --dry-run`.

```yaml vat-report=skills build
status: ok
examined: 2
findings: []
summary:
  errors: 0
  warnings: 0
  info: 0
gate:
  strict: false
durationMs: 119
data:
  dryRun: true
  validated: false
  skillsBuilt: 0
  skillsFailed: 0
  skillsFailedValidation: 0
  skillsInPlace: []
  skillsPluginOnly: []
  outputCommitted: false
  skills:
    - name: skill1
      source: skills/skill1/SKILL.md
      output: dist/skills/skill1
      status: not-built
    - name: skill2
      source: skills/skill2/SKILL.md
      output: dist/skills/skill2
      status: not-built
```

### `skills package`

One skill packaged. Produced by `vat skills package resources/skills/SKILL.md -o dist/pkg`.

```yaml vat-report=skills package
status: ok
examined: 1
findings: []
summary:
  errors: 0
  warnings: 0
  info: 0
gate:
  strict: false
data:
  skill: test-skill-1
  version: null
  outputPath: dist/pkg
  dryRun: false
```

### `skills install`

A built skill installed to the user scope (home directory shortened). Produced by `vat skills install dist/skills/test-skill-1 --target claude --scope user`.

```yaml vat-report=skills install
status: ok
examined: 1
findings: []
summary:
  errors: 0
  warnings: 0
  info: 0
gate:
  strict: false
data:
  source: /work/project/dist/skills/test-skill-1
  target: claude
  scope: user
  dryRun: false
  skills:
    - name: test-skill-1
      installPath: ~/.claude/skills/test-skill-1
durationMs: 1598
```

### `skill review`

The review checklist, cut to its first section. Produced by `vat skill review resources/skills/SKILL.md --yaml`.

```yaml vat-report=skill review
status: ok
examined: 1
findings: []
summary:
  errors: 0
  warnings: 0
  info: 0
gate:
  strict: false
data:
  skill: test-skill-1
  source: /work/project/resources/skills/SKILL.md
  metadata:
    skillLines: 13
    totalLines: 13
    fileCount: 1
    directFileCount: 0
    maxLinkDepth: 0
    excludedReferenceCount: 0
    excludedReferences: []
  sections:
    - section: Naming
      codes: []
      manual:
        - "[A] Does the name use gerund form (e.g. processing-pdfs) or an acceptable alternative (noun/verb phrase)?"
        - "[A] Does the name avoid vague terms like helper, utils, tools?"
durationMs: 62
```

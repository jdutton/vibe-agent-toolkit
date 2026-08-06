---
name: vat-skill-authoring
description: Use when authoring or revising a SKILL.md file — frontmatter, body
  structure, references, packagingOptions, validation overrides — or when
  writing and bundling the cross-platform Node scripts a skill ships.
---

# VAT Skill Authoring: SKILL.md Structure and Packaging

This skill covers authoring SKILL.md files for portable Claude skills: frontmatter shape, body structure, reference links, the packaging options that control how the skill is bundled for distribution, and how to build the Node scripts a skill ships so they still run on the machine that installs it. For the TypeScript agent side (archetypes, result envelopes, orchestration, runtime adapters) use `vibe-agent-toolkit:vat-agent-authoring`.

## SKILL.md Structure

A SKILL.md file is the definition file for a portable skill. It tells Claude what the skill does and how to use it. All SKILL.md files must have YAML frontmatter:

```markdown
---
name: my-skill
description: One sentence — what this skill does and when to use it (≤250 chars)
---

# My Skill

Rest of the skill documentation...
```

Required frontmatter fields:

- `name` — unique identifier, kebab-case (`^[a-z][a-z0-9-]*$`), matches the skill's directory name after build. Avoid the reserved words `claude` and `anthropic` (Claude Code rejects non-certified skills using those words — surfaced as `RESERVED_WORD_IN_NAME`).
- `description` — trigger description used for Claude's skill routing; be specific about activation conditions.

Best practices for `description`:

- Lead with an action verb or `Use when <concrete trigger>` — filler openers like "This skill...", "A skill that...", "Use when you want to..." fire `SKILL_DESCRIPTION_FILLER_OPENER`.
- Include 2–4 trigger keywords a user is likely to type.
- Write in third person. First-person ("I can...") and conversational second-person ("You can use...") fire `SKILL_DESCRIPTION_WRONG_PERSON`.
- Keep under 250 characters so the Claude Code `/skills` listing doesn't truncate the tail (target ≤200 for safety, ≤130 if shipping a large skill collection). The hard schema limit is 1024.

Other frontmatter keys — keep them conservative:

- The standard key set is `name`, `description`, `allowed-tools`, `argument-hint`, `metadata`, `license`, `compatibility`, `model` (plus the Claude Code behavior flags `disable-model-invocation`, `user-invocable`, `context`, `agent`, `hooks`). VAT warns on anything outside it via `SKILL_FRONTMATTER_EXTRA_FIELDS` (one issue per non-standard field) — spec-compliant consumers silently ignore unknown keys, so a bare `version:` or `team:` looks declarative but carries no semantics off your project.
- Stamp per-skill data — `version`, `team`/owner, status — under the allowed `metadata:` mapping (nest `version:`/`team:` beneath `metadata:`), **not** as bare top-level keys. For VAT packaging/validation config, use `vibe-agent-toolkit.config.yaml` under `skills.config.<name>`, never the frontmatter. (The cross-document reference keys below are the one routine exception — VAT resolves them for link validation; keep other custom data under `metadata:`.)

## Cross-document references in SKILL.md frontmatter

When SKILL.md frontmatter references other documents (parent specs, ADRs,
related skills), use **leading-`/`** URI-references:

```yaml
---
parent_spec: /docs/specs/foo.md
related-skills:
  - /packages/foo/resources/skills/bar/SKILL.md
---
```

These resolve against the project root per RFC 3986 §4.2 (same rule VAT
applies to body links). Source-relative paths (`../../docs/foo.md`) also
work but are fragile when skills move.

If a tool needs to programmatically rewrite these references — e.g., when
moving a file — load [[markdown-rewriting]] for the canonical pattern.
Never use `gray-matter`, `front-matter`, or `js-yaml` directly for SKILL.md
edits; they silently drop frontmatter comments. ESLint enforces this for
VAT-internal code.

## Body Structure

- Lead with a short orientation paragraph: what the skill owns and when to reach for it.
- Use H2 sections for major content blocks; avoid deeply nested H3/H4 trees — they hurt Claude's ability to route attention inside the file.
- Keep SKILL.md under ~500 lines. Longer than that fires `SKILL_LENGTH_EXCEEDS_RECOMMENDED` and is a strong signal to split via progressive disclosure (linked reference files) or to spin the content into a sibling skill.
- Avoid time-sensitive phrasing like "as of April 2026" in the body — it ages the skill quickly (`SKILL_TIME_SENSITIVE_CONTENT`).

## References Section

A short `## References` section at the bottom is the canonical place to list linked resources. Two patterns:

- **Progressive disclosure** — link to `.md` files inside the skill directory that get bundled. Keep reference depth ≤ 2 hops; deeper chains fire `REFERENCE_TOO_DEEP`.
- **Prose references to sibling skills** — write `vibe-agent-toolkit:vat-audit`, not `[vat-audit](./vat-audit.md)`. Markdown links to sibling SKILL.md files cause the packager to transclude the other skill (and fire `LINK_TO_SKILL_DEFINITION`).

Avoid linking to navigation files (`README.md`, `index.md`) — they're excluded from the bundle and the link resolves to nothing (`LINK_TO_NAVIGATION_FILE`).

## Referencing bundled scripts and assets (portability)

When the body tells the agent to run a bundled script or read a bundled asset, **reference it by a relative path rooted at the skill directory** — `scripts/run.mjs`, `assets/template.xlsx` — and nothing else. This is the only form that is portable across the surfaces a skill can run on (Claude Code plugins, claude.ai uploads, the API container, and others).

**Never anchor the path on `CLAUDE_PLUGIN_ROOT`, an absolute path, or any environment variable.** Two reasons:

1. **`CLAUDE_PLUGIN_ROOT` is a Claude-Code-plugin-only construct — it is not part of the portable skill contract.** It does not exist when the same skill is mounted standalone (a claude.ai upload, an API-uploaded skill, `~/.claude/skills/`). A skill that depends on it stops being portable, which defeats the purpose of shipping a skill.
2. **Even inside Claude Code it points at the wrong root.** It resolves to the *plugin* directory, not the skill, so authors append the plugin-relative segment `skills/<name>/…`. That segment only exists under plugin mounting; under a single-skill mount the skill directory *is* the root, so a `${CLAUDE_PLUGIN_ROOT}/skills/<name>/scripts/run.mjs` path silently 404s — and it 404s on the user's very first invocation, the most expensive place to fail.

**Why relative paths work everywhere:** at runtime the agent reads `SKILL.md` from the skill's own directory, then runs bundled scripts from there. A bundled script is a sibling of `SKILL.md`, so a skill-relative path resolves wherever the skill happens to be mounted. "Relative to the skill root" is the one anchor guaranteed to exist on every surface. (See Anthropic's [skill authoring best practices](https://platform.claude.com/docs/en/docs/agents-and-tools/agent-skills/best-practices) — every script example there is a skill-relative path; `CLAUDE_PLUGIN_ROOT` appears nowhere.)

**The one gotcha — working directory.** The agent's cwd when it runs a command is not guaranteed to be the skill directory (it is often the user's project). So either state plainly that paths are *relative to this skill's directory (the folder containing SKILL.md)*, or have the skill `cd` into its own directory first.

```bash
# ✅ Portable — relative to the skill directory
node scripts/run.mjs <verb> ...

# ❌ Non-portable — Claude-Code-plugin-only, and the skills/<name>/ segment
#    breaks under a standalone skill mount
node "${CLAUDE_PLUGIN_ROOT}/skills/my-skill/scripts/run.mjs" <verb> ...
```

A script bundled via the `files:` config lands at a skill-relative `dest` (e.g. `scripts/run.mjs`) — reference it in the body by that same relative path, so the documented invocation and the packaged layout are the same string. `files:` is also what lets `vat verify` confirm the artifact actually ships at that path (see `vibe-agent-toolkit:vat-skill-distribution`); a script injected by an external build step VAT can't see has no such guarantee.

## Building a bundled script that actually runs

Referencing the script correctly is half the job. The other half is making sure the file sitting at that path can execute on the machine that installed the skill.

**Start from the environment truth.** A bundled script runs where there is no `node_modules`. A claude.ai upload, a marketplace install, the API container — none of them install your dependencies and none of them run your package manager. Node builtins are the entire runtime you get. Any surviving import of a non-builtin package is a runtime failure at the user's first invocation, which is the most expensive place to fail.

**So bundle it.** Compile the entry point and everything it imports into a single self-contained, tree-shaken ESM `.mjs` — esbuild or equivalent, `--bundle --format=esm --platform=node`. Give it a `#!/usr/bin/env node` shebang so it is directly executable, and no top-level `module.exports`: the artifact is ESM, and a stray CJS export marks it as a module the loader will refuse.

**Verify statically, in the build.** After writing the bundle, scan it for module specifiers that are neither relative nor Node builtins — `import … from '…'`, `export … from '…'`, and dynamic `import('…')`. Any hit fails the build; a warning is not enough, because one external makes the artifact broken for every user. Two details keep the scan from lying:

- **Anchor the match on a line-start `import`/`export`.** esbuild hoists imports to the top, one per line, so a line-anchored pattern finds all of them — while an unanchored search for `from '…'` also matches template literals and ordinary strings that merely contain the word "from", and you learn to ignore the check.
- **Skip comment lines.** A JSDoc `@example` that shows `import { thing } from 'some-package'` is documentation, not a dependency. Without the skip it fails a build that is perfectly correct.

**Also clean-room boot it — on three legs, not one.** The scan and the boot catch different failures: the boot catches a real external whose specifier the regex never shape-matched (it surfaces as `ERR_MODULE_NOT_FOUND` at startup) and it catches a fail-open bin that exits 0 having printed nothing. Run it — `--help` is enough — asserting a zero exit **and** non-empty output. *Where* you run it decides what you are able to detect at all:

- **Under the shipped `dest` name**, in a fresh temp directory outside any `node_modules` tree. Catches the rename trap below.
- **Through a symlink whose name differs from its target.** Catches the realpath trap below.
- **From a packed tarball installed outside the workspace** — pack the package, install the tarball into a throwaway project, and invoke the bin through `node_modules/.bin/`. This is the only leg that reproduces the real installed layout, symlinks and all.

A clean room that only *copies* files — the shape most projects reach for first, and the shape the first leg alone has — **certifies fail-open bins as healthy**. A copy has no symlink, so it is structurally incapable of seeing the realpath trap. The second and third legs are not refinements of the first; they are the only legs that can see that defect.

**Boot it under its SHIPPED name, not just its build-time name.** This is the least obvious rule here and the one most likely to cost you a release. The `files:` config injects a bundle at whatever `dest` you declare, which is routinely a different name than it was built as — `dist/bin/foo.mjs` shipping as `scripts/foo-cli.mjs`. A script that decides "am I being run directly?" by comparing the basename of `process.argv[1]` against its own build-time filename evaluates that guard as **false** under the shipped name. Every command then exits 0 having printed nothing: the script is inert, and it reads as success to every instrument that watches exit codes. Booting only under the build-time name reproduces the invocation a developer already performs by hand, which is exactly why this class of defect survives normal testing — it exists only in the artifact nobody executes.

```javascript
// ❌ False under any dest whose basename differs — every verb silently no-ops
if (basename(process.argv[1]) === 'foo.mjs') await main();
```

**The identity guard fails the same way under a symlink.** The obvious repair is to compare identities instead of basenames. It looks airtight. It is not:

```javascript
// ❌ False whenever argv[1] is a symlink — same inert, exit-0 signature
if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
```

npm writes `node_modules/.bin/<name>` as a **symlink**. Invoked through it, `process.argv[1]` is the link path while `import.meta.url` is the realpath of the target — different strings, guard false, `main()` never runs, exit 0, nothing printed. That is the identical signature to the rename trap above, with a different trigger, and it fires on the single most common way anyone ever invokes your bin: the installed one. A sweep of one consuming project found three bins carrying it. And a copy-based clean room cannot see it, because a copy has no symlink; the defect is reproducible only from a real install.

**So don't ship an entry guard at all.** Make the bin a guard-free entry module whose only job is to call the CLI's main function:

```javascript
#!/usr/bin/env node
// bin/foo.mjs — the bundle entry point. No guard, so there is nothing to evaluate false.
import { main } from '../src/cli.js';

await main();
```

Rename it, symlink it, resolve it through three levels of realpath — it still runs, because there is no condition to get wrong. If you insist on a guard, it must compare `import.meta.url` against `pathToFileURL(realpathSync(process.argv[1]))`, not against `process.argv[1]` raw, and it must survive `argv[1]` being absent or unresolvable. That the correct spelling takes a sentence to state, and that both natural spellings of it are wrong, is exactly why the guard-free entry module is the recommendation rather than a stylistic preference.

Declaring the script under `files:` with the `dest` the body references is what makes this checkable at all: it is the one place the shipped name is written down, and it is what lets `vat verify` confirm the artifact ships at the path the body tells the agent to run.

## Cross-platform helpers for skill scripts and dev tooling

Bundled skill scripts — and the build, CI, and validation tooling around them — run on Windows, macOS, and Linux, and Node's own path and process APIs do not behave the same on all three. `@vibe-agent-toolkit/utils` is the shared answer to those potholes. It is Node-only and requires Node >= 22.

Import from the narrow subpath rather than the `.` barrel. The package sets `"sideEffects": false`, so a tree-shaking bundler drops what you don't call either way — the difference is not bundle size, it is what your build has to **resolve**. The `.` barrel's module graph reaches `yaml`, `handlebars`, and `node:fs` no matter what you destructure, so every one of those must be installed for the bundle to build; `@vibe-agent-toolkit/utils/path` reaches `node:path` and nothing else. Depend on the package at build time and let the bundler inline it — nothing survives as an import, so the external-import scan above still passes.

| Subpath | Contents |
|---|---|
| `@vibe-agent-toolkit/utils/path` | `safePath.join/resolve/relative`, `toForwardSlash`, `toAbsolutePath`, `getRelativePath`, `isAbsolutePath`, `isAbsoluteAnyPlatform`, `hasParentTraversalSegment` |
| `@vibe-agent-toolkit/utils/fs` | `normalizePath`, `normalizedTmpdir`, `mkdirSyncReal`, `resolveFromImportMeta`, `dynamicImportPath` |
| `@vibe-agent-toolkit/utils/process` | `safeExecSync`, `safeExecResult`, `spawnHardened`, `shouldUseShell`, `windowsShellQuote`, `buildWindowsShellLine`, `makeStdioBlocking` |
| `@vibe-agent-toolkit/utils/git` | `gitFindRoot`, `gitLsFiles`, `isGitIgnored`, `loadGitignoreRules`, `GitTracker` |

The concrete failures these prevent:

- **Path comparisons that fail only on Windows.** `path.join()` returns `a\b` there and `a/b` everywhere else, so the same file compares unequal to itself, misses in a `Map` keyed by path, and never matches a forward-slash glob. Everything on `./path` returns forward slashes on every platform — use it for comparisons, `Map` keys, globs, and anything you print.
- **A temp directory that doesn't exist.** `os.tmpdir()` can hand back an 8.3 short path on Windows (`C:\Users\RUNNER~1\…`), which is not string-equal to the long path you build later, so `existsSync` reports false on a directory you just created. Use `normalizedTmpdir()`, `mkdirSyncReal()`, and `normalizePath()`. These return **OS-native** separators on purpose — they resolve real filesystem identity through `realpathSync.native()`, which is what expands short names. Wrap them in `toForwardSlash()` at the moment you need the string for a comparison, not before.
- **Spawning an npm-installed CLI.** On Windows those are `.cmd`/`.bat` shims that cannot be spawned directly; a naive `spawn` fails with `EINVAL` or `ENOENT`. Use `spawnHardened()` for async streaming work and `safeExecSync()`/`safeExecResult()` for synchronous calls — they pick the shell correctly and quote for it. `shouldUseShell()`, `windowsShellQuote()`, and `buildWindowsShellLine()` are there if you must hand-roll the invocation.
- **`await import()` of an absolute path.** Windows rejects a bare absolute path as a module specifier (`ERR_UNSUPPORTED_ESM_URL_SCHEME`) because it is not a `file://` URL. Use `dynamicImportPath()`, and `resolveFromImportMeta()` for paths relative to an `import.meta.url`.
- **Output truncated by `process.exit()`.** A published bin can exit before stdout flushes, printing nothing on the run that mattered. `makeStdioBlocking()` closes that.
- **Build guards and gates that need git.** `gitFindRoot()`, `gitLsFiles()`, `isGitIgnored()`, `loadGitignoreRules()`, and `GitTracker` (cached, for repeated checks) cover repository introspection without shelling out by hand.

If your project writes this kind of tooling regularly, ban raw `path.join`/`resolve`/`relative` with a lint rule and point it at `safePath` — the separator bug is invisible on the author's machine and only ever appears in someone else's CI.

## packagingOptions Reference

Packaging options are configured per skill in `vibe-agent-toolkit.config.yaml` under `skills.config.<name>`:

```yaml
skills:
  include: ["resources/skills/SKILL.md", "resources/skills/*.md"]
  defaults:
    linkFollowDepth: 2
  config:
    my-skill:
      linkFollowDepth: 1
      resourceNaming: resource-id
      stripPrefix: knowledge-base
      excludeReferencesFromBundle:
        rules:
          - patterns: ["**/concepts/**"]
            template: "Use search to find: {{link.text}}"
        defaultTemplate: "{{link.text}} (search knowledge base)"
```

**`linkFollowDepth`** — How deep to follow links from SKILL.md:

| Value | Behavior |
|-------|----------|
| `0` | Skill file only (no links followed) |
| `1` | Direct links only |
| `2` | Direct + one transitive level **(default)** |
| `"full"` | Complete transitive closure |

**`resourceNaming`** — How bundled files are named:

| Strategy | Example | Use When |
|----------|---------|----------|
| `basename` | `overview.md` | Few files, unique names **(default)** |
| `resource-id` | `topics-quickstart-overview.md` | Many files, flat output |
| `preserve-path` | `topics/quickstart/overview.md` | Preserve structure |

Use `stripPrefix` to remove a common directory prefix (e.g., `"knowledge-base"`).

**`excludeReferencesFromBundle`** — Rules for excluding files and rewriting their links:

- `rules[]` — ordered glob patterns (first match wins), each with optional Handlebars template
- `defaultTemplate` — applied to depth-exceeded links not matching any rule

**Template variables:**

| Variable | Description |
|----------|-------------|
| `{{link.text}}` | Link display text |
| `{{link.href}}` | Original href (without fragment) |
| `{{link.fragment}}` | Fragment including `#` prefix, or empty |
| `{{link.type}}` | Link type (`"local_file"`, etc.) |
| `{{link.resource.id}}` | Target resource ID (if resolved) |
| `{{link.resource.fileName}}` | Target filename (if resolved) |
| `{{skill.name}}` | Skill name from frontmatter |

## Validation Overrides

The `validation` sub-key in a skill's config provides the unified override framework for VAT validation codes:

```yaml
skills:
  config:
    my-skill:
      validation:
        severity:
          LINK_DROPPED_BY_DEPTH: error           # upgrade: block on depth-dropped links
          LINK_TO_NAVIGATION_FILE: ignore        # silence: this skill intentionally links to READMEs
        allow:
          LINK_TO_GITIGNORED_FILE:
            - paths: ["references/generated-index.md"]
              reason: "build artifact, reviewed"
              expires: "2026-09-30"
          SKILL_LENGTH_EXCEEDS_RECOMMENDED:
            - reason: "whole-skill concern; paths defaults to ['**/*']"
```

Two sub-keys, each covering a different override granularity:

- **`severity`** — class-level. Raise any code to `error` (blocks build), lower to `warning` (emits, non-blocking), or `ignore` (fully suppressed). Applies to every instance of that code.
- **`allow`** — per-instance. Suppress specific `(code, path)` matches with a required `reason` and optional `expires` date. `paths` is optional (defaults to `["**/*"]` — the whole skill). Use for legitimate exceptions that don't warrant code-wide silencing.

Common adjustments:

- Downgrade `LINK_DROPPED_BY_DEPTH` to `ignore` when intentionally linking out to external docs.
- Do **not** waive `PACKAGED_UNREFERENCED_FILE` for a file consumed programmatically — declare it under `files:` instead. A declared `dest` is exempt from the orphan check, so a waiver list here is just a hand-maintained duplicate of the `files:` map.
- Raise `ALLOW_EXPIRED` to `error` for zero-tolerance expiry policies.

Expired `allow` entries still apply — VAT emits `ALLOW_EXPIRED` as a reminder rather than silently re-surfacing the underlying issue (no surprise build breaks when a date passes). Unused `allow` entries surface as `ALLOW_UNUSED` (analogous to ESLint's unused-disable).

`vat audit` is advisory: it applies `severity` for display grouping only, ignores `allow`, and always exits 0. Use `vat skills validate` or `vat skills build` for gated checks.

## Pre-publication Check

Before shipping a skill, walk through the `vibe-agent-toolkit:vat-skill-review` checklist — it covers naming, description quality, structure, validation-code triage, and Anthropic's skill-authoring best practices. The `vat skill review <skill>` CLI command renders a skill-specific view of the same checklist.

## References

- `vibe-agent-toolkit:vat-skill-review` — pre-publication quality checklist (general + CLI-backed items, tied to VAT validation codes)
- `vibe-agent-toolkit:vat-skill-distribution` — plugin/marketplace config, `vat build`, `vat verify`, npm publishing
- `vibe-agent-toolkit:vat-knowledge-resources` — the `resources:` config section for multi-collection frontmatter schema validation
- Validation Codes Reference — full list of codes VAT emits, their default severity, and override recipes.
- Skill Quality and Compatibility — VAT's Stance — what VAT believes makes a skill good and compatible.

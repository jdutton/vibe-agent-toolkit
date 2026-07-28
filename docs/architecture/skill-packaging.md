# Skill Packaging Shapes

VAT recognizes four skill/plugin packaging shapes. Each has a distinct directory layout, a distinct set of applicable validation codes, and (in the case of skill-claude-plugin) a distinct graduation path from a simpler shape.

## Shapes

### Standalone skill

A bare skill with no plugin packaging. Multi-AI-platform: the same `SKILL.md` works across Claude Code, Claude Chat, and any other runtime that understands the agent-skills contract.

```
my-skill/
└── SKILL.md
```

**Canonical location for Claude Code:** `~/.claude/skills/<name>/SKILL.md`.

Applicable validation: all skill-level codes (`SKILL_NAME_*`, `SKILL_DESCRIPTION_*`, `LINK_*`, capability observations, etc.). No plugin-level codes apply.

### Skill-claude-plugin

A skill that self-publishes as a Claude plugin by co-locating `.claude-plugin/plugin.json` at the same root as `SKILL.md`. The skill is authoritative; the plugin manifest is a Claude-specific distribution wrapper.

```
my-skill/
├── SKILL.md
└── .claude-plugin/
    └── plugin.json
```

**Graduation:** a standalone skill becomes a skill-claude-plugin by adding `.claude-plugin/plugin.json`. The skill itself remains platform-agnostic; the graduation adds Claude-specific packaging that makes the skill installable via `claude plugin install`.

Applicable validation: all skill-level codes (on the skill surface) PLUS all plugin-level codes (on the plugin surface), PLUS `SKILL_CLAUDE_PLUGIN_NAME_MISMATCH` when the two manifests declare different `name` values.

### Claude-plugin (canonical Anthropic layout)

A Claude plugin that packages one or more skills under a `skills/` subdirectory. This is the canonical Anthropic layout documented at [code.claude.com/docs/en/plugins-reference](https://code.claude.com/docs/en/plugins-reference).

```
my-plugin/
├── .claude-plugin/
│   └── plugin.json
├── skills/
│   ├── skill-a/
│   │   └── SKILL.md
│   └── skill-b/
│       └── SKILL.md
└── commands/           # optional
```

Applicable validation: plugin-level codes on the plugin manifest; skill-level codes on each nested skill; no cross-check between plugin name and individual skill names (they are independent by design — plugins can ship any number of skills under namespaced names).

### Claude-marketplace

A marketplace manifest that lists one or more plugins available for installation.

```
my-marketplace/
└── .claude-plugin/
    └── marketplace.json
```

A marketplace may **co-locate a single plugin** via `source: "./"` — see `format-detection.ts` co-located pattern detection. When co-located, the directory is treated as a single marketplace surface, not two surfaces, to preserve the historical contract.

Applicable validation: marketplace-level codes.

## Detection

`vat audit` uses `enumerateSurfaces(dir)` (in `packages/agent-skills/src/validators/format-detection.ts`) to find every manifest at a directory's root layer. A directory can contain:

- Zero surfaces (audit falls through to recursive scan)
- One surface (single-validator dispatch; legacy behavior preserved)
- Two surfaces (typically a skill-claude-plugin — skill + plugin emit independently)
- Three surfaces (rare: skill + plugin + marketplace in one directory — allowed but unusual)

## One Production Path for Skills

`vat claude plugin build` (`packages/cli/src/commands/claude/plugin/build.ts`) assembles a Claude-plugin's non-skill content and its skills through two different mechanisms — but only ONE of them ever produces a skill:

- **Tree-copy** (`packages/cli/src/commands/claude/plugin/tree-copy.ts`, `treeCopyPlugin`) copies everything under the plugin's source directory verbatim, except `.claude-plugin/` (owned by the `plugin.json` merge-write) and, unconditionally, **every plugin-local skill directory** (`excludeSkillDirs`). What's left — `commands/`, `hooks/`, `agents/`, `.mcp.json`, and any other root files — has no packaging semantics of its own, so a byte-for-byte copy is correct for it.
- **Packaging** (`packagePluginLocalSkills` in `build.ts`) runs every plugin-local skill (a skill under the plugin's own `skills/` source tree) through `packageSkill` — the identical packager pool skills (`vat skills build`) use. Each skill gets its own effective packaging config (`skills.config.<name>` merged over `skills.defaults`, keyed by the skill's declared name or its directory name), so link-following, reference-rewriting, `files:` injection, and declared-test-input exclusion all apply exactly as they do for a pool skill. A skill whose packaged output fails post-build validation now **fails the plugin build**, holding plugin-local skills to the same bar `vat skills build` already holds pool skills to.

A skill is therefore never tree-copied — `applyTreeCopiedSkillFiles` (the old function that re-applied `files:` semantics on top of a verbatim copy) no longer exists. Before this, a plugin-local skill's whole source directory shipped byte-for-byte: eval suites (answer keys included), scratch files, and un-rewritten links all shipped, `files:` had to be re-implemented on the tree-copy side to compensate, and no post-build validation ever ran against the result. "What ships in a skill" now has exactly one answer, regardless of whether the skill came from the shared pool or a plugin's own `skills/` tree.

One collision case remains, orthogonal to the tree-copy/package split above: a skill name can be BOTH selected from the pool (via a plugin's `skills:` selector) AND present in the plugin's own `skills/` source tree. The collision referee (`resolveCollidingSkillDirs`) resolves this before either mechanism runs — the pool-packaged copy (already built by `vat skills build`, with its own links already rewritten) wins, and the plugin-local copy is excluded from `packagePluginLocalSkills` for that name (it was never eligible for tree-copy either, since all skill directories are excluded from the tree-copy unconditionally).

## Inventory Layer

The shapes above describe what an artifact *is*; the inventory layer describes what an artifact *contains*. Every detector that walks a plugin/marketplace/skill/install consumes the same structural model: a vendor-neutral interface (`packages/agent-skills/src/inventory/`) plus concrete extractors (`packages/claude-marketplace/src/inventory/`). The inventory is the single source of truth for "what does this artifact structurally hold" — declared components from the manifest, components discovered on disk, cross-component references, and parse errors. `vat audit` and `vat inventory` both build from it; new detectors are pure consumers of the model and never re-walk the filesystem.

The four inventory kinds:

- **Marketplace** — `marketplace.json` plus the plugin entries it declares and any plugins discovered on disk under it.
- **Plugin** — `plugin.json` (or absent, for the skill-claude-plugin shape) plus the components it declares in tri-state form (`null` = auto-discovery, `[]` = explicit suppression, populated list = explicit declaration) and the components discovered on disk.
- **Skill** — `SKILL.md` frontmatter plus the linked and packaged files referenced from it.
- **Install** — `~/.claude/plugins/` (or any install root) and the marketplaces and plugins under it.

The inventory schema is `vat.inventory/v1alpha`; it evolves freely under pre-1.0. Output is available via `vat inventory <path>` (YAML, JSON, or `--shallow` projection).

## Skill Reference Resolution

The shapes above describe what an artifact *is*. This section describes how a command turns a **skill reference** — the subject you hand to `vat skill test run`, `vat audit`, or `vat skill review` (a bare name like `my-skill`, a path like `./dist/skills/x`, or a source spec like `npm:@scope/s@1.2.3`) — into something testable or auditable.

### The separator: build-vs-as-is

There is exactly one fork:

- **A config-declared skill → build → test the dist.** This isn't only a bare name: a `<path>` that points AT a declared skill's authored SOURCE directory resolves to the SAME `buildable` result as its name — VAT builds it with the real entry points (`packageSkill` for pool skills, `vat claude plugin build` for plugin-local skills), then tests the **built dist**. `--no-build` skips that build: it reuses an existing dist as-is (unrebuilt, possibly stale) if one is already present, but hard-fails (exit `2`) if no dist exists yet — it does NOT fall back to testing raw source. Only `--dry-run` degrades to raw source (and only when no dist exists yet).
- **Everything else → test as-is.** Source specs (`workspace:` / `npm:` / `url:` / `vendored`), a `<path>` at a declared skill's already-built DIST directory, and a `<path>` that maps to no declared skill at all are tested exactly as supplied — no build step.

### The load-bearing insight: source ≠ dist for declared skills

For a declared skill, **the authored source tree is not what ships.** `packageSkill` does link-following, reference-rewriting, nav-stripping, and `files:` injection (not `files:` alone) as it produces the dist. Testing the source therefore tests something users never install — the entire reason `buildable` exists. The dist is the only faithful subject.

### `resolveSkillReference` — the single entry point

[`resolveSkillReference(ref, cwd)`](../../packages/cli/src/skill-resolution/) (in `packages/cli/src/skill-resolution/`) is the **single, project-aware entry point** that every skill-reference-taking command routes through: `vat audit`, `vat skill review`, and `vat skill test`. It classifies a reference (the disambiguation ladder) and returns a `SkillReference` whose arm tells the caller what to do — never write a parallel path-only resolver beside it.

The `SkillReference` arms:

- **`buildable`** — a declared skill: build (real entry points), then test the dist.
- **`source`** — test the tree/spec as-is (already-built dist, external source, or undeclared path). Carries an optional `declaredSkill` back-link (see below).
- **`name-miss`** — a bare name in a project that declares no such skill (error; lists known skills).
- **`not-found`** — not a path and no governing config to resolve a name against (error).

#### Path ↔ declared-skill linkage: two directions, two outcomes

A `<path>` is matched against a declared skill's directories in TWO directions, and the direction that hits decides whether the path builds:

- **Forward — path AT the SOURCE dir → `buildable`.** If the path points at a declared skill's authored SOURCE directory (dirname of its `SKILL.md`), `findDeclaredSkillForSourceDir` matches it and the resolver returns the SAME `buildable` result its name would — the path is built (real entry points), then the dist is tested. `--no-build` skips that build: an existing dist is reused unrebuilt (possibly stale); with no dist yet, it hard-fails rather than falling back to raw source — only `--dry-run` does that (and only when no dist exists yet).
- **Reverse — path AT the DIST dir → `source` + `declaredSkill` back-link.** If the path instead points at a declared skill's already-built `expectedDistDir`, the resolver attaches a `declaredSkill` link (name, `configRoot`, authored `sourcePath`) via `findDeclaredSkillForPath`, but does **not** rebuild it — it is staged **as-is**. This is the reverse of the forward match above: it walks up from the path (config-first, so a monorepo package config beats the repo `.git`) and matches it against each declared skill's forward-computed dist dir (both directions share `computeSkillDistribution`).

Both directions apply to the `path:<dir>` spelling too. That prefix exists only to disambiguate a path from a bare name; it is **not** a build directive, so `path:./skills/foo` and `./skills/foo` resolve identically. (`--no-build` remains the only build directive.) The other source specs — `workspace:`, `npm:`, `url:`, `vendored` — are not paths into the project tree and are never matched against declared skills.

Either direction lets `vat skill test` honor that skill's persisted `test:` config (model / evals / timeout / `test.build`) and resolve the authored eval suite relative to the **source** dir. A path that matches NEITHER direction is *config-blind*: it is tested as-is with no `test:` config, and the command warns (pointing at the name form). This keeps `resolveSkillReference` the single home for the name↔path mapping — no command re-derives it.

### Reference form → result arm

| Reference form | Result arm |
|---|---|
| bare name matching a declared skill | `buildable` (build → test dist) |
| bare name, undeclared, but an existing local dir | `source` (path, as-is) |
| bare name, undeclared, not a dir, inside a project | `name-miss` |
| bare name, no governing config, existing dir | `source` (path, as-is) |
| bare name, no governing config, not a dir | `not-found` |
| `<path>` at a declared skill's SOURCE dir | `buildable` (build → test dist; same contract as its name) |
| `<path>` at a declared skill's built dist | `source` (path, as-is) + `declaredSkill` back-link (honors its `test:` config) |
| `<path>` mapping to no declared skill (incl. the `./<name>` escape) | `source` (path, as-is — config-blind, never name-resolved) |
| `workspace:<pkg>` | `source` |
| `npm:<spec>` | `source` |
| `url:<u>` | `source` |
| `path:<dir>` | same as a bare `<path>` — the three `<path>` rows above apply (`buildable` at a declared skill's SOURCE dir, otherwise `source`) |
| `vendored` | `source` |

## Decision Records

### AC-10d — Plugin-local `files:` deferred paths are out of scope for issue #127 / slice 2 of #129

**Status: SUPERSEDED.** The premise below no longer holds — see [One Production Path for Skills](#one-production-path-for-skills) above. Plugin-local skills are packaged through `packageSkill` and get the same `files:` / deferred-artifact handling pool skills always had; there is no longer a second, tree-copied surface for `files:` to be out of scope of. Kept for history.

**Original decision:** Plugin-local `files:` deferred paths are **out of scope** for this slice.

Tree-copied plugin-local skills (`vat claude plugin build`) had no `files:` surface of their own at the time — plugin-level `files[].dest` rejects `skills/…` paths, and tree-copied skills bypassed `packageSkill` entirely. As a result, the deferred-path wiring introduced in issue #127 (slice 2 of #129) applied exclusively to skills built through the packaging path (`packageSkill`).

A plugin-local `files:` deferred surface was deliberately **not** introduced here. The skill-stream (`packageSkill`) remained the sole owner of `files:`, and adding a parallel plugin-local deferred surface was deferred to the #129 engine slice (slice 3), where `DeferredArtifacts` becomes an engine input rather than a per-path co-change.

## See also

- [`docs/validation-codes.md`](../validation-codes.md) — every validation code by name, default severity, and applicable shapes.
- [`docs/skill-quality-and-compatibility.md`](../skill-quality-and-compatibility.md) — VAT's stance on structure, packaging, and compatibility.
- [`docs/research/2026-05-03-claude-plugin-loader-semantics.md`](../research/2026-05-03-claude-plugin-loader-semantics.md) — empirical Claude Code loader behavior behind the tri-state declared-vs-discovered model.

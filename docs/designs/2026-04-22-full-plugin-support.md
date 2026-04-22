# Full Claude Code Plugin Support in VAT

**Status:** Approved
**Date:** 2026-04-22
**Author:** Brainstormed with Pilo

## Problem

VAT's plugin publish is skills-only. `ClaudeMarketplacePluginEntrySchema` in `packages/resources/src/schemas/project-config.ts` is `.strict()` and accepts only `{ name, description, skills }`. `buildPlugin()` in `packages/cli/src/commands/claude/plugin/build.ts` only copies skills; it never handles `commands/`, `hooks/`, `agents/`, or `.mcp.json`.

Claude Code plugins natively support commands, hooks, agents, and MCP servers alongside skills. VAT adopters who want to ship those must either (a) hand-author a marketplace outside VAT (giving up skill bundling) or (b) post-process VAT's dist tree before publish. Both are workarounds.

Concrete consumer needs (AvonRisk SDLC plugin):
- Slash commands (`/sdlc:app:create`, `/sdlc:canon:refresh`, …)
- SessionStart hook for discovery / staleness nudges

Both are generic plugin-authoring needs, not AvonRisk-specific. Other adopters hit the same wall as soon as they want anything beyond skills.

## Goals

1. A VAT repo can declare a plugin with **any** Claude-plugin asset type (commands, hooks, agents, MCP, supporting scripts/code/references) and have `vat claude plugin build` produce a correctly-shaped plugin directory.
2. Existing skills-only configs continue to work unchanged.
3. An existing native Claude plugin can be lifted into VAT by dropping it under `plugins/<name>/` with minimal rework.
4. Plugin-local skills get the same validation and bundling rigor as pool skills.

## Non-Goals

- Asset-pool sharing of commands/hooks/agents across plugins (deferred until concrete demand)
- Deep schema validation of Claude's `hooks.json`, `.mcp.json`, or agent frontmatter (Claude validates at runtime; VAT only parses)
- Hook-script processing (compilation, transitive deps) — authors ship compiled artifacts themselves
- Backwards-compat shims (pre-1.0 policy: break freely)
- Changes to `marketplace.json` structure
- New top-level CLI commands

## Design

### Source layout

Additive to today's layout. Skills pool stays unchanged; a new top-level `plugins/` dir holds per-plugin native-shape directories:

```
vibe-agent-toolkit.config.yaml
skills/                          # existing — shared pool (unchanged)
  <skill>/SKILL.md
plugins/                          # NEW — one dir per plugin
  <plugin>/
    .claude-plugin/               # author-supplied plugin.json (optional, merged)
    commands/                     # copied tree
    hooks/
    agents/
    .mcp.json                     # if present
    skills/                       # plugin-local skills
      <skill>/SKILL.md
    scripts/ lib/ references/ …   # any supporting files, copied as-is
```

**Why this shape:**
- Matches native Claude plugin layout — lifting an existing plugin into VAT means dropping it under `plugins/<name>/`.
- Plugin author files are collocated and `grep`-discoverable as "this plugin's stuff".
- Future Claude plugin features (new directories) work without schema changes — whatever the author puts under `plugins/<name>/` ships.
- Smallest schema surface (one optional `source` field, no per-asset key lists).

### Build pipeline

Each plugin's output is the merger of two streams plus a generated manifest:

```
skills/<name>             ─→ [skill pipeline] ─→ dist/skills/<name>          ─┐
                                                                               ├─→ dist/.../plugins/<plugin>/
plugins/<p>/skills/<name> ─→ [skill pipeline] ─→ dist/plugins/<p>/skills/<n> ─┘       skills/       (pool selections + local)
                                                                                        commands/     (tree copy)
plugins/<p>/{commands,hooks,agents,.mcp.json,scripts,…} ──→ [tree copy] ─────→          hooks/
                                                                                        agents/
                                                                                        .mcp.json
                                                                                        scripts/ lib/ …
                                                                                        .claude-plugin/plugin.json  (merged)
```

**Output paths:**
- Canonical final plugin output path: `dist/.claude/plugins/marketplaces/<marketplace>/plugins/<plugin>/` — matches today's `buildMarketplace()` output (see `packages/cli/src/commands/claude/plugin/build.ts` ~line 233). [inferred]
- Pool-skill intermediate output stays at `dist/skills/<name>/` so standalone `vat skills build` is unchanged. [inferred]
- Plugin-local skill intermediate output is `dist/plugins/<plugin>/skills/<skill>/`. [inferred]
- At plugin-build time, both intermediates are copied into the canonical final path above. [inferred]

**Skill stream (pool + plugin-local):**
- Both run through the **identical existing skill pipeline**: link-following, `excludeReferencesFromBundle`, validation, `files` mappings. One code path, two discovery sources.
- Pool skills are selected per-plugin via the existing `skills: [...]` selector.
- Plugin-local skills are **implicit** — every SKILL.md under `plugins/<name>/skills/` ships with that plugin, no selector needed.
- Plugin-local skills inherit `skills.defaults` from the top-level config but are NOT addressable by `skills.config[<name>]` — that namespace remains pool-only. [inferred] Per-plugin skill overrides are deferred to a future release. [inferred] If a plugin-local skill's name collides with a pool `skills.config` key, the pool config is not applied to the local skill (pool-only scope). [inferred]
- The `publish` key in `skills.defaults` is **NOT inherited** by plugin-local skills — `publish` is a pool-distribution concept (who ships a skill from the shared pool) and has no meaning for plugin-local skills, which are semantically mandatory and always ship with their plugin. [inferred] Setting `skills.defaults.publish: false` at the top level does not suppress plugin-local skills. [inferred] All other `skills.defaults` keys (`linkFollowDepth`, `resourceNaming`, `stripPrefix`, `excludeNavigationFiles`, `excludeReferencesFromBundle`, `validation`, `targets`, `files`) are inherited by plugin-local skills. [inferred]
- Discovered SKILL.md paths are deduplicated by canonical path before the pipeline runs. [inferred] Auto-injected plugin-local globs bypass top-level `skills.exclude` patterns — plugin-local skills are semantically mandatory and cannot be excluded via top-level config. [inferred]
- Output locations stay distinct so ownership is clear: pool → `dist/skills/<name>/`, local → `dist/plugins/<name>/skills/<skill>/`. Both get copied into the final plugin output dir at build time.
- Skill name collision detection runs at the **discovery phase, before any copy**. [inferred] Only a pool-vs-local collision **within the same plugin's selection set** is an error; two different plugins may each have a local skill with the same name because their output directories are disjoint. [inferred] A collision error blocks only the offending plugin's build — other plugins continue. [inferred]

**Tree-copy stream:**
- Everything under the **resolved source directory** (the `source` override if provided, otherwise `plugins/<name>/`) that is not `skills/` and not `.claude-plugin/` is copied as-is. [inferred]
- The `skills/` and `.claude-plugin/` exclusion paths are interpreted relative to the resolved source directory — not relative to the literal `plugins/<name>/` — so they apply correctly when `source` points elsewhere. [inferred]
- Skill auto-discovery follows the same resolved source (i.e., `<source>/skills/**/SKILL.md`). [inferred]
- Respects `.gitignore` (prevents `node_modules/`, `.DS_Store`, `.env` leaking — same behavior as skills today). Tree copy reuses the gitignore-aware walker from `@vibe-agent-toolkit/utils` in a new "walk-all" mode (the existing skill-link traversal uses the same walker with link-following semantics); if that mode does not already exist, the implementation plan adds it. [inferred]
- Gitignore enforcement applies to the **tree-copy stream only**. The **skill discovery stream uses a non-gitignore-aware glob** when searching for plugin-local `SKILL.md` files under `<source>/skills/**/SKILL.md` — plugin-local skills are discovered regardless of their gitignore status, consistent with their "semantically mandatory" contract. [inferred] Once a plugin-local SKILL.md is discovered, it runs through the normal skill pipeline, which itself may respect gitignore for linked/referenced files (matching today's skill pipeline behavior). [inferred] If an author gitignores a plugin-local `SKILL.md` itself, the skill is still discovered and built, but a build-time warning is logged noting the inconsistency. [inferred]
- Exclusions: `skills/` is handled by the skill stream; the entire `.claude-plugin/` directory is copied to output with `plugin.json` replaced by the merged result. [inferred] If the author's `.claude-plugin/` directory contains a `marketplace.json`, it is ignored with a warning (marketplace.json is VAT-generated at the marketplace level). [inferred]

**plugin.json merge:**
- VAT generates `{ name, description, version, author }` as today.
- Version source for the VAT-generated value is the root `package.json#version` (matches today's `buildPlugin()` behavior). [inferred]
- If `plugins/<name>/.claude-plugin/plugin.json` exists, its fields are merged in.
- Precedence: **VAT wins** on `name`, `version`, `author`. **Author wins** on any other field (`keywords`, `repository`, `homepage`, `license`, …). `description` resolves via the deterministic chain `description = config.description ?? author.description ?? defaultDescription`. [inferred]
- `defaultDescription` is the literal string `` `${plugin.name} plugin` `` — this preserves today's fallback behavior in `buildPlugin()` (`packages/cli/src/commands/claude/plugin/build.ts` ~line 382: `description: pluginDef.description ?? \`${pluginDef.name} plugin\``). [inferred]
- VAT-winning fields (`name`, `version`, `author`) are **replaced wholesale** (shallow top-level replacement) — notably, if the author's `plugin.json` has an `author` field in any shape (string, object with different keys, extra fields), it is discarded in full and the VAT-generated `author` object is used verbatim. No deep-merge of the `author` object. [inferred]
- When an author-supplied value for a VAT-winning field (`name`, `version`, `author`) differs from the VAT-generated value, the VAT value is used and a warning is logged identifying the mismatched field. [inferred]
- Intent: VAT owns identity fields; authors own presentation/metadata.

**Compiled artifacts outside the plugin dir:**
- Reuse the existing `SkillFileEntrySchema` pattern for plugin-level `files: [{ source, dest }]`.
- Source path is relative to project root; dest is relative to the plugin's output dir.
- `files` entries are applied **after** the tree-copy stream, so they may overwrite tree-copied files; each overwrite is logged as an info-level message. [inferred]
- `dest` must resolve inside the plugin output directory — path-traversal values (e.g. `../`) are a build error. [inferred] Parent directories in `dest` are auto-created as needed. [inferred]
- Use case: a TypeScript hook compiles to `dist/hooks/my-hook.mjs` outside `plugins/<name>/` — `files: [{ source: "dist/hooks/my-hook.mjs", dest: "hooks/my-hook.mjs" }]` injects it.

### Schema changes

One file: `packages/resources/src/schemas/project-config.ts`.

**`ClaudeMarketplacePluginEntrySchema`:**

```typescript
export const ClaudeMarketplacePluginEntrySchema = z.object({
  name: z.string()
    .describe('Plugin name (lowercase alphanumeric with hyphens)'),
  description: z.string().optional()
    .describe('Plugin description'),
  skills: z.union([z.literal('*'), z.array(z.string())]).optional()  // CHANGED: was required
    .describe('Pool skills to include: "*" for all, or array of skill name selectors. Omit for no pool skills (plugin-local skills still ship).'),
  source: z.string().optional()  // NEW
    .describe('Path to plugin directory (default: plugins/<name>)'),
  files: z.array(SkillFileEntrySchema).optional()  // NEW
    .describe('Explicit source→dest file mappings for compiled artifacts outside the plugin directory'),
}).strict();
```

**Schema is still `.strict()`** — no passthrough. This is VAT-generated config, so we stay conservative (per Postel's Law in CLAUDE.md).

**Truth table for `skills` field × resolved plugin directory:** [inferred]

At schema-read time, `skills: []` is normalized to `skills: absent` — an empty array expresses the same intent as omitting the field and is treated identically throughout the pipeline. [inferred]

| `skills` field | Plugin dir present | Behavior |
|---|---|---|
| absent (or `[]`) | absent | Error — plugin has no content source [inferred] |
| present (non-empty or `"*"`) | absent | Pool-skills-only plugin (today's behavior preserved) [inferred] |
| absent (or `[]`) | present | Tree-copy + plugin-local skills only (no pool selections) [inferred] |
| present (non-empty or `"*"`) | present | Both pool selections and full tree-copy / local skills [inferred] |


**No new top-level config keys.** No `commands`/`hooks`/`agents`/`mcp` arrays. The plugin directory IS the declaration.

**Skills discovery glob extension:**
- `SkillsConfigSchema.include` keeps its shape.
- Internally, the skill discovery pass auto-injects `plugins/<plugin-name>/skills/**/SKILL.md` globs for each declared plugin. No adopter boilerplate.

### Validation (v1)

| Asset | Check |
|---|---|
| `plugins/<name>/` (if declared) | Directory exists |
| `commands/**/*.md` | File exists; no frontmatter validation (Claude runtime) |
| `hooks/hooks.json` | Parses as JSON |
| `agents/**/*.md` | File exists |
| `.mcp.json` | Parses as JSON |
| Plugin-local SKILL.md | Full existing skill pipeline validation |
| Pool skill name vs plugin-local skill name | Error with resolution guidance |
| `files[].source` | File exists at build time |
| `.claude-plugin/plugin.json` (author) | Parses as JSON; merge conflicts with VAT fields logged |

**Out of scope:** deep schema validation of hook manifests, MCP configs, or agent frontmatter.

**`vat audit` behavior for new asset types (v1):** parse-only — the audit applies the same surface-level checks used at build time. [inferred] Commands (`commands/**/*.md`) and agents (`agents/**/*.md`) are checked for file existence and parse-able markdown; `hooks/hooks.json` and `.mcp.json` are checked for valid JSON parsing. [inferred] Deep schema validation (hook event names, MCP server shapes, agent frontmatter schemas) remains out of scope. [inferred] Parse failures are reported as audit errors; missing recommended fields are not flagged. [inferred]

### CLI surface

No new commands. No new flags.

- `vat skills build` — discovery extended to find plugin-local skills. Output routed to `dist/plugins/<name>/skills/`.
- `vat claude plugin build` — extended to tree-copy plugin dirs, merge `plugin.json`, apply `files` mappings. Emits the same YAML summary shape plus new counts (`commandsCopied`, `hooksCopied`, `agentsCopied`, `mcpCopied`).
- `vat validate` / `vat audit` — pick up new content automatically via config. Audit applies parse-only checks to new asset types (see Validation (v1) above). [inferred]

## Testing

System tests in `packages/cli/test/system/`:

**Positive path:**
- Build a marketplace whose plugin has commands, hooks, agents, .mcp.json, a `scripts/` dir, a plugin-local skill, a pool skill selector, and a `files` mapping. Verify the dist tree is exactly correct at every path.

**Negative paths:**
- Declared plugin dir missing → build errors with clear message.
- `hooks/hooks.json` not valid JSON → build errors.
- `.mcp.json` not valid JSON → build errors.
- `files[].source` missing → build errors.
- Same skill name in pool and plugin-local → build errors with path-to-path resolution guidance.
- `.gitignore`d file inside plugin dir (seeded `node_modules/`) is NOT copied.
- Plugin.json from author with conflicting `name` → VAT wins, author keywords still present.

Unit tests:
- Merge logic for `plugin.json` field precedence (VAT vs author).
- Skill discovery double-glob (pool + per-plugin).
- Path resolution for `files[].source` and `source` override.

Coverage target: same bar as rest of codebase (unit tests only are coverage-instrumented; system tests verify end-to-end shape).

## Implementation Plan Sketch

The implementation plan (written next) should break this into incremental, reviewable chunks. Rough decomposition:

1. **Schema** — extend `ClaudeMarketplacePluginEntrySchema`; make `skills` optional; add `source`, `files`. Unit tests.
2. **Skill discovery** — auto-inject plugin-local globs; route output to `dist/plugins/<name>/skills/`. Unit tests.
3. **Plugin-local skill collision check** — detect and error. Unit test.
4. **Plugin tree copy** — copy everything under `plugins/<name>/` minus `skills/` and `.claude-plugin/`; respect `.gitignore`. Integration test.
5. **plugin.json merge** — read author file, merge with VAT fields using precedence rules. Unit test.
6. **Plugin-level `files` mapping** — reuse skills' existing mapping logic. Unit test.
7. **End-to-end system test** — full plugin with every asset type.
8. **Docs** — update `docs/guides/marketplace-distribution.md`; add example under `docs/examples/`.
9. **CHANGELOG** — entry under `[Unreleased]` → Added.

## Risks and Mitigations

| Risk | Mitigation |
|---|---|
| Author ships a broken `hooks.json` or `.mcp.json` that passes our "just parses" check | Document that deep validation is Claude runtime's job; add opt-in schema validation later if adopters request |
| Skill name collision between pool and plugin-local silently wins one side | Always error; force adopter to rename or delete one |
| `.gitignore` behavior drifts from skills'. | Share the gitignore-aware walker already used by skills (no duplicate implementation) |
| Plugin-dir grows to include build artifacts the author forgot to gitignore | Same gitignore respect; document the `files` mapping as the intended mechanism for injected artifacts |
| Author-supplied `.claude-plugin/plugin.json` conflicts with VAT-generated fields | Precedence table documented; conflicts logged at build time |

## Success Criteria

- A VAT config declaring a plugin with `source: plugins/sdlc/` (or default) produces a dist plugin containing every asset type the adopter put under `plugins/sdlc/`.
- `vat claude marketplace publish` pushes the full plugin to the target marketplace repo.
- Existing skills-only configs continue to work with zero regression.
- An AvonRisk-style plugin with slash commands and a SessionStart hook can ship today via VAT alone — no post-build workarounds.
- All tests pass. `bun run validate` clean.

## Open Questions (deferred)

- Should authors be able to override VAT-generated `plugin.json` `version`? (Currently: no — VAT wins.) Revisit if adopters ship plugins with independent versioning.
- Should we ship a helper command `vat claude plugin new <name>` that scaffolds the `plugins/<name>/` directory? Not in v1; consider after real usage patterns settle.
- Deep schema validation for `hooks.json` / `.mcp.json`. Defer until adopter pain appears.

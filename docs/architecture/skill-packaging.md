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

## Inventory Layer

The shapes above describe what an artifact *is*; the inventory layer describes what an artifact *contains*. Every detector that walks a plugin/marketplace/skill/install consumes the same structural model: a vendor-neutral interface (`packages/agent-skills/src/inventory/`) plus concrete extractors (`packages/claude-marketplace/src/inventory/`). The inventory is the single source of truth for "what does this artifact structurally hold" — declared components from the manifest, components discovered on disk, cross-component references, and parse errors. `vat audit` and `vat inventory` both build from it; new detectors are pure consumers of the model and never re-walk the filesystem.

The four inventory kinds:

- **Marketplace** — `marketplace.json` plus the plugin entries it declares and any plugins discovered on disk under it.
- **Plugin** — `plugin.json` (or absent, for the skill-claude-plugin shape) plus the components it declares in tri-state form (`null` = auto-discovery, `[]` = explicit suppression, populated list = explicit declaration) and the components discovered on disk.
- **Skill** — `SKILL.md` frontmatter plus the linked and packaged files referenced from it.
- **Install** — `~/.claude/plugins/` (or any install root) and the marketplaces and plugins under it.

The inventory schema is `vat.inventory/v1alpha`; it evolves freely under pre-1.0. Output is available via `vat inventory <path>` (YAML, JSON, or `--shallow` projection).

## See also

- [`docs/validation-codes.md`](../validation-codes.md) — every validation code by name, default severity, and applicable shapes.
- [`docs/skill-quality-and-compatibility.md`](../skill-quality-and-compatibility.md) — VAT's stance on structure, packaging, and compatibility.
- [`docs/research/2026-05-03-claude-plugin-loader-semantics.md`](../research/2026-05-03-claude-plugin-loader-semantics.md) — empirical Claude Code loader behavior behind the tri-state declared-vs-discovered model.

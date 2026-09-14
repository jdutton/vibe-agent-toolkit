---
paths:
  - "**/SKILL.md"
  - "**/vibe-agent-toolkit.config.yaml"
  - "packages/agent-skills/src/**"
  - "packages/cli/src/commands/build*"
  - "packages/cli/src/commands/verify*"
  - "packages/cli/src/commands/skill/**"
---

# Skill distribution boundaries — who owns what between `SKILL.md`, the config and `package.json`

- `SKILL.md` frontmatter carries only the portable skill schema — never a VAT-specific field. All
  VAT config (discovery globs, packaging, `publish`, plugin membership) lives in
  `vibe-agent-toolkit.config.yaml`. (not enforced)
- `package.json` `vat.skills` is a packaging hint that `vat verify` checks and `vat build` never
  reads. (enforced by: `vat verify` consistency-check)
- `publish: false` (merged from `skills.defaults` and `skills.config.<name>`, read through the one
  `isSkillPublished` predicate) names an IN-PLACE skill: still discovered and validated at source
  by `vat validate`, never bundled by `vat build`, never expected by `vat verify`. It scopes the
  pool (`dist/skills`) only — a plugin-local skill ships with its plugin by location regardless.
  (enforced by: `vat build`, `vat verify`)
- Error messages name the config mechanism that fixes them. (not enforced)

Roles table: [`docs/architecture/skill-packaging.md`](../../docs/architecture/skill-packaging.md#who-owns-what-skillmd-configyaml-packagejson).
Authoring a skill body: the `vat-skill-authoring` skill; shipping one: `vat-skill-distribution`.

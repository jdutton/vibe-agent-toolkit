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
- `publish: false` opts a skill out of the distribution-consistency checks only; it is still
  discovered, built and held to every packaging rule. (enforced by: `vat build`)
- Error messages name the config mechanism that fixes them. (not enforced)

Roles table: [`docs/architecture/skill-packaging.md`](../../docs/architecture/skill-packaging.md#who-owns-what-skillmd-configyaml-packagejson).
Authoring a skill body: the `vat-skill-authoring` skill; shipping one: `vat-skill-distribution`.

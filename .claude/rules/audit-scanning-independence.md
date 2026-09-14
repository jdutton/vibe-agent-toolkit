---
paths:
  - "packages/cli/src/commands/audit.ts"
  - "packages/cli/src/commands/audit/**"
  - "packages/cli/src/commands/audit-settings.ts"
---

# `vat audit` enumerates through the `crawl` lane; only its CLASSIFICATION is its own

`vat audit` enumerates its subject tree through the `crawl` lane (`crawlDirectory`) like every
other command — `packages/cli/src/commands/audit/scan-population.ts` is a consumer of the lane, not
a walker.

What stays audit's own is CLASSIFICATION: which files are subjects (`SKILL.md`, the two registry
files, a `.claude-plugin/` marker), subtree ownership between a plugin and the skills beneath it,
and the two exclude bases.

Do not converge that with `discovery.scan()` (it classifies markdown/agents for a different
question) and do not add a second walker: a new `node:fs` import in a command module is a lint
error (`local/commands-import-boundary`).

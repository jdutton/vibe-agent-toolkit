---
paths:
  - "docs/external/**/*.md"
  - "packages/vat-development-agents/resources/skills/vat-skill-review.md"
---

# Re-fetch a cached external doc once it's ~90 days stale

Files under `docs/external/` are cached copies of external guidance (e.g. Anthropic's
skill-authoring best-practices doc); each names its source URL and fetch date in its preamble.

When a cached doc's fetch date is more than ~90 days old, or a new Claude Code release changes
Skill behavior, re-fetch the source, diff against the cache, and update both the cache and any
VAT tooling that depends on it — primarily `vat-skill-review.md`. The cache exists so VAT's
opinions stay diffable against Anthropic's; don't let them silently drift.

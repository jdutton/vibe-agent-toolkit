---
paths:
  - "docs/external/**/*.md"
  - "docs/external/**/*.json"
  - "packages/vat-development-agents/resources/skills/vat-skill-review.md"
---

# Re-fetch a cached external doc once it's ~90 days stale

Files under `docs/external/` are cached copies of external artifacts; each names its source URL
and fetch date in its preamble. Two kinds live here and they refresh differently:

**Cached prose** (e.g. Anthropic's skill-authoring best-practices doc) — re-fetch when a cached
doc's fetch date is more than ~90 days old, or when a new Claude Code release changes Skill
behavior. Diff against the cache and update both the cache and any VAT tooling that depends on it,
primarily `vat-skill-review.md`. The cache exists so VAT's opinions stay diffable against
Anthropic's; don't let them silently drift.

**Cached machine artifacts** — an upstream JSON Schema VAT validates its own output against, such
as `docs/external/ard/ard-entry.schema.json`. These carry a sibling `README.md` holding the
preamble, since the artifact itself has nowhere to put one. Refresh is a **byte diff**, not a
reading, and the sibling README states which upstream quirks VAT's emitter works around — check
those specifically, because a fixed quirk changes what VAT should emit. An artifact whose upstream
`$id` is an unpinned branch URL moves with no signal, so the date is the only tripwire there is.

⛔ Vendoring an artifact never justifies a version constant for it. Recording "fetched from `<url>`
on `<date>`; upstream declares `<version>`" is an external fact; an integer someone must remember to
bump is what [CLAUDE.md](../../CLAUDE.md) forbids.

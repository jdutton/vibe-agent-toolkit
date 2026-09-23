### Changed

- **`vat claude context` no longer crawls the tree to find its `CLAUDE.md` and `.claude/rules`
  files when the projection store already lists them.** On a store miss it crawls as before.

- **A parse-cache write no longer re-checks its directory for every entry.** If the cache directory
  is removed mid-run, the write now fails and is counted in `writeFailures` rather than being
  repaired silently.

### Added

- **`@vibe-agent-toolkit/resources`: `readStoredRealizations`** — reads what the projection store
  holds for a subset of a run's contributors without populating anything, for a lane that cannot
  name its contributors until it has read the tree.

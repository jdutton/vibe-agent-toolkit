### Breaking

- **`RunPopulation` and `withRunPopulation` (`@vibe-agent-toolkit/resources`) require an
  `onHomeSettled` option.** A verb that does not overlap work with the home population passes
  `IGNORE_HOME_SETTLEMENT`.
- **Stored lab `perf` reports from earlier builds are refused; re-capture them.** Perf rows gained
  required fields (per-surface wall, total CPU, per-process records, `checksOverlapped`,
  `gateDeclinedBy`).

### Changed

- **`vat validate` starts its checks child during the resources phase when the projection store is
  warm and every member is admitted from it;** output matches a sequential run apart from the
  exceptions in `docs/architecture/resource-scanning-and-caching.md` section 3.7b. On a
  memory-capped runner, budget for roughly the sum of the parent's and the child's peaks.
- **A new work counter, `parse.cache.written`,** counts parse-cache entries written, in the parent and
  by parse workers.

### Added

- **`@vibe-agent-toolkit/utils/testing` exports `normalizeCommandOutput`, `buildPathSubstitutions` and
  the `NormalizeContext` and `PathSubstitution` types:** the one normalizer for captured
  whole-command output, moved from the private lab package.
- **`@vibe-agent-toolkit/resources` exports `parserKindForResolvedPath`, `hydratesUnder`,
  `storedAnswer`, `IGNORE_HOME_SETTLEMENT`, the static `RunPopulation.homeKey`, and the types
  `HomeSettlement`, `StoredAnswer`, `StoredComputeBy` and `StoredContent`.**

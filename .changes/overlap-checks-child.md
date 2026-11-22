### Breaking

- **`RunPopulation` and `withRunPopulation` (`@vibe-agent-toolkit/resources`) require an
  `onHomeSettled` option.** A verb that does not overlap work with the home population passes
  `IGNORE_HOME_SETTLEMENT`.
- **`blobFactsReader` (`@vibe-agent-toolkit/resources`) returns a `BlobFactsReader`, not a function.**
  Call `reader.outcome(contentKey)` where you called `reader(contentKey)`; `reader.answer(contentKey)`
  gives the outcome's kind without building the facts.
- **Stored lab `perf` reports from earlier builds are refused; re-capture them.** Perf rows gained
  required fields (per-surface wall, total CPU, per-process records, `checksOverlapped`,
  `gateDeclinedBy`).

### Changed

- **`vat validate` starts its checks child during the resources phase when the projection store is
  warm and every member is admitted from it;** output matches a sequential run apart from the
  exceptions in `docs/architecture/resource-scanning-and-caching.md` section 3.7b. On a
  memory-capped runner, budget for roughly the sum of the parent's and the child's peaks. The parent
  runs one major garbage collection at an overlapped checks turn, where a sequential parent idles
  and V8 collects on its own, which holds its peak to a sequential run's (figures:
  `docs/architecture/resource-scanning-and-caching.md` section 3.7b).
- **A new work counter, `parse.cache.written`,** counts parse-cache entries written, in the parent and
  by parse workers.
- **A new work counter, `checks.gate.rows.read`,** counts the blob tier rows `vat validate`'s checks
  overlap gate checks. The gate builds no member's facts, and every other counter is the same
  whether a run overlapped or not, except when the crawl reaches no member that reads the tier but
  some home member does: then the overlapped run counts the one shared tier read
  (`store.reads.persistent` and its decoded rows) that a sequential run skips (section 3.7b).

### Added

- **`@vibe-agent-toolkit/utils/testing` exports `normalizeCommandOutput`, `buildPathSubstitutions` and
  the `NormalizeContext` and `PathSubstitution` types:** the one normalizer for captured
  whole-command output, moved from the private lab package.
- **`@vibe-agent-toolkit/resources` exports `parserKindForResolvedPath`, `hydratesUnder`,
  `storedComputeBy`, `IGNORE_HOME_SETTLEMENT`, the static `RunPopulation.homeKey`, and the types
  `BlobFactsReader`, `HomeSettlement`, `StoredComputeBy` and `StoredContent`.**

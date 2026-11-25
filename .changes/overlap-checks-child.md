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
  memory-capped runner, budget for roughly the sum of the parent's and the child's peaks. The
  overlapped parent's uncapped peak is higher because it never idles for V8 to collect; under a
  heap cap at the sequential peak it runs in less (figures: section 3.7b).
- **A new work counter, `parse.cache.written`,** counts parse-cache entries whose write was reported:
  the parent's own writes, and each write a parse worker reports back. A worker killed after writing
  an entry but before replying leaves that entry uncounted.
- **A new work counter, `checks.gate.rows.read`,** counts the blob tier rows the admission request reads
  for `vat validate`'s checks overlap gate, summed per member: a content key that several members share is counted once
  for each of them. The gate builds no member's facts, and every other counter is the same
  whether a run overlapped or not, except when the crawl reaches no member that reads the tier but
  some home member does: then the overlapped run counts the one shared tier read
  (`store.reads.blob` and its decoded rows) that a sequential run skips (section 3.7b).

### Added

- **`VAT_VALIDATE_DEBUG_FACTS`:** set to a directory, `vat validate` writes a JSON dump there at exit
  saying whether its checks child started during the resources phase and, when it did not, the first
  gate condition that kept it sequential.
- **`@vibe-agent-toolkit/utils/testing` exports `normalizeCommandOutput`, `buildPathSubstitutions` and
  the `NormalizeContext` and `PathSubstitution` types:** the one normalizer for captured
  whole-command output, moved from the private lab package.
- **`@vibe-agent-toolkit/resources` exports `parserKindForResolvedPath`, `hydratesUnder`,
  `storedComputeBy`, `IGNORE_HOME_SETTLEMENT`, the static `RunPopulation.homeKey`, and the types
  `BlobFactsReader`, `HomeSettlement`, `StoredComputeBy` and `StoredContent`.**

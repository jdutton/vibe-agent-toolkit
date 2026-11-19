### Breaking

- **`buildInventoryPopulation()` (`@vibe-agent-toolkit/claude-marketplace`) requires `run`**, the
  `PopulationRun` it reads and parses through. Open one per inventory with `withPopulationRun()`
  from `@vibe-agent-toolkit/resources` and pass it to every call in that inventory.
- **`ParsePoolPolicy.limits` no longer takes `inputBytes`**, and so neither does
  `ResourceRegistryOptions.parsePool`. Every dispatcher refuses a file past the one input cap the
  population holds (8 MiB, read from `dispatcher.inputBytes`). Remove the key; the other limits
  are unchanged.
- **A `ParseDispatcher` keeps and freezes its parse results only when it reads through a run's
  content (`content` set)**: a run's dispatcher returns the same deep-frozen result to every lane
  that asks for one file, so a caller that edits a result must copy what it edits. A dispatcher
  without `content` parses each request as before.

### Changed

- **`vat validate`, `vat verify`, `vat resources validate`, `vat skills validate`,
  `vat resources scan` and `vat rag index` read, key, parse and admit each file once per run**,
  whichever phase asks: the verb opens one run, and every phase crawls a view of one run registry.
  `vat audit`, `vat skills build`, `vat claude plugin build` (so `vat build`) and `vat ard emit` are
  not covered yet and still read a file once per lane that asks. A warm projection-store hit still
  reads and hashes each file a view admits. No action needed.
- **The notice that git cannot key a file is printed once per run**, not once per phase that
  crawls it.
- **`VAT_WORK_COUNTERS` dumps four more counters**: `content.read`, `fs.stat`, `registry.built` and
  `registry.admitted`, attributed per phase.

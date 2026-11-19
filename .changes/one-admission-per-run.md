### Changed

- **Each file is read, keyed, parsed and admitted once per `vat` process run**, whichever phase
  asks: `vat validate`, `vat verify`, `vat resources validate`, `vat skills validate` and the other
  verbs that crawl resources open one run, and every phase crawls a view of one run registry. No
  action needed.
- **`VAT_WORK_COUNTERS` dumps four more counters**: `content.read`, `fs.stat`, `registry.built` and
  `registry.admitted`, attributed per phase.

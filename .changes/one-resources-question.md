### Changed

- **Every resources lane populates the tree once per tree and git index, and shares it**:
  `vat resources validate`, `scan`, `query`, `check`, `vat skills validate`, `vat skills build`,
  `vat claude plugin build`, `vat build` and `vat claude context` read one stored population, so a
  repeat run on an unchanged tree and index is served from the store whichever verb wrote it, and
  `vat validate`'s checks phase is served the population its resources phase wrote.
- **A cold `vat resources scan`/`validate`, `vat skills validate`/`build`, `vat claude plugin build`
  or `vat rag index` now runs the blob stage**: it reads, hashes and parses every non-ignored file,
  where it used to read none. Cold cost is <MEASURED>× the previous release on the same tree; a
  warm run is a store hit. Peak memory on that cold run grows with the tree's total text, because
  the run's content cache holds every file it keyed.
- **With the store off (`VAT_PROJECTION_STORE=off`) or outside a git repository**, nothing is shared
  between the resources phase and the checks child, so `vat validate` populates the tree twice.

### Fixed

- **Under a clean/smudge filter or `working-tree-encoding`, two paths sharing a git blob could be
  filed under one content key.** On the git enumerator, a second path whose blob OID matched an
  earlier path's was served that path's read: the same content key and the same text, though its
  working-tree bytes differed. Every path is now read and keyed from its own bytes. Affected
  v0.2.0-rc.3 through v0.2.0-rc.11; v0.1.42 is not affected.

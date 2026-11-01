### Changed

- **Every resources lane populates the tree once per tree and git index, and shares it**:
  `vat resources validate`, `scan`, `query`, `check`, `vat skills validate`, `vat skills build`,
  `vat claude plugin build`, `vat build` and `vat claude context` read one stored population, so a
  repeat run on an unchanged tree and index is served from the store whichever verb wrote it, and
  `vat validate`'s checks phase is served the population its resources phase wrote. A cold run of a
  membership command (`scan`, `validate`) now reads every non-ignored file.
- **With the store off (`VAT_PROJECTION_STORE=off`) or outside a git repository**, nothing is shared
  between the resources phase and the checks child, so `vat validate` populates the tree twice.

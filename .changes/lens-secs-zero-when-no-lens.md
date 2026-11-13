### Fixed

- **`lensSecs` reported a small nonzero cost for a statement that names no derived relation**
  (`vat resources query` and `vat resources check`). It timed an empty loop, so a GC pause on a
  loaded machine could publish milliseconds of lens cost beside `lensesEvaluated: []`. It is now
  exactly `0` when no lens was evaluated, as documented. No action needed.

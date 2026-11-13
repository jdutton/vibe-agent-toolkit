### Fixed

- **`lensSecs` reported a small nonzero cost for a statement that names no derived relation**
  (`vat resources query` and `vat resources check`). It timed an empty loop, so a GC pause on a
  loaded machine could publish milliseconds of lens cost beside `lensesEvaluated: []`. It is now
  exactly `0` when the statements name no derived relation. A lens that was named but refused
  still reports what it cost, beside an empty `lensesEvaluated`. No action needed.

### Breaking

- **`vat claude org skills install --from-npm` reports each failed skill as
  `{ skill, error: { code, message } }`** (was `{ skill, error: "<message>" }`): the same
  `{ code, message }` shape the run's own refusal publishes, so one payload carries one error
  shape. `code` is mapped exactly as a run-level refusal's is (`EXTERNAL_API_FAILED` for a
  refused or unanswered API call, `INTERNAL_ERROR` for a VAT defect).

### Fixed

- **`vat corpus scan` no longer swallows a VAT defect into an `unloadable` row.** An uncoded
  throw inside an entry's audit (a validator `TypeError`) used to become a
  `CORPUS_ENTRY_INCOMPLETE` warning, and the scan exited 0; it now ends the scan as
  `INTERNAL_ERROR`, exit 2, in both the local and the URL lane. A coded refusal (a missing or
  unreadable source, a failed clone) is still that entry's `unloadable` row.

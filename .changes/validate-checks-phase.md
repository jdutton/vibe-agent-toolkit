### Breaking

- **`vat validate` gains a `checks` phase whenever `resources:` is configured** (a third `data.phases`
  entry): VAT's built-in checks plus your `resources.checks`, over the whole tracked tree —
  `resources.include`/`exclude` do not scope it. It builds its own projection, so runs take longer.
- **The `checks` phase can fail `vat validate`:** a check row at `error` or `RESOURCE_CHECK_BROKEN`
  (exit 1), or `RUN_INCOMPLETE` (exit 2) if it stops before its population is in. It is killed after
  300 s without progress (the whole population is one unit); `vat validate` cannot raise that bound.

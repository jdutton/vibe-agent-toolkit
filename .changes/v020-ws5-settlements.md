### Breaking

- **RAG query fields no provider implemented are deleted.** `RAGQuery` / `RAGQuerySchema` no longer
  declare `hybridSearch`, `filters.dateRange`, or the top-level `filters.tags` / `filters.type` /
  `filters.headingPath`; the schema is strict, so a query carrying any of them is a schema error.
  `hybridSearch: { enabled: false }` is now an error too (omit the field). Move metadata filters
  under `filters.metadata`. `rag` no longer exports `assertQuerySupported` or `QuerySupport`
  (`assertFiltersProducedConditions` stays); `rag-lancedb` no longer exports `LANCEDB_QUERY_SUPPORT`.
  `buildWhereClause` and `query()` validate against the strict `RAGQuerySchema`, so an unknown filter
  key throws a `ZodError` instead of the former "Unsupported RAG query field" message.

- **`SKILL_NAME_XML_TAGS` is removed.** A skill name containing `<` already fails the
  `^[a-z0-9]+(-[a-z0-9]+)*$` pattern, so it reports `SKILL_NAME_INVALID` alone. Drop any
  `SKILL_NAME_XML_TAGS` override or reference. `SKILL_DESCRIPTION_XML_TAGS` stays, documented as
  VAT's reading of the vendor's "cannot contain XML tags".

### Changed

- **`version:` in `vibe-agent-toolkit.config.yaml` is now an unrecognized key, like any other.**
  The config still loads: `version: 1` (or any value) draws a warning naming the key and the file,
  and the key is dropped (was accepted silently and ignored). Delete the `version:` line. The npm
  package version is the only version VAT has.

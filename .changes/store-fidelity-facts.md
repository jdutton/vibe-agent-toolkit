### Breaking

- **The blob tier stores every fact the registry builds a resource from.** New and changed columns:
  `blobs.frontmatterValue` (the exact frontmatter-codec encoding; `blobs.frontmatter` stays as the
  lossy JSON query surface), `blobs.frontmatterNotAMapping`, `blobs.anchors`,
  `blob_references.astIndex`, and `blob_conditions.ordinal` (now part of its primary key, so two
  identical findings on one line are two rows). A store written by an earlier build is a different
  store directory (the shape digest changed); nothing is migrated.
- **`blobs.frontmatterError` no longer carries the "not a YAML mapping" reason.** A block that is
  valid YAML but not a mapping is `frontmatterError: null, frontmatterNotAMapping: true`. The
  `claude-rule-frontmatter-invalid` check reports both, and its SQL twin reads both columns.
- **Positionless links and headings are stored, never dropped.** `blob_references.line`,
  `startOffset` and `endOffset`, and `blob_sections.lineStart`, `lineEnd`, `bytes` and `tokens`, are
  nullable. `BlobPopulationResult.headingsSkippedForMissingLine` and
  `referencesSkippedForMissingLine` are removed, and so are `hasReferenceSpan` and `PositionedLink`.
- **A file whose parser throws is `RESOURCE_UNREADABLE` in the registry too**, with the same reason
  and code the projection records, instead of failing the run.
- **A file whose bytes are not text (a NUL in its decoded head) is the same resource in both lanes**:
  no links, no headings, `estimatedTokenCount` 0. The registry no longer parses it.
- **`unparsedResourceFacts` is removed.** `contentRoute` (not text, no parser, or a parse) is the one
  route both lanes and the CLI's parse-fact snapshot take; a file no parser routes to now carries
  `lexicalReferences` and `contentMeasures` in that snapshot.

### Added

- **`blobFactsReader`**, the one reader that rebuilds a resource's content-addressed facts from the
  stored blob rows, and the mapping tables `RESOURCE_METADATA_FACT_SOURCES`,
  `RESOURCE_LINK_FACT_SOURCES` and `REGISTRY_OUTPUT_FACT_SOURCES`: every field and registry output
  `vat validate` reads is a blob fact, a live recomputation or a counted per-file read, checked
  against `ResourceMetadata` by the type system.

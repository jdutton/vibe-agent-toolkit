### Breaking

- **The blob tier stores every fact the registry builds a resource from.** New and changed columns:
  `blobs.frontmatterValue` (the exact frontmatter-codec encoding; `blobs.frontmatter` stays as the
  lossy JSON query surface), `blobs.frontmatterNotAMapping`, `blobs.anchors`,
  `blobs.findingCount` (how many finding rows the parse filed in `blob_conditions`),
  `blob_references.astIndex`, and `blob_conditions.ordinal` (now part of its primary key, so two
  identical findings on one line are two rows). A store written by an earlier build is a different
  store directory (the shape digest changed); nothing is migrated.
- **`blobs.frontmatterError` no longer carries the "not a YAML mapping" reason.** A block that is
  valid YAML but not a mapping is `frontmatterError: null, frontmatterNotAMapping: true`. The
  `claude-rule-frontmatter-invalid` check reports both, and its SQL twin reads both columns.
- **Positionless links and headings are stored, never dropped.** `blob_references.line`,
  `startOffset` and `endOffset`, and `blob_sections.lineStart`, `lineEnd`, `bytes` and `tokens`, are
  nullable. A positionless link is now also an `edges` row, so `vat resources query` over `edges`
  returns links it used to omit. `BlobPopulationResult.headingsSkippedForMissingLine` and
  `referencesSkippedForMissingLine` are removed, and so are `hasReferenceSpan` and `PositionedLink`.
- **A file whose parser throws is `RESOURCE_UNREADABLE` in the registry too**, with the same reason
  and code the projection records, instead of failing the run.
- **A file whose bytes are not text (a NUL in its decoded head) is the same resource in both lanes**:
  no links, no headings, `estimatedTokenCount` 0. The registry no longer parses it.
- **`ResourceLink.nodeType` is required.** Every link a parser returns through the public
  `MarkdownParser` interface (and every `ResourceLink` in `ResourceMetadata`) must state the node it
  came from: `link`, `linkReference`, `definition` or `htmlAttribute`. An absent one used to be
  filed as `markdown-link`, and the fact reader would rebuild it with a `nodeType` the parse never
  gave it. Both shipped parsers always state one. `LinkEntry.link` (link judging) is a
  `JudgedLink`, a `ResourceLink` without `nodeType`, since judging never reads it.
- **`unparsedResourceFacts` is removed.** `contentRoute` (not text, no parser, or a parse) is the one
  route both lanes and the CLI's parse-fact snapshot take; a file no parser routes to now carries
  `lexicalReferences` and `contentMeasures` in that snapshot.

### Added

- **`blobFactsReader`**, the one reader that rebuilds a resource's content-addressed facts from the
  stored blob rows, with `BLOB_FACT_FIELDS` and `RESOURCE_LINK_FACT_SOURCES`: every `ResourceMetadata`
  and `ResourceLink` field is mapped to a blob fact, a live recomputation or a counted per-file read,
  and the type system checks the mapping against those two schemas' keys. The registry's other
  outputs are not part of the mapping.

### Breaking

- **`ResourceMetadata.checksum` and `BaseResource.checksum` are removed; `contentKey` replaces both.** `checksum` was
  the SHA-256 of the decoded text, so distinct byte sequences that decode alike (invalid UTF-8
  collapses to `U+FFFD`) could share one. `contentKey` is the content key the parse cache and the
  projection store already file facts under: `<parserKind>.<sha-256 of the raw bytes>`. Read
  `resource.contentKey` where you read `resource.checksum`; the two are different values and never
  comparable.
- **`vat resources scan --verbose` prints `contentKey` per file where it printed `checksum`**, and the
  published `resources-scan` JSON Schema changed with it. A consumer that read `files[].checksum` reads
  `files[].contentKey` (a `<parserKind>.<hex>` string, not a bare 64-character hex digest).
- **`getResourcesByChecksum` and `getUniqueByChecksum` are renamed `getResourcesByContentKey` and
  `getUniqueByContentKey`** (on `ResourceRegistry`, `ResourceCollection` and
  `ResourceCollectionInterface`), and **`getDuplicates` is re-keyed on the content key**: identical
  bytes routed to different parsers (a `.md` and a `.html` with the same content) are no longer
  duplicates, because the key includes the parse route.
- **`calculateChecksumFromContent` is removed from `@vibe-agent-toolkit/resources`, as are the `SHA256` type and `SHA256Schema`.** Key a file with
  `readContentWithKey` (or `computeContentKey` over bytes you already hold).
- **The lab `population` facet identifies a file by `identity: { scheme, value }`, not by `checksum`.**
  `PopulationEntry.checksum` is gone and a stored `population` report from an earlier build no longer
  validates. A subject document that carries `checksum` (rc.17 and earlier) reads as scheme
  `checksum`, one that carries `contentKey` as scheme `contentKey`. Comparing two sides under
  different schemes reports content as not comparable (`content-incomparable`, or
  `contentComparison: { kind: 'incomparable' }` on a `changed` verdict) instead of reporting every
  path as changed; membership (added, removed) still compares.

### Changed

- **`vat rag index` refuses a file changed since the crawl by its content key**: it re-reads the file
  once with the registry's own keying function and indexes that read's text, so the text indexed and
  the key compared are the same bytes. The refusal now says "content key" where it said "checksum".
- **The audit cache-staleness detector compares content keys.**

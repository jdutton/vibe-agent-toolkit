### Changed

- **A file routed by `resources.extractors.data` now has its own output caps: 262,144 rows and
  64 MiB of rows' JSON** (it shared the document caps, 16,384 rows and 4 MiB, so a 1.1 MB JSON
  Schema document was `PARSE_LIMIT_EXCEEDED`). Markdown and HTML keep their caps; depth stays
  1,000 levels for both.

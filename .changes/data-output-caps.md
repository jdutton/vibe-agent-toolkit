### Changed

- **A file routed by `resources.extractors.data` now has its own output caps: 262,144 rows and
  64 MiB of rows' JSON** (it shared the document caps, 16,384 rows and 4 MiB, so a 1.1 MB JSON
  Schema document was `PARSE_LIMIT_EXCEEDED`). Markdown and HTML keep their caps; depth stays
  1,000 levels for both. A row or byte cap a parse pool's caller names applies to data jobs as
  named.
- **The data stage no longer holds every extracted row set at once.** With the store on it writes
  row sets in batches as they are extracted; with it off it holds at most 64 MiB of rows and refuses
  each file past that `refused`, by name. Ten data files at both caps no longer abort the process
  under a 512 MiB heap flag.

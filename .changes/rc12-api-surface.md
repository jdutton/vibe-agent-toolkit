### Breaking

- **`normalizePath(target, { within })` replaces `normalizePath(...paths)`** (`@vibe-agent-toolkit/utils`,
  library-only). A relative `target` resolves against cwd; `within` is the tree being crawled (pass `target`
  itself for the operator's own path). `normalizePath(a, b)` no longer compiles: write
  `normalizePath(safePath.resolve(a, b), { within: a })`.
- **`new FsLookupCache(within)` and `crawlDirectorySync({ outputs, … })` take required arguments**
  (`@vibe-agent-toolkit/utils`, library-only): the cache names the tree its paths are crawled in, and
  `crawlDirectorySync` requires `outputs` exactly as `crawlDirectory` does (`[]` for a read-only caller).
- **`@vibe-agent-toolkit/resource-compiler/language-service`: `loadMarkdownResource(filePath, within)` and
  `getMarkdownResource(filePath, within, loader)` take a required `within`** (library-only) — the
  directory of the file that imports the markdown.

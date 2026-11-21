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
- **`GitSnapshotFailure` (`@vibe-agent-toolkit/utils/git`) carries a required `kind: 'not-taken'`**;
  a value you construct (a mock, a wrapper) adds it. `gitSnapshotFailureOf` now also takes a
  `GitTreeKeyFailure`.
- **`ResourceEnumeration` (`@vibe-agent-toolkit/resources`) has a required `stored` field**: what
  the projection store holds about each member when the store served the population, `null`
  otherwise. A custom `ResourcePopulationSource` returns `stored: null`.
- **`RunPopulation.admit` (`@vibe-agent-toolkit/resources`) takes a `compute` that returns the
  `AdmittedFacts` union** (`{ kind: 'facts', facts }` or `{ kind: 'not-admitted', entry }`), not
  `{ parse, checksum }`, and returns the same union. A caller passing its own `compute` returns
  `{ kind: 'facts', facts }` built from its parse.
- **`GitNoAnswerCode` (`@vibe-agent-toolkit/utils/git`) has a new member,
  `GIT_SNAPSHOT_INDEX_HIDES`.** An exhaustive `switch` or `Record<GitNoAnswerCode, ...>` over it
  adds a case.

### Added

- **(library) `gitTreeKey()` / `freshGitTreeKey()` on `@vibe-agent-toolkit/utils/git`**: the working
  tree's key, `gitTreeSnapshot`'s hash, declined (`GitTreeKeyFailure`, with `GitTreeKeyOutcome` and
  `GitHiddenEntry`) when git's index flags a file assume-unchanged or skip-worktree that hides bytes.
  `gitSnapshotFailureOf` classifies a declined key as the new `GIT_SNAPSHOT_INDEX_HIDES_CODE`, or as
  `GIT_FAILED_CODE` or a git-run code when git gives no usable flag listing; `gitSnapshotError` takes
  a `GitTreeKeyFailure` too. `gitSnapshotAbsentEntries()` names a snapshot's entries absent from disk
  under skip-worktree.
- **(library) `parserKindOf` on `@vibe-agent-toolkit/resources`**: the parser kind a content key
  names, so a consumer re-keys a file with the route the registry keyed it under.
- **(library) `plantFiles()`, `workSpentNow()` and `workSpentSince()` (with `WorkSpent`) on
  `@vibe-agent-toolkit/utils/testing`**: write a fixture tree from a path-to-contents map, and read
  the work counters a store-hydration suite compares (content reads, hashes, parse lookups,
  admissions) as one snapshot and its difference across a run.

### Changed

- **A warm `vat validate` builds its resources registry from the projection store**: on a store
  hit each member is admitted from its stored blob facts with no content read, hash or parse, and
  a member the store does not cover (an evicted key, a file that cannot be read now, a file another
  view routes to another parser) is read and parsed as on a cold run. Findings and exit code are
  unchanged. No action needed.
- **A warm run whose projection store cannot read its stored blob facts back refuses the run once,
  as `BACKEND_UNAVAILABLE` (exit 2)**, with the store's own error, and runs no later phase. The
  store is a cache: clear it (`vat cache clear`) or point `VAT_CACHE_DIR` elsewhere.
- **The projection store is not used in a repository whose git index flags a file
  `assume-unchanged` or `skip-worktree` that is on disk.** git does not read such a file,
  so the tree's key would not change when it does, and a stored projection could describe bytes that
  are no longer on disk. The run populates without a cache and prints, once per root, "The
  projection store is on, but git cannot key this tree", naming the flag and the first flagged
  files and how to clear them (`git update-index --no-assume-unchanged` / `--no-skip-worktree`).
  Findings and exit code are unchanged; such runs are cold. A skip-worktree file absent from disk,
  as a sparse checkout leaves every file outside its definition, hides nothing: a sparse checkout
  keeps the store, keyed apart from the same tree with those files present. `changed_files` judges
  the flags by the same rule. Every run with the store on asks git one more `ls-files -v` per
  snapshot (`git.calls` +1 on a hit, +2 on a write), and the git crawl reads the same listing.
- **The git crawl no longer enumerates a sparse checkout's absent files.** The snapshot lists a
  skip-worktree file with its staged bytes though nothing is on disk; a run that used the snapshot's
  members reported it as `RESOURCE_UNREADABLE`. It is now no member, as a filesystem walk finds it.
- **A stored projection is reused only under the same parse limits, every one of them**, not the
  input cap alone. Stores written by an earlier build miss once and are rewritten. No action needed.
- **`vat rag index` refuses a file changed since the crawl by its content key**: it re-reads the file
  once with the registry's own keying function and indexes that read's text, so the text indexed and
  the key compared are the same bytes. The refusal now says "content key" where it said "checksum".
- **The audit cache-staleness detector compares content keys.**

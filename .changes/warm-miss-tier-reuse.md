### Changed

- **A warm run after an edit re-parses only the edited files.** No action needed.

### Breaking

- **The cache namespace is the VAT version alone, in a source checkout as in an installed build** (a checkout used `<version>-dev-<hex>`). Within one version a change to VAT's code or its resolved dependencies does not invalidate the cache: run `vat cache clear` when you want it cold. Installed builds are unchanged.
- **`FactStore.writeBlobFacts` takes `{ rows, coveredAtRead, settledAtRead }`** in place of the rows alone; a custom store implements the replace-and-re-stamp rule documented on the port. Library-only; CLI users are unaffected.
- **`skillTextDeclarationDigest` is removed from `@vibe-agent-toolkit/resources`.** Nothing keys on the skill-text declaration since the cache namespace became the VAT version alone. Library-only; CLI users are unaffected.
- **`populateBlobs` takes two new required options, `content` and `stored`** (the run's content source, and the stored blob tier it serves covered keys from). Library-only; CLI users are unaffected.

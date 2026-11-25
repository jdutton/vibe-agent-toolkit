### Changed

- **A warm run after an edit re-parses only the edited files.** No action needed.
- **The installed cache namespace now carries a parser-version suffix** (`<version>-p<6 hex>`). One cold start on upgrade; `vat cache prune` removes the old namespace.

### Breaking

- **`FactStore.writeBlobFacts` takes `{ rows, coveredAtRead, settledAtRead }`** in place of the rows alone; a custom store implements the replace-and-re-stamp rule documented on the port. Library-only; CLI users are unaffected.

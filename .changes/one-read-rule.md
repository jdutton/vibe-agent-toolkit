### Breaking

- **Library (`@vibe-agent-toolkit/resources`): `FactStore.readBlobFacts` returns `{ rows, present }`.**
  `present` is the requested content keys whose ledger row exists, read in the same transaction as
  `rows`; a `FactStore` implementation or wrapper must return it, and a caller reads `.rows`.

### Changed

- **A run decodes each stored blob row at most once**: a later, wider request reads only the
  tables and reference forms the run does not hold yet, so `vat resources query` with a lens that
  populates no longer decodes its keys' rows twice. No action needed.

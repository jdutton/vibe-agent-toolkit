### Breaking

- **Library (`@vibe-agent-toolkit/resources`): `FactStore.readBlobFacts` returns `{ rows, present }`.**
  `present` is the requested content keys whose ledger row exists, read in the same transaction as
  `rows`; a `FactStore` implementation or wrapper must return it, and a caller reads `.rows`.

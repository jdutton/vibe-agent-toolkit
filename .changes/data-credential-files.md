### Fixed

- **Credentials files are never stored as data rows, whatever `resources.extractors.data` glob
  matches them.** A broad glob such as `**/*.yml` used to route an untracked, never-committed
  `.yarnrc.yml` and store its `npmAuthToken` whole in the projection store, which CI caches. A
  `.yarnrc.yml` now routes as the new variant `yarnrc`: only its allowlisted top-level keys
  (`nodeLinker`, `npmRegistryServer`, `npmScopes`, `npmRegistries`, `packageExtensions` and the
  other non-secret settings) are kept, every key starting `npmAuth` is dropped at any depth, and so
  is any value aliasing a dropped one. `.npmrc`, `.yarnrc`, `.netrc`, `_netrc`, `.git-credentials`,
  `.pypirc`, `.env`, `.env.*`, `.docker/config.json`, `.config/gh/hosts.yml`, `.aws/credentials`,
  `.kube/config`, `.pgpass`, Cargo, RubyGems and Terraform credentials and files under `.ssh/` are
  not routed at all.

### Added

- **`DATA_CREDENTIAL_FILE_NOT_ROUTED` (warning)** names each credentials file a data glob would
  have routed, in `vat resources check` and the `checks` phase of `vat validate`; `vat resources
  query` writes it to stderr when its statement names a `data__*` relation. Excluding the path or
  `resources.validation.severity` silences it.

### Changed

- **Docs: the adoption guide's cache note no longer says the cache holds no whole file bodies.**
  Every routed data file is stored whole as rows. The parse-limits record now says the data caps
  are exported on the `@vibe-agent-toolkit/resources/testing` subpath.

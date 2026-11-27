### Fixed

- **Files of the named credentials kinds are never stored as data rows, whatever
  `resources.extractors.data` glob matches them.** A broad glob such as `**/*.yml` used to route an
  untracked, never-committed `.yarnrc.yml` and store its `npmAuthToken` whole in the projection
  store, which CI caches. The list of kinds is closed and matches by file name: it is not a guarantee
  (a secret in a file under any other name, or a hard link to a listed file, is routed like any
  ordinary file), so keep secrets out of files a glob routes. A `.yarnrc.yml` or `.yarnrc.yaml` now
  routes as the new variant `yarnrc`: only these top-level keys are kept, `checksumBehavior`, `compressionLevel`, `defaultSemverRangePrefix`, `enableGlobalCache`, `enableImmutableInstalls`, `enableScripts`, `enableStrictSsl`, `enableTelemetry`, `nmHoistingLimits`, `nmMode`, `nodeLinker`, `npmPublishAccess`, `npmPublishRegistry`, `npmRegistries`, `npmRegistryServer`, `npmScopes`, `packageExtensions`, `plugins`, `pnpMode`, `supportedArchitectures`, `yarnPath`, and any other key
  answers zero rows. Every key starting `npmAuth` is dropped at any depth, and so is any scalar or
  map key holding a URL with userinfo or a query string, any flow-collection key, and any value
  aliasing a dropped one. A `.yarnrc.yml` defect never quotes the file. An `.npmrc` stays read as
  variant `ini` through its key allowlist, and is matched case-insensitively. These kinds are not
  routed at all: `.yarnrc`, `.netrc`, `_netrc`, `.git-credentials`, `.pypirc`, `.env`, `.env.*`, `.docker/config.json`, `.config/gh/hosts.yml`, `.config/gh/hosts.yaml`, `.aws/credentials`, `.kube/config`, `.pgpass`, `.cargo/credentials`, `.cargo/credentials.toml`, `.gem/credentials`, `.terraformrc`, `terraform.rc`, `.ssh/**`, `auth.json`, `local.settings.json`, `credentials.json`, `client_secret*.json`, `*service-account*.json`.

### Added

- **`DATA_CREDENTIAL_FILE_NOT_ROUTED` (warning)** names each file of a named kind a data glob would
  have routed, in `vat resources check` and the `checks` phase of `vat validate`; `vat resources
  query` writes it to stderr when its statement names a `data__*` relation. Its location is the
  path, so `resources.validation.allow.DATA_CREDENTIAL_FILE_NOT_ROUTED` waives exactly one file;
  `exclude` removes one path. When this rule is why a declared block routed no file, the
  `CONFIG_INVALID` refusal says so.

### Changed

- **Docs: the adoption guide's cache note no longer says the cache holds no whole file bodies.**
  Every routed data file is stored whole as rows. The parse-limits record now says the data caps
  are exported on the `@vibe-agent-toolkit/resources/testing` subpath.

### Security

- **Adopter action: if a broad `resources.extractors.data` glob ever routed an untracked `.yarnrc.yml` or
  `.docker/config.json`** (or any other named kind) before this release, its token was stored in the
  projection store and may sit in a CI cache. Rotate the token, delete the `actions/cache` entries
  earlier releases saved (`vat cache prune` cannot reach them), and run `vat cache clear` locally.

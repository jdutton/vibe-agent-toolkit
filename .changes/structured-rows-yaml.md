### Added

- **YAML files as queryable rows.** The `data__*` relations gain the variant `yaml` (YAML 1.2, core
  schema). By default every `**/pnpm-workspace.yaml` is read; an `include` glob in
  `resources.extractors.data` now routes `.yaml` and `.yml` files too (e.g.
  `.github/workflows/*.yml`). Every document of a stream is rows (`doc`); aliases are expanded, each
  copied row marked by `aliasOf` and counted against `outputRows` and `outputBytes`; `<<` is a plain
  key, never merged; `tag` holds a node's explicit tag. No YAML 1.1 reading applies: `yes` is a
  string, and a 1.1 tag (`!!binary`, `!!timestamp`, `!!omap`, `!!pairs`, `!!set`) is kept in `tag`
  with its node read as written, never decoded. A
  number's `lexeme` keeps its source text, but only a plain integer lexeme is stored INTEGER, so
  `0x1F` and `+1` are REAL.
- **Data codes for YAML.** `DATA_YAML_VERSION` (defective): a `%YAML` directive naming any version
  but 1.2, every directive in the stream checked. `DATA_NON_STRING_KEY` (condition): a mapping key
  that is not a string, keyed by its source text. An alias naming no anchor before it is
  `DATA_PARSE_ERROR`; `.inf` and `.nan` are `DATA_LOSSY_NUMBER`. A lone CR is one line break in
  `line` and `column`, as it is for JSON.

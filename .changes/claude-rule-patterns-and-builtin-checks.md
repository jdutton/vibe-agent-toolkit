### Added

- **`vat resources check` now runs built-in checks with no `resources.checks` declared.** The first
  is `claude-rule-glob-inert`, emitting `CLAUDE_RULE_GLOB_INERT` at `info` for every `paths:` glob
  under `.claude/rules/` that matches no file. Silence it with
  `resources.validation.severity.CLAUDE_RULE_GLOB_INERT: ignore`; run it alone with
  `--check claude-rule-glob-inert`. Built-ins are never SQL, and `data.checks` marks them
  `builtin: true`.

- **`claude_rule_patterns`** joins the projection for `vat resources query` and `check` — one row
  per `paths:` glob with `pattern`, `literalPrefix`, `witnessPath` and `status`. ⚠️ Filter on
  `status = 'inert'`, never `status != 'matched'`: `unevaluated` means VAT never ran the matcher.

### Fixed

- **A bounded skill extent no longer under-reports the files a build would ship.** The projection's
  skill extent charged a non-markdown target — an image, a JSON file, an HTML page — a hop against
  `linkFollowDepth`, while the packager bundles it regardless: a leaf enqueues nothing, so there is
  no hop to bound. A skill whose documents link assets got a membership answer from
  `vat resources query` that was smaller than what `vat build` produced. Closure declarations gained
  `traverseParserKinds` to say which kinds are doors; anything else is admitted as a leaf and never
  traversed through. Refusals still outrank it, on both arms.

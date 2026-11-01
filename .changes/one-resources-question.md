### Changed

- **Every resources lane populates the tree once per tree and git index, and shares it**:
  `vat resources validate`, `scan`, `query`, `check`, `vat skills validate`, `vat skills build`,
  `vat claude plugin build`, `vat build` and `vat claude context` read one stored population, so a
  repeat run on an unchanged tree and index is served from the store whichever verb wrote it, and
  `vat validate`'s checks phase is served the population its resources phase wrote.
- **A cold `vat resources scan`/`validate`, `vat skills validate`/`build`, `vat claude plugin build`
  or `vat rag index` now runs the blob stage**: it reads, hashes and parses every non-ignored file,
  where it used to read none. The cold cost depends on how much of the tree is resources (median of
  5 interleaved rounds against v0.2.0-rc.11):
  - On VAT's own tree, where a minority of tracked files are resources, a cold
    `vat resources validate` is 1.58× (3.32 s vs 2.10 s).
  - On a large adopter monorepo it is 1.01× (16.2 s vs 16.0 s). The `vat skills validate` that
    follows it falls from 4.9 s to 2.7 s, because it now hits what validate stored. A cold
    `vat validate` (19.6 s) is faster than rc.11's separate validate, check and skills runs
    (28.9 s).

  A warm run is a store hit. With the store off (`VAT_PROJECTION_STORE=off`) or outside a git
  repository there is no warm run, so every membership run pays this cold cost. Peak memory on
  that cold run grows with the tree's total text, because the run's content cache holds every file
  it keyed.
- **`vat claude context` registers the same contributor set as the resources lanes**, plus its
  `@`-import extents, so it answers its question from the population they share instead of a
  hand-kept copy of their registration.
- **With the store off (`VAT_PROJECTION_STORE=off`) or outside a git repository**, nothing is shared
  between the resources phase and the checks child, so `vat validate` populates the tree twice.
- **`vat inventory` and the resources lanes still evict each other's stored population.** The
  two share a store key but not a parameter set (`vat inventory` does not decline ignored files),
  and each run's filesystem context replaces the other's, so alternating `vat inventory` with
  `vat resources validate`, `scan`, `query` or `check` over one unchanged tree re-derives every
  time. Time, not answers. Recorded in `docs/contributing/known-defects.md`.
- **Test timeouts in the integration and system tiers are floors, not literals or multiples.** A
  test that needs longer than its tier passes `atLeastTierTimeout(inject('tierTestTimeout'), budget)`
  (new in `@vibe-agent-toolkit/utils/testing`): the platform-scaled default is the floor and the
  budget a ceiling. `local/no-literal-test-timeout` accepts a number only as that budget. The system
  tier defaults to `max(120 s, platform)` per test and `max(300 s, platform)` per hook, and the CI
  `validate` job ends a hang at 70 min (180 min on Windows).

### Fixed

- **No success banner over a run that examined nothing.** `vat skills validate` on a config with no
  `skills:` block, or include globs matching nothing, printed `✅ All validations passed` directly
  above its refusal and exit 1; `vat skills build` and `vat build` had the same shape. Each now
  prints `⚠️ Not a verdict: nothing was examined` there instead, and `vat validate`'s opening
  line no longer starts with `✅` before anything has run. `vat claude plugin install` over a
  source with no skill prints `⚠️ Nothing installed` instead of `✅ Installed 0 skill(s)`.

- **A store hit no longer hides refused content.** The line naming files declined as not text,
  unreadable or too large, or mis-decoded, is now read from the population's stored rows, so
  `vat resources check` after `vat resources validate`, and `vat validate`'s checks phase, report a
  binary that only a cold run used to name. `vat resources query`, `check`, `vat claude context` and
  `vat inventory` report it on stderr, each line naming its population (`resources population:`,
  `claude-context population:`, `inventory population:`), and a query over the `claude_context_*`
  relations reports the lens population too; the membership and build verbs stay quiet. The line no
  longer counts headings or references dropped for want of a source line, which no stored row
  records. A failed read (`BLOB_UNREADABLE`, `BLOB_CONTENT_CHANGED`) is reported by the run that
  observed it and not by a later store hit, which re-reads that file instead of serving the failure.
- **The refusal line no longer names every committed image.** Binary content is reported only at a
  path whose type promises text (`.md`, `.json`, a collection's declared `mimeType`), so a
  repository's PNGs stay silent; a corpus with no text at all is still reported. The line's pointer
  names the table that holds its rows (`blob_conditions`, `resource_realizations` or `blobs`).

- **Under a clean/smudge filter or `working-tree-encoding`, two paths sharing a git blob could be
  filed under one content key.** On the git enumerator, a second path whose blob OID matched an
  earlier path's was served that path's read: the same content key and the same text, though its
  working-tree bytes differed. Every path is now read and keyed from its own bytes. Affected
  v0.2.0-rc.3 through v0.2.0-rc.11; v0.1.42 is not affected.

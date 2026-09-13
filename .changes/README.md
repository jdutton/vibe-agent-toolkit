# Changelog fragments

One file per branch or topic, so two branches never conflict on `CHANGELOG.md`'s
`[Unreleased]` block. `bun run bump-version <stable>` folds every fragment here under the new
version heading, section by section, and deletes it. RC bumps leave fragments in place.

A fragment is a markdown file named for its topic (`skill-test-exit-codes.md`) containing only
`### <Section>` headings and bullets:

```markdown
### Fixed

- **`vat foo` could commit into the wrong repository when run from inside a git hook.**
  Fixed; no action needed.

### Breaking

- **`vat skill test` exit codes 3 and 4 fold into 2**; the JSON report's `reason` field says which.
```

Allowed sections: `Breaking`, `Added`, `Changed`, `Deprecated`, `Removed`, `Security`, `Fixed`.
No `## [version]` headings — those belong to `CHANGELOG.md`. `bun run validate-structure` fails on
a malformed fragment. Wording rules are in `.claude/rules/changelog-adopter-visible.md`; this file
is not a fragment.

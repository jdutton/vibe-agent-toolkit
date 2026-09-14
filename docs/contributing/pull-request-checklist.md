# Before a pull request, and before a release tag

The root [`CLAUDE.md`](../../CLAUDE.md) holds the gate rule (loop `bun run validate` to zero
errors; trust the exit code, not the summary). This page is the once-per-PR and once-per-release
sequence that surrounds it.

## Before opening or updating a pull request

1. **Changelog.** Either a `.changes/<topic>.md` fragment
   ([`.changes/README.md`](../../.changes/README.md)) or a direct edit under `CHANGELOG.md`
   `[Unreleased]`; prefer the fragment when other branches are in flight — fragments never
   conflict, and `bump-version` folds them. Nothing enforces the choice; `pre-release` enforces
   that a stable version leaves `[Unreleased]` empty. Wording is an adopter contract: what the
   reader must DO, three lines at most, per
   [`.claude/rules/changelog-adopter-visible.md`](../../.claude/rules/changelog-adopter-visible.md).
   A contributor-only change (docs under `docs/contributing/`, a `.claude/rules/` file, dev
   tooling) gets no entry.
2. **Version.** Ask the developer *"bump the version or cut an RC for this change?"* — a bump is
   their decision, never a side effect. `bun run bump-version <version>`: a stable bump stamps
   `[Unreleased]` and folds the fragments; an RC leaves both in place.
3. **Gate.** `bun run validate` once more on the final tree, exit code read from a file, and say
   which tree hash it ran on. A green pre-commit hook is the smaller tier; CI runs the full tier on
   ubuntu and Windows, so a green commit is not a green PR.
4. **Description.** What changed for an adopter, what changed for a contributor, and which
   ratchets moved (allowlist counts, thresholds, seeds) with the reason for each — a ratchet that
   moved without a stated reason is the first thing a reviewer asks about.
5. **Review.** Findings name their drift class and the class-level fix
   ([`drift-classes.md`](drift-classes.md)); "fix at the instance" is not an accepted response to
   a class finding.

After the PR is open: SonarCloud's comment must show New, Accepted and Security Hotspots all zero
("Quality Gate passed" is not zero); ignore its coverage line
([why](traps.md#sonarcloud-coverage-on-new-code-is-always-zero)) — Codecov is the coverage
authority. Fix every smell at its cause; `NOSONAR` does nothing under automatic analysis
([why](traps.md#nosonar-does-nothing-under-sonarcloud-automatic-analysis)).

## Before tagging a release

Releases are cut from `main` after merge — never from a branch.

1. `bun run pre-release` must pass. It is the pre-publish check plus release readiness: a
   marketplace publish dry-run, no tag of this version already on the remote, and (stable only)
   a non-empty, stamped CHANGELOG section with nothing left under `[Unreleased]`.
2. Only then `git tag v<version>` and `git push origin main v<version>` — the tag push triggers
   `publish.yml`, which re-runs the same check against the pushed tag.
3. Watch the workflow; rollback and the manual fallback are in
   [`docs/publishing.md`](../publishing.md#rollback-safety).

(enforced by: `bun run pre-release`, `publish.yml`; the rest of this page is not)

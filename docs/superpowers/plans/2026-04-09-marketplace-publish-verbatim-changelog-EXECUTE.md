# Execution Prompt: Marketplace Publish Verbatim CHANGELOG Fix

**Copy the block below into a fresh Claude Code session.**

---

Execute the implementation plan at `docs/superpowers/plans/2026-04-09-marketplace-publish-verbatim-changelog.md` using the **superpowers:subagent-driven-development** skill. Dispatch one subagent per task, review between tasks, and iterate until each task's verification passes before moving on.

## Branch & environment

- You should already be on branch `fix/marketplace-publish-verbatim-changelog` (created from `main`). Verify with `git status` before starting. If you're on the wrong branch, stop and ask.
- The plan file `docs/superpowers/plans/2026-04-09-marketplace-publish-verbatim-changelog.md` is **untracked** in the working tree. It needs to be included in the final commit.

## Commit discipline — READ CAREFULLY

**Do NOT commit incrementally.** Ignore every `git add` / `git commit` step inside the plan. Hold all changes uncommitted in the working tree throughout the entire execution. Make **exactly one commit at the very end**, after the entire plan is complete and the full validation suite passes.

Rationale: the change is a single cohesive refactor (delete `stampChangelog`, add `parseVersionSection`, rewire `publish-tree.ts`, update help, document breaking change). A single commit keeps the git history clean and makes the breaking-change PR easy to revert if needed.

## Verification discipline — also read carefully

Verification is **not** optional just because commits are deferred. You still MUST verify along the way:

- **After each task's code edits**, run the targeted test command specified in that task (e.g., `cd packages/cli && bun run test:unit -- changelog-utils` for Task 1, `bun run test:unit -- publish-tree` for Task 2).
- **After Task 2**, also run `cd packages/cli && bun run test:unit` to catch any publish.ts / ComposeOptions / `date` cleanup you may have missed.
- **After Task 3**, run `bun run build` and sanity-check `node packages/cli/dist/bin/vat.js claude marketplace publish --help` shows the new wording.
- **Before the final commit**, run `bun run validate` from the repo root and confirm every phase passes. This is the hard gate. Do not commit until this is green.

If any verification step fails:
1. Do NOT skip forward. Fix the issue.
2. Re-run the failed verification.
3. Only proceed once it passes.

## Task 4 adjustments (CHANGELOG + version + PR)

The plan's Task 4 steps need these adjustments:

1. **CHANGELOG entry:** add it as specified in Task 4 Step 2 (this IS a user-visible breaking change — marketplace publish behavior flips).
2. **Version bump question:** ask Jeff before committing. This is a breaking change to a feature shipped in 0.1.23, currently in `[Unreleased]` for the next release. Recommend discussing whether it warrants calling out in an RC or just bundling into the next regular release. Do not commit or push until Jeff answers.
3. **Final `bun run validate`:** must be green immediately before the single commit.
4. **The single final commit** should include: source changes, test changes, help text, CHANGELOG.md entry, AND the plan file itself (`docs/superpowers/plans/2026-04-09-marketplace-publish-verbatim-changelog.md`, currently untracked).
5. **PR creation:** do NOT create the PR automatically. After the commit lands, stop and ask Jeff whether to push and create the PR. Suggested PR title is in Task 4 Step 7 of the plan.

## Dogfood step (Task 4 Step 6)

Still run the `vat audit --user --verbose` dogfood check — it's best-effort, not a gate. Report any unexpected output but do not block on it unless it looks like a regression caused by this change (very unlikely — this change doesn't touch audit).

## Final commit message

Use a single conventional-commit message that covers the whole change. Suggested format:

```
fix(cli): marketplace publish mirrors CHANGELOG verbatim

VAT no longer rewrites the CHANGELOG.md it copies into the publish
tree. The source file is mirrored byte-for-byte and release notes
flow to the commit body via changelogDelta extraction only.

Accepts both Keep a Changelog workflows:
- Workflow A: non-empty [Unreleased] (extracted for commit body)
- Workflow B: pre-stamped [X.Y.Z] matching package.json (preferred)

Changes:
- Delete stampChangelog() and its tests (one caller, clean removal)
- Add parseVersionSection() helper with semver pre-release support
- publish-tree.ts copies CHANGELOG byte-for-byte; extracts commit
  body via parseVersionSection -> parseUnreleasedSection fallback
- Remove unused `date` field from ComposeOptions / PublishOneOptions
  (YAGNI, pre-1.0)
- Update publish --help to document verbatim behavior

Benefits:
- Corrections/typo-fixes to CHANGELOG.md on main now propagate to
  the publish branch on the next publish.
- main and publish branch never diverge on CHANGELOG contents.
- Postel's Law: VAT is conservative in what it produces.
- Eliminates a duplicate-heading footgun that would trigger if
  stampChangelog ran against a pre-stamped changelog.

BREAKING CHANGE: Workflow A adopters whose main-branch CHANGELOG
carries [Unreleased] at publish time will see that heading on the
publish branch too. To publish with a stamped heading, stamp
CHANGELOG.md on main before tagging (e.g., via bump-version).

Refs: adopter bug report 2026-04-09
Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
```

## Start

Announce you're using subagent-driven-development, then read the plan and begin Task 1. Remember: no incremental commits, full verification between tasks, single commit at the end, stop before pushing.

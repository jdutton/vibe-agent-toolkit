---
paths:
  - "**/CHANGELOG.md"
---

# You are editing CHANGELOG.md — it is an adopter contract, not a work log

## ⛔ Write what the reader must DO, not what you found out

This is the rule that gets missed on the first draft, every time, including by people who
have already read this file. You have just finished the work; the investigation is vivid and
the mechanism feels like the interesting part. **It is not the deliverable.** The reader did
not do the work, will never do the work, and is scanning to answer one question: *does this
affect me, and what do I change?*

**The three-line ceiling.** An entry gets **one line naming the change**, and at most two more
only if the reader must act. Something genuinely subtle earns a fourth. If yours is a
paragraph, you are narrating.

**The deletion test — apply it before saving, not after Jeff asks.** Draft the entry, then
strike every sentence that survives the question *"would the reader still know what to do
without this?"* Sentences that always go:

- How the bug works internally, and why it is hard to notice.
- What you measured, and the fixture you measured it with.
- Which other component behaves differently and why yours is right.
- Any sentence beginning "Measured", "The result is not", "This is deliberately".

Keep numbers only where the number changes a decision (a size limit, a version, a count that
tells someone whether they are affected). Cut numbers that merely prove you did the work.

```
❌  **`vat foo` could write to the wrong repository.** The command builds a throwaway repo
    under the temp directory and runs init, checkout -b, add and commit in it — but an
    inherited GIT_DIR overrides the cwd those were given. Measured from inside a worktree
    pre-commit hook against a bystander repository: its branch was switched, its index
    rewritten and a commit landed in it, with the push next in line, while every command
    reported success. The same class of failure hit ... [140 more words]

✅  **`vat foo` could commit into the wrong repository when run from inside a git hook.**
    Fixed; no action needed.
```

The long version is not more helpful, it is less: the one fact the reader needed —
*"from inside a git hook"* — is the fifteenth thing they read.

**Where the detail belongs instead:** the code, as a comment at the site; the commit message;
or memory. All three keep it for the people who need it. The changelog is the one place it
costs every reader and helps none.

## The baseline

**The baseline is the LAST STABLE RELEASE, never the last RC.** Every entry answers one
question: *what changes for someone upgrading from the last `## [X.Y.Z]` heading?* RC tags
publish to `next` for testing and are **never** given their own heading — `[Unreleased]`
accumulates until a stable bump stamps it.

## What does NOT get an entry

- **A bug introduced and fixed entirely within the current `-rc.*` line.** No released
  version ever exhibited it, so documenting it describes a defect no adopter could have
  hit. This is the single largest source of changelog bloat here.
  - **Test before you write:** does the affected symbol/flag/field exist at the last stable
    tag? `git grep -l '<symbol>' v<last-stable> -- packages` — **use `-- packages`, not a
    `packages/*/src` glob**, which silently matches nothing and returns a confident zero for
    everything. Sanity-check with a symbol you know existed.
  - Zero hits → the surface is new this cycle → fold the final behaviour into the **Added**
    entry and delete the fix entry. Hits → the fix is real and visible → keep it.
- **Internal-only work**: refactors, test improvements, CI/tooling, lint config, dev-dep
  pins, doc reorganisation. Exception: it changes what an adopter observes, or it is
  security/dependency work (below).
- **Repo hygiene** that ships no behaviour change.

## What ALWAYS gets an entry

- **BREAKING changes — these are the highest-value content in the file.** Never drop or
  soften one while consolidating. Each states what changed, why, and **what the adopter must
  do**. Consolidating several related breaks into one entry is good; losing one is not. When
  you condense, re-derive the list from the pre-edit text (`grep -oE '\*\*BREAKING[^.]*'`)
  and check the new draft covers every item, marking any deliberate drop and its reason.
  Mark library-only API breaks as such so CLI users can skip them.
- **Security and dependency advisories**, even when routine — an adopter needs to know what
  their tree inherits. Merge the routine sweeps into one entry with net numbers.

## Style

- Lead with the user-visible symptom, not the internal cause. Real measured numbers beat
  adjectives ("247 errors from one schema", "369 s → 42 s") — do not round them off.
- One entry per adopter-visible change, not one per commit or per PR.
- Never name a proprietary adopter — describe abstractly ("an adopter with ~90 skills").
  `bun run validate-structure` fails the build on a contraband name.

## Size is a hard constraint, not a style note

`vat claude marketplace publish` passes the whole `[Unreleased]` section as a **single**
`git commit -m` argument, and **Linux caps one argument at 131,072 bytes** (`MAX_ARG_STRLEN`
— separate from, and far smaller than, `ARG_MAX`). Crossing it makes the publish step fail
*after* npm has already published, with a misleading "exit 1". macOS has no such cap, so a
local `bun run pre-release` dry-run **cannot** catch it.

Check before releasing:

```bash
awk '/^## \[Unreleased\]/{f=1} f&&/^## \[0\./&&!/Unreleased/{exit} f' CHANGELOG.md | wc -c
```

If it is anywhere near 131,072 the section has stopped being a changelog. Apply the triage
above rather than truncating — the size is the symptom.

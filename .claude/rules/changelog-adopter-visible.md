---
paths:
  - "**/CHANGELOG.md"
---

# You are editing CHANGELOG.md — it is an adopter contract, not a work log

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

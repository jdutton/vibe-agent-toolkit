# Pipeline oracles

Intermediate correctness instruments for VAT's resource pipeline. Internal to
this repository — deliberately **not** exported from `packages/cli/src/index.ts`,
and nothing outside VAT's own tests should bind to these shapes.

## Why these exist

VAT's correctness evidence today is whole-command stdout diffs. They proved
determinism superbly — three runs of six commands across two corpora differ by
exactly one line, the duration field, and a 1.81 MB audit YAML with 1,755
findings diffs to zero lines outside it — but they answer exactly one question:
*did the output change?*

That is the wrong question for a change that touches enumeration, parsing,
projection and judgement at once. Two consequences:

- **No localization.** A red 1.81 MB diff cannot distinguish "a different file
  set was enumerated" from "a file parsed differently" from "a join went wrong"
  from "a check now fires more often."
- **Blind to population.** The safety story for any pipeline restructure is
  "each lane's population is unchanged" — and population is not directly
  observable in command output. `filesScanned` catches gross changes; a file
  whose *classification* moves while its findings stay identical is invisible.

## What is here

| Instrument | What it answers | Status |
|---|---|---|
| **Enumeration snapshot** | Per lane, per corpus: which paths, **in which order**, with `exists` / `isDirectory` / `gitignored` / `isSymlink` / `symlinkResolves` / content key | Built |
| **Parse-fact snapshot** | Per content key: links + ordinals, headings + slugs, frontmatter **source**, parse conditions | Built |
| **Rule-invocation log** | Per run: which check ran, over how many rows, emitting how many findings | **Not built** — see below |

### ⛔ The enumeration snapshot is never sorted

`ResourceRegistry.addResources` is explicitly first-added-wins on
`DuplicateResourceIdError`. Arrival order therefore decides which of two
colliding files gets validated, bundled and rewritten. A sorted snapshot would
hide exactly the defect this instrument exists to catch, so
`renderEnumerationSnapshot` reproduces capture order verbatim.

There is one exception, and it is about hosts rather than about ordering being
unimportant. `crawlDirectory` has two mutually exclusive routes: `git ls-files`
(git-sorted, portable) and a recursive `readdirSync` walk (**filesystem** order —
ext4's hashed directories, APFS and NTFS all differ). An ordered golden captured
on the walk route on one host does not hold on another for reasons that are not
defects. So the walk route gets `renderEnumerationSnapshotUnordered` plus a
within-host order-stability assertion, and only the git route gets an ordered
golden.

### The parse-fact snapshot is keyed by content, not by path

That is what makes it double as the parse cache's correctness oracle. If two
paths key the same and their facts differ, a content-addressed cache is unsound.
If the same bytes key differently across runs, it is useless. Neither is visible
in command output.

Frontmatter is captured as **source**, not as the parsed object. A YAML→JSON
round-trip is lossy in ways a validator notices: `.inf` and `.nan` become `null`,
`!!binary` becomes a Buffer envelope, and a cyclic anchor makes `JSON.stringify`
throw. A cache storing the object would hand Ajv `Infinity` on a cold run and
`null` on a warm one — same corpus, same config, different reported issues.

## The five lanes

There is no single enumeration in VAT. There are five, and they disagree about
what the corpus is. `lanes.ts` names each one's **real production builder** —
never a copy — alongside a declarative restatement of its crawl, because the
registry does not retain the pre-deduplication ordered list. That restatement is
a copy and therefore a drift risk, so every snapshot reconciles the two and
reports disagreement as `restatementDrift`.

**A non-empty `restatementDrift` means `lanes.ts` has drifted from the code it
claims to describe, and every snapshot it produced is a fiction. Fix the lane
definition; do not regenerate the golden.**

## The trap corpus

`trap-corpus.ts` builds a small tree in which every file earns its place by
making one specific defect observable. Two properties no committed VAT fixture
had:

- **It is not a git repository by default.** Every other VAT fixture is, and
  that masked a defect worth 88% of one command's runtime — because the defect
  cannot fire inside a repo. `initGit: true` gets the other route.
- **It contains a skill that actually bundles a file.** All 13 of VAT's dogfood
  skills bundle zero files, so VAT's own build cannot tell a working link graph
  from a structurally empty one.

It is built from code rather than shipped as an archive because symlinks do not
survive a ZIP round-trip reliably across platforms, and because building from
code lets the corpus *ask* whether the host can create symlinks rather than
assume it.

## Running the gate

```bash
bun run test:integration          # compares against the committed goldens
UPDATE_DRIFT_GOLDEN=1 bun run test:integration   # regenerate, then READ THE DIFF
```

Goldens live in `packages/cli/test/golden/pipeline-oracles/`, mirroring the
convention `packages/vat-development-agents/test/system/packaged-output-drift.system.test.ts`
already established. They are reviewed expected output, not a claim that the
output is correct: a drift failure is a prompt to read the diff.

Because these are ordinary integration tests, they run in the existing
Node 22/24 × Ubuntu/Windows CI matrix without any separate runner.

## Not built yet

**The rule-invocation log.** Per run: which check ran, over how many rows,
emitting how many findings — the instrument that converts "the golden went red"
into "check X now fires three more times", and the same instrument adopter-
authored SQL checks will need at runtime. It is not here because VAT's checks
are not a registry today; they are functions scattered across the validators,
so producing an honest log means instrumenting each one. That is a change to
production control flow rather than an addition beside it, and it belongs with
the work that gives checks a common shape.

## Known defects these instruments surfaced

Both are pinned by tests that assert **today's** behaviour, with the intended
behaviour stated in the test's docstring. When either is fixed, its assertions
flip in the change that fixes it.

1. **`followSymlinks: false` is honoured on the walk route and ignored on the
   git route.** `git ls-files` returns mode-120000 entries and that branch does
   no symlink filtering, so the same tree with the same options has a different
   population depending only on whether a `.git` exists above it.
   (`enumeration-symlink-divergence.integration.test.ts`)
2. **A committed dangling `*.md` symlink terminates the command.** On the git
   route that entry reaches `readFile`, which throws `ENOENT`; `addResources`
   catches only `DuplicateResourceIdError`, so it escapes `registry.crawl` and
   the process dies with a raw stack trace rather than reporting a finding.
   (same file)
3. **The built lane's link graph is empty.** Packaged output landing under the
   project's `dist/` is excluded from the crawl that the post-build validator
   uses, so `fileCount`, `maxLinkDepth`, the size rules and — not just metrics —
   the per-bundled-file content scans all operate on an empty bundle set.
   (`built-lane-link-graph.integration.test.ts`)

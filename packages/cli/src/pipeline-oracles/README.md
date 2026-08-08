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
| **Parse-fact snapshot** | Per content key: links + ordinals + `resolvedId`, headings + slugs, frontmatter **source, value shapes and value digests**, fragment anchors, optional-array presence states, byte and decoded lengths, parse conditions — with `keyof ParseResult` coverage enforced at compile time | Built |
| **Symlink divergence report** | Per lane, per corpus: the three populations one tree can present (`git ls-files`, walk without following, walk following) and every path that is not in all of them, with the reason | Built |
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

**Every path is parsed, including the second and later arrivals under a key
already recorded**, and the rows are compared field by field into
`keyDisagreements` — which must be empty. Skipping those parses is the cache's
own assumption asserted inside the instrument meant to test it; see "The one
item that was fixed rather than declared" below for what that cost.

#### Every `ParseResult` field is accounted for, and `tsc` enforces it

The snapshot's claim is *"if a cached parse differs from a fresh one, a row here
differs."* A field of `ParseResult` that no row records breaks that claim
silently: the cache corrupts it, every golden stays green, and the gate reports
success for precisely the thing it exists to catch.

So `parse-fact-snapshot.ts` partitions `keyof ParseResult` into
`CapturedParseResultField` and `UnrecordedParseResultField`, and asserts the
remainder is `never`. **Adding a field to `ParseResult` fails the build** until
someone states which bucket it is in. The guard lives in `src/` deliberately —
no test file in this repository is typechecked, so the same assertion written in
`test/` would assert nothing.

This is not a hypothetical. `anchors` was uncovered until 2026-08-07, and it is
the input to `ResourceRegistry.buildFragmentIndex` — every `file.md#fragment`
check in VAT.

#### Frontmatter is captured three ways, because no one capture does the job

- **Source** (`frontmatterSource`), the block as written. Catches a change in
  the *parser*. It is re-derived from the freshly-read bytes, so it is
  **constant by construction for a given content key** — which means it can
  never detect a cache fault, and that is why the other two exist.
- **Shapes** (`frontmatterFields[].typeName`), each top-level key with the
  runtime type of its value. This is what a lossy round-trip moves: `.inf` goes
  `number` → `null`, `!!binary` goes `Buffer` → `Object`. Top-level only, so a
  cyclic anchor is recorded rather than thrown on.
- **Value digests** (`frontmatterFields[].valueDigest`). Shape alone is not
  enough and the gap is not hypothetical: every `SKILL.md` in a corpus has
  `{name: string, description: string}`, so a cache serving one skill's parse
  for another moved nothing. The digest is hand-rolled rather than
  `JSON.stringify` because every input it must survive breaks that — `.inf` and
  `.nan` serialize to `null`, `!!binary` to an envelope, and a cyclic anchor
  throws, which would mean the document is silently never recorded at all.

#### Absent is not empty — and it matters where it is *reachable*

The rule is real, but it was first enforced in the one place it cannot fire.
Both parsers spread `anchors` conditionally (`...(list.length > 0 && { anchors })`),
so a present-but-empty `anchors` is **unreachable**; its rendering is defensive
only.

Where it does fire is `parseErrors` and `unresolvedReferences`. `collectConditions`
reads both through `?? []`, so absent and empty produce an identical `conditions`
list — while the contract distinguishes them explicitly (`unresolvedReferences`
is *"HTML leaves this undefined; markdown always populates it (possibly empty)"*).
Those states are therefore recorded separately, in `optionalArrays`.

#### Lists are one entry per line, never joined

A `', '` join is ambiguous, and it was not a theoretical ambiguity: `["p, q"]`
and `["p", "q"]` rendered the identical line `anchors: p, q`, and `id="p, q"`
survives both parsers verbatim — two different fragment-target sets,
indistinguishable, on the field that feeds every `file.md#fragment` check. Every
list now renders a count header (`-` for absent, a number otherwise) followed by
one tab-delimited line per entry, and every interpolated value goes through
`renderInline`. `href` and `slug` previously did not, so a tab or newline inside
one could corrupt the table.

### The symlink divergence report answers a product question with measurements

`followSymlinks` is not one decision; it is three collapsed into a boolean —
**looping/aliasing**, **escaping the crawl root**, and **membership**. Only the
last is a product question, and it is the one the flag answers worst: it is
honoured on the walk and ignored by `git ls-files`, so the same tree with the
same options has a different population depending on whether a `.git` exists
above it.

Measured on two of Anthropic's own shipped plugin trees:

| corpus | git route | walk, no follow | walk, following |
|---|---:|---:|---:|
| `superpowers/6.1.1` (no `.git`) | — | 82 | 83 |
| `data-engineering/0.1.0` (git) | 70 | 68 | **70** |

Two findings. **Following makes the routes agree exactly** — 70 and 70. And
**every divergent row in both trees is an `alias`**: a second name for a blob
already enumerated (`AGENTS.md → CLAUDE.md` and its inverse), never new content.
So the decision is not up-versus-down; it is what a projection does with one
blob that has two names. The escape case is real and lives in the trap corpus,
but was **not observed** in either real tree — do not read "every divergence is
an alias" as a law.

⚠️ Two confounds are **classified rather than filtered**: forcing the walk means
`respectGitignore: false`, which also stops honouring `.gitignore`; and
`git ls-files` returns only *tracked* files. A difference removed before it is
counted is a difference nobody can audit.

### `aliasesEnumeratedPath` and `targetInsideRoot` are exercised in exactly one place

Both are constant-`false` in all ten committed enumeration goldens, whose
corpora are built with `skipSymlinks: true` — so the goldens alone cannot tell a
working column from one that is hardcoded. `symlink-divergence.integration.test.ts`
is the only place either is observed non-default, and it also pins the
distinction the column would be easiest to get wrong: `twins/left/same.md` and
`twins/right/same.md` share a **content key** and are **not** aliases. Aliasing
is answered by real path, never by content, or every pair of empty files in any
corpus would report as aliases of each other.

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

### The `parse/` files exist because VAT's real corpus cannot distinguish

VAT's own 265 tracked markdown files contain **763 `link` objects but only two
`linkReference`s, two `definition`s, zero HTML anchors and zero frontmatter
errors**. A whole-corpus diff over them is therefore silent on the contracts
most at risk in a parse refactor: it cannot observe kind-ordering, reference
resolution, anchor extraction or masking at all. The AST-traversal collapse
diffed to zero rows across all 265 documents and that proved almost nothing —
what proved it was an eleven-case adversarial probe, and `parse/` is that probe
ported in so the property is guarded rather than re-established by hand.

The load-bearing one is `parse/interleaved-kinds.md`. `links` is ordered by node
**kind** — every `link`, then every `linkReference`, then every `definition` —
not by document position, and every other document in the corpus declares its
definitions last, where the two orders happen to agree. That file declares one
**first**, so a collapse into a single document-order traversal renumbers its
ordinals and nothing else's.

## Running the gate

```bash
bun run test:integration          # compares against the committed goldens
UPDATE_DRIFT_GOLDEN=1 bun run test:integration   # regenerate, then READ THE DIFF
```

`UPDATE_DRIFT_GOLDEN` is declared in `turbo.json`'s `globalEnv`, which is what
makes the second command work at all. Turbo runs tasks in a strict environment
and passes through only declared variables, so before it was declared the
regeneration command ran the suite with the flag **unset** — it compared against
the goldens, passed, and wrote nothing, while looking exactly like a successful
regeneration. Being in `globalEnv` also puts it in the task hash, so a
regeneration run can never be served from the cache of a comparison run.

If the goldens do not move when you expect them to, check that first: this
repository caches `test:integration`, and a replayed task prints the same green
as an executed one.

Goldens live in `packages/cli/test/golden/pipeline-oracles/`, mirroring the
convention `packages/vat-development-agents/test/system/packaged-output-drift.system.test.ts`
already established. They are reviewed expected output, not a claim that the
output is correct: a drift failure is a prompt to read the diff.

Because these are ordinary integration tests, they run in the existing
Node 22/24 × Ubuntu/Windows CI matrix without any separate runner.

## What this instrument can and cannot see

The claim "these oracles catch a pipeline restructure going wrong" is only worth
as much as the evidence behind it, and a green suite is not that evidence — a
suite that asserts nothing is also green. So every fact class here was tested by
**deliberately breaking it and confirming the gate goes red at the right row**:
24 runs over 14 named mutations, each applied to `src/` (never to a test), run,
and reverted.

The interesting output is not the twenty that went red. It is the three that did
not, and the two that went red in only one place.

### Declared blind spots — mutations the gate cannot see

**`gitignored` cannot be falsified on either route.** Forcing the column to a
constant `false` changes nothing anywhere. On the git route `git ls-files`
cannot return an ignored path, so the column is constant-`false` *by
construction*; off the git route there is no gitignore oracle at all, so it is
constant-`false` for a second, unrelated reason. The fact is real and lives in
`GitTracker`'s memoised oracle — it is simply not a property of an enumerated
row, and this column exists to let the two populations be compared, not because
it varies within one. **Do not "fix" this by making the column vary.**

**Disabling `restatementDrift` is invisible on a corpus that has no drift.**
Replacing the reconciliation with `[]` leaves every test green, because drift is
non-empty only when `lanes.ts` has diverged from the real builders and today it
has not. Pairing the two mutations bounds the cost precisely: with a lane
deliberately restated wrong, the drift test fires and *names the lane*; with the
same wrong restatement **and** detection disabled, that test goes green while
the lane's golden still moves. So the blind spot costs the **diagnosis**, not
the detection — a drifted lane is still caught, just as an unexplained
population change.

**`anchors` can never be present-and-empty**, so the `(none)` rendering of that
state is unreachable. Both parsers spread the key conditionally
(`...(list.length > 0 && { anchors })`). The `absent`/`empty` distinction is
live and falsifiable for `parseErrors` and `unresolvedReferences`, which is
where `optionalArrays` earns its place; for `anchors` it is defensive only.

### Facts observed in exactly one place

`targetInsideRoot` and `aliasesEnumeratedPath` can each be replaced by a
constant without moving a single golden line — every golden corpus is built with
`skipSymlinks: true`, where the honest answers are `true` and `false`
respectively. Both mutations are caught, but by exactly one assertion in
`symlink-divergence.integration.test.ts`. Delete that test and these two columns
become decorative. This is a property of the corpora, not of the columns.

### The one item that was fixed rather than declared

Until 2026-08-08 the parse-fact capture parsed the **first** path under each
content key and skipped the rest, with a comment saying so outright: *"not
re-parsing here is the same claim, asserted."* That is a content-addressed
cache's own assumption — same key implies same facts — implemented inside the
instrument built to verify it. With one parse per key there is no second
observation, so the load-bearing mutation had nothing to disagree with.

It now parses every path and compares, reporting `keyDisagreements`. The
difference is measurable. Removing the parser kind from the content key (making
it a pure function of bytes, which is exactly the unsound key this schema exists
to prevent) makes `empty.md` and `empty.html` collide:

- **with the fix:** `keyDisagreementCount: 0 → 1`, naming both paths and the
  three fields they differ on (`conditions,optionalArrays,parserKind`);
- **with the old skip restored:** `keyDisagreementCount` stays `0`. The gate
  still goes red — `blobCount` drops from 37 to 36 — but it reports a corpus
  that lost a document, with nothing said about *why*.

Both are red. Only one is a diagnosis.

### Two things the run itself taught

**A mutation that produces no diff must be distinguished from one that never
ran.** Every mutation was verified to have actually changed its file before the
gate was run; three "no red" results turned out to be substitutions that matched
nothing, which would otherwise have been recorded as blind spots.

**Restoring a mutated file with `mv` silently keeps the mutant alive.** `mv` puts
back the backup's original mtime, so `tsc --build` sees the restored source as
older than its own output, skips the rebuild, and leaves the mutant in `dist` —
where any test that imports a built package still runs it. One run was
contaminated this way and had to be repeated. Restore with `cp` + `touch`.

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
   (`enumeration-symlink-divergence.integration.test.ts`; quantified by
   `symlink-divergence.integration.test.ts` and the table above)
2. **A committed dangling `*.md` symlink terminates the command.** On the git
   route that entry reaches `readFile`, which throws `ENOENT`; `addResources`
   catches only `DuplicateResourceIdError`, so it escapes `registry.crawl` and
   the process dies with a raw stack trace rather than reporting a finding.
   (same file)
3. **A followed directory symlink enumerated one file once per kernel-permitted
   level.** `crawlDirectory`'s walk had no visited set, so `a/loop -> a`
   returned `a/note.md` **sixteen times** under sixteen distinct paths — one per
   nesting depth, bounded only by `MAXSYMLINKS` (32 on macOS, 40 on Linux, so
   the row count was a property of the operating system) and terminating inside
   the `catch` that exists to skip *broken* links, reporting nothing. **Fixed**,
   not pinned: a visited-realpath set, gated on `followSymlinks` so the default
   path pays no `realpath`. Latent rather than live — nothing in production sets
   the flag — which is exactly why it had to be fixed *before* any convergence,
   not after. (`file-crawler.integration.test.ts`)
4. **A duplicated definition label resolves to the LAST definition; CommonMark
   says the first.** `[dup]: ./first-wins.md` followed by `[dup]: ./last-wins.md`
   makes VAT report `./last-wins.md` for the reference, while every renderer
   links to `./first-wins.md` — so link validation checks a target the reader
   never visits. Pre-existing, and the fix is one line
   (`if (!definitions.has(id))`), but it changes output, so it belongs in its own
   commit with its own golden movement. Pinned as today's behaviour by
   `parse/duplicate-definition.md` and annotated at the code site in
   `link-parser.ts`.
5. **The built lane's link graph is empty.** Packaged output landing under the
   project's `dist/` is excluded from the crawl that the post-build validator
   uses, so `fileCount`, `maxLinkDepth`, the size rules and — not just metrics —
   the per-bundled-file content scans all operate on an empty bundle set.
   (`built-lane-link-graph.integration.test.ts`)

---
package: "@vibe-agent-toolkit/lab"
status: experimental
tags: [quality, benchmarking, profiling, corpus]
---

# @vibe-agent-toolkit/lab

The quality lab. Generates analyzable reports about a project, and compares them along exactly one
axis at a time — so a delta always has one thing to attribute it to.

> **Status: publish-shaped, not published.** Built as a public package — real exports, a versioned
> CLI contract, docs — but carrying `"private": true` while the interface still moves. Graduating it
> is the intent, not keeping it private. See [Roadmap](docs/roadmap.md).

## Using it

The binary is **`vat-lab`**, and every facet exposes the same two verbs — `run` produces a report,
`compare` diffs two of them:

```bash
vat-lab <facet> run <subject> --instrument <spec> [--command <name>]... [--out <dir>] [--runs <n>] [--cache warm|cold] [--id <name>]
vat-lab <facet> compare <baseline> <candidate>
```

`--command` names one measurable vat command instead of the default set and may be repeated
(`--command validate --command verify`); see
[Which commands get measured](docs/run-harness.md#which-commands-get-measured).

Facets today are **`io`** (filesystem-call counts), **`perf`** (wall time), **`parse`** (where the
time inside vat's document parse goes, pass by pass), **`crawl`** (where the time spent *finding*
those documents goes, per contributor, stratum and fixpoint pass), **`population`** (*which*
files a command enumerated) and **`verdict`** (what a build *decides* — exit codes, findings and
normalized documents — across a subject set, checked both ways against committed deltas).
`verdict` is shaped differently: `run` takes a required `--subjects <file>` instead of a
`<subject>`, and `compare` takes two capture directories plus `--deltas` and `--control` — see
[The verdict facet](docs/facets.md#the-verdict-facet). `parse` defaults to `--cache cold` because vat's parse cache
short-circuits the parse function on a hit, so a warm run has nothing to attribute; `crawl` and
`population` default to warm, because nothing caches a crawl — see [Facets](docs/facets.md).

`crawl` exists for one question `perf` cannot answer: VAT has **two crawlers live at once** — the
incumbent `walkLinkGraph` and the projection's `ClosureExtentContributor` — and both now record
through one seam, on one clock, into one dump. Its `by stratum` line is the two of them side by
side (`crawl` is the incumbent walker, `closure` is the projection), which is what makes a flip
decision a measurement rather than an argument.

`population` answers the other half of that question, and the four cost facets could not: not what
the crawl *spent* but what it *covered*. Its comparator is exact set difference — added, removed,
and same-path-different-content kept apart — and every row is held against git's own listing, so a
single report is falsifiable rather than only comparable with another run of itself. Each row also
names the arm the run *said* it took, read back out of vat's own output: an A/B whose two arms
silently ran the same enumerator is a clean result that means nothing, and this is what makes that
visible.

⚠️ The arm is the **lane and its extent source together** (`projection via git`), never the lane
alone. The projection lane has two enumerators and reports the same word for both, so an A/B
varying only `VAT_EXTENT_SOURCE` — which is exactly the axis the git-walker flip turns on — puts
`projection` on both sides. And `crawlSourceFor` declines git *silently* on a root outside a
repository, so "the two enumerators agree" and "the switch did nothing" are the same picture until
the extent source separates them. The walk sources no extent and so reports none.

`io` rows carry the same `lane` / `extentSource` pair, read by the same reader — off the **last**
repeat, whose dumps the row reports, where `population` reads its **first** — so an A/B of call
counts no longer has to infer which arm ran from a call-site signature. Every reader in the lab
parses a subject's stdout through one document reader (JSON first, then YAML — a single document,
a leading `---` tolerated), so an `io` row measured over the **default** spec (`resources-scan`,
YAML) carries its real lane exactly as one measured over `--command resources-population` (JSON)
does. `null` still means *the output did not say* — the build is too old to report a lane, or the
row's arm truly is unreported — and reads as `lane UNREPORTED by the subject's output`; a compare
over two such rows says `arm UNPROVEN on both sides`, and a compare where only one side named its
arm says `arm UNPROVEN on the before side — …; the after side ran 'projection via git'` (or the
sides swapped) — never the `[A → B]` form, which is reserved for two named arms that differ. See
[Facets](docs/facets.md) for the full table of arm clauses.

```bash
vat-lab population run ../some-project --instrument tree:. --id some-project \
  --env VAT_RESOURCES_CRAWL=walk --out ./walk
vat-lab population run ../some-project --instrument tree:. --id some-project \
  --env VAT_RESOURCES_CRAWL=projection --out ./projection
vat-lab population compare ./walk/<report>.json ./projection/<report>.json
```

The lane is chosen with `--env`, never by exporting it in your shell: every arm starts from an
environment cleared of INHERITED `VAT_*`, and only what the arm sets explicitly reaches vat.

⚠️ Separate `--out` directories are required for two arms selected by the **environment**: the
coordinate models the subject, its version and the vat build, and an env-selected lane is none of
those, so both reports would otherwise land on one filename and the second would overwrite the
first. See the note on `reportFileName` in `src/store.ts`.

A minimal vary-the-instrument comparison — the same project, measured by two builds of vat:

```bash
vat-lab io run ../some-project --id some-project --out ./before
# ...change vat, rebuild...
vat-lab io run ../some-project --id some-project --out ./after
vat-lab io compare ./before/<report>.json ./after/<report>.json
```

Reports default to `.vat-lab/`, which this repo gitignores — keep it that way, since lab output
landing inside the tree being measured changes the next run's numbers.

## Arms — every timed measurement is a sequence in its own directories

A timed arm is a **sequence of steps** run in `<arms root>/<build>-<arm>-<state>/{store,tmp,home,npm-cache}`
(created at 0700), from a **cleared environment**: no inherited `VAT_*`, temp, XDG, git config,
git template or exec path, or inherited `npm_config_*` setting reaches a VAT step — but npm's
network settings, an allow list in any case and in either the `-` or `_` spelling (`registry`, a
scoped `@scope:registry`, `proxy`, `https-proxy`, `noproxy`/`no-proxy`, `ca`, `cafile`,
`strict-ssl`), so an `npx:` arm still reaches its registry. Everything else under `npm_config_*` is
removed: identity and config files (`userconfig`, `_auth`, a `//host/:_authToken`, `cert`, `key`)
and whatever changes what npm does (`ignore-scripts`, `offline`, `node-options`, `script-shell`, …).
Every report records the names, never the values, of the network settings kept (`npmNetworkEnv`,
on the envelope and on each arm), so two developers' runs can be told apart; git reads no system config or attributes
(`GIT_CONFIG_NOSYSTEM=1`, `GIT_ATTR_NOSYSTEM=1`); `TMPDIR`/`TEMP`/`TMP` point at the arm's `tmp/`,
and `HOME` and `CLAUDE_CONFIG_DIR` at its empty `home/`. A developer's `VAT_PROJECTION_STORE=off`,
global git exclude or `~/.claude/CLAUDE.md` therefore never decides a number. **Outside the arm:**
the machine-level Claude managed-settings policy (the OS-wide managed settings file an
administrator installs) is read from a fixed system path no variable redirects, so every arm on one
machine reads the same one — consistent across arms, but not isolated from the machine. `runRepeats` requires the `arm`;
single-command facet runs are one-step sequences under `<arms root>/<build>-<command>-<cache>`.

- **The arms root lies outside every subject.** `--arms-dir <dir>` (absolute; never a link) when
  given, else a fresh `run-*` directory under `<os tmpdir>/vat-lab-arms-<user>/`, printed as
  `Arms under <root>`. A root that is, lies inside or contains a measured tree is refused — the
  default one before anything is created. Every root the lab uses carries `.vat-lab-root`: an absent
  `--arms-dir` is created 0700 and marked; an existing EMPTY one is adopted as it is — the lab writes
  `.vat-lab-root` into it and then its arms and clone beneath it, and never chmods it; an existing,
  non-empty one without the marker is refused, nothing written into it.
- **The default run directory ends with the capture.** When the capture ends — passed or failed —
  the lab removes the whole `run-*` directory (stores, caches, npm's fetch) and prints
  `Removed arms under <root>`; `--keep-arms` keeps it and prints `Kept arms under <root>`. A named
  `--arms-dir` is always kept. Exactly one thing outlives a default run directory: the **prepared
  clone** of a `perf arms` run whose `arms-report.json` was written. Just before writing it, the
  lab moves the clone out of `<base>/run-<id>/clone` into a fresh `<base>/clone-XXXXXX/` that
  `mkdtemp` makes beside the run directory (under the same `vat-lab-arms-<user>/` base), so no
  earlier kept clone is ever in the way; it writes `<base>/clone-XXXXXX/clone` as `prepared.path`,
  prints `Prepared clone kept at <base>/clone-XXXXXX/clone; remove it when done`, then removes the
  run directory whole — delete `<base>/clone-XXXXXX/` yourself once `verdict run --prepared` and
  `verdict union` are done with it. The prerequisites and the arms ran at the pre-move path, so an
  artifact that recorded an absolute path into the clone may be stale. The report never waits on
  that move: when it fails (a Windows `EBUSY`, say), the report names `<run>/clone`, the lab prints
  `Could not move the prepared clone out of <run>: <why>; the run directory is kept whole` and
  `Kept arms under <run>`, and the whole run directory is yours to remove. A `perf arms` run that
  writes no report (a bad `--commit`, a failing `--prerequisite`, a clone not at the committed tree,
  a refused arm, a report that cannot be written) leaves nothing: the clone goes with the run
  directory, and no `Prepared clone kept` line is printed. Under `--keep-arms` or a named
  `--arms-dir` the clone stays at `<root>/clone`. Every result is written, and a kept clone named,
  before the root ends, so a cleanup that fails costs neither; when the capture failed too, both
  are reported, the capture's first, under the capture's own code.
- **The lab chmods only what it created.** `--out` is created 0700 when absent and written into
  as-is when it exists, and every directory the lab makes under it (an ab run's `pair-N/<arm>/`) is 0700; reports are written 0600, never through a link. An `--out` that IS a subject
  (`--out .` from its root) is refused. `--out` holds reports only, so the default `.vat-lab/`
  inside a checkout is safe.
- **The arm owns its directories' variables.** `--env`/`--unset` naming `TMPDIR`, `TEMP`, `TMP`,
  `HOME`, `CLAUDE_CONFIG_DIR`, `VAT_PROJECTION_STORE_DIR`, `GIT_CONFIG_NOSYSTEM`, `GIT_ATTR_NOSYSTEM` or npm's three
  `npm_config_*` settings below is refused
  (`<NAME> is set by the lab itself on every arm`) — an arm cannot choose them.
- **npm's cache is the arm's own and never reset.** `npm_config_cache` is `<arm>/npm-cache`, with
  `npm_config_prefer_offline=true` and the update notifier off, and every build is **started once,
  untimed** (`--version`, cwd the npm cache) before round 1. An `npx:` build therefore fetches its
  bytes there, once, never in a timed repetition; a build whose start exits non-zero refuses the
  arm (`the build did not start — '--version' exited N`).
- **A populating arm asks the build for its parse directory**: from its entry for a `tree:` or
  `dist:` build, and for an `npx:` build from the copy npx runs: the pinned version installed in
  the clone's own project (`node_modules`, which npx runs ahead of its cache), else the one install
  the untimed start left in the arm's npm cache (`<arm>/npm-cache/_npx/<hash>/`). Neither, or two
  installs, refuses the arm before any measured child — never a guess; the refusal names the cause
  and says to measure the copy npx did run with a `dist:` instrument. An arm whose own `--env` turns caching off
  (`VAT_PROJECTION_STORE=off`, `VAT_CACHE=0`) is checked for writing nothing there instead, so a
  store-on vs store-off A/B measures both arms.
- Each step of a CI sequence carries ONE **committed expected exit** — 0 unless
  `--expect-exit <build>:<sequence>:<step>=<code>` (e.g. `cand:ci-c:validate-ci=1`) says otherwise;
  a list, a repeated step, exit 2 and a code outside 0–255 are refused. Exiting otherwise is a
  failed measurement (`step '<name>' exited N, not exactly C: <stderr>`), never a slow one, and
  each arm's `exits` records the commitment and the outcome: `shared` with the `code` its rounds
  shared, `not-run` (never reached, or its process never started: a missing binary's `ENOENT`),
  `killed` (its process started and was killed every round: a timeout, a signal, a full output
  buffer), or `disagreed` with what each round `seen` did. (`<facet> run|ab`
  differ: a command may exit any code its verb completes with — 0, or 0 or 1 for a gate — alike on
  every repeat; `--expect-exit <command>=<code>` makes it exact. See `docs/run-harness.md`.)
  A committed non-zero exit ends the repetition as CI's `&&` does: completed, nothing after it run.
- **Cold** clears the arm's store and parse cache before each repetition; when step 1 `populates`,
  it must leave the store non-empty and at least one parse shard (a file, not an empty directory).
- **Warm** primes the arm once before round 1 with an unmeasured run, which must leave the same
  store and shard when any step `populates` (a priming failure fails the arm). In each measured
  round, a step whose command reads provenance (`resources check`, `validate`) must publish
  `population: store` — absent or `derived` fails the repetition; a step with no provenance reader
  asserts nothing.
- The lab never runs `vat cache clear` — it owns the directories it clears.
- A bare command name (`git`, a prerequisite's `pnpm`) resolves from the **child's** PATH, absolute
  entries only — never from a working directory, which here is the subject's clone.

`vat-lab perf arms` runs named CI sequences across builds in **interleaved rounds** (default 5),
after preparing a `git clone --local` of the subject at `--commit` under `<arms root>/clone` (kept
afterwards where the report's `prepared.path` says — see above): the
`--prerequisite` commands, then one warm-up in its own scratch arm
(`<arms root>/prepare-warmup-cold/` — outside the clone, never a measured arm), then a check that
`git status --porcelain` is empty and the tree equals the committed tree. Every preparation git runs
under the same cleared environment as the arms, so the developer's global config can neither hide a
stray file from that check nor expose one. `--rounds` is at least 5; a `--build` alias may appear
once (case ignored). It writes `<out>/arms-report.json` (0600, in a 0700 `--out`) with the prepared
clone, every build (`alias`, the coordinate as given, the resolved version), the machine load, and
per arm min, median and IQR plus the inherited names its VAT and tool steps — and the
preparation's warm-up and prerequisites — went without.

`vat-lab perf bars <arms-report.json> --bar '<build>:<arm>:<state> <=|< <factor>* <build>:<arm>:<state>'`
judges bars on the **median AND the min**: both hold → PASS, neither → FAIL, one → INCONCLUSIVE;
`<=` ties pass, `<` ties fail, where a tie is equality to a relative 1e-9 (so `1.15*` of an exact
multiple ties rather than losing to float rounding). The factor is required (`1*` for a plain
comparison), a bar comparing an arm with itself is refused (it cannot fail), an arm with no
measurement fails its bar, and the command exits 1 unless every bar passes. Before the verdicts it
prints `Builds:` — each alias's resolved version and the coordinate it came from — and the load the
arms ran under, so a verdict read later names the bytes it judged.

**Bar 2 is measurable only after S2.** A warm `ci-c` repetition must report `store` for both its
resources phase and its checks phase (S1 bar 4; absent fails either). The checks phase publishes
its `population` today, but the resources phase's `data.population` does not exist yet: today's
`resources validate` report schema
is `.strict()` without that field — every warm `validate` step fails the warm rule as "absent"
until S2 adds it. The lab cannot import the CLI's report schemas (they are internal to the CLI,
and the lab measures several builds), so the extractor's `cand-C-warm` fixture is modelled ahead
of S2, and its test names that dependency.

```bash
vat-lab perf arms ../subject --build base=dist:/path/to/base/cli --build cand=dist:/path/to/cand/cli \
  --arm base:ci-b:cold --arm cand:ci-b:cold --prerequisite "bun install" \
  --arms-dir /tmp/lab-arms --out ./arms
```

The verdict facet reads the same prepared tree with `verdict run --prepared <alias>=<prepared.path>`
(the report records it as `preparedClone`), runs `validate` and the `*-ci` verbs, and
**bar 3** is

```bash
vat-lab verdict union <leftDir> <rightDir> --alias <a> --left <rows> --right <rows> \
  --arms <out>/arms-report.json --left-arm rc11:ci-b:cold --right-arm cand:ci-c:cold [--deltas <file>]
```

The inputs must belong together, or it is refused: each capture was measured with its named arm's
build, each side's `--left`/`--right` rows are that arm's timed steps in order, and neither arm
failed, broke its rule on any repetition, or has fewer than five repetitions. It holds only when
(1) both captures ran in that report's prepared clone, at its commit, clean; (2) every left
finding, keyed `(code, location, line, severity)`, is among the right's; (3) the right's extra
findings are exactly the ones the deltas file's `unions` section declares for that subject (each
with a `changelog:` citation and a reason); and (4) round by round, the right arm exited as the
left arm's first non-zero step did (0 when none) after the entry's declared `exit: { from, to }`
move, if any, and never 2 — a run that did not complete. A declared move whose `from` is not the
left's exit fails too. It prints `BAR 3 HOLDS` or `BAR 3 FAILS` with the missing, undeclared and
unused keys and exits 1 when it fails. `perf bars` refuses a bar naming an unfailed arm that is
still incomplete — no report `perf arms` writes holds one, so it is a hand-edited or foreign file —
and never reads an arm no bar names; an arm that failed still fails each bar over it, naming why. It heads its verdicts with every input that
decided the numbers — `--env`, `--unset`, `--expect-exit`, `--prerequisite`, `--timeout-ms` — as
`arms-report.json` records them.

## The three axes

Every report is a measurement at a coordinate, and carries the whole triple or it is comparable to
nothing:

| Axis | Field | What it is |
|---|---|---|
| **A** | `subject` | Which repository or folder was measured |
| **B** | `subjectVersion` | Which commit of it — or, for a folder with no git, a content fingerprint |
| **C** | `instrument` | Which build of vat did the measuring |

A comparison holds two axes still and varies one:

- **Vary C** — did vat get better, or faster? Regression and benchmarking, for quality as well as speed.
- **Vary B** — what moved upstream, and did their quality move or did ours?
- **Vary A** — how does the ecosystem look? The cross-sectional survey.

**Varying two at once is refused by default.** A delta across two simultaneous changes cannot be
attributed to either, so the comparator returns a `REFUSED:` rather than a number nobody can act on.
Callers pass `allowMultiAxis` to say out loud that they know the result is uninterpretable.

## Subjects move on purpose

A subject is tracked on a moving ref — `#main`, not a pinned SHA. Upstream moving *is* the signal a
survey exists to see, and pinning the subject would hide it.

Pinning happens at observation time instead: a run resolves whatever ref it was given to a concrete
commit and stamps it into the report. The subject keeps moving, every report stays retrospectively
pinned, and any two reports remain diffable.

## Why a separate CLI, not a `vat` subcommand

The lab drives vat through its **command-line boundary only**, never through its internals. That is
what lets one run measure two different vat versions — a released one against a dev build — and what
lets it measure a repository with no vat config at all.

An in-process command group would live inside exactly one vat version and inherit its internal API,
which forecloses the cross-version comparison that is the whole point. See
[Scope and migration](docs/scope.md) for what this means for the verbs that exist today.

## Sub-topics

This README is the front door. The detail lives next door:

- **[Scope and migration](docs/scope.md)** — what belongs in the lab, what stays in vat, and the
  backlog of verbs to move with the evidence for each.
- **[Roadmap](docs/roadmap.md)** — the staged plan. Deliberately not built all at once.
- **[Facets](docs/facets.md)** — the report-body contract, and how to add one.
- **[Run harness](docs/run-harness.md)** — how the lab obtains a vat to run: a working tree, a built
  `dist/`, or a released version via `npx`.

## Refusals

The lab refuses rather than coerces. A report from another envelope format, another facet, or an
older body schema is refused, because a comparator that tolerates a schema change reports
differences belonging to the change rather than to the subject — the most expensive wrong answer
this package can give.

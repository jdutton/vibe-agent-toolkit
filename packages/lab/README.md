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

Facets today are **`io`** (filesystem-call counts), **`perf`** (wall time, plus total CPU summed over vat's processes, per-surface wall read from the
`Surface:` banners, and, from a build that writes a `VAT_VALIDATE_DEBUG_FACTS` dump, whether `vat validate`
overlapped its checks child; a build that writes none is reported unknown, never as not overlapped),
**`parse`** (where the
time inside vat's document parse goes, pass by pass), **`crawl`** (where the time spent *finding*
those documents goes, per contributor, stratum and fixpoint pass), **`population`** (*which*
files a command enumerated), **`memory`** (peak RSS per repeat — the largest VAT-owned process's
peak, `VmHWM` on Linux and `process.resourceUsage().maxRSS` on macOS and Windows, worker threads
included, never summed across processes, with how many vat processes reported counted beside it;
see [Facets](docs/facets.md)), **`work`** (vat's own deterministic work counters, such as store
rows decoded, extents derived and parses dispatched, summed across processes and compared exactly;
see [The work facet](docs/facets.md#the-work-facet)) and **`verdict`** (what a build *decides* — exit codes, findings and
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
  --env VAT_EXTENT_SOURCE=filesystem --out ./filesystem
vat-lab population run ../some-project --instrument tree:. --id some-project \
  --env VAT_EXTENT_SOURCE=git --out ./git
vat-lab population compare ./filesystem/<report>.json ./git/<report>.json
```

Current vat builds have one lane, the projection, and the scan no longer reports `lane`; the arm an
A/B can vary is the extent source. The walk-lane wording above applies to builds that still had it.

The arm is chosen with `--env`, never by exporting it in your shell: every arm starts from an
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
git template or exec path, `NODE_PATH`, or inherited `npm_config_*` setting reaches a VAT step — but npm's
network settings, an allow list in any case and in either the `-` or `_` spelling (`registry`, a
scoped `@scope:registry`, `proxy`, `https-proxy`, `noproxy`/`no-proxy`, `ca`, `cafile`,
`strict-ssl`). An `npx:` build is never run through npm, so the one npm the lab itself runs is that
build's `npm install`, which reaches its registry through the allow list — an arm's own `--env`
never reaches that install, which serves every arm naming the spec. That install reads the operator's npm userconfig (an
inherited `npm_config_userconfig`, else `~/.npmrc`) with `HOME` at the install arm's empty home, so a
`~/` or `${HOME}` in that file resolves there, not to the operator's home. Everything else under `npm_config_*` is
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
  non-empty one without the marker is refused, nothing written into it. **One invocation per
  `--arms-dir` at a time:** nothing locks it, and every arm under it — the `npx:` install arm
  included — is emptied when its run starts, so two concurrent invocations sharing one `--arms-dir`
  delete each other's stores and installs. The default run directory is fresh per invocation.
  **What keeps an `npx:` install's module resolution inside it.** Node resolves a module up the
  directory tree, past the install and the arms root. The install is laid out hoisted
  (`--install-strategy=hoisted` on npm's command line, which beats any `.npmrc`) and refused if it
  holds a linked package directory or a `node_modules/.store`. It is refused, naming the path, when
  any directory above its prefix holds a `node_modules`. **That check runs once, at install time,
  and the default arms root's ancestors are shared:** `/tmp` on Linux (`/tmp/node_modules` is
  world-writable) and `C:\` on Windows, where another user could plant a `node_modules` after the
  check — **on a shared host, pass `--arms-dir` under your home.** For every optional peer
  (`peerDependenciesMeta`, `optional: true`) that ANY package of the install declares and that does
  not resolve from that package inside the install, the lab writes a stub package at the install's
  top-level `node_modules`; Node stops there and fails the load as not found — the package's own
  "not installed". Never stubbed: a name any installed package lists in `optionalDependencies` (npm
  skipped it, and it stays absent), and a peer name that is not a valid package name (a legacy
  uppercase one), which is skipped rather than refusing the install. Every arm clears `NODE_PATH`.
  What remains outside the install: Node's CommonJS global folders — `$HOME/.node_modules`,
  `$HOME/.node_libraries` (the arm's own empty home) and `$PREFIX/lib/node` of the Node that runs.
  A `tree:` or `dist:` build resolves from where it lies, as it would for its operator.
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
  `HOME`, `CLAUDE_CONFIG_DIR`, `VAT_CACHE_DIR`, `GIT_CONFIG_NOSYSTEM`, `GIT_ATTR_NOSYSTEM` or npm's three
  `npm_config_*` settings below is refused
  (`<NAME> is set by the lab itself on every arm`) — an arm cannot choose them.
- **npm's cache is the arm's own and never reset.** `npm_config_cache` is `<arm>/npm-cache`, with
  `npm_config_prefer_offline=true` and the update notifier off, and every build is **started once,
  untimed** (`--version`, cwd the npm cache) before round 1; a build whose start exits non-zero
  refuses the arm (`the build did not start — '--version' exited N`).
- **An `npx:` build never runs through npx.** npx runs the package's `bin`, the cli's cwd-resolving
  wrapper, which runs the SUBJECT'S own vat when the subject has one installed — under the pinned
  name. So the pinned spec is installed once per invocation (`--ignore-scripts`, in an arm of its own
  under the arms root, `harness/npx-install.ts`) and runs as `node <install>/…/@vibe-agent-toolkit/cli/dist/bin.js`,
  as a `dist:` build does — `bin.js` is the CLI itself and delegates to no other copy, which is the
  protection. The spec must be `vibe-agent-toolkit` or `@vibe-agent-toolkit/cli` pinned to an exact
  version (no other package, path, URL, tarball, git ref or alias), refused before any setup. Once
  per install, before any repeat: the entry is looked for only where the named package's own cli
  lives, its `package.json` must name `@vibe-agent-toolkit/cli` at the pin, its real path must lie
  inside the install, and it must start (`--version` exits 0 — `bin.js` and its static imports
  load). npm is the one bundled with the Node that runs the lab — never PATH's — run as
  `node <npm-cli.js>` with no shell on every platform (a Node with no bundled npm is refused,
  naming the path looked for), with its own fixed install timeout, never `--timeout-ms`. Every install
  refusal — npm failing, the wrong cli, an entry outside the install or one that does not start,
  a closure that does not resolve inside it — prints one `REFUSED:` line. Its closure is the one
  definition every kind stamps (see [the closure digest](docs/run-harness.md#the-closure-digest--arm-identity-by-what-it-runs)):
  the bytes of the cli and its `@vibe-agent-toolkit/*` packages plus the `name@version` of every
  third-party package in that closure, resolved no higher than the install — so an `npx:` build
  matches a `dist:` build of the same install, the umbrella and the cli pins of one version match,
  and a third-party dependency that floated to another version is another instrument. A report
  stored by an earlier lab whose closure was computed differently compares as a different
  instrument: re-capture it (nothing detects that; there is no version marker).
- **Nested `vat` calls are pinned only when the arm says so — for every kind.** No arm kind
  (`tree:`, `dist:` or `npx:`) sets `VAT_BIN` or `VAT_ROOT_DIR`: they are never inherited and
  reach a child only through the arm's own `--env`. Without it, a nested `vat` call from the
  subject's own scripts or hooks resolves through the subject's install, not the build under
  test. A `tree:` or `dist:` arm pins them with `--env VAT_BIN=<its dist/bin.js>`; an `npx:`
  install lives at a lab-internal path emptied each run, so to pin nested calls to a release use a
  `dist:` arm over a private install plus a shim
  ([recipe](../../docs/contributing/vat-debugging.md#crucible-runs)).
- **A populating arm asks the build for its parse directory**, from its entry — never a guess.
  An arm whose own `--env` turns caching off
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
- **Cold** clears the arm's VAT cache (`VAT_CACHE_DIR`, its `store/`) and `tmp/` before each
  repetition; when step 1 `populates`, it must leave a projection store (a non-empty
  `projection-*` directory) and at least one parse shard (a file, not an empty directory) in the
  build's own cache namespace, the parent of the parse directory the build names. A current build
  keeps that namespace under `store/`; a build that predates `VAT_CACHE_DIR` keeps it under `tmp/`.
- **Warm** primes the arm once before round 1 with an unmeasured run, which must leave the same
  store and shard when any step `populates` (a priming failure fails the arm). In each measured
  round, a step whose command reads provenance must publish `population: store`. Two readers do:
  `resources check` (`data.population`) and `validate` (the `resources` and `checks` phases'
  `population`). A field that is absent or not a string counts as absent, and absent or `derived`
  fails the repetition. `resources validate` publishes `data.population` too, but the lab does
  not judge it yet. A baseline build that predates the field cannot yet be told apart from a run
  that dropped it, and judging it needs a per-build declaration, which is pending. A step with no
  provenance reader (`resources validate`, `resources query`, `skills validate`, the facet entry
  for `validate`) asserts nothing.
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

**Bar 2:** a warm `ci-c` repetition must report `store` for both its resources phase's and its
checks phase's `data.population` (absent fails either). The lab cannot import the CLI's report
schemas (they are internal to the CLI, and the lab measures several builds), so the extractor's
`cand-C-warm` fixture models that shape by hand.

```bash
vat-lab perf arms ../subject --build base=dist:/path/to/base/packages/cli/dist --build cand=dist:/path/to/cand/packages/cli/dist \
  --arm base:ci-b:cold --arm cand:ci-b:cold --prerequisite "bun install" \
  --arms-dir /tmp/lab-arms --out ./arms
```

To see where a phase's time goes, capture V8 CPU profiles of every vat process and attribute their
samples to cost buckets (rules and semantics: [`docs/facets.md`](docs/facets.md)). A profiled row is
for attribution, never for a gate: profiling inflates wall.

```bash
vat-lab perf run ../subject --id subject --cpu-prof-dir /tmp/lab-prof --out ./perf
vat-lab perf attribute ./perf/<report>.json --profiles /tmp/lab-prof [--json ./attribution.json]
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

## Edit arms, gap bars, store size and touched LFS files

A clean `warm` arm answers "does an unchanged tree hit the store". The questions a developer feels
are "what does one edit cost" and "what does fifty cost". Those are arms of their own, judged
against a clean arm of the same build in the same invocation.

### The `warm-edit<N>[:<kind>]` state

The state slot of an arm name (`<build>:<sequence>:<state>`) accepts `warm-edit<N>` beside `warm` and
`cold`: `main:ci-c:warm-edit1`, `main:ci-c:warm-edit50:create`. `<N>` is how many files each repetition
edits; `<kind>` is `modify` (the default), `create` or `delete`. The edit is part of the arm's
identity, so `warm-edit1` and `warm-edit50` of one build are two arms with two rows. `--arm`, `--bar`
and the report spell the state the same way.

The count and the kind live only in the arm name; there is no flag for either.

- An edit arm edits and restores the tree it runs in, so it runs only in the lab's prepared clone,
  `<arms root>/clone` under a marked arms root: any other working directory is refused before
  anything runs, a copy of an operator's checkout included. The edits and restores run through the
  arm's git, which reads a tree right only when the tree was checked out under it.

- `--edit <path>` (repeatable) names the files to edit, relative to the subject, and applies only to
  edit arms; it is global, so every edit arm of the invocation edits from the same paths. Every
  `--edit` path must be a tracked file of the subject: an untracked one is refused before priming,
  since `git checkout` could not restore it.
- Without `--edit`, each edit arm picks from every tracked `*.md` file with no frontmatter, in
  code-unit order. A count above the candidates is refused before anything runs, naming the count.
- Every round's tree is one the store has not seen. `modify` appends `\n<!-- lab edit round <r> -->\n`
  to the first `<N>` candidates. `create` writes `lab-edit-<r>-<i>.md` beside the i-th of them.
  `delete` removes a rotating window: round r deletes the `<N>` candidates from offset `r*N`, so no
  two rounds delete the same files; a delete arm whose rounds need more files than there are
  (`rounds * N` above the candidates) is refused before anything runs, naming both numbers.
- A deleted file that something links to moves a finding, and the exit rule below fails the arm.
  Point a delete arm at pages nothing links to, with `--edit`.
- Every edit and every restore is untimed. `modify` and `delete` are restored with
  `git checkout -- <path>` and a created file is removed, also when the edit itself fails part-way.
  Each repetition records the edited paths and how many paths `git status` reports changed after the
  edit (untracked files included, so a created file counts); an edit whose changed count differs from
  the number of files it named is a violation.
- The report's `inputs.edits` records every edit arm's name, kind, count and `--edit` paths (`null`
  for the default candidates), so two invocations of `warm-edit1` over different files stay
  distinguishable. Each edit arm needs a clean `warm` arm of the same build and sequence in the
  invocation; one without is refused before anything runs.

One invocation interleaves the clean arm and its edit arms per build, round by round, so every gap is
measured under one machine load:

```bash
vat-lab perf arms ../subject --build main=dist:/path/to/packages/cli/dist \
  --arm main:ci-c:warm --arm main:ci-c:warm-edit1 --arm main:ci-c:warm-edit50 --rounds 5 \
  --arms-dir /tmp/lab-arms --out ./arms
```

**The edit arm's warm rule.** The clean warm rule (a step publishes `population: store`) is false for
an edit arm: an edit moves the tree key, so the extent is derived. An edit repetition is valid only when
the resources provenance of its first step that reads or fills a population is `derived` (a later step
reads what that step refilled from the edited tree, so `ci-b`'s `resources check` may report `store`)
**and** its work dump shows `store.reads.extent >= 1` and
`store.writes.persistent >= 1`. A run that reports `population: store`, or one that wrote nothing,
violates the rule: it did not do the work an edit costs, so its time is not an edit's time. So does an
exit code that differs from the same build's clean arm in that round, since an edit that moved a
finding would time a different run. (Under the default exact exit commitment a differing exit is
already a step violation; the clean-arm check also holds when `--expect-exit` admits another code.)
A round whose clean arm has no repetition (its priming failed) fails the edit arm's repetition too:
there is no clean exit to compare, so no gap to time.

**Work dumps per repetition.** Every arm repetition runs with `VAT_WORK_COUNTERS` pointed at a fresh
directory and the report keeps the merged counters for that repetition. With `GIT_TRACE2_EVENT` set
per repetition it also keeps `gitSpawns`, the count of git processes the repetition started.

### Gap bars

A **gap** is `median(edit arm) - median(clean arm)` of one build in one invocation. A gap is never
computed across two builds or across two invocations. `vat-lab perf bars` accepts two gap forms
beside the ratio form above:

```text
gap(<build>:<seq>:warm-edit<N>) <= <factor>*gap(<build>:<seq>:warm-edit<N>)
gap(<build>:<seq>:warm-edit<N>) <= <seconds>s
```

The first compares two builds' gaps (a candidate's one-file gap against a baseline's); the second
holds one gap under an absolute time. A gap bar naming an edit arm with no clean arm of the same
build in the invocation is refused. When one build has two edit arms, the report also records the
marginal per-file cost, `(gap(warm-edit<N>) - gap(warm-edit1)) / (N - 1)`, with each arm's IQR.

A gap bar, and a ratio bar that names an edit arm on either side, is judged only when every arm it
reads has an IQR smaller than the bar's margin: the distance between the left value (the gap, or the
left median) and the bound it is held to (the scaled right gap or median, or the seconds). Each arm
is gated on its own IQR, and a right-side arm's IQR is scaled by the bar's factor, as its value is.
Otherwise the bar is reported NOISE-BOUND, never passed, and `perf bars` exits non-zero; re-run the
invocation with more rounds. A ratio bar over clean and cold arms only keeps the median-and-min rule
above.

### Store size per commit

`runStoreSizeArm` replays a subject's last N first-parent commits in the clone, oldest first, one warm
`validate` each, and reports per commit the store's size in bytes and the step's wall time. The size
is `page_count * page_size` read through a read-write connection after
`PRAGMA wal_checkpoint(TRUNCATE)`, so the write-ahead log's timing never moves it; the `-wal` file
alone is not the measure: once the CLI has closed, SQLite has removed it, so it is absent (or empty). A growth that tracks a
commit's diff is the expected shape; growth out of proportion to it is the finding.

```bash
vat-lab perf store-size ../subject --build dist:/path/to/packages/cli/dist --commits 20 --out ./store-size
```

`--commits` defaults to 20 and is refused when HEAD has fewer first-parent commits. The clone is
prepared at the oldest of them; row 1 is that commit's validate into an empty arm store, and each later
row carries the same store forward one commit. A commit whose `validate` exits other than 0 or 1 stops
the arm. The report is `<out>/store-size-report.json`. `--arms-dir`, `--keep-arms` and `--timeout-ms`
work as for `perf arms`.

### Touched LFS files

`lfs-touch` builds a scratch repository whose `filter.lfs.clean` and `filter.lfs.smudge` run a
lab-owned filter script and count its work. The measured step is one warm `vat resources validate`,
so the checks child's own snapshot never enters the count. Every fixture file is backdated ten seconds
before the commit and before the refresh, so no index entry is racily clean. The arm reports, from the
filter's own log, how many times git ran the filter and over how many bytes, with the whole step's wall
time and `git.snapshots` from the repetition's work dump.

- After a `touch` of N files of S bytes, git re-cleans each: the log shows at least N invocations and
  N x S bytes per run, while the tree hash is unchanged and the run is a store hit with one snapshot.
- After `git update-index --refresh`, the log shows 0 invocations: git has recorded the files clean.
- The `io` facet cannot see this work: it counts Node calls in VAT's process, not bytes and not git's
  children. Defaults are N = 100 files of S = 2 MB.
- The scratch repository sets `GIT_CONFIG_NOSYSTEM=1` and `core.autocrlf=false`.

```bash
vat-lab perf lfs-touch --build dist:/path/to/packages/cli/dist --files 100 --size 2097152 --rounds 3 --out ./lfs
```

`--files` (N, default 100), `--size` (S in bytes, default 2,097,152) and `--rounds` (default 3) are
whole numbers of at least 1. Each round is one touched step and one refreshed step. Round r's touch
moves every filtered file's mtime to the fixture's backdated second minus r, so every touch is a second
no file and no index entry has held (Git for Windows sees no ctime change from a touch, so a repeated
mtime would read clean there), and the bytes and the tree hash never change. A build that emits no
`git.snapshots` counter reports it unread, with the reason, never 0. The filter is
`packages/utils/test/fixtures/lfs-filter.mjs`, run as `"<runtime>" "<script>" clean|smudge`, the runtime being the one
running the lab; a runtime or script path holding `"`, `$`, a backtick or (on POSIX) a backslash is refused. Its
`clean` writes an LFS-style pointer. Git runs under the arm's
environment (no system or global config), so a machine's git-lfs `filter.lfs.process` never replaces
it. The report is `<out>/lfs-touch-report.json`.

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
  `dist/`, or a released version (`npx:`, installed under the arms root and run as its `dist/bin.js`).

## Refusals

The lab refuses rather than coerces. A report from another envelope format, another facet, or an
older body schema is refused, because a comparator that tolerates a schema change reports
differences belonging to the change rather than to the subject — the most expensive wrong answer
this package can give.

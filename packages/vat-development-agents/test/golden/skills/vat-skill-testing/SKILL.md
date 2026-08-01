---
name: vat-skill-testing
description: Use when running `vat skill test run`/`configure`, triaging
  friction.json output, reasoning about the test harness's isolation or auth
  model, or confirming a packaged skill works in a clean install.
---

# VAT Skill Testing: Behavioral Downstream Packaging Check

`vat skill test` answers one question: **does this packaged skill actually work when installed in isolation?** It stages the built skill into a fresh, context-isolated temp harness — a scrubbed env allowlist and no user/project settings, **not** an OS security sandbox — and runs a headless behavioral evaluation, no interactive session required.

## Boundary: Where `vat skill test` Fits

| Tool | What it does |
|---|---|
| `skill-creator` | Interactive authoring and iteration of a skill (author-side) |
| `vat skill review` | Pre-publication static quality checklist + validation-code triage |
| `vat audit` | Packaging/compat static analysis of built plugins and marketplaces |
| **`vat skill test`** | **Behavioral downstream check — does the packaged skill work in a clean harness?** |

`vat skill test` reuses skill-creator's grading rubric and JSON shapes for grading output, but not its interactive driver. It is a post-packaging validation step, not a skill-authoring aid.

## Cost & Cadence — Where This Fits in Your Workflow

A full run is **not cheap**: on the order of ~38 headless `claude` sessions (an executor and a grader spawned per eval), ~8–13 minutes wall-clock, and real token spend. Treat `vat skill test` as a **pre-release / nightly / on-demand** check — **not** a gate on every push or commit. Keep the per-commit loop on fast static checks (lint, typecheck, unit tests); reach for `vat skill test` before a release, on a schedule, or when you've changed the skill's behavior and want a behavioral signal.

To make that cadence budgetable, the run's summary line reports the actual spend it just incurred — a `≈$<total> across <N> sessions` suffix that rolls up `total_cost_usd` across every executor **and** grader session (so it counts both halves of each eval, not just the skill run). Read it off a real run to size a nightly/pre-release schedule; it's omitted only when no session reported a cost (e.g. a fully mocked test).

**Cost-tier fail-fast (see below) helps at the margin, not the order of magnitude.** Gating expensive tiers behind cheap ones stops a broken foundation from burning tokens on hard cases, but a full green run through every declared tier is still tens of sessions and minutes — tiering changes *when you stop spending on a bad run*, not how much a good run costs.

**`--dry-run` is the underused, zero-token way to validate plumbing.** It assembles the executor command — staging, model resolution, `evals.json` parsing, `toolExpectations`/`declaredExecutables` resolution — **without spawning `claude`**, so it catches config typos and broken wiring before you spend anything:

```bash
# No --i-understand-this-runs-skill-code needed — a dry-run never executes skill code
vat skill test run my-skill --dry-run
```

Run `--dry-run` first any time you touch `evals.json`, `skills.config.<skill>.test`, or `executables`.

## The Execution Loop

VAT owns the loop directly — there is no single "experimenter" agent. For **each eval**, VAT spawns a blind **executor** (the skill under test), captures its transcript **in memory**, then spawns a separate **grader** over that transcript. VAT — never the model — writes the results.

```
driver (you)
  └─ vat skill test run [source]
       ├─ 1. Resolve source (local path, git URL, npm)
       ├─ 2. Stage: copy packaged skill + declared deps into an isolated temp harness
       ├─ 3. Preflight: token-free fail-fast checks (see below)
       └─ 4. Per eval (bounded-parallel, --concurrency), lowest cost tier first:
            ├─ Spawn EXECUTOR (headless `claude`, the skill under test, `--model`)
            │    └─ transcript captured IN MEMORY (never written to the sandbox)
            ├─ Spawn GRADER (headless `claude`, `--grader-model`) over that transcript
            │    └─ emits a nonce-stamped fragment (expectations + optional tool verdict)
            └─ VAT merges the fragments → results/ (sole writer; nonce re-verified)
```

Artifacts produced under `<harnessRoot>/results/`:

| Artifact | Contents |
|---|---|
| `grading.json` | Flat per-expectation grades + pass/fail summary (VAT-merged) |
| `friction.json` | Packaging friction items (categories, severities, messages) |
| `tool-eval.json` | Per-eval tool verdicts — always written (`{"evals": []}` when no eval declares `toolExpectations`) |
| `transcripts/` | Per-eval executor conversation logs |

**Anti-forgery model.** The executor and grader are separate roles; the transcript never touches the skill's sandbox; the grader runs in a directory outside the harness root; and every grader fragment carries a secret per-run nonce (delivered only via the grader's stdin — never on disk or an argv) that VAT re-verifies before merging. So untrusted skill code running in the sandbox cannot forge its own passing grade, tamper with the transcript, or write a result VAT will accept. Full contract: `docs/skill-test-grading-schema.md`.

## Exit Codes

| Code | Meaning |
|---|---|
| `0` | Harness ran to completion and **every eval passed** (`PASS N/N`) — or a failing verdict was suppressed with `--allow-eval-failure`. Read the printed summary and `results/grading.json` for detail. |
| `4` | An eval **FAILED** — the harness completed and produced valid results, but the **composite verdict** did not all pass. This covers three cases: an output expectation failed, a declared `toolExpectations` verdict failed (`FAIL N/M (K tool)`), or a cheaper cost tier failed and gated the higher tiers (their evals are **SKIPPED**, never passed). The **fail-closed default** — suppress with `--allow-eval-failure` for interactive iteration. |
| `3` | Bootstrap: no `evals.json` found — VAT wrote a template. **Not a failure.** Fill in the template and re-run. |
| `2` | Preflight / env failure: missing `claude` binary, auth error, declared inputs or deps absent, unsafe `--workdir`, `--require-auth` mismatch, or the `--i-understand-this-runs-skill-code` acknowledgment was not given. |
| `1` | Internal (harness) failure — an executor or grader spawn stalled/timed out/errored, a grader exited without a valid fragment, or a fragment's nonce was missing/wrong. A **stall, timeout, spawn error, or nonce/skew failure is authoritative and always exit 1** — it is never laundered into a PASS or a FAIL, even if a `grading.json` is present on disk (hardening against skill code that writes a fake grade then hangs). |

The taxonomy separates "evals failed" (`4`) from "the harness broke" (`1`/`2`/`3`) so a CI consumer can tolerate the former while failing closed on the latter:

```bash
vat skill test run my-skill --i-understand-this-runs-skill-code
case $? in
  0) ;;              # all evals passed
  4) ;;              # evals failed but the harness is healthy — tolerate/warn
  *) exit 1 ;;       # 1/2/3/unknown — harness broke, fail the build
esac
```

Which specific evals failed lives in `results/grading.json`, never in the exit code.

> **A timed-out run may leave `results/` incomplete or a `grading.json` unparseable.** Any consumer reading `grading.json` must treat an unparseable or missing file as a **failure**, not crash on it. The exit code (1) already tells you the run did not complete; do not trust a partial artifact.
>
> **The default `--timeout` scales with the suite's declared eval count** (roughly `2min + 2min/eval`, floored at 5min, capped at 1h) so a correctly-configured multi-eval suite is not truncated by a flat budget. An explicit `--timeout` always overrides. If a run times out, the message names the declared eval count — raise `--timeout` (and `--stall`) for large suites.

## Executor vs Grader Models

Two independent models run per eval, and you pick each one:

| Role | Flag | Config | Default | Selects |
|---|---|---|---|---|
| **Executor** (the skill under test) | `--model <id>` | `skills.config.<skill>.test.model` | claude's own default | the model whose behavior you are measuring |
| **Grader** (judges the transcript) | `--grader-model <id>` | top-level `test.graderModel` | `claude-sonnet-5` | a fixed judge, ideally stronger/cheaper than the executor |

- `--model` is passed **verbatim** to `claude --model` (no VAT mapping/validation) — pin it for reproducible, cost-controlled runs.
- `--grader-model` is **independent** of `--model`. Keeping the grader fixed while you vary the executor is the point: it holds the yardstick steady.
- `--concurrency <n>` (default 4) bounds how many evals run their executor→grader pair in parallel (each retries a rate-limit with backoff).

**`graderModel` and `concurrency` are GLOBAL**, not per-skill: they live in a **top-level** `test:` node in `vibe-agent-toolkit.config.yaml` (distinct from the per-skill `skills.config.<skill>.test` block), because they describe the judge/pipeline, not one skill. `vat skill test configure` writes the per-skill block only — set the global ones with the `--grader-model` / `--concurrency` flags, or by hand-editing the top-level `test:` node:

```yaml
# vibe-agent-toolkit.config.yaml
test:                      # GLOBAL — judge + pipeline
  graderModel: claude-sonnet-5
  concurrency: 4

skills:
  config:
    my-skill:
      test:                # PER-SKILL — executor + this skill's knobs
        model: claude-opus-4-8
```

Precedence for the global knobs: **flag > top-level `test:` config > built-in default**.

## Bootstrap Flow (Exit 3)

First run with no `evals.json`:

```bash
vat skill test run ./dist/skills/my-skill/ --i-understand-this-runs-skill-code
# Exit 3 — VAT scaffolds evals.json template next to the skill source
```

Edit `evals.json` to fill in expected behaviors, then re-run. The template includes annotated comments explaining each field.

## Authoring `evals.json` — the part that actually matters

A run is only as good as its evals. The harness, isolation, and grading are plumbing; the eval suite is where you encode *what "working" means* for your skill. These practices come straight from Anthropic's `skill-creator` methodology and its grader rubric — VAT reuses both.

The suite lives at `<skill>/evals/evals.json` (override with `skills.config.<skill>.test.evals`); input fixtures live alongside it under `<skill>/evals/fixtures/`.

### The shape

```json
{
  "skill_name": "csv-summarizer",
  "evals": [
    {
      "id": "line-totals-reconcile",
      "category": "recognition-accuracy",
      "prompt": "Can you take a look at this orders export and tell me whether it adds up? I just need to know if unit price times quantity ties to the line total before I send it on.",
      "files": ["fixtures/orders-clean.csv"],
      "expected_output": "Recognizes the file as a monthly orders export (8 rows), runs the reconciliation, and reports in plain English that unit_price x quantity ties to line_total for every row.",
      "expectations": [
        "The output identifies the file as a monthly orders export with 8 rows.",
        "The output states unit_price x quantity reconciles to line_total for every row.",
        "The output does NOT claim any row fails to add up."
      ],
      "tier": 0,
      "toolExpectations": {
        "mustRun": ["csvsum"],
        "mustNotRun": ["rm"],
        "sequence": ["csvsum parses the orders export", "csvsum reports the reconciliation"]
      }
    }
  ]
}
```

- `id` — unique identifier; an integer **or** a descriptive string (descriptive ids read better in results).
- `category` — optional grouping label you choose; VAT carries it through untouched.
- `files` — optional input paths relative to the `evals.json` directory; each eval's files are staged into its own isolated working directory.
- `expectations` is required and needs at least one entry — it is what the grader scores (pass/fail per entry).
- `expected_output` is optional prose describing a correct result; when present the grader receives it as context informing its judgment, but the verdict is still decided per `expectations` entry.
- `tier` (optional, integer) — cost tier for fail-fast ordering (see **Cost tiers** below). Omit to leave an eval in the default tier `0`.
- `toolExpectations` (optional) — assert which tools/executables the skill should (and shouldn't) invoke (see **Tool expectations** below).

### Write blind, realistic prompts

The executor is never told it's being tested — and it shouldn't be able to tell. Phrase prompts exactly the way a real user would ("Quick sanity check on this month's orders export, please."), never "Test that the skill computes line totals." This is not cosmetic: models behave measurably differently when they sense an eval, so a benchmark-flavored prompt measures the wrong thing.

### Write *discriminating* expectations

Every expectation must **fail for a wrong output**. The classic trap — which the grader is explicitly told to flag — is checking mere presence: `"the output mentions Acme Freight"` also passes for a hallucinated document. Check *correctness*, tied to the input, not presence. And pair positive assertions with **negative** ones (`"does NOT claim every row reconciles"`): one-sided evals create one-sided optimization. If an assertion would pass for an obviously broken result, it's not pulling its weight.

The harness itself is only as sharp as the evals you write — a passing `toolExpectations`/`expectations` grade tells you nothing if the assertion couldn't have failed. **Antipattern: a presence-only check with no negative counterpart.** `"the output mentions the order id"` or `"the output includes a reconciliation summary"`, on its own, passes for a hallucinated order id or a summary that reaches the wrong conclusion — it can't distinguish "did the right thing" from "said the right *words*." `vat skill test` emits an advisory lint warning when **every** expectation in an eval is presence-only ("mentions/includes/contains/references/appears/states…") with no discriminating or negative cue and no `toolExpectations` declared. It's a nudge, not a gate — it never blocks a run or changes the exit code — so treat it as a prompt to strengthen the eval, not a substitute for writing discriminating expectations in the first place.

A second advisory in the same family catches a quieter footgun: when a `toolExpectations` entry names an executable that looks like a **typo** of one of the skill's `declaredExecutables` (e.g. `csvsum-py` when the skill declares `csvsum`), the harness warns before any spend. A misspelled tool name never matches the transcript, so `mustRun`/`mustSucceed`/`sequence` fail for the wrong reason and `mustNotRun` passes vacuously — the assertion *looks* like it checks a tool but can't. This lint is conservative (it fires only when there's a specific declared name the reference is probably a typo of, so a deliberate `Bash`/`git` reference is never flagged) and, like the presence-only lint, surfaces under `--dry-run` — so a zero-token dry run catches the typo before you spend.

Before/after, same eval:

```json
// Before — antipattern: also passes for a hallucinated customer
"expectations": [
  "The output mentions Acme Freight as the top customer."
]

// After — discriminating: fails a wrong or invented result
"expectations": [
  "The output identifies Acme Freight as the top customer by revenue, matching customer_name in the input file.",
  "The output does NOT invent a customer not present in the input file."
]
```

### Cover real scenarios; aim for ≥3 evals

Anthropic's bar is *at least three evaluations, drawn from real usage and past failures, tested across models*. Group evals by what they exercise — the `csv-summarizer` example above uses three categories:

| Category | Tests |
|---|---|
| `recognition-accuracy` | Did the skill produce the correct figures from a real input file? |
| `guidance-correctness` | When asked directly, does it give correct advice (the right SQL idiom, the right command)? |
| `invocation-recovery` | Does it recover correctly from a guard error or a malformed invocation? |

Keep *regression* evals (known-good behavior that should always pass) mentally separate from *capability* evals (harder cases). A suite that scores 100% every time is usually too easy — a healthier capability suite leaves headroom that improvements can move.

### Fixtures

Put input files under `evals/fixtures/` and reference them via `files`. Use realistic, slightly messy data — the kind that surfaces real bugs, not toy data that everything passes.

### A/B skill-lift (`--baseline`)

A skill's value is its **lift over what the model already does without it**. `--baseline` runs each eval twice — with the skill and without — and reports the delta. If an expectation passes in *both* configurations it proves nothing about the skill; make the test harder, or focus the skill on where the model genuinely needs help. This is the single best way to answer "is this skill actually earning its place?"

### Tool expectations — what the skill should *run*

Output correctness is not the whole story: a skill can produce the right answer for the wrong reason (e.g. reasoning it out instead of running the executable it ships). `toolExpectations` lets an eval assert the skill's **tool behavior**, judged by the grader from the transcript (preferring the structured `tool_use`/`tool_result` entries):

| Field | Asserts |
|---|---|
| `mustRun` | each named executable was invoked at least once |
| `mustNotRun` | each named executable was **never** invoked (e.g. `rm`, a network CLI) |
| `mustSucceed` | each named executable was invoked **and** did not fail (its invoking `tool_result` was not an error) |
| `sequence` | the described steps happened in order |

Names are matched leniently — the grader recognizes varied launch forms of the *same* executable (`uv run csvsum.py`, `python3 csvsum.py`, `./csvsum`, `node dist/csvsum.mjs`) as all "running `csvsum`", so you assert the tool, not an exact command string.

> **`mustRun` means *invoked*, not *succeeded*.** The verdict is judged from the transcript, which records that a tool was *called* and how — it cannot see a script's exit code through a shell wrapper (a Bash `tool_result.is_error` is `false` even for a command that exits non-zero). So a skill that invokes a **broken** executable and works around the failure still satisfies `mustRun`. Use `mustSucceed` (below) when you need "ran *and* succeeded."

**`mustSucceed`** closes most of that gap — it asserts the tool ran and its invoking `tool_result` was not an error — but it is still **transcript-judged**, not a captured real exit code. Be honest with yourself about the limit: a skill that swallows a non-zero exit (`cmd || true`, catching and silently ignoring a subprocess failure) can still read as succeeded, because the grader is judging what the transcript shows, not re-executing anything. For a hard guarantee, pair `mustSucceed` with a discriminating output `expectations` entry (e.g. *"the output reflects a successful csvsum run, not an error fallback"*). Where it applies, prefer `mustSucceed` over the older workaround of asserting "ran and succeeded" purely in prose — it gives you a structured verdict in `tool-eval.json` instead of one entangled with the output grade:

```json
"toolExpectations": {
  "mustRun": ["csvsum"],
  "mustSucceed": ["csvsum"],
  "mustNotRun": ["rm"]
}
```

**Declare your executables so the grader knows their names.** A `mustRun: ["csvsum"]` resolves against the skill's declared executables in `skills.config.<skill>.executables` — each entry is `{ path, kind, howInvoked }` (`kind` ∈ `node|python|shell|pwsh|binary`). The referenced name matches the `path` basename with its extension stripped (`scripts/csvsum.py` → `csvsum`) or the exact `path`. These flow into the grader prompt as recognition hints:

```yaml
skills:
  config:
    my-skill:
      executables:
        - path: scripts/csvsum.py
          kind: python
          howInvoked: uv run csvsum.py
```

Tool verdicts land in their own **`tool-eval.json`** channel and never leak into `grading.json`. They ride the **WITH-arm only** in a `--baseline` run (the skill-absent arm has no tools to judge). `toolExpectations` is only meaningful for a **declared** skill subject (name, or a path that maps back to a declared skill) — a plain path/source subject has no `executables` manifest to resolve names against.

> **Only committed (or `files:`-injected) files stage.** A name-target build stages the skill via a **tracked-files** tree-copy, so an **untracked** script (a scratch `probe.mjs` you never `git add`-ed) silently won't be in the harness — a `mustRun` against it then fails because the file is *absent*, not because it ran. Commit test scripts, or inject non-artifact files through a `files:` entry (the same mechanism skills use to bundle a built CLI).

### Cost tiers — fail fast before you spend

Give an eval a numeric `tier` to order the run by cost. VAT runs **ascending tiers (cheapest first)**, bounded-parallel within a tier, and **gates between them**: once a cheaper tier fails a gating expectation, the higher (more expensive) tiers are **SKIPPED** — never graded, never counted as passed — and the run is a fail-fast eval failure (exit `4`). Put cheap, foundational checks (does it invoke at all? does it recognize the input?) in tier `0`, and expensive end-to-end cases in higher tiers, so a broken foundation stops the run before it burns tokens on the hard cases. The summary names the skipped tier and eval count. Omit `tier` and everything runs in tier `0` (no gating).

### How grading works (so you can trust the verdict)

For each eval a separate headless **grader** judges the executor's transcript and output files against the `expectations`, requiring **evidence** per verdict, with **no partial credit** and the burden of proof on the expectation. It grades the *artifact*, not the agent's self-reported success — and it is a different agent and (by default) a different model from the executor, so a skill cannot grade itself. VAT then **recomputes** the pass/fail counts from the per-expectation flags rather than trusting any self-reported summary (a mismatch is a loud `GradingSkewError`, not a silent pass). The reported verdict is **composite**: output expectations AND every declared tool verdict must pass, and the run fails closed (exit `4`) if any of `grading.json`/`friction.json`/`tool-eval.json` is missing or invalid after the merge. Full contract: `docs/skill-test-grading-schema.md`.

**A single red eval is a signal to investigate, not proof of a regression.** The grader is a model judging free-form transcript evidence, and verdicts wobble — the same eval, same skill, same code, can flip pass/fail between two runs. Do **not** wire `vat skill test` as a hard 100%-pass CI gate; leave headroom (see **Cover real scenarios** above) and treat one failing eval in an otherwise-green suite as "read `results/grading.json` and the transcript," not "the build is broken." This is exactly why the design above leans the way it does: evidence-required, no-partial-credit grading with the burden of proof on the expectation, and a self-contradictory or missing grade **fails closed** (`GradingSkewError` / exit `4`) instead of being silently waved through as a pass. The strictness is there so that when a FAIL shows up, it's telling you something real to look at — not so that every run should be expected to come back all-green.

## Security Caveat and Required Acknowledgment

`vat skill test run` **executes the skill's code on your machine.** The headless session runs with `--permission-mode bypassPermissions`, so staged skill files run with **your user account's full privileges** — they can read/write your files (including credentials under `~/.claude`, SSH keys, cloud configs), run shell commands, and make network requests, and the auth credential billing the run is reachable by that code. The harness gives **context isolation, not an OS security sandbox**, so only run skills you trust. Before spawning the executor, the command prints this warning and requires the `--i-understand-this-runs-skill-code` flag:

```bash
# Required — preflight exits 2 without it
vat skill test run ./dist/skills/my-skill/ --i-understand-this-runs-skill-code
```

`--allow-unverified-skill-source` skips the integrity check of the **vendored skill-creator copy** (during preflight, the harness verifies the committed skill-creator's per-file hash manifest; a missing or mutated manifest fails preflight with exit 2). Pass it only when you knowingly run against a modified or unverifiable vendored skill-creator:

```bash
--allow-unverified-skill-source
```

It does **not** bypass any URL/`sha256` verification of the subject skill source — that verification is handled separately by the source resolver. Both `--allow-unverified-skill-source` and `--i-understand-this-runs-skill-code` are intentional friction — they ensure you have reviewed what runs before running it.

## Auth Model

The preflight probe is always token-free (`claude auth status --json` — never a `-p` call).

### `--auth` modes

| Mode | Behavior |
|---|---|
| `inherit` (default) | Subscription-preferred: scrubs the API key from the harness environment when a subscription is logged in; falls back to key if no subscription |
| `subscription` | Force OAuth / subscription-only — fails preflight if no subscription logged in |
| `api-key` | Force API key — fails preflight if `ANTHROPIC_API_KEY` is not set |
| `auto` | Raw CLI precedence (Claude's native resolution order, no scrubbing) |

### `--require-auth` guard

An independent fail-fast flag that checks auth type before staging — exits `2` on mismatch:

```bash
# Fail fast if the executor won't use a subscription token
vat skill test run ./dist/skills/my-skill/ \
  --require-auth subscription \
  --i-understand-this-runs-skill-code
```

Supported values: `subscription`, `api-key`.

## Persisting Configuration

`vat skill test configure` writes knobs to `skills.config.<skill>.test` in `vibe-agent-toolkit.config.yaml` using a comment-preserving YAML upsert — your existing comments are not destroyed:

```bash
vat skill test configure my-skill --auth subscription --require-auth subscription
```

Prefer `configure` over adding raw YAML by hand; it validates the values before writing.

### Knobs (flag ⇄ config key)

Most knobs exist both as a CLI flag (one-off) and a `test:` config key (persisted). Flags override config for a given run.

Two config homes: **per-skill** knobs live in `skills.config.<skill>.test`; the **global** judge/pipeline knobs (`graderModel`, `concurrency`) live in a top-level `test:` node. `configure` writes the per-skill block only.

| Flag | Config key | Home | Purpose |
|---|---|---|---|
| `--model <id>` | `model` | per-skill | **Executor** model, passed **verbatim** to `claude --model` (no mapping). Pin for reproducible runs. |
| `--grader-model <id>` | `graderModel` | **global** | **Grader** (judge) model, independent of `--model`. Default `claude-sonnet-5`. |
| `--concurrency <n>` | `concurrency` | **global** | Max evals run in parallel (default 4). |
| `--baseline` | `baseline` | per-skill | Run the with/without A/B skill-lift comparison. |
| `--allow-eval-failure` | — | — | Opt out of the fail-closed default so a failing (or fail-fast-gated) eval exits `0` (interactive use). By **default** a failing eval exits `4`. |
| `--with name=<src>` | `with` | per-skill | Stage a **required** companion skill the subject can invoke (`workspace:`/`npm:`/`url:`/`path:`/`vendored`). A `path:` source that maps to a **declared** skill is **built** first, exactly like the subject, so its `files:` artifacts are injected — a companion backed by a bundled executable stages functional. Its build failure fails the run. Unresolvable source, or a duplicate name across subject/`--with`/`--with-optional`, exits `2`. |
| `--with-optional name=<src>` | `optional` | per-skill | Stage an **optional** companion; skipped with a stderr warning if its source can't be resolved. Also built when it maps to a declared skill, but a build failure falls back to the raw (unbuilt) source **only** when non-destructive — a `pool`-distribution build, or no build attempted (`--no-build`/`--dry-run`). A failed `plugin-local` build fails the run, because the marketplace build wipes its output tree first and staging would read from a deleted tree. |
| `--env KEY=VALUE` | `env` | per-skill | Inject an env var into the **executor** spawn (`${fixturesDir}`, `${stagedSkillDir}`, `${harnessRoot}`, `${resultsDir}` interpolate). Protected names (PATH, auth, model) cannot be overridden. |
| `--pass-env KEY` | `passEnv` | per-skill | Forward a host env var by name if present. |
| `--max-turns` / `--max-budget-usd` / `--timeout` / `--stall` | same | per-skill | Per-spawn turn cap / USD cap / wall-clock seconds / no-output watchdog seconds. **`--timeout` default scales with the declared eval count** (~`2min + 2min/eval`, floored 5min, capped 1h); an explicit value overrides. |
| `--evals <path>` (via config) | `evals` | per-skill | Path to `evals.json` relative to the skill source. |
| — | `build` | per-skill | Shell command run once before staging to generate build artifacts (cwd = config root). |
| — | `executables` | per-skill | Declared executables (`{ path, kind, howInvoked }`) — stable names for `toolExpectations`. Lives on the skill's config, not its `test:` block. |
| `--no-build` / `--refresh` / `--keep` / `--out` / `--workdir` | — | — | Skip building a declared skill / force re-stage / keep the harness dir / override output dir / override working dir. Under `--no-build`, a **required** `--with` companion with no built dist hard-fails the run (exit `2`) rather than silently staging nothing. |

Both `test:` blocks are validated under a **strict** schema (VAT-produced config) — unknown keys are a config error. This is the deliberate inverse of `evals.json`, which VAT reads **liberally** (adopter-authored data): there, unknown fields like `category` pass through untouched.

**Companion builds are deduped, and each companion's `build` hook is its own.** Every declared skill builds **at most once per run**, so a subject that is also a companion — or several companions sharing one marketplace — never triggers duplicate builds. A companion's `test.build` pre-stage hook runs with that companion's own command *and* its own config root as cwd. **Known limitation:** for `plugin-local` companions sharing a marketplace, only the **first** participant's `build` hook runs, because a single marketplace build serves them all — if a later participant's hook generates artifacts the others don't, generate them outside the hook.

**Name vs path subject — both honor `test:` config.** A **name** (`vat skill test run my-skill`) is built from source, then the dist is tested. A **path at a declared skill's SOURCE directory** (`vat skill test run ./skills/my-skill/`) resolves to the SAME `buildable` result as its name — VAT builds it (real entry points, so `files:` injection runs) and tests the dist. `--no-build` skips that build, not falls back to source: it reuses an existing dist as-is (unrebuilt, possibly stale) when one is already present, and hard-fails (exit `2`) if no dist exists yet — only `--dry-run` degrades to raw source, and only when no dist exists yet. A **path at that skill's already-built DIST** (`vat skill test run ./dist/skills/my-skill/`) is tested **as-is** (no rebuild) but still honors the same `test:` config — VAT maps the path back to its declared skill (project-aware, so it works from any directory) and resolves the eval suite from the skill's source. Only a path that maps to **neither** a declared skill's source nor its dist is config-blind; the command prints a one-line note in that case pointing you at the name form. See Skill Reference Resolution for the full disambiguation ladder.

## Friction Triage via `friction.json`

`results/friction.json` lists packaging issues observed during the run. Each item has:

- `severity`: `high` | `medium` | `low`
- `category`: one of the five VAT-owned categories below
- `message`: human-readable description
- `subjectFile` (optional): the file the friction is attributed to
- `evidence` (optional): quoted excerpt or path that triggered the finding

### The Five Friction Categories

| Category | What it means |
|---|---|
| `path-assumption` | The skill assumed a file or directory exists at a relative or absolute path that is not present in the isolated harness. Common when the skill was developed against an un-packaged working tree. |
| `undeclared-dependency` | The skill invoked a tool, binary, or library that was not declared in its `dependencies` or `files` config and is therefore absent in isolation. |
| `ambient-propping` | The skill relied on context (env vars, config files, sibling skills) that was available in the author's environment but not in a clean install. Classic sign that the skill was never tested in isolation. |
| `doc-engine-drift` | The skill's documented behavior (in SKILL.md or references) diverged from what the packaged code actually does — an executor consistently did the "right thing per the docs" but the script produced a different result. |
| `missing-bundled-file` | A file listed in the skill's `files` config is referenced in SKILL.md or a script but was not found in the harness. Usually a `vat build` step that did not run, or a glob that matched nothing. |

High-severity items block real-world usability. Medium and low items are quality improvements. Address `path-assumption`, `undeclared-dependency`, and `ambient-propping` first — they are the most common causes of "works on my machine" failures.

## Common Commands

```bash
# First run — bootstrap evals.json template (exit 3)
vat skill test run ./dist/skills/my-skill/ --i-understand-this-runs-skill-code

# Run evals after filling in evals.json
vat skill test run ./dist/skills/my-skill/ --i-understand-this-runs-skill-code

# A/B skill-lift: run each eval with AND without the skill, report the delta
vat skill test run ./dist/skills/my-skill/ --baseline --i-understand-this-runs-skill-code

# CI gate: a failing eval exits 4 by default (no flag needed). For interactive
# iteration, --allow-eval-failure downgrades that 4 to 0.
vat skill test run ./dist/skills/my-skill/ --allow-eval-failure --i-understand-this-runs-skill-code

# Force subscription auth, fail fast if none logged in
vat skill test run ./dist/skills/my-skill/ \
  --auth subscription \
  --require-auth subscription \
  --i-understand-this-runs-skill-code

# Run against a URL source, skipping the vendored skill-creator integrity check
vat skill test run https://github.com/org/repo.git#main:dist/skills/my-skill/ \
  --allow-unverified-skill-source \
  --i-understand-this-runs-skill-code

# Persist auth knobs to config
vat skill test configure my-skill --auth subscription --require-auth subscription

# Get full help
vat skill test --help
vat skill test run --help
```

## Reading Results

After a run, check:

1. **Printed summary** — `PASS N/N`, `FAIL N/M`, a `(K tool)` suffix for tool-verdict failures, and any `SKIPPED (fail-fast)` tier line.
2. **`results/grading.json`** — per-expectation verdicts, evidence, and the pass/fail summary.
3. **`results/tool-eval.json`** — per-eval tool verdicts. **Always written** (`{"evals": []}` when no eval declared `toolExpectations`), so check `.evals.length`, not file existence.
4. **`results/friction.json`** — packaging friction items; triage by severity and category (see above).
5. **`results/transcripts/`** — executor conversation logs for failed evals; the most useful debugging artifact when an eval fails unexpectedly.

A `FAIL N/M` (exit 4) means the harness worked but the composite verdict did not all pass. Fix the skill, rebuild (`vat build`), and re-run.

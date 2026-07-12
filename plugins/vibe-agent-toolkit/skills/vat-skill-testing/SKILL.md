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

## The Execution Loop

```
driver (you)
  └─ vat skill test run [source]
       ├─ 1. Resolve source (local path, git URL, npm)
       ├─ 2. Stage: copy packaged skill + declared deps into an isolated temp harness
       ├─ 3. Preflight: token-free fail-fast checks (see below)
       └─ 4. Spawn ONE headless `claude` — the "experimenter"
            └─ Experimenter reads eval procedure from harnessRoot/
                 ├─ Dispatches executor subagents — one per eval in evals.json
                 └─ Grades each executor against the rubric
                      └─ Artifacts land under harnessRoot/results/
```

Artifacts produced under `<harnessRoot>/results/`:

| Artifact | Contents |
|---|---|
| `grading.json` | Per-eval grade, rubric scores, pass/fail verdict |
| `friction.json` | Packaging friction items (categories, severities, messages) |
| `experimenter-prompt.txt` | Full prompt sent to the experimenter — useful for debugging |
| `transcripts/` | Per-executor conversation logs |

IPC between driver, experimenter, and executors is purely filesystem — no sockets or shared memory.

## Exit Codes

| Code | Meaning |
|---|---|
| `0` | Harness ran to completion and **every eval passed** (`PASS N/N`) — or a failing verdict was suppressed with `--allow-eval-failure`. Read the printed summary and `results/grading.json` for detail. |
| `4` | An eval **FAILED** (`FAIL N/M`): the harness completed and produced a valid `grading.json`, but the skill's expectations did not all pass. This is the **fail-closed default** — suppress with `--allow-eval-failure` for interactive iteration. |
| `3` | Bootstrap: no `evals.json` found — VAT wrote a template. **Not a failure.** Fill in the template and re-run. |
| `2` | Preflight / env failure: missing `claude` binary, auth error, declared inputs or deps absent, unsafe `--workdir`, `--require-auth` mismatch, or the `--i-understand-this-runs-skill-code` acknowledgment was not given. |
| `1` | Internal failure, including the experimenter exiting without producing a valid `grading.json`. A **stall, timeout, or non-zero experimenter exit is authoritative and always exit 1** — it is never laundered into a PASS even if a `grading.json` is present on disk (a hardening against skill code that writes a fake grade then hangs). |

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

> **A timed-out run may leave `grading.json` truncated and unparseable** (the experimenter is told to flush incrementally, so a mid-run kill can cut a partial file). Any consumer reading `grading.json` must treat an unparseable file as a **failure**, not crash on it. The exit code (1) already tells you the run did not complete; do not trust a partial artifact.
>
> **The default `--timeout` scales with the suite's declared eval count** (roughly `2min + 2min/eval`, floored at 5min, capped at 1h) so a correctly-configured multi-eval suite is not truncated by a flat budget. An explicit `--timeout` always overrides. If a run times out, the message names the declared eval count — raise `--timeout` (and `--stall`) for large suites.

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
  "skill_name": "data-extract-analysis",
  "evals": [
    {
      "id": "incurred-reconciles",
      "category": "recognition-accuracy",
      "prompt": "Can you take a look at this loss run and tell me whether it adds up? I just need to know if paid plus reserves ties to incurred before I send it on.",
      "files": ["fixtures/wc-loss-run-clean.csv"],
      "expected_output": "Recognizes the file as a workers'-comp loss run (8 claims), runs the reconciliation, and reports in plain English that paid + reserves ties to incurred for every row.",
      "expectations": [
        "The output identifies the file as a workers'-comp loss run with 8 rows.",
        "The output states paid + reserve reconciles to incurred for every row.",
        "The output does NOT claim any row fails to add up."
      ]
    }
  ]
}
```

- `id` — unique identifier; an integer **or** a descriptive string (descriptive ids read better in results).
- `category` — optional grouping label you choose; VAT carries it through untouched.
- `files` — optional input paths relative to the `evals.json` directory; each eval's files are staged into its own isolated working directory.
- `expectations` is required and needs at least one entry — it is what the grader scores (pass/fail per entry).
- `expected_output` is optional prose describing a correct result; when present the grader receives it as context informing its judgment, but the verdict is still decided per `expectations` entry.

### Write blind, realistic prompts

The executor is never told it's being tested — and it shouldn't be able to tell. Phrase prompts exactly the way a real user would ("Reserve review on this WC loss run, please."), never "Test that the skill computes reserves." This is not cosmetic: models behave measurably differently when they sense an eval, so a benchmark-flavored prompt measures the wrong thing.

### Write *discriminating* expectations

Every expectation must **fail for a wrong output**. The classic trap — which the grader is explicitly told to flag — is checking mere presence: `"the output mentions John Smith"` also passes for a hallucinated document. Check *correctness*, tied to the input, not presence. And pair positive assertions with **negative** ones (`"does NOT claim every row reconciles"`): one-sided evals create one-sided optimization. If an assertion would pass for an obviously broken result, it's not pulling its weight.

### Cover real scenarios; aim for ≥3 evals

Anthropic's bar is *at least three evaluations, drawn from real usage and past failures, tested across models*. Group evals by what they exercise — dxa, the reference adopter, uses three categories:

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

### How grading works (so you can trust the verdict)

A headless grader judges each expectation against the executor's transcript and output files, requiring **evidence** per verdict, with **no partial credit** and the burden of proof on the expectation. It grades the *artifact*, not the agent's self-reported success. VAT then **recomputes** the pass/fail counts from the per-expectation flags rather than trusting the grader's summary (a mismatch is a loud `GradingSkewError`, not a silent pass). Full contract: `docs/skill-test-grading-schema.md`.

## Security Caveat and Required Acknowledgment

`vat skill test run` **executes the skill's code on your machine.** The headless session runs with `--permission-mode bypassPermissions`, so staged skill files run with **your user account's full privileges** — they can read/write your files (including credentials under `~/.claude`, SSH keys, cloud configs), run shell commands, and make network requests, and the auth credential billing the run is reachable by that code. The harness gives **context isolation, not an OS security sandbox**, so only run skills you trust. Before spawning the experimenter, the command prints this warning and requires the `--i-understand-this-runs-skill-code` flag:

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

| Flag | Config key | Purpose |
|---|---|---|
| `--model <id>` | `model` | Model passed **verbatim** to `claude --model` (no mapping). Pin it for reproducible, cost-controlled runs. |
| `--baseline` | `baseline` | Run the with/without A/B skill-lift comparison. |
| `--allow-eval-failure` | — | Opt out of the fail-closed default so a failing eval exits `0` (interactive use). By **default** a failing eval exits `4` — distinct from the harness-broke codes so CI can gate on it. |
| `--with name=<src>` | `with` | Stage a declared-dependency skill (`workspace:`/`npm:`/`url:`/`path:`/`vendored`). |
| `--with-optional name=<src>` | `optional` | Stage an optional dependency (absent by default). |
| `--env KEY=VALUE` | `env` | Inject an env var into the experimenter spawn (`${fixturesDir}`, `${stagedSkillDir}`, `${harnessRoot}`, `${resultsDir}` interpolate). Protected names (PATH, auth, model) cannot be overridden. |
| `--pass-env KEY` | `passEnv` | Forward a host env var by name if present. |
| `--max-turns` / `--max-budget-usd` / `--timeout` / `--stall` | same | Turn cap / USD cap / wall-clock seconds / no-output watchdog seconds. **`--timeout` default scales with the declared eval count** (~`2min + 2min/eval`, floored 5min, capped 1h); an explicit value overrides. |
| `--evals <path>` (via config) | `evals` | Path to `evals.json` relative to the skill source. |
| — | `build` | Shell command run once before staging to generate build artifacts (cwd = config root). |
| `--no-build` / `--refresh` / `--keep` / `--out` / `--workdir` | — | Skip building a declared skill / force re-stage / keep the harness dir / override output dir / override working dir. |

The `test:` block is validated under a **strict** schema (it's VAT-produced config) — unknown keys are a config error. This is the deliberate inverse of `evals.json`, which VAT reads **liberally** (adopter-authored data): there, unknown fields like `category` pass through untouched.

**Name vs path subject — both honor `test:` config.** A **name** (`vat skill test run my-skill`) is built from source, then the dist is tested. A **path** at that skill's built dist (`vat skill test run ./dist/skills/my-skill/`) is tested **as-is** (no rebuild) but still honors the same `test:` config — VAT maps the path back to its declared skill (project-aware, so it works from any directory) and resolves the eval suite from the skill's source. Only a path that maps to **no** declared skill is config-blind; the command prints a one-line note in that case pointing you at the name form.

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

After a completed run (exit 0), check:

1. **Printed summary** — `PASS N/N` or `FAIL N/M` at the bottom of the run output.
2. **`results/grading.json`** — per-eval verdicts, rubric scores, and failure reasons.
3. **`results/friction.json`** — packaging friction items; triage by severity and category (see above).
4. **`results/transcripts/`** — executor conversation logs for failed evals; the most useful debugging artifact when an eval fails unexpectedly.

Exit 0 with a `FAIL N/M` summary means the harness worked but the skill did not pass all evals. Fix the skill, rebuild (`vat build`), and re-run.

---
name: vat-skill-testing
description: Use when running `vat skill test run`/`configure`, triaging friction.json output, reasoning about the test harness's isolation or auth model, or confirming a packaged skill works in a clean install.
---

# VAT Skill Testing: Behavioral Downstream Packaging Check

`vat skill test` answers one question: **does this packaged skill actually work when installed in isolation?** It stages the built skill into a hardened temp harness and runs a headless behavioral evaluation — no interactive session required.

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
| `0` | Harness ran to completion and produced a valid `grading.json`. Read the printed summary (`PASS N/N` or `FAIL N/M`) and `results/grading.json` for eval outcomes — exit 0 does **not** mean all evals passed. |
| `3` | Bootstrap: no `evals.json` found — VAT wrote a template. **Not a failure.** Fill in the template and re-run. |
| `2` | Preflight / env failure: missing `claude` binary, auth error, declared inputs or deps absent, unsafe `--workdir`, `--require-auth` mismatch, or the `--i-understand-this-runs-skill-code` acknowledgment was not given. |
| `1` | Internal failure, including the experimenter exiting without producing a valid `grading.json`. |

## Bootstrap Flow (Exit 3)

First run with no `evals.json`:

```bash
vat skill test run ./dist/skills/my-skill/ --i-understand-this-runs-skill-code
# Exit 3 — VAT scaffolds evals.json template next to the skill source
```

Edit `evals.json` to fill in expected behaviors, then re-run. The template includes annotated comments explaining each field.

## Security Caveat and Required Acknowledgment

`vat skill test run` **executes arbitrary skill code** in the sandboxed harness. Before spawning the experimenter, the command prints a security warning and requires the `--i-understand-this-runs-skill-code` flag:

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

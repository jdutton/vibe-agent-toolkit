# vat skill test - Eval Harness Commands

## Overview

The `vat skill test` commands run a packaged skill's eval suite in a headless,
context-isolated Claude session. Each eval runs in two roles: a blind **executor**
(the skill under test) performs the task, then a separate **grader** judges the
captured transcript and emits a verdict.

```bash
vat skill test run <skill>        # execute the eval suite
vat skill test configure <skill>  # persist knobs into vibe-agent-toolkit.config.yaml
```

> **This command executes skill code.** It is context-isolated, not an OS sandbox.
> `--i-understand-this-runs-skill-code` is required to acknowledge that.

Note the singular `vat skill` — distinct from the `vat skills` (plural) packaging
commands documented in [skills.md](./skills.md).

## Two config homes

Most knobs exist both as a CLI flag (one-off) and a config key (persisted). **Flags
override config.** There are two places config lives:

| Home | Location | Holds |
|---|---|---|
| **Per-skill** | `skills.config.<skill>.test` | Everything about testing *one* skill — model under test, budgets, evals, companions |
| **Global** | top-level `test:` node | Judge/pipeline knobs shared by every skill — `graderModel`, `concurrency` |

```yaml
# vibe-agent-toolkit.config.yaml
test:                          # GLOBAL — the judge and the pipeline
  graderModel: claude-sonnet-5
  concurrency: 4

skills:
  config:
    my-skill:
      test:                    # PER-SKILL — the thing under test
        model: claude-opus-5
        timeout: 1500
        auth: subscription
        requireAuth: subscription
        evals: evals/suite.json
```

Both blocks are validated under a **strict** schema — an unknown key is a config
error, not a silent no-op. (This is the deliberate inverse of `evals.json`, which
VAT reads liberally as adopter-authored data.)

`vat skill test configure <skill>` writes the **per-skill** block using a
comment-preserving YAML upsert, and validates values before writing. Prefer it over
hand-editing.

## Per-skill knobs (`skills.config.<skill>.test`)

Every field is optional; an omitted knob falls back to its default.

| Config key | Type / unit | Default | CLI flag | Purpose |
|---|---|---|---|---|
| `model` | string | claude's own default | `--model <id>` | Model for the **executor** (the skill under test). Passed **verbatim** to `claude --model` — VAT does no mapping or validation. Pin it for reproducible runs. |
| `maxTurns` | integer > 0 | none | `--max-turns <n>` | Per-spawn cap on executor/grader turns. |
| `maxBudgetUsd` | number > 0 | none | `--max-budget-usd <n>` | Hard USD budget cap passed to the CLI. |
| `timeout` | integer, **seconds** | scales with eval count: ~`2min + 2min/eval`, floored at 5min, capped at 1h | `--timeout <s>` | Wall-clock timeout. An explicit value always overrides the scaled default. |
| `stall` | integer, **seconds** | none | `--stall <s>` | Stall watchdog — kill the spawn after this long with no stream output. |
| `evals` | string (path) | bootstrapped suite | `--evals <path>` | Path to `evals.json`, **relative to the skill source**. |
| `auth` | `inherit` \| `subscription` \| `api-key` \| `auto` | `inherit` | `--auth <mode>` | Auth mechanism for the spawned session. |
| `requireAuth` | `subscription` \| `api-key` | none | `--require-auth <mech>` | Fail-fast guard: preflight exits `2` if the effective mechanism isn't this. |
| `baseline` | boolean | `false` | `--baseline` | Run the opt-in with/without A/B skill-lift comparison. |
| `skillCreator` | source descriptor | `{ vendored: true }` | — | Source for the vendored skill-creator rubric. |
| `with` | array of source descriptors | none | `--with name=<src>` | **Required** companion skills staged alongside the subject, invocable by it. |
| `optional` | array of source descriptors | none | `--with-optional name=<src>` | **Optional** companions — skipped with a warning if unresolvable. |
| `env` | map string→string | none | `--env KEY=VALUE` | Env vars injected into the **executor** spawn. Values interpolate `${fixturesDir}`, `${stagedSkillDir}`, `${harnessRoot}`, `${resultsDir}`. Protected names (PATH, auth, model, admin) cannot be overridden. |
| `passEnv` | array of strings | none | `--pass-env KEY` | Names of host env vars to forward to the executor spawn if present. Protected names are ignored with a warning. |
| `build` | string (shell command) | none | — | Command run **once, before staging**, to generate build artifacts. Runs with `cwd` = config root. A non-zero exit aborts the run (exit `2`). |

A **source descriptor** is one of `{ workspace: <pkg> }`, `{ npm: <spec> }`,
`{ url: <u>, sha256?: <hash> }`, `{ path: <dir> }`, or `{ vendored: true }`. On the
command line the same sources are written as `name=workspace:<pkg>`,
`name=npm:<spec>`, `name=url:<u>`, `name=path:<dir>`, or `name=vendored` — the CLI
form requires an explicit companion `name=`, the config form derives it from the
resolved skill.

### Companion staging and builds

A `path:` companion whose source directory maps to a **declared** skill is **built**
first, exactly like the subject, so its `files:` build artifacts are injected — a
companion backed by a bundled executable stages functional rather than inert. A
required companion's build failure fails the run; an optional one falls back to raw
unbuilt source only when the failure is non-destructive. Each declared skill builds
**at most once per run**.

Staging the same name twice across the subject, `--with`, and `--with-optional` is a
duplicate-name error (exit `2`).

## Global knobs (top-level `test:`)

| Config key | Type | Default | CLI flag | Purpose |
|---|---|---|---|---|
| `graderModel` | string | `claude-sonnet-5` | `--grader-model <id>` | Model for the fixed grader/judge. Passed verbatim to `claude --model`. Independent of `model` — you can run the skill under one model and grade under another. |
| `concurrency` | integer > 0 | `4` | `--concurrency <n>` | Width of the bounded-parallel executor→grader pipeline. |

## Run-only flags (no config key)

| Flag | Purpose |
|---|---|
| `--i-understand-this-runs-skill-code` | **Required.** Acknowledges the command executes skill code. |
| `--no-build` | Stage existing `dist` instead of building. Errors if absent for the subject or a **required** companion; an optional companion falls back to raw source with a warning. |
| `--refresh` | Force a full re-stage, ignoring existing staged content. |
| `--keep` | Keep the harness directory after the run (needed to inspect `results/`). |
| `--dry-run` | Assemble the command without spawning Claude. Note this **skips the build**, so it does not preview `files:` injection. |
| `--out <dir>` / `--workdir <dir>` | Override the harness output / working directory. |
| `--allow-eval-failure` | Opt out of fail-closed: exit `0` even when an eval fails. For interactive iteration. |
| `--allow-unverified-skill-source` | Skip the vendored manifest integrity check. |
| `--debug` | Enable debug logging. |

## Exit codes

The harness deliberately separates "the evals failed" from "the harness broke", so
CI can tolerate one and gate on the other.

- `0` - Run completed, all expectations passed
- `1` - Harness broke (internal error, stall, timeout, grader nonce failure)
- `2` - Preflight failure (bad config, unresolvable required companion, auth guard, `build` hook failed)
- `3` - Bootstrap failure
- `4` - **Eval failure** — the run completed but expectations did not all pass

```bash
vat skill test run my-skill --i-understand-this-runs-skill-code
case $? in
  0) ;;
  4) echo "evals failed (tolerated)" ;;
  *) exit 1 ;;    # harness broke — fail the build
esac
```

## Results

With `--keep`, the harness directory retains a `results/` tree that VAT is the sole
writer of:

- `grading.json` - per-expectation verdicts and the pass/total summary
- `friction.json` - packaging issues observed during the run (advisory)
- `tool-eval.json` - tool-expectation verdicts; always written, so check
  `.evals.length` rather than file existence

## Examples

```bash
# Run a declared skill's suite, honoring its test: config
vat skill test run my-skill --i-understand-this-runs-skill-code

# Pin both models independently, keep the harness for inspection
vat skill test run my-skill --model claude-opus-5 --grader-model claude-sonnet-5 \
  --keep --i-understand-this-runs-skill-code

# Stage a required companion the subject is expected to invoke
vat skill test run router-skill --with helper=path:./skills/helper \
  --i-understand-this-runs-skill-code

# Persist knobs instead of passing them every time
vat skill test configure my-skill --auth subscription --require-auth subscription
```

## See Also

- [skills.md](./skills.md) - `vat skills` (plural): packaging, validation, install
- [index.md](./index.md) - full CLI command index
